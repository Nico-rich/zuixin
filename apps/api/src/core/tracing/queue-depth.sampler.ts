import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Queue } from 'bullmq';
import { ObservabilityService } from './observability.service';

/** 采样队列（与 QueueModule 注册名一致；media-cleanup 为内部维护队列，不入观测面） */
export const SAMPLED_QUEUES = ['image', 'video', 'agent-run', 'workflow'] as const;

const DEFAULT_INTERVAL_MS = 60_000;

/**
 * M8-P3 队列深度采样（Worker 进程独有；API 进程不启动）：
 * 每 60s 用 Queue.getJobCounts 采样一次（启动即先采一次，运维/测试无需等待首个周期）。
 * depth = waiting + active + delayed（积压：待执行 + 执行中 + 延迟/重试中）。
 * 采样失败仅 warn（Redis 抖动绝不拖垮 Worker）；onModuleDestroy 清定时器并关闭探针连接。
 */
@Injectable()
export class QueueDepthSampler implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger('QueueDepthSampler');
  private readonly queues = new Map<string, Queue>();
  private timer: NodeJS.Timeout | null = null;

  constructor(@Inject(ObservabilityService) private readonly metrics: ObservabilityService) {}

  async onModuleInit(): Promise<void> {
    await this.sample();
    const intervalMs = Number(process.env.QUEUE_DEPTH_INTERVAL_MS ?? DEFAULT_INTERVAL_MS);
    this.timer = setInterval(() => void this.sample(), Number.isFinite(intervalMs) && intervalMs > 0 ? intervalMs : DEFAULT_INTERVAL_MS);
    this.timer.unref?.(); // 不因探针定时器阻止进程退出（BullMQ 消费者自身维持进程存活）
  }

  /** 采样一轮（四个队列各一条样本；单个队列失败不影响其余） */
  async sample(): Promise<void> {
    for (const name of SAMPLED_QUEUES) {
      try {
        const counts = await this.queue(name).getJobCounts('waiting', 'active', 'delayed');
        const depth = (counts.waiting ?? 0) + (counts.active ?? 0) + (counts.delayed ?? 0);
        await this.metrics.recordMetric('queue_depth', depth, 'count', { queue: name });
      } catch (err) {
        this.logger.warn(`队列深度采样失败 queue=${name}: ${(err as Error).message}`);
      }
    }
  }

  private queue(name: string): Queue {
    let q = this.queues.get(name);
    if (!q) {
      q = new Queue(name, { connection: { url: process.env.REDIS_URL ?? 'redis://localhost:6379', maxRetriesPerRequest: null } });
      this.queues.set(name, q);
    }
    return q;
  }

  async onModuleDestroy(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    for (const q of this.queues.values()) await q.close().catch(() => undefined);
    this.queues.clear();
  }
}
