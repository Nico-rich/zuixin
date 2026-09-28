import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit, Optional } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import Redis from 'ioredis';
import { PrismaService } from '../prisma/prisma.service';
import { AGENT_RUN_QUEUE } from '../../core/queue/queue.module';
import {
  DEFAULT_PROBE_TIMEOUT_MS, ProbeResult, DependencyState, probeDb, probeRedis,
  probeLocalStorage, probeS3Storage, probeTimeoutMs, withTimeout,
} from './health-probes';

export interface QueueReport {
  state: DependencyState;
  waiting: number; active: number; delayed: number; failed: number;
  /** 积压深度 = waiting + active（与 backpressure 判定同一口径） */
  depth: number;
  /** 告警水位（只观测；拒绝由 QuotaService.assertQueueDepth 在创建入口裁决） */
  maxDepth: number;
  detail?: string;
}

export interface HealthCheckEntry {
  name: string;
  /** critical=true 的依赖 down ⇒ /ready 503；false ⇒ 只影响报告字段 */
  critical: boolean;
  state: DependencyState;
  latencyMs: number;
  detail?: string;
}

export interface HealthReport {
  status: 'ok' | 'degraded' | 'unavailable';
  ready: boolean;
  db: ProbeResult;
  redis: ProbeResult;
  /** 非关键依赖（MinIO/本地盘）：故障只影响本字段，绝不 503 */
  storage: ProbeResult & { driver: string };
  queue: QueueReport;
  checks: HealthCheckEntry[];
  uptimeMs: number;
  timestamp: string;
}

export const DEFAULT_QUEUE_MAX_DEPTH = 1_000;

/**
 * 建 Redis 探针客户端（**HealthService 与回归测试共用同一工厂**，防止两者漂移）。
 *
 * `enableOfflineQueue: true`（ioredis 默认）是必须的：`lazyConnect` + 冷启动/重连窗口里
 * stream 尚未 writable，若关掉离线队列，首个 ping 会**立即** reject → 探针在实例刚起来时
 * 误报 Redis down → /ready 503 → 负载均衡把健康实例摘掉（假故障比慢 200ms 危害大得多）。
 * 让命令排队，连上后立即冲刷即可拿到真实结论。
 *
 * 失败仍然有界：`maxRetriesPerRequest: 1` + `retryStrategy` 上限 2s + 调用方 1s 硬超时，
 * 因此真断线时 ping 会在超时窗口内失败，不会挂住 health 请求。
 */
export function createRedisProbeClient(url: string, timeoutMs = DEFAULT_PROBE_TIMEOUT_MS): Redis {
  return new Redis(url, {
    lazyConnect: true,
    connectTimeout: timeoutMs,
    maxRetriesPerRequest: 1,
    enableOfflineQueue: true,
    retryStrategy: (times) => Math.min(200 * times, 2_000),
  });
}

function envDepth(): number {
  const n = Number(process.env.AGENT_RUN_QUEUE_MAX_DEPTH);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_QUEUE_MAX_DEPTH;
}

/**
 * M8-P9 Health 服务（分级依赖探测）：
 *
 * 语义分级（**这是 /ready 与 /live 的本质区别**）：
 * - critical（DB / Redis）任一 down ⇒ `/ready` 503 + status='unavailable'——服务无法正确工作，
 *   负载均衡必须摘流量；
 * - non-critical（对象存储）down ⇒ status='degraded'，`/ready` 仍 200——生成类能力受损但
 *   对话/查询等核心路径可用，摘掉整个实例反而放大故障；
 * - `/live` 不做任何依赖探测（恒定 200）——liveness 只回答"进程是否活着"，
 *   绝不因依赖抖动触发编排层重启（重启治不好下游故障，只会雪崩）。
 *
 * 每个探测都有 1s 硬超时（HEALTH_PROBE_TIMEOUT_MS 可覆盖）⇒ health 请求耗时上界 ≈ 3×timeout，
 * 绝不因依赖挂起而拖垮探针。
 */
@Injectable()
export class HealthService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger('Health');

  /** 独立 Redis 探针连接：与 BullMQ 主连接隔离（主连接 maxRetriesPerRequest=null 会无限重试，
   *  探针必须能快速失败）——配置见 createRedisProbeClient */
  private redisProbe: Redis | null = null;

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Optional() @InjectQueue(AGENT_RUN_QUEUE) private readonly agentRunQueue?: Queue,
  ) {}

  onModuleInit(): void {
    this.ensureRedisProbe().connect().catch(() => undefined); // 预连接（失败仅记录，绝不影响启动）
  }

  onModuleDestroy(): void {
    this.redisProbe?.disconnect();
    this.redisProbe = null;
  }

  /** 注入替身（单测用；生产不调用） */
  setRedisProbeForTesting(client: Redis | null): void {
    this.redisProbe = client;
  }

  private ensureRedisProbe(): Redis {
    if (!this.redisProbe) {
      const url = process.env.REDIS_URL ?? 'redis://localhost:6379';
      this.redisProbe = createRedisProbeClient(url, probeTimeoutMs());
      // ioredis 的 'error' 事件无监听者时会抛出未捕获异常；探针只记录不抛出
      this.redisProbe.on('error', (err: Error) => this.logger.debug(`Redis 探针连接错误: ${err.message}`));
    }
    return this.redisProbe;
  }

  /** liveness：常量返回，**不触发任何 I/O**（本方法体内不允许出现 await/探测调用） */
  live(): { status: 'ok'; uptimeMs: number; timestamp: string } {
    return { status: 'ok', uptimeMs: Math.round(process.uptime() * 1000), timestamp: new Date().toISOString() };
  }

  /**
   * 三个依赖探测（可覆写点：单测注入不可达结果——**不真停共享基础设施**）。
   * 三个探测并行 ⇒ 总耗时 ≈ max(单项) 而非 sum，且每项都有硬超时。
   */
  protected async runProbes(timeoutMs: number): Promise<{ db: ProbeResult; redis: ProbeResult; storage: ProbeResult }> {
    const [db, redis, storage] = await Promise.all([
      probeDb(this.prisma, timeoutMs),
      probeRedis(this.ensureRedisProbe(), timeoutMs),
      this.probeStorage(timeoutMs),
    ]);
    return { db, redis, storage };
  }

  /** 完整探测（db + redis + storage + queue 计数）——/health 与 /ready 共用 */
  async check(): Promise<HealthReport> {
    const timeoutMs = probeTimeoutMs();
    const { db, redis, storage } = await this.runProbes(timeoutMs);
    const queue = await this.probeQueue(timeoutMs, redis.state === 'up');

    const checks: HealthCheckEntry[] = [
      { name: 'db', critical: true, ...db },
      { name: 'redis', critical: true, ...redis },
      { name: 'storage', critical: false, ...storage },
    ];
    return {
      status: evaluateStatus(db, redis, storage.state),
      ready: isReady(db, redis),
      db, redis,
      storage: { ...storage, driver: process.env.STORAGE_DRIVER ?? 'local' },
      queue,
      checks,
      uptimeMs: Math.round(process.uptime() * 1000),
      timestamp: new Date().toISOString(),
    };
  }

  /** 就绪判定（只含 critical 依赖）：DB + Redis 全 up ⇒ ready */
  async readiness(): Promise<HealthReport> {
    return this.check();
  }

  protected probeStorage(timeoutMs: number): Promise<ProbeResult> {
    const driver = process.env.STORAGE_DRIVER ?? 'local';
    // M10 集成：A7 扩展 s3/minio 别名——健康面驱动标识对齐（resolveStorageDriver 同源口径）
    if (driver === 's3-compatible' || driver === 's3' || driver === 'minio') {
      return probeS3Storage({
        endpoint: process.env.STORAGE_ENDPOINT ?? '',
        region: process.env.STORAGE_REGION ?? 'us-east-1',
        bucket: process.env.STORAGE_BUCKET ?? 'agent-storage',
        accessKeyId: process.env.STORAGE_ACCESS_KEY_ID ?? '',
        secretAccessKey: process.env.STORAGE_SECRET_ACCESS_KEY ?? '',
        forcePathStyle: true,
      }, timeoutMs);
    }
    return probeLocalStorage(process.env.STORAGE_LOCAL_DIR ?? './data/storage', timeoutMs);
  }

  /** 队列计数（Redis 已 down 时不再打第二次网络，直接复用 redis 探测结论） */
  private async probeQueue(timeoutMs: number, redisUp: boolean): Promise<QueueReport> {
    const maxDepth = envDepth();
    const base: QueueReport = { state: 'down', waiting: 0, active: 0, delayed: 0, failed: 0, depth: 0, maxDepth };
    if (!redisUp) return { ...base, detail: 'Redis 不可达' }; // 根因优先：Redis 挂了不必再问队列
    if (!this.agentRunQueue) return { ...base, detail: 'agent-run 队列未注册（降级：不影响 readiness）' };
    try {
      const counts = await withTimeout(
        this.agentRunQueue.getJobCounts('waiting', 'active', 'delayed', 'failed'),
        timeoutMs,
        'queue',
      );
      const waiting = counts.waiting ?? 0;
      const active = counts.active ?? 0;
      return {
        state: 'up',
        waiting, active,
        delayed: counts.delayed ?? 0,
        failed: counts.failed ?? 0,
        depth: waiting + active,
        maxDepth,
      };
    } catch (err) {
      return { ...base, detail: (err as Error).message.slice(0, 200) };
    }
  }
}

/** 纯函数：critical 依赖决定 readiness（单测覆盖全分支，无需真实停依赖） */
export function isReady(db: ProbeResult, redis: ProbeResult): boolean {
  return db.state === 'up' && redis.state === 'up';
}

/** 纯函数：报告态（unavailable = critical 挂；degraded = 仅非关键依赖挂） */
export function evaluateStatus(db: ProbeResult, redis: ProbeResult, storageState: DependencyState): HealthReport['status'] {
  if (!isReady(db, redis)) return 'unavailable';
  return storageState === 'up' ? 'ok' : 'degraded';
}

export { DEFAULT_PROBE_TIMEOUT_MS };
