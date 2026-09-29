import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Readable } from 'node:stream';
import { NodeHttpHandler } from '@smithy/node-http-handler';
import { StorageS3Adapter, S3_ABORT_SLACK_MS, S3_MAX_KEYS } from './storage-s3.adapter';
import { StorageTimeoutError } from '../storage-timeouts';

/**
 * M11-P11（D1-12/NV-13）单测：S3Client 的**超时配置注入**与**单请求 abort 兜底**。
 *
 * 不触真实网络：`@aws-sdk/client-s3` 整体 mock（构造参数全程捕获）；`NodeHttpHandler` 用
 * **真实实现**（只包一层子类捕获构造入参），断言取 smithy **自己解析出的 config**
 * （`configProvider`）——而不是我们传进去的对象，"配置键名写错被 SDK 静默忽略"也能被抓到。
 * 注意：`httpHandlerConfigs()` 在首次 `handle()` 之前返回 `{}`（smithy 懒解析），故不从它取。
 */

const h = vi.hoisted(() => ({
  clientConstruct: vi.fn(),
  send: vi.fn(),
  handlerOptions: [] as unknown[],
  handlers: [] as unknown[],
}));

vi.mock('@aws-sdk/client-s3', () => {
  class FakeS3Client {
    constructor(config: unknown) { h.clientConstruct(config); }
    send(command: unknown, options?: unknown) { return h.send(command, options); }
  }
  class FakeCommand {
    constructor(readonly input: unknown) {}
  }
  return {
    S3Client: FakeS3Client,
    PutObjectCommand: class extends FakeCommand {},
    GetObjectCommand: class extends FakeCommand {},
    DeleteObjectCommand: class extends FakeCommand {},
    ListObjectsV2Command: class extends FakeCommand {},
  };
});

vi.mock('@smithy/node-http-handler', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@smithy/node-http-handler')>();
  class CapturingNodeHttpHandler extends actual.NodeHttpHandler {
    constructor(options?: ConstructorParameters<typeof actual.NodeHttpHandler>[0]) {
      h.handlerOptions.push(options);
      super(options);
      h.handlers.push(this);
    }
  }
  return { ...actual, NodeHttpHandler: CapturingNodeHttpHandler };
});

vi.mock('@aws-sdk/s3-request-presigner', () => ({ getSignedUrl: vi.fn(async () => 'https://signed.example/obj?X-Amz-Signature=test') }));

const CONFIG = {
  endpoint: 'http://localhost:9000', region: 'us-east-1', bucket: 'agent-storage',
  accessKeyId: 'minioadmin', secretAccessKey: 'minioadmin', forcePathStyle: true,
};

interface ResolvedHandlerConfig { connectionTimeout?: number; requestTimeout?: number }

/** 最近一次 S3Client 构造入参 */
const lastClientConfig = () => h.clientConstruct.mock.calls.at(-1)?.[0] as {
  endpoint: string; region: string; forcePathStyle: boolean;
  credentials: { accessKeyId: string; secretAccessKey: string };
  requestHandler: NodeHttpHandler;
};

/** smithy 真正会用于请求的超时（私有 `configProvider` 解析结果；`httpHandlerConfigs()` 首次请求前为空） */
const resolvedHandlerConfig = () => {
  const handler = h.handlers.at(-1) as { configProvider: Promise<ResolvedHandlerConfig> };
  return handler.configProvider;
};

const ENV_KEYS = ['STORAGE_S3_CONNECT_TIMEOUT_MS', 'STORAGE_S3_REQUEST_TIMEOUT_MS', 'STORAGE_DEADLINE_MS'];
let savedEnv: Record<string, string | undefined>;

beforeEach(() => {
  h.clientConstruct.mockClear();
  h.send.mockReset();
  h.handlerOptions.length = 0;
  h.handlers.length = 0;
  savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k]; else process.env[k] = savedEnv[k];
  }
  vi.useRealTimers();
});

describe('StorageS3Adapter 超时配置注入（M11-P11 D1-12）', () => {
  it('默认：注入真实 NodeHttpHandler + 建连 5000ms / 请求 30000ms（绝不落 SDK 的 0 = 永不超时）', async () => {
    new StorageS3Adapter({ ...CONFIG });
    const cfg = lastClientConfig();
    expect(cfg.requestHandler).toBeInstanceOf(NodeHttpHandler);
    expect(await resolvedHandlerConfig()).toMatchObject({ connectionTimeout: 5_000, requestTimeout: 30_000 });
  });

  it('env 覆盖：STORAGE_S3_CONNECT_TIMEOUT_MS / STORAGE_S3_REQUEST_TIMEOUT_MS 生效', async () => {
    process.env.STORAGE_S3_CONNECT_TIMEOUT_MS = '1234';
    process.env.STORAGE_S3_REQUEST_TIMEOUT_MS = '5678';
    new StorageS3Adapter({ ...CONFIG });
    expect(await resolvedHandlerConfig()).toMatchObject({ connectionTimeout: 1_234, requestTimeout: 5_678 });
  });

  it('显式配置优先于 env（便于单测/特殊链路注入）', async () => {
    process.env.STORAGE_S3_CONNECT_TIMEOUT_MS = '1234';
    process.env.STORAGE_S3_REQUEST_TIMEOUT_MS = '5678';
    new StorageS3Adapter({ ...CONFIG, connectTimeoutMs: 11, requestTimeoutMs: 22 });
    expect(await resolvedHandlerConfig()).toMatchObject({ connectionTimeout: 11, requestTimeout: 22 });
  });

  it('非法/零/负值 env 回退默认（0 在 smithy 语义里是"永不超时"，必须显式拒绝）', async () => {
    process.env.STORAGE_S3_CONNECT_TIMEOUT_MS = '0';
    process.env.STORAGE_S3_REQUEST_TIMEOUT_MS = '-1';
    new StorageS3Adapter({ ...CONFIG });
    expect(await resolvedHandlerConfig()).toMatchObject({ connectionTimeout: 5_000, requestTimeout: 30_000 });
  });

  it('既有构造契约不变（端点/区域/路径风格/凭证原样传入）', () => {
    new StorageS3Adapter({ ...CONFIG });
    expect(lastClientConfig()).toMatchObject({
      endpoint: CONFIG.endpoint, region: CONFIG.region, forcePathStyle: true,
      credentials: { accessKeyId: CONFIG.accessKeyId, secretAccessKey: CONFIG.secretAccessKey },
    });
  });
});

describe('StorageS3Adapter 单请求 abort 兜底', () => {
  it('正常路径：put/getStream/delete 均带 abortSignal（未超时不 abort，语义不变）', async () => {
    const adapter = new StorageS3Adapter({ ...CONFIG });
    h.send.mockResolvedValueOnce({}).mockResolvedValueOnce({ Body: Readable.from([Buffer.from('x')]) }).mockResolvedValueOnce({});

    await adapter.put('u/1.png', Readable.from([Buffer.from('a')]), { contentType: 'image/png', sizeBytes: 1 });
    const stream = await adapter.getStream('u/1.png');
    await adapter.delete('u/1.png');

    expect(stream.read()).toEqual(Buffer.from('x'));
    expect(h.send).toHaveBeenCalledTimes(3);
    for (const call of h.send.mock.calls) {
      const options = call[1] as { abortSignal?: AbortSignal } | undefined;
      expect(options?.abortSignal).toBeInstanceOf(AbortSignal);
      expect(options?.abortSignal?.aborted).toBe(false);
    }
    // 命令入参不变（桶/键/内容类型/长度）
    expect((h.send.mock.calls[0][0] as { input: Record<string, unknown> }).input).toMatchObject({
      Bucket: 'agent-storage', Key: 'u/1.png', ContentType: 'image/png', ContentLength: 1,
    });
  });

  it('请求永不 settle → requestTimeout + 宽限后主动 abort，抛 StorageTimeoutError（5xx 语义）', async () => {
    vi.useFakeTimers();
    const adapter = new StorageS3Adapter({ ...CONFIG, requestTimeoutMs: 30 });
    h.send.mockImplementation((_cmd: unknown, options?: { abortSignal?: AbortSignal }) => new Promise((_resolve, reject) => {
      options?.abortSignal?.addEventListener('abort', () => reject(new Error('Request aborted')));
    }));

    const pending = adapter.put('u/hang.bin', Readable.from([Buffer.from('a')]), { contentType: 'application/octet-stream', sizeBytes: 1 });
    const assertion = expect(pending).rejects.toBeInstanceOf(StorageTimeoutError);
    await vi.advanceTimersByTimeAsync(30 + S3_ABORT_SLACK_MS + 1);
    await assertion;
    await expect(pending).rejects.toMatchObject({
      name: 'StorageTimeoutError', code: 'STORAGE_TIMEOUT', timeoutMs: 30 + S3_ABORT_SLACK_MS, label: 's3:put',
    });
    expect((h.send.mock.calls[0][1] as { abortSignal: AbortSignal }).abortSignal.aborted).toBe(true);
  });

  it('请求在超时前成功 → 不 abort、不改写结果（定时器随请求结束清除）', async () => {
    vi.useFakeTimers();
    const adapter = new StorageS3Adapter({ ...CONFIG, requestTimeoutMs: 30 });
    const signals: AbortSignal[] = [];
    h.send.mockImplementation((_cmd: unknown, options?: { abortSignal?: AbortSignal }) => {
      if (options?.abortSignal) signals.push(options.abortSignal);
      return Promise.resolve({});
    });

    await adapter.delete('u/1.png');
    await vi.advanceTimersByTimeAsync(60_000); // 远超 abort 上界：若无清除逻辑，这里会 abort 已完成的请求
    expect(signals[0].aborted).toBe(false);
  });

  it('底层自身失败（非本层 abort）原样上抛，绝不被改写成超时语义', async () => {
    const adapter = new StorageS3Adapter({ ...CONFIG, requestTimeoutMs: 5_000 });
    h.send.mockRejectedValue(Object.assign(new Error('Access Denied'), { name: 'AccessDenied' }));
    await expect(adapter.delete('u/1.png')).rejects.toMatchObject({ name: 'AccessDenied', message: 'Access Denied' });
  });

  it('预签名 URL 仍走同一 client（纯本地计算，无网络往返）', async () => {
    const adapter = new StorageS3Adapter({ ...CONFIG });
    await expect(adapter.createPresignedUrl('u/1.png', 900)).resolves.toContain('X-Amz-Signature');
    expect(h.send).not.toHaveBeenCalled();
  });
});

/**
 * M12-P5：`list`（ListObjectsV2）——孤儿对象清扫的数据来源。
 * 覆盖点：请求入参语义（字面前缀/分页/上限收敛）、返回值净化（目录占位对象、缺失时间）、
 * 以及"协议异常时不空转翻页"这条防呆。
 */
describe('StorageS3Adapter list（M12-P5 对象枚举）', () => {
  const inputOf = (call: number) => (h.send.mock.calls[call][0] as { input: Record<string, unknown> }).input;

  it('默认入参：只带 Bucket + MaxKeys（不传 Prefix/ContinuationToken），解析 Contents', async () => {
    const adapter = new StorageS3Adapter({ ...CONFIG });
    h.send.mockResolvedValueOnce({
      Contents: [{ Key: 'u/2026/01/a.png', Size: 12, LastModified: new Date('2026-01-02T03:04:05Z') }],
      IsTruncated: false,
    });

    const page = await adapter.list();

    expect(inputOf(0)).toEqual({ Bucket: 'agent-storage', MaxKeys: 1_000 });
    expect(page.objects).toEqual([{ key: 'u/2026/01/a.png', sizeBytes: 12, lastModified: new Date('2026-01-02T03:04:05Z') }]);
    expect(page.nextCursor).toBeNull();
  });

  it('前缀是字面前缀（原样传给 Prefix，不做目录推断）+ 续页游标原样传给 ContinuationToken', async () => {
    const adapter = new StorageS3Adapter({ ...CONFIG });
    h.send.mockResolvedValueOnce({ Contents: [], IsTruncated: false });

    await adapter.list({ prefix: 'u1/2026', limit: 25, cursor: 'tok-abc' });

    // 关键：`u1/2026` 不补 `/`（补了就会漏掉对象），与本地驱动同一语义
    expect(inputOf(0)).toEqual({ Bucket: 'agent-storage', Prefix: 'u1/2026', MaxKeys: 25, ContinuationToken: 'tok-abc' });
  });

  it('IsTruncated=true + 有 token ⇒ nextCursor=token（可续页）；空串 token ⇒ null（绝不空转）', async () => {
    const adapter = new StorageS3Adapter({ ...CONFIG });
    h.send
      .mockResolvedValueOnce({ Contents: [{ Key: 'a', Size: 1, LastModified: new Date(1) }], IsTruncated: true, NextContinuationToken: 'tok-2' })
      .mockResolvedValueOnce({ Contents: [], IsTruncated: true, NextContinuationToken: '' });

    await expect(adapter.list()).resolves.toMatchObject({ nextCursor: 'tok-2' });
    // IsTruncated 与 token 自相矛盾（协议异常）：如实结束本页，调用方据此停手
    await expect(adapter.list()).resolves.toMatchObject({ nextCursor: null });
  });

  it('返回值净化：目录占位对象（Key 以 / 结尾）与无 Key 条目被过滤；Size/LastModified 缺失不猜测', async () => {
    const adapter = new StorageS3Adapter({ ...CONFIG });
    h.send.mockResolvedValueOnce({
      Contents: [
        { Key: 'dir/', Size: 0, LastModified: new Date(1) },
        { Size: 9 },
        { Key: 'real.bin' },                                  // Size/LastModified 均缺失
        { Key: 'odd.bin', Size: Number.NaN, LastModified: '2026-01-01' }, // 类型不对
      ],
      IsTruncated: false,
    });

    const page = await adapter.list();

    expect(page.objects.map((o) => o.key)).toEqual(['real.bin', 'odd.bin']);
    // 拿不到就是 null（"年龄未知"），绝不猜成 0 字节 / 1970 年
    expect(page.objects[0]).toEqual({ key: 'real.bin', sizeBytes: 0, lastModified: null });
    expect(page.objects[1]).toEqual({ key: 'odd.bin', sizeBytes: 0, lastModified: null });
  });

  it('limit 收敛到协议上限 1000（调用方传 Infinity / 超大值不得打穿 MaxKeys）', async () => {
    const adapter = new StorageS3Adapter({ ...CONFIG });
    h.send.mockResolvedValue({ Contents: [], IsTruncated: false });
    await adapter.list({ limit: 5_000 });
    expect(inputOf(0)).toMatchObject({ MaxKeys: S3_MAX_KEYS });
    await adapter.list({ limit: Number.POSITIVE_INFINITY });
    expect(inputOf(1)).toMatchObject({ MaxKeys: S3_MAX_KEYS });
    await adapter.list({ limit: 0 }); // 非法值 → 回退默认，不落 MaxKeys=0（S3 会当成默认 1000，语义漂移）
    expect(inputOf(2)).toMatchObject({ MaxKeys: 1_000 });
  });

  it('有界性：list 同样走 abort 兜底（存储端点半开时不会永久挂住清扫任务）', async () => {
    vi.useFakeTimers();
    const adapter = new StorageS3Adapter({ ...CONFIG, requestTimeoutMs: 30 });
    h.send.mockImplementation((_cmd: unknown, options?: { abortSignal?: AbortSignal }) => new Promise((_resolve, reject) => {
      options?.abortSignal?.addEventListener('abort', () => reject(new Error('Request aborted')));
    }));

    const pending = adapter.list();
    const assertion = expect(pending).rejects.toBeInstanceOf(StorageTimeoutError);
    await vi.advanceTimersByTimeAsync(30 + S3_ABORT_SLACK_MS + 1);
    await assertion;
    await expect(pending).rejects.toMatchObject({ code: 'STORAGE_TIMEOUT', label: 's3:list' });
  });
});
