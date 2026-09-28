import { Inject, Injectable, Logger, OnApplicationShutdown, OnModuleInit } from '@nestjs/common';
import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { hostname } from 'node:os';
import { randomBytes } from 'node:crypto';
import { AGENT_RUN_QUEUE } from '../../core/queue/queue.module';
import { AgentRunLeaseService } from '../../core/agent-run-lease/agent-run-lease.service';
import { EventBusService } from '../../core/events/event-bus.service';
import { AGENT_RUN_CANCEL_CHANNEL } from '../../modules/agent-runs/agent-runs.service';
import { ObservabilityService } from '../../core/tracing/observability.service';
import { TraceContext, newTraceId } from '../../core/tracing/trace-context';
import { AsyncAgentRunDriver } from './async-agent-run.driver';
import { ShutdownStep } from '../../lifecycle/lifecycle-registry';

/**
 * M6-P3 AgentRun Worker：
 * job {runId} → DB 加载（身份唯一事实来源）→ 原子 claim（split-brain 防线，失败即退出）
 * → heartbeat（续期 fencing + 取消检测）→ Async Driver → Engine → release。
 * 优雅停机：controls.active=false（Engine 跳过终态写入）+ release lease + abort + job 抛错回退重试。
 */
@Processor(AGENT_RUN_QUEUE, { concurrency: Number(process.env.AGENT_RUN_WORKER_CONCURRENCY ?? 2) })
@Injectable()
export class AgentRunProcessor extends WorkerHost implements OnApplicationShutdown, OnModuleInit {
  private readonly logger = new Logger('AgentRunWorker');
  private readonly instanceId = `${hostname()}:${process.pid}:${randomBytes(4).toString('hex')}`;
  private active: { abort: AbortController; controls: { active: boolean }; runId: string; workerId: string } | null = null;

  constructor(
    @Inject(AgentRunLeaseService) private readonly lease: AgentRunLeaseService,
    @Inject(AsyncAgentRunDriver) private readonly driver: AsyncAgentRunDriver,
    @Inject(EventBusService) private readonly events: EventBusService,
    @Inject(ObservabilityService) private readonly metrics: ObservabilityService, // M8-P3 指标采样（只读观测面）
  ) {
    super();
  }

  /** M6-P5 cancel 快速通道：Redis 提示 → 立即 abort 本地 Engine（DB 条件更新与心跳 15s 仍是事实兜底） */
  async onModuleInit(): Promise<void> {
    await this.events.subscribe(AGENT_RUN_CANCEL_CHANNEL, (event) => {
      const runId = event.runId as string | undefined;
      if (runId && this.active?.runId === runId) {
        this.logger.warn({ runId }, '收到 cancel 提示（快速通道）→ abort Engine');
        this.active.abort.abort();
      }
    });
  }

  async process(job: Job<{ runId?: string }>): Promise<void> {
    const runId = job.data?.runId;
    if (!runId) return; // 非法 payload → 直接完成（不执行任何 Runtime）
    const workerId = this.instanceId;

    // 原子 claim：queued 首次执行 / stale lease 接管；失败 = 重复 job 或他 worker 持有 → 静默退出（DB lease 是最终防线）
    const claimed = await this.lease.claim(runId, workerId, await this.lease.leaseTtlMs());
    if (!claimed.acquired) {
      this.logger.warn({ runId, claimStatus: claimed.status, owner: claimed.workerId }, 'claim 失败，跳过执行（重复 job / 已终态 / 他 worker 持有）');
      return;
    }

    const abort = new AbortController();
    const controls = { active: true };
    this.active = { abort, controls, runId, workerId };
    const intervalMs = await this.lease.heartbeatIntervalMs();
    const heartbeat = setInterval(() => void this.heartbeatTick(runId, workerId, abort), intervalMs);
    this.logger.log({ runId, workerId }, 'claim 成功，开始执行');
    const startedAtMs = Date.now(); // M8-P3：时长采样起点（仅观测，不参与任何业务判定）
    try {
      // M8-P3：run 作用域内建立 TraceContext（run 内产生的审计自动带 runId/traceId；控制流不变）
      await TraceContext.runWithContext({ runId, traceId: newTraceId() }, () => this.driver.execute(runId, abort.signal, controls));
    } finally {
      clearInterval(heartbeat);
      this.active = null;
      // M8-P3：run 时长采样（best-effort——ObservabilityService 内部吞异常，绝不影响 lease/重试语义）
      await this.metrics.recordRunDuration('agent_run', runId, Date.now() - startedAtMs, {
        workerId, outcome: controls.active ? 'finished' : 'shutdown',
      });
      if (!controls.active) {
        // 优雅停机：放弃本次执行（已 release lease + Engine 未写终态）→ job 失败退回，BullMQ attempts 重试（新 worker resume）
        throw new Error('worker shutdown：放弃当前 job，交由重试/恢复接管');
      }
    }
  }

  /** 心跳 tick：① 外部状态变化（cancel/recovery 终态）→ abort Engine；② 续期 count=0（被接管）→ 立即停止，不再写任何状态 */
  private async heartbeatTick(runId: string, workerId: string, abort: AbortController): Promise<void> {
    try {
      const row = await this.lease.getStatus(runId);
      if (!row || row.status !== 'running') {
        this.logger.warn({ runId, status: row?.status }, 'run 已非 running（外部取消/恢复终态）→ 停止 Engine');
        abort.abort();
        return;
      }
      const renewed = await this.lease.renew(runId, workerId, await this.lease.leaseTtlMs());
      if (renewed.count === 0) {
        this.logger.warn({ runId, workerId }, 'lease 续期失败（已被接管/fencing）→ 立即停止 Engine');
        abort.abort();
      }
    } catch (err) {
      this.logger.warn({ runId }, `心跳异常: ${(err as Error).message}`);
    }
  }

  async onApplicationShutdown(): Promise<void> {
    const a = this.active;
    if (!a) return;
    a.controls.active = false; // Engine 跳过终态写入（不伪造 cancelled/failed）
    await this.lease.release(a.runId, a.workerId).catch(() => undefined); // 释放 → 新 worker 立即可接管
    a.abort.abort();
    this.logger.log({ runId: a.runId }, '优雅停机：已释放 lease 并中止当前执行');
  }

  /** Pre-M9 G3：有序停机阶段接线（finalizeLeases = 释放 lease + 中止在途执行；幂等，Nest 钩子会再调一次为 no-op） */
  async onLifecycleStep(step: ShutdownStep): Promise<void> {
    if (step === 'finalizeLeases') await this.onApplicationShutdown();
  }
}
