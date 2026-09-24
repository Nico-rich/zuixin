import { Inject, Injectable, Logger } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { PrismaService } from '../../modules/prisma/prisma.service';
import { AGENT_RUN_QUEUE } from '../queue/queue.module';
import { DEFAULT_RUN_DEADLINE_MS } from '../agent-run-lease/agent-run-lease.service';
import { EventBusService, agentRunChannel } from '../events/event-bus.service';

const TASK_TERMINAL = ['completed', 'failed', 'cancelled'] as const;


/**
 * M6-P4 GenerationTask 终态 → AgentRun 唤醒（waiting → queued → worker claim → resume）：
 * - 单点 hook：media-generation（完成/失败）与 media-cleanup sweep（任务超时）三处终态调用；
 * - 三重幂等（设计 §9.2）：① 条件更新 waiting→queued 原子去重；② 队列 jobId `run-{runId}` 去重；
 *   ③ worker claim 条件更新最终防线——重复唤醒绝不产生重复执行；
 * - P4-10：run deadline（自 startedAt，含 waiting 时间）已过 → 直接 timeout，绝不 waiting→running 复活；
 * - 不信任 payload：只按 runId/taskId 读 DB，身份与状态全部 DB 事实。
 */
@Injectable()
export class AgentRunResumeTrigger {
  private readonly logger = new Logger('AgentRunResume');

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @InjectQueue(AGENT_RUN_QUEUE) private readonly agentRunQueue: Queue,
    @Inject(EventBusService) private readonly events: EventBusService,
  ) {}

  /** GenerationTask 终态 hook（executeTask 完成/失败路径 + sweep 超时路径） */
  async onTaskTerminal(taskId: string): Promise<void> {
    const task = await this.prisma.generationTask.findUnique({
      where: { id: taskId },
      select: { id: true, status: true, runId: true },
    });
    if (!task || !task.runId || !(TASK_TERMINAL as readonly string[]).includes(task.status)) return;
    // M6-P6：任务终态实时通知（SSE 观察层；Timeline 投影仍是历史事实）
    await this.events.publish(agentRunChannel(task.runId), { type: `task.${task.status}`, taskId, runId: task.runId })
      .catch(() => undefined);
    await this.wakeWaitingRun(task.runId, taskId);
  }

  /**
   * waiting → queued（或 deadline 已过 → timeout）。
   * 条件更新：waitingOnTaskId 精确匹配，只有对应任务唤醒对应 run（P4-6）；
   * terminal/waiting 之外的任何状态绝不复活（P4-6 防 resurrect）。
   */
  async wakeWaitingRun(runId: string, taskId: string): Promise<{ woken: boolean }> {
    const run = await this.prisma.agentRun.findUnique({
      where: { id: runId },
      select: { id: true, status: true, startedAt: true, waitingOnTaskId: true },
    });
    if (!run || run.status !== 'waiting' || run.waitingOnTaskId !== taskId) return { woken: false };

    const deadlineMs = await this.runDeadlineMs();
    const pastDeadline = Date.now() - run.startedAt.getTime() > deadlineMs;
    const done = await this.prisma.agentRun.updateMany({
      where: { id: runId, status: 'waiting', waitingOnTaskId: taskId },
      data: pastDeadline
        ? { // P4-10：deadline 在 waiting 期间继续计算；超期即终态，绝不复活
            status: 'timeout', errorCode: 'AGENT_RUN_TIMEOUT', errorMessage: '执行超时',
            completedAt: new Date(), waitingOnTaskId: null, workerId: null, leaseUntil: null, heartbeatAt: null,
          }
        : { // P4-7：唤醒 = waitingOnTaskId 清空 + queued（workerId/lease 由 claim 重新持有）
            status: 'queued', waitingOnTaskId: null, workerId: null, leaseUntil: null, heartbeatAt: null,
          },
    });
    if (done.count === 0) return { woken: false }; // 竞态：已唤醒/已终态
    if (pastDeadline) {
      this.logger.warn({ runId, taskId }, '任务终态到达但 run deadline 已过 → timeout');
      return { woken: false };
    }
    await this.agentRunQueue.add(
      'execute',
      { runId },
      {
        // 唯一键：不得复用 create 的 `run-{runId}`——原 job 可能尚未被 removeOnComplete 移除，
        // BullMQ 同键 add 会命中已有 job 而不再入队（run 永久 stuck queued）。重复唤醒的去重
        // 由条件更新 waiting→queued（原子）与 claim（最终防线）承担，不依赖 jobId。
        jobId: `run-${runId}-wake-${Date.now()}`,
        attempts: 2, backoff: { type: 'exponential', delay: 2000 },
        removeOnComplete: true, removeOnFail: { count: 500 },
      },
    );
    this.logger.log({ runId, taskId }, 'GenerationTask 终态 → 唤醒 AgentRun（waiting→queued）');
    return { woken: true };
  }

  private async runDeadlineMs(): Promise<number> {
    const row = await this.prisma.systemSetting.findUnique({ where: { key: 'limits' } });
    const n = Number((row?.value as { agentRunDeadlineMs?: number } | null)?.agentRunDeadlineMs);
    return Number.isFinite(n) && n > 0 ? n : DEFAULT_RUN_DEADLINE_MS;
  }

  /**
   * M7-P1 Approval 终态 → AgentRun 唤醒（与 onTaskTerminal 同构的 waiting 唤醒原语）：
   * 条件更新 waiting + waitingOnApprovalId 精确匹配 → queued（deadline 已过 → timeout，绝不复活）；
   * jobId 唯一键 `run-{id}-wake-{ts}`（BullMQ 同键去重陷阱，M6 教训）；重复唤醒由条件更新 + claim 去重。
   */
  async wakeWaitingRunByApproval(runId: string, approvalId: string): Promise<{ woken: boolean }> {
    const run = await this.prisma.agentRun.findUnique({
      where: { id: runId },
      select: { id: true, status: true, startedAt: true, waitingOnApprovalId: true },
    });
    if (!run || run.status !== 'waiting' || run.waitingOnApprovalId !== approvalId) return { woken: false };

    const deadlineMs = await this.runDeadlineMs();
    const pastDeadline = Date.now() - run.startedAt.getTime() > deadlineMs;
    const done = await this.prisma.agentRun.updateMany({
      where: { id: runId, status: 'waiting', waitingOnApprovalId: approvalId },
      data: pastDeadline
        ? {
            status: 'timeout', errorCode: 'AGENT_RUN_TIMEOUT', errorMessage: '执行超时',
            completedAt: new Date(), waitingOnApprovalId: null, workerId: null, leaseUntil: null, heartbeatAt: null,
          }
        : {
            status: 'queued', waitingOnApprovalId: null, workerId: null, leaseUntil: null, heartbeatAt: null,
          },
    });
    if (done.count === 0) return { woken: false }; // 竞态：已唤醒/已终态
    if (pastDeadline) {
      this.logger.warn({ runId, approvalId }, '审批终态到达但 run deadline 已过 → timeout');
      return { woken: false };
    }
    await this.agentRunQueue.add(
      'execute',
      { runId },
      {
        jobId: `run-${runId}-wake-${Date.now()}`,
        attempts: 2, backoff: { type: 'exponential', delay: 2000 },
        removeOnComplete: true, removeOnFail: { count: 500 },
      },
    );
    this.logger.log({ runId, approvalId }, 'Approval 终态 → 唤醒 AgentRun（waiting→queued）');
    return { woken: true };
  }
}
