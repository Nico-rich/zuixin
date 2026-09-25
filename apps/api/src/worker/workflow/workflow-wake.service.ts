import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { PrismaService } from '../../modules/prisma/prisma.service';
import { WORKFLOW_QUEUE } from '../../core/queue/queue.module';
import { EventBusService, agentRunChannel } from '../../core/events/event-bus.service';
import { WORKFLOW_APPROVAL_DECIDED_CHANNEL } from '../../core/events/workflow-channels';

/**
 * M7-P6 Workflow 唤醒（waiting → queued + 唯一 jobId；与 M6 wakeWaitingRun 同构原语）：
 * - 审批决断：订阅全局通道（API 进程 decide 发布）→ 条件更新唤醒；recoverStale 兜底（事件丢失）；
 * - 子 AgentRun 终态：订阅 agent-run:{childRunId} 观察通道（驱动端 run.completed 等事件）→ 唤醒；
 *   兜底同样由 recoverStale 承担（at-least-once + 条件更新幂等，重复唤醒绝不重复执行）。
 */
@Injectable()
export class WorkflowWakeService implements OnModuleInit {
  private readonly logger = new Logger('WorkflowWake');

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @InjectQueue(WORKFLOW_QUEUE) private readonly workflowQueue: Queue,
    @Inject(EventBusService) private readonly events: EventBusService,
  ) {}

  async onModuleInit(): Promise<void> {
    // 审批决断 → 唤醒（API 进程 decide 发布，本订阅跨进程；recoverStale 兜底事件丢失）
    await this.events.subscribe(WORKFLOW_APPROVAL_DECIDED_CHANNEL, (event) => {
      void this.wakeByApproval(event.approvalId as string | undefined).catch(() => undefined);
    });
  }

  /** 审批决断唤醒（waiting+waitingOnApprovalId 条件更新；已终态/已唤醒 no-op——绝不复活） */
  async wakeByApproval(approvalId?: string): Promise<{ woken: boolean }> {
    if (!approvalId) return { woken: false };
    const target = await this.prisma.workflowRun.findFirst({
      where: { status: 'waiting', waitingOnApprovalId: approvalId }, select: { id: true },
    });
    if (!target) return { woken: false };
    const done = await this.prisma.workflowRun.updateMany({
      where: { id: target.id, status: 'waiting', waitingOnApprovalId: approvalId },
      data: { status: 'queued', waitingOnApprovalId: null, workerId: null, leaseUntil: null, heartbeatAt: null },
    });
    if (done.count === 0) return { woken: false };
    await this.enqueueWake(target.id);
    this.logger.log({ approvalId, runId: target.id }, '审批决断 → 唤醒 workflow run');
    return { woken: true };
  }

  /** 子 AgentRun 终态唤醒（等待该子 run 的 workflow run；条件更新去重，重复唤醒幂等） */
  async wakeByAgentRun(childRunId?: string): Promise<{ woken: boolean }> {
    if (!childRunId) return { woken: false };
    const target = await this.prisma.workflowRun.findFirst({
      where: { status: 'waiting', waitingOnAgentRunId: childRunId }, select: { id: true },
    });
    if (!target) return { woken: false };
    const done = await this.prisma.workflowRun.updateMany({
      where: { id: target.id, status: 'waiting', waitingOnAgentRunId: childRunId },
      data: { status: 'queued', waitingOnAgentRunId: null, workerId: null, leaseUntil: null, heartbeatAt: null },
    });
    if (done.count === 0) return { woken: false };
    await this.enqueueWake(target.id);
    this.logger.log({ childRunId, runId: target.id }, '子 AgentRun 终态 → 唤醒 workflow run');
    return { woken: true };
  }

  private enqueueWake(runId: string): Promise<void> {
    return this.workflowQueue.add(
      'execute', { runId },
      {
        // 唯一键：不得复用创建时的 jobId（BullMQ 同键去重吞 job——M6 教训）
        jobId: `wf-${runId}-wake-${Date.now()}`,
        attempts: 2, backoff: { type: 'exponential', delay: 2000 },
        removeOnComplete: true, removeOnFail: { count: 500 },
      },
    ).then(() => undefined);
  }

  /** 订阅特定子 AgentRun 的观察通道（processor 进入 waiting 时调用；driver 事件实时触发 wakeByAgentRun） */
  async watchChildRun(childRunId: string): Promise<void> {
    await this.events.subscribe(agentRunChannel(childRunId), (event) => {
      const type = event.type as string | undefined;
      if (type && ['run.completed', 'run.failed', 'run.cancelled', 'run.timeout'].includes(type)) {
        void this.wakeByAgentRun(childRunId).catch(() => undefined);
      }
    });
  }
}
