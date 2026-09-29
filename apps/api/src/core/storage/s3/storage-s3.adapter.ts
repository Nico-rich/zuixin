import { DeleteObjectCommand, GetObjectCommand, ListObjectsV2Command, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { NodeHttpHandler } from '@smithy/node-http-handler';
import { Readable } from 'node:stream';
import { StorageAdapter, StorageListOptions, StorageListPage, StorageObjectInfo } from '../storage.types';
import { StorageTimeoutError, storageConnectTimeoutMs, storageRequestTimeoutMs } from '../storage-timeouts';

/** S3 `MaxKeys` 的服务端硬上限（协议规定 ≤1000；超出会被服务端拒绝或用默认值——驱动侧先收敛） */
export const S3_MAX_KEYS = 1_000;
const DEFAULT_LIST_LIMIT = 1_000;

export interface S3Config {
  endpoint: string; region: string; bucket: string;
  accessKeyId: string; secretAccessKey: string; forcePathStyle: boolean;
  /**
   * M11-P11（D1-12）：建连/单请求超时。**不传则读 env**（STORAGE_S3_CONNECT_TIMEOUT_MS /
   * STORAGE_S3_REQUEST_TIMEOUT_MS，默认 5000 / 30000）；显式值优先于 env（便于单测与特殊链路）。
   */
  connectTimeoutMs?: number;
  requestTimeoutMs?: number;
}

/**
 * abort 兜底相对单请求超时的宽限：让 `NodeHttpHandler` 自身的 requestTimeout 错误**优先暴露**
 * （SDK 语义/文案更权威），本层 abort 只覆盖"请求已发出但 handler 计时未生效"的窗口
 * （例如流式 Body 上传中途停滞、响应头已到但 Body 停住）。
 */
export const S3_ABORT_SLACK_MS = 1_000;

/** S3 兼容驱动（MinIO / Cloudflare R2 / AWS S3 一套） */
export class StorageS3Adapter implements StorageAdapter {
  private readonly client: S3Client;
  private readonly requestTimeoutMs: number;

  constructor(private readonly cfg: S3Config) {
    this.requestTimeoutMs = cfg.requestTimeoutMs ?? storageRequestTimeoutMs();
    this.client = new S3Client({
      endpoint: cfg.endpoint, region: cfg.region, forcePathStyle: cfg.forcePathStyle,
      credentials: { accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey },
      // M11-P11（D1-12/NV-13）：显式 NodeHttpHandler —— 默认 requestTimeout = 0（**永不超时**），
      // 半开的存储端点会让 put/getStream/delete 的 Promise 永不 settle（挂死请求线程与配额预留）。
      requestHandler: new NodeHttpHandler({
        connectionTimeout: cfg.connectTimeoutMs ?? storageConnectTimeoutMs(),
        requestTimeout: this.requestTimeoutMs,
      }),
    });
  }

  async put(key: string, stream: Readable, meta: { contentType: string; sizeBytes: number }): Promise<void> {
    await this.withAbort('s3:put', (abortSignal) => this.client.send(new PutObjectCommand({
      Bucket: this.cfg.bucket, Key: key, Body: stream,
      ContentType: meta.contentType, ContentLength: meta.sizeBytes,
    }), { abortSignal }));
  }

  async createPresignedUrl(key: string, expiresInSec: number): Promise<string> {
    // 预签名是**纯本地计算**（不发网络请求），无超时面；底层 client 已带 requestHandler 配置
    return getSignedUrl(this.client, new GetObjectCommand({ Bucket: this.cfg.bucket, Key: key }), { expiresIn: expiresInSec });
  }

  async getStream(key: string): Promise<Readable> {
    // 有界的是"拿到响应头"这一步；返回的 Body 由调用方消费（传输阶段另有 handler 的 socket 超时面）
    const res = await this.withAbort('s3:getStream', (abortSignal) => this.client.send(new GetObjectCommand({
      Bucket: this.cfg.bucket, Key: key,
    }), { abortSignal }));
    return res.Body as Readable;
  }

  async delete(key: string): Promise<void> {
    await this.withAbort('s3:delete', (abortSignal) => this.client.send(new DeleteObjectCommand({
      Bucket: this.cfg.bucket, Key: key,
    }), { abortSignal }));
  }

  /**
   * M12-P5：`ListObjectsV2` 分页枚举（孤儿对象清扫的数据来源；MinIO/R2/AWS 同一套协议）。
   *
   * 语义与边界：
   * - `Prefix` 是**字面前缀**（S3 协议语义），不做目录推断；未给 ⇒ 全桶；
   * - `MaxKeys` 收敛到协议上限 `S3_MAX_KEYS`（1000），续页用服务端返回的 `NextContinuationToken`；
   * - 只返回**对象**（`Key` 以 `/` 结尾的"目录占位对象"被过滤——它们不是可清扫的数据对象）；
   * - `lastModified` 取服务端 `LastModified`；缺失 ⇒ null（调用方按"年龄未知"保守处理）；
   * - 有界性：与其余方法同一 `withAbort` 兜底（存储端点半开时不会永久挂住清扫任务）。
   */
  async list(options: StorageListOptions = {}): Promise<StorageListPage> {
    const limit = Math.min(Math.max(Math.trunc(options.limit ?? DEFAULT_LIST_LIMIT) || DEFAULT_LIST_LIMIT, 1), S3_MAX_KEYS);
    const res = await this.withAbort('s3:list', (abortSignal) => this.client.send(new ListObjectsV2Command({
      Bucket: this.cfg.bucket,
      ...(options.prefix ? { Prefix: options.prefix } : {}),
      MaxKeys: limit,
      ...(options.cursor ? { ContinuationToken: options.cursor } : {}),
    }), { abortSignal }));
    const objects: StorageObjectInfo[] = [];
    for (const entry of res.Contents ?? []) {
      const key = typeof entry.Key === 'string' ? entry.Key : '';
      if (!key || key.endsWith('/')) continue; // 目录占位对象不是数据对象
      objects.push({
        key,
        sizeBytes: typeof entry.Size === 'number' && Number.isFinite(entry.Size) ? entry.Size : 0,
        lastModified: entry.LastModified instanceof Date ? entry.LastModified : null,
      });
    }
    // IsTruncated=true 但服务端没给 token（协议异常）⇒ 如实结束本页并置 null（调用方据此停手，绝不空转翻页）
    const nextCursor = res.IsTruncated === true && typeof res.NextContinuationToken === 'string' && res.NextContinuationToken.length > 0
      ? res.NextContinuationToken
      : null;
    return { objects, nextCursor };
  }

  /**
   * 单次请求的 abort 兜底：`requestTimeoutMs + 宽限` 后主动 abort（销毁 socket、结束未完成的 Body 流），
   * 并把"确实由本层 abort 触发"的失败统一折叠成 `StorageTimeoutError`。
   *
   * 归因不吞错：非 abort 触发的失败（凭证错误、404、SDK 自身超时文案、连接被拒）**原样上抛**，
   * 绝不被改写成超时语义。
   */
  private async withAbort<T>(label: string, run: (abortSignal: AbortSignal) => Promise<T>): Promise<T> {
    const controller = new AbortController();
    const timeoutMs = this.requestTimeoutMs + S3_ABORT_SLACK_MS;
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    timer.unref?.();
    try {
      return await run(controller.signal);
    } catch (err) {
      if (controller.signal.aborted) throw new StorageTimeoutError(label, timeoutMs);
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }
}
