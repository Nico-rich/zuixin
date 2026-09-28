import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { PrismaService } from '../../modules/prisma/prisma.service';
import { WORKFLOW_QUEUE } from '../../core/queue/queue.module';
import { addJobBestEffort } from '../../core/queue/bounded-add';
import { EventBusService, agentRunChannel } from '../../core/events/event-bus.service';
import { WORKFLOW_APPROVAL_DECIDED_CHANNEL } from '../../core/events/workflow-channels';
import { parseWaitingUntil } from '../../modules/workflows/workflow-wait.service';

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

  /**
   * M9-P4：wait 步骤（时间窗）的**延迟唤醒投递**——按剩余时长投递一次性延迟作业（唯一 jobId 含期限，
   * 同一期限重复调度天然去重；不同期限各自唯一——M6 教训：绝不复用创建时的 jobId）。
   * 作业 kind='wait-wake'：**到期与否的判定在作业消费时进行**（见 wakeByWaitDue），
   * 绝不"投递即唤醒"（提前前进会破坏 wait 语义）。主路径即此延迟作业；
   * 丢 job / 调度丢失由 `WorkflowLeaseService.recoverStale`（wait 到期分支 ⑥）兜底。
   */
  async scheduleWaitWake(runId: string, untilMs: number): Promise<boolean> {
    const delay = Math.max(0, untilMs - Date.now());
    const ok = await addJobBestEffort(this.workflowQueue,
      'execute', { runId, kind: 'wait-wake' },
      {
        jobId: `wf-${runId}-wait-${untilMs}`,
        delay,
        attempts: 2, backoff: { type: 'exponential', delay: 2000 },
        removeOnComplete: true, removeOnFail: { count: 500 },
      },
      `wait:${runId}`);
    this.logger.log({ runId, delay }, 'wait 步骤：已投递延迟唤醒');
    return ok;
  }

  /**
   * M9-P4：延迟唤醒作业消费时的**到期条件唤醒**（durable：判定完全依赖 DB 事实，不依赖作业携带的期限）。
   * - run 仍 `waiting` 且当前步骤是「已落库期限的时间窗 wait」且**已到期** → 条件更新 waiting→queued
   *   （与审批/子 run 唤醒同构；绝不复活终态、绝不与外部终态竞争），返回 true 供 processor 继续 claim 执行；
   * - **早到**（未到期）→ 重新武装同一 jobId 的延迟作业（去重，绝不提前前进），返回 false；
   * - 等待对象是审批/子 run（各自的唤醒路径负责）、run 已非 waiting → 返回 false（本次作业直接完成）；
   * - run 已是 queued（recoverStale/其他唤醒路径已置位）→ 返回 true（无状态可改，交给 claim 裁决）。
   */
  async wakeByWaitDue(runId: string): Promise<boolean> {
    const run = await this.prisma.workflowRun.findUnique({
      where: { id: runId }, select: { id: true, status: true, currentStep: true },
    });
    if (!run) return false;
    if (run.status === 'queued') return true; // 已被其他唤醒路径置为 queued：本次作业继续走 claim（幂等）
    if (run.status !== 'waiting') return false; // 终态/运行中：绝不复活、绝不重复接管
    const row = await this.prisma.workflowStepRun.findUnique({
      where: { workflowRunId_stepIndex: { workflowRunId: runId, stepIndex: run.currentStep } },
      select: { stepType: true, status: true, output: true },
    });
    if (!row || row.stepType !== 'wait' || row.status !== 'waiting') return false;
    const until = parseWaitingUntil(row.output);
    if (until === null) return false; // 无落库期限（非时间窗等待）→ 不上手
    if (until > Date.now()) {
      await this.scheduleWaitWake(runId, until); // 早到：重新武装（同 jobId 去重），继续等待
      this.logger.log({ runId, untilMs: until }, 'wait 唤醒早到 → 重新武装延迟作业（绝不提前前进）');
      return false;
    }
    const woken = await this.prisma.workflowRun.updateMany({
      where: { id: runId, status: 'waiting' },
      data: { status: 'queued', workerId: null, leaseUntil: null, heartbeatAt: null },
    });
    if (woken.count === 0) return false; // 竞争：外部已终态/已被接管
    this.logger.log({ runId, untilMs: until }, 'wait 步骤到期（延迟作业）→ 唤醒 workflow run');
    return true;
  }

  private enqueueWake(runId: string): Promise<void> {
    // Pre-M9 G4：唤醒投递 best-effort（行已回到 queued，recoverStale 巡检兜底）；有界 2s，失败告警不冒泡
    return addJobBestEffort(this.workflowQueue,
      'execute', { runId },
      {
        // 唯一键：不得复用创建时的 jobId（BullMQ 同键去重吞 job——M6 教训）
        jobId: `wf-${runId}-wake-${Date.now()}`,
        attempts: 2, backoff: { type: 'exponential', delay: 2000 },
        removeOnComplete: true, removeOnFail: { count: 500 },
      },
      `wake:${runId}`).then(() => undefined);
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
