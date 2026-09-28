import { Inject, Injectable, Logger, OnApplicationShutdown, OnModuleInit } from '@nestjs/common';
import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { hostname } from 'node:os';
import { randomBytes } from 'node:crypto';
import { EVALUATION_QUEUE } from '../../core/queue/queue.module';
import { EvaluationRunnerService } from '../../modules/evaluation/runner/evaluation-runner.service';
import { EVALUATION_RUN_CANCEL_CHANNEL } from '../../modules/evaluation/evaluation-runs.service';
import { EventBusService } from '../../core/events/event-bus.service';
import { ObservabilityService } from '../../core/tracing/observability.service';
import { ShutdownStep } from '../../lifecycle/lifecycle-registry';

/**
 * M9-P1 评测 Worker（payload 仅 {runId}——身份/参数一律由 DB 快照裁决）。
 *
 * 与既有 processor 同构：
 * - 幂等由 runner 的条件更新保证（run: pending→running 唯一 claim；caseRun: pending→running；结果行唯一键 upsert），
 *   重复投递/重复消费绝不多跑 case、绝不多写结果；
 * - 取消：EventBus 提示（快速通道，立即 abort 在途 case）+ runner 每 case 复查 DB 状态（事实兜底）；
 * - 优雅停机：finalizeLeases 阶段 abort 在途执行（已完成 case 的事实保留，run 状态由 DB 裁决）。
 */
@Processor(EVALUATION_QUEUE, { concurrency: Number(process.env.EVALUATION_WORKER_CONCURRENCY ?? 2) })
@Injectable()
export class EvaluationProcessor extends WorkerHost implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger('EvaluationWorker');
  private readonly instanceId = `${hostname()}:${process.pid}:${randomBytes(4).toString('hex')}`;
  private active: { runId: string; abort: AbortController } | null = null;

  constructor(
    @Inject(EvaluationRunnerService) private readonly runner: EvaluationRunnerService,
    @Inject(EventBusService) private readonly events: EventBusService,
    @Inject(ObservabilityService) private readonly metrics: ObservabilityService,
  ) {
    super();
  }

  async onModuleInit(): Promise<void> {
    await this.events.subscribe(EVALUATION_RUN_CANCEL_CHANNEL, (event) => {
      const runId = event.runId as string | undefined;
      if (runId && this.active?.runId === runId) {
        this.logger.warn({ runId }, '收到 cancel 提示（快速通道）→ 中止在途评测');
        this.active.abort.abort();
      }
    });
  }

  async process(job: Job<{ runId?: string }>): Promise<void> {
    const runId = job.data?.runId;
    if (!runId) return; // 非法 payload → 直接完成（绝不猜测）
    const abort = new AbortController();
    this.active = { runId, abort };
    const startedAtMs = Date.now();
    try {
      const outcome = await this.runner.executeRun(runId, abort.signal);
      this.logger.log({ ...outcome, workerId: this.instanceId }, '评测 run 处理完成');
    } finally {
      this.active = null;
      // 观测面（best-effort；独立指标名——绝不混入 agent_run/workflow 指标）
      await this.metrics.recordMetric(
        'evaluation_run_duration_ms',
        Date.now() - startedAtMs,
        'ms',
        { runId, workerId: this.instanceId },
      ).catch(() => undefined);
    }
  }

  async onApplicationShutdown(): Promise<void> {
    this.active?.abort.abort();
  }

  /** Pre-M9 G3：有序停机阶段接线（finalizeLeases → 中止在途执行；幂等） */
  async onLifecycleStep(step: ShutdownStep): Promise<void> {
    if (step === 'finalizeLeases') await this.onApplicationShutdown();
  }
}
