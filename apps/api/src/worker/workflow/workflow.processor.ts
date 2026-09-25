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

export { WORKFLOW_CANCEL_CHANNEL };

/**
 * M7-P6 Workflow Worker（复用 M6 原语集：claim → heartbeat → executor → release）：
 * job {runId} 执行工作流；{kind:'scheduled', workflowId} 由调度任务消费（创建 run 后入队 execute）。
 * 优雅停机：controls.active=false + release + abort（执行上下文无独立 AbortSignal——workflow 步骤均为有界调用）。
 */
@Processor(WORKFLOW_QUEUE, { concurrency: Number(process.env.WORKFLOW_WORKER_CONCURRENCY ?? 2) })
@Injectable()
export class WorkflowProcessor extends WorkerHost implements OnApplicationShutdown, OnModuleInit {
  private readonly logger = new Logger('WorkflowWorker');
  private readonly instanceId = `${hostname()}:${process.pid}:${randomBytes(4).toString('hex')}`;
  private active: { runId: string; workerId: string } | null = null;

  constructor(
    @Inject(WorkflowLeaseService) private readonly lease: WorkflowLeaseService,
    @Inject(WorkflowExecutor) private readonly executor: WorkflowExecutor,
    @Inject(WorkflowWakeService) private readonly wake: WorkflowWakeService,
    @Inject(WorkflowTriggersService) private readonly triggers: WorkflowTriggersService,
    @Inject(EventBusService) private readonly events: EventBusService,
    @Inject(PrismaService) private readonly prisma: PrismaService,
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
    this.active = { runId, workerId };
    const heartbeat = setInterval(() => void this.heartbeatTick(runId, workerId), 15_000);
    this.logger.log({ runId, workerId }, 'workflow claim 成功，开始执行');
    try {
      for (let i = 0; i < 200; i++) { // 步数上限兜底（definition 校验已限，此处防环）
        const result = await this.executor.execute(runId, workerId);
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
    }
  }

  private async heartbeatTick(runId: string, workerId: string): Promise<void> {
    try {
      const row = await this.lease.getStatus(runId);
      if (!row || row.status !== 'running') {
        this.logger.warn({ runId, status: row?.status }, 'workflow 已非 running（外部取消/恢复终态）');
        return;
      }
      const renewed = await this.lease.renew(runId, workerId, 60_000);
      if (renewed.count === 0) {
        this.logger.warn({ runId, workerId }, 'workflow lease 续期失败（已被接管/fencing）');
      }
    } catch (err) {
      this.logger.warn({ runId }, `心跳异常: ${(err as Error).message}`);
    }
  }

  async onApplicationShutdown(): Promise<void> {
    const a = this.active;
    if (!a) return;
    await this.lease.release(a.runId, a.workerId).catch(() => undefined);
    this.logger.log({ runId: a.runId }, '优雅停机：已释放 workflow lease');
  }
}
