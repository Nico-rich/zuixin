import { Inject, Injectable, Logger, OnApplicationShutdown, OnModuleInit } from '@nestjs/common';
import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { hostname } from 'node:os';
import { randomBytes } from 'node:crypto';
import { WORKFLOW_QUEUE } from '../../core/queue/queue.module';
import { WorkflowLeaseService } from './workflow-lease.service';
import { WorkflowWakeService } from './workflow-wake.service';
import { WorkflowExecutor } from '../../modules/workflows/workflow-executor.service';
import { WorkflowTriggersService } from '../../modules/workflows/workflow-triggers.service';
import { EventBusService } from '../../core/events/event-bus.service';
import { PrismaService } from '../../modules/prisma/prisma.service';
import { WORKFLOW_CANCEL_CHANNEL } from '../../core/events/workflow-channels';
import { ObservabilityService } from '../../core/tracing/observability.service';
import { TraceContext, newTraceId } from '../../core/tracing/trace-context';
import { ShutdownStep } from '../../lifecycle/lifecycle-registry';

export { WORKFLOW_CANCEL_CHANNEL };

/**
 * M7-P6 Workflow Worker（复用 M6 原语集：claim → heartbeat → executor → release）：
 * job {runId} 执行工作流；{kind:'scheduled', workflowId} 由调度任务消费（创建 run 后入队 execute）。
 * 优雅停机：release + abort（Pre-M9 D5 起持有独立 AbortController 并下传执行器，参见 heartbeatTick）。
 *
 * Pre-M9 D5：**lease 续期失败（count=0 = 已被接管/fencing）或 run 已非 running → 立即 abort 当前执行**，
 * 与 agent run lease 语义对齐：中止在途步骤调用 + 停止步骤循环 + 不写任何状态（终态写入本就有 workerId fencing）。
 * 原实现只 warn 不停止 → 分叉 worker 会继续跑完后续步骤（agent 步骤重复创建子 run / external_action 重复执行 = 双写）。
 */
@Processor(WORKFLOW_QUEUE, { concurrency: Number(process.env.WORKFLOW_WORKER_CONCURRENCY ?? 2) })
@Injectable()
export class WorkflowProcessor extends WorkerHost implements OnApplicationShutdown, OnModuleInit {
  private readonly logger = new Logger('WorkflowWorker');
  private readonly instanceId = `${hostname()}:${process.pid}:${randomBytes(4).toString('hex')}`;
  private active: { runId: string; workerId: string; abort: AbortController } | null = null;

  constructor(
    @Inject(WorkflowLeaseService) private readonly lease: WorkflowLeaseService,
    @Inject(WorkflowExecutor) private readonly executor: WorkflowExecutor,
    @Inject(WorkflowWakeService) private readonly wake: WorkflowWakeService,
    @Inject(WorkflowTriggersService) private readonly triggers: WorkflowTriggersService,
    @Inject(EventBusService) private readonly events: EventBusService,
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(ObservabilityService) private readonly metrics: ObservabilityService, // M8-P3 指标采样（只读观测面）
  ) {
    super();
  }

  async onModuleInit(): Promise<void> {
    await this.events.subscribe(WORKFLOW_CANCEL_CHANNEL, (event) => {
      const runId = event.runId as string | undefined;
      if (runId && this.active?.runId === runId) {
        this.logger.warn({ runId }, '收到 cancel 提示（快速通道）');
      }
    });
  }

  async process(job: Job<{ runId?: string; kind?: string; workflowId?: string }>): Promise<void> {
    // 调度触发（repeatable job）：创建 run 后转 execute（幂等键 = 时间桶）
    if (job.data?.kind === 'scheduled' && job.data.workflowId) {
      await this.triggers.tickScheduled(job.data.workflowId);
      return;
    }
    const runId = job.data?.runId;
    if (!runId) return; // 非法 payload → 直接完成

    const workerId = this.instanceId;
    const claimed = await this.lease.claim(runId, workerId, 60_000);
    if (!claimed.acquired) {
      this.logger.warn({ runId, claimStatus: claimed.status }, 'claim 失败，跳过执行');
      return;
    }
    const abort = new AbortController();
    this.active = { runId, workerId, abort };
    const heartbeat = setInterval(() => void this.heartbeatTick(runId, workerId, abort), 15_000);
    this.logger.log({ runId, workerId }, 'workflow claim 成功，开始执行');
    const startedAtMs = Date.now(); // M8-P3：时长采样起点（仅观测，不参与任何业务判定）
    const traceId = newTraceId(); // M8-P3：本次 workflow run 的追踪 ID（步内审计同源）
    try {
      for (let i = 0; i < 200; i++) { // 步数上限兜底（definition 校验已限，此处防环）
        // Pre-M9 D5：lease 续期失败/外部终态（分叉 worker）→ 立即停止，绝不再进入下一步、绝不写任何状态
        if (abort.signal.aborted) {
          this.logger.warn({ runId, step: i }, 'workflow 已被 fencing/中止 → 停止执行循环（不写任何状态）');
          return;
        }
        // 只置 workflowRunId（此处 runId 语义是 workflow run id——绝不冒充 agentRunId）
        const result = await TraceContext.runWithContext(
          { workflowRunId: runId, traceId },
          () => this.executor.execute(runId, workerId, abort.signal),
        );
        if (abort.signal.aborted) return; // 步骤内被中止（在途调用已 abort）→ 结果不可信，直接退出
        if (result.outcome === 'waiting') {
          // 观察子 AgentRun 实时终态（审批唤醒由全局订阅承担；两类都有 recoverStale 兜底）
          const row = await this.prisma.workflowRun.findUnique({
            where: { id: runId }, select: { waitingOnAgentRunId: true },
          });
          if (row?.waitingOnAgentRunId) await this.wake.watchChildRun(row.waitingOnAgentRunId);
          return;
        }
        if (result.outcome === 'done') return;
      }
      this.logger.warn({ runId }, 'workflow 步数超过上限（环检测兜底）');
    } finally {
      clearInterval(heartbeat);
      this.active = null;
      // M8-P3：workflow 时长采样（best-effort——绝不影响 lease/步进语义）
      await this.metrics.recordRunDuration('workflow_run', runId, Date.now() - startedAtMs, { workerId });
    }
  }

  /**
   * 心跳 tick（Pre-M9 D5：与 agent run lease 语义对齐）：
   * ① 已非 running（外部取消/恢复终态）→ abort 当前执行；
   * ② **续期 count=0（已被接管/fencing）→ 立即 abort 当前执行**——原实现只 warn 不停止，
   *    分叉 worker 会继续执行后续步骤（重复的 agent 步骤/外部动作 = 双写风险）。
   */
  private async heartbeatTick(runId: string, workerId: string, abort: AbortController): Promise<void> {
    try {
      const row = await this.lease.getStatus(runId);
      if (!row || row.status !== 'running') {
        this.logger.warn({ runId, status: row?.status }, 'workflow 已非 running（外部取消/恢复终态）→ 立即中止当前执行');
        abort.abort();
        return;
      }
      const renewed = await this.lease.renew(runId, workerId, 60_000);
      if (renewed.count === 0) {
        this.logger.warn({ runId, workerId }, 'workflow lease 续期失败（已被接管/fencing）→ 立即中止当前执行');
        abort.abort();
      }
    } catch (err) {
      this.logger.warn({ runId }, `心跳异常: ${(err as Error).message}`);
    }
  }

  async onApplicationShutdown(): Promise<void> {
    const a = this.active;
    if (!a) return;
    await this.lease.release(a.runId, a.workerId).catch(() => undefined);
    a.abort.abort(); // G3/D5：释放后立即中止在途执行（步骤级调用收到 abort，绝不再写状态）
    this.logger.log({ runId: a.runId }, '优雅停机：已释放 workflow lease 并中止当前执行');
  }

  /** Pre-M9 G3：有序停机阶段接线（finalizeLeases；幂等——Nest 钩子会再调一次为 no-op） */
  async onLifecycleStep(step: ShutdownStep): Promise<void> {
    if (step === 'finalizeLeases') await this.onApplicationShutdown();
  }
}
