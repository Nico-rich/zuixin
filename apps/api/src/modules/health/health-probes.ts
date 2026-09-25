import { access, constants } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { HeadBucketCommand, S3Client } from '@aws-sdk/client-s3';

/**
 * M8-P9 依赖探测原语（纯函数 + 可注入依赖 ⇒ 单测可 mock 不可达，绝不真停共享基础设施）。
 *
 * 设计约束：
 * - **每个探测都有硬超时**（默认 1s）：依赖挂起时 health 端点必须仍然回答——绝不把
 *   "Kubernetes/负载均衡探针超时" 变成 "进程被误杀"；
 * - 探测绝不抛异常：失败一律折叠成 ProbeResult{state:'down'}，由调用方决定分级语义；
 * - 计时用 monotonic 的 performance.now()（与挂钟跳变无关）。
 */

export type DependencyState = 'up' | 'down';

export interface ProbeResult {
  /** up = 探测成功；down = 不可达/超时/报错 */
  state: DependencyState;
  /** 探测耗时（ms，保留 1 位小数） */
  latencyMs: number;
  /** 失败原因（截断 200 字符，绝不含凭证） */
  detail?: string;
}

export const DEFAULT_PROBE_TIMEOUT_MS = 1_000;

/** 超时读取（每次调用现读，便于运维/测试覆盖） */
export function probeTimeoutMs(): number {
  const n = Number(process.env.HEALTH_PROBE_TIMEOUT_MS);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_PROBE_TIMEOUT_MS;
}

/**
 * 给任意 promise 套硬超时（**不泄漏 unhandled rejection**：超时后原 promise 的 reject 已被吞掉）。
 * 超时 ≠ 取消：底层调用可能仍在进行，但调用方在 timeoutMs 内一定拿到结论。
 */
export function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error(`${label} 探测超时（>${ms}ms）`));
    }, ms);
    timer.unref?.();
    p.then(
      (v) => { if (settled) return; settled = true; clearTimeout(timer); resolve(v); },
      (e) => { if (settled) return; settled = true; clearTimeout(timer); reject(e); },
    );
  });
}

const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

function brief(err: unknown): string {
  const msg = err instanceof Error ? (err.message || err.name) : String(err);
  return msg.slice(0, 200);
}

/** 统一包装：计时 + 超时 + 异常折叠（所有探测共用，保证语义一致） */
async function runProbe(label: string, timeoutMs: number, fn: () => Promise<unknown>): Promise<ProbeResult> {
  const started = now();
  try {
    await withTimeout(Promise.resolve().then(fn), timeoutMs, label);
    return { state: 'up', latencyMs: round(now() - started) };
  } catch (err) {
    return { state: 'down', latencyMs: round(now() - started), detail: brief(err) };
  }
}

function round(n: number): number {
  return Math.round(n * 10) / 10;
}

// ===== DB =====

/** Prisma 最小面（避免探测模块依赖整个 PrismaService 类型，单测可直接塞 fake） */
export interface QueryRawCapable {
  $queryRaw(strings: TemplateStringsArray, ...values: unknown[]): Promise<unknown>;
}

/** DB 可达（SELECT 1；连接池/网络/认证任一失败 → down） */
export function probeDb(prisma: QueryRawCapable, timeoutMs = DEFAULT_PROBE_TIMEOUT_MS): Promise<ProbeResult> {
  return runProbe('db', timeoutMs, () => prisma.$queryRaw`SELECT 1`);
}

// ===== Redis =====

export interface RedisPingCapable {
  ping(): Promise<string>;
}

/** Redis 可达（PING → 期待 PONG） */
export function probeRedis(client: RedisPingCapable, timeoutMs = DEFAULT_PROBE_TIMEOUT_MS): Promise<ProbeResult> {
  return runProbe('redis', timeoutMs, async () => {
    const reply = await client.ping();
    if (String(reply).toUpperCase() !== 'PONG') throw new Error(`PING 返回异常：${String(reply).slice(0, 40)}`);
  });
}

// ===== 对象存储（非关键依赖：故障只影响报告字段，绝不 503） =====

/**
 * 本地磁盘驱动：探测"存储根目录可写"。
 *
 * **只读、不创建目录**：根目录尚未创建不是故障（StorageLocalAdapter.put 会 mkdirSync 自愈），
 * 因此向上回溯到最近一个已存在的祖先目录检查 W_OK——既避免探针产生副作用，
 * 又真实回答"将来能不能写进去"。整条祖先链都不可写才判 down。
 */
export function probeLocalStorage(rootDir: string, timeoutMs = DEFAULT_PROBE_TIMEOUT_MS): Promise<ProbeResult> {
  return runProbe('storage', timeoutMs, async () => {
    let dir = resolve(rootDir);
    for (let depth = 0; depth < 32; depth++) {
      try {
        await access(dir, constants.W_OK);
        return;
      } catch {
        const parent = dirname(dir);
        if (parent === dir) throw new Error(`存储路径及其祖先均不可写：${rootDir}`);
        dir = parent;
      }
    }
    throw new Error(`存储路径层级过深或不可写：${rootDir}`);
  });
}

export interface S3ProbeConfig {
  endpoint: string; region: string; bucket: string;
  accessKeyId: string; secretAccessKey: string; forcePathStyle: boolean;
}

/**
 * S3 兼容驱动（MinIO/R2/S3）：HeadBucket 真实往返（唯一能证明"桶可达+凭证有效"的探测）。
 * 只读、幂等、无副作用（绝不写探针对象）。
 */
export function probeS3Storage(cfg: S3ProbeConfig, timeoutMs = DEFAULT_PROBE_TIMEOUT_MS): Promise<ProbeResult> {
  return runProbe('storage', timeoutMs, async () => {
    const client = new S3Client({
      endpoint: cfg.endpoint, region: cfg.region, forcePathStyle: cfg.forcePathStyle,
      credentials: { accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey },
      requestHandler: { requestTimeout: timeoutMs, connectionTimeout: timeoutMs },
    });
    try {
      await client.send(new HeadBucketCommand({ Bucket: cfg.bucket }));
    } finally {
      client.destroy();
    }
  });
}
