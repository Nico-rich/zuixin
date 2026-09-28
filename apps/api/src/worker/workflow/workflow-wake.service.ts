import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { PrismaService } from '../../modules/prisma/prisma.service';
import { WORKFLOW_QUEUE } from '../../core/queue/queue.module';
import { addJobBestEffort } from '../../core/queue/bounded-add';
import { EventBusService, agentRunChannel } from '../../core/events/event-bus.service';
import { WORKFLOW_APPROVAL_DECIDED_CHANNEL } from '../../core/events/workflow-channels';
import { parseWaitingUntil } from '../../modules/workflows/workflow-wait.service';

/** 子 AgentRun 终态事件类型（driver 观察通道发布；**其余事件绝不触发唤醒**） */
export const CHILD_TERMINAL_EVENTS: readonly string[] = ['run.completed', 'run.failed', 'run.cancelled', 'run.timeout'];
/** 子 AgentRun 终态状态（DB 事实；与上述事件类型一一对应——订阅后校验用） */
export const CHILD_TERMINAL_STATUSES: readonly string[] = ['completed', 'failed', 'cancelled', 'timeout'];

/**
 * M7-P6 Workflow 唤醒（waiting → queued + 唯一 jobId；与 M6 wakeWaitingRun 同构原语）：
 * - 审批决断：订阅全局通道（API 进程 decide 发布）→ 条件更新唤醒；recoverStale 兜底（事件丢失）；
 * - 子 AgentRun 终态：订阅 agent-run:{childRunId} 观察通道（驱动端 run.completed 等事件）→ 唤醒；
 *   兜底同样由 recoverStale 承担（at-least-once + 条件更新幂等，重复唤醒绝不重复执行）。
 */
@Injectable()
export class WorkflowWakeService implements OnModuleInit {
  private readonly logger = new Logger('WorkflowWake');
  /**
   * D2-04：子 run 终态订阅表（childRunId → handler）—— 与 M10-P10 X-05（delegation）对称。
   *
   * EventBusService 的 handler 登记是**进程内常驻**资源（handler 表 + 闭包捕获 this）：
   * 原实现每次进入 waiting-on-child 都新订阅一个闭包且终态后从不摘除 →
   * ① 订阅随等待次数线性累积（长驻 worker 内存泄漏）；② 同一 childRunId 重入等待会**多份投递**。
   * 回收时机 = 终态确认 / 唤醒路径（事件处理、订阅后校验、兜底唤醒 recoverStale）。
   *
   * **丢订阅绝不丢唤醒**：唤醒的事实源是 **DB 条件更新**（waiting + waitingOnAgentRunId →
   * queued，count=0 即竞争失败），兜底通道 `WorkflowLeaseService.recoverStale` ④ 不依赖本订阅。
   */
  private readonly childSubscriptions = new Map<string, (event: Record<string, unknown>) => void>();

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

  /**
   * 子 AgentRun 终态唤醒（等待该子 run 的 workflow run；条件更新去重，重复唤醒幂等）。
   * D2-04：本方法是该子 run 订阅的**终点**（三条出口都回收）——
   * 子 run 已终态 → 不会再产生终态事件，订阅已无意义；唤醒的事实源是 DB（+recoverStale 兜底）。
   */
  async wakeByAgentRun(childRunId?: string): Promise<{ woken: boolean }> {
    if (!childRunId) return { woken: false };
    const target = await this.prisma.workflowRun.findFirst({
      where: { status: 'waiting', waitingOnAgentRunId: childRunId }, select: { id: true },
    });
    if (!target) {
      // 无人再等待该子 run（父 run 已终态/已唤醒/被取消）→ 订阅永不触发，立即回收
      this.clearChildSubscription(childRunId);
      return { woken: false };
    }
    const done = await this.prisma.workflowRun.updateMany({
      where: { id: target.id, status: 'waiting', waitingOnAgentRunId: childRunId },
      data: { status: 'queued', waitingOnAgentRunId: null, workerId: null, leaseUntil: null, heartbeatAt: null },
    });
    if (done.count === 0) {
      this.clearChildSubscription(childRunId); // 竞争：已被其他路径唤醒/已终态 → 订阅已无意义
      return { woken: false };
    }
    await this.enqueueWake(target.id);
    this.clearChildSubscription(childRunId);
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

  /**
   * 订阅特定子 AgentRun 的观察通道（processor 进入 waiting 时调用；driver 事件实时触发 wakeByAgentRun）。
   *
   * D2-04（对称 M10-P10 X-05）：
   * - **登记前先回收**同名订阅——同一步重入等待绝不产生第二份 handler（绝不双份投递/累积）；
   * - 订阅建立失败时（EventBusService 有界订阅会显式抛错）不记录 handler，绝不留下"看似已订阅"的假象；
   * - **订阅后校验**：子 run 若已终态（终态事件在「run 落 waiting」与「本订阅建立」之间发布 →
   *   Pub/Sub at-most-once 已丢失），立即按 DB 事实唤醒并回收订阅——既不丢唤醒，也不留死订阅。
   */
  async watchChildRun(childRunId: string): Promise<void> {
    this.clearChildSubscription(childRunId);
    const handler = (event: Record<string, unknown>) => {
      const type = event.type as string | undefined;
      if (!type || !CHILD_TERMINAL_EVENTS.includes(type)) return; // 非终态事件：绝不触发唤醒、订阅保留
      // 终态事件即本订阅的终点：先回收订阅再唤醒（终态 run 不会再发终态事件）
      this.clearChildSubscription(childRunId);
      void this.wakeByAgentRun(childRunId).catch(() => undefined);
    };
    await this.events.subscribe(agentRunChannel(childRunId), handler);
    this.childSubscriptions.set(childRunId, handler);
    // 订阅后校验（best-effort：DB 抖动绝不影响"进入等待"这一事实——recoverStale 仍会兜底唤醒）
    const child = await this.prisma.agentRun
      .findUnique({ where: { id: childRunId }, select: { status: true } })
      .catch(() => null);
    if (child && CHILD_TERMINAL_STATUSES.includes(child.status)) {
      this.logger.warn({ childRunId, status: child.status }, '订阅后校验：子 run 已终态（终态事件早于订阅建立）→ 立即按 DB 事实唤醒');
      this.clearChildSubscription(childRunId);
      await this.wakeByAgentRun(childRunId).catch(() => undefined);
    }
  }

  /**
   * D2-04：回收子 run 终态订阅（幂等；未登记则 no-op——绝不误删他人 handler）。
   * 公开面同时供兜底巡检（`WorkflowLeaseService.recoverStale` 唤醒/超时分支）调用：
   * 事件丢失时唤醒由 DB 兜底，订阅则由这些"终态确认/唤醒路径"一并回收。
   */
  clearChildSubscription(childRunId: string): void {
    const handler = this.childSubscriptions.get(childRunId);
    if (!handler) return;
    this.childSubscriptions.delete(childRunId);
    this.events.unsubscribe(agentRunChannel(childRunId), handler);
  }

  /** 在途子 run 订阅数（可观测；终态/唤醒后必须回落，绝不随等待次数累积） */
  pendingChildSubscriptions(): number {
    return this.childSubscriptions.size;
  }
}
