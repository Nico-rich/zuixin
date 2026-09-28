import { Inject, Injectable, Logger } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { PrismaService } from '../../modules/prisma/prisma.service';
import { WORKFLOW_QUEUE } from '../../core/queue/queue.module';
import { addJobBestEffort } from '../../core/queue/bounded-add';
import { DEFAULT_LEASE_TTL_MS } from '../../core/agent-run-lease/agent-run-lease.service';
import { QuotaService } from '../../modules/billing/quota.service';
import { WORKFLOW_DEADLINE_DEFAULT_MS, workflowDeadlineMsFromSetting } from '../../modules/workflows/workflow-types';
import { parseWaitingUntil } from '../../modules/workflows/workflow-wait.service';
import { CHILD_TERMINAL_STATUSES, WorkflowWakeService } from './workflow-wake.service';

export const WORKFLOW_DEADLINE_MS = WORKFLOW_DEADLINE_DEFAULT_MS; // workflow run 上限 1h（可被 limits.workflowDeadlineMs 覆盖）

/**
 * M7-P6 WorkflowRun Lease——复用 M6 AgentRun Lease 原语集（同一状态机形状，独立表）：
 * claim 条件更新（queued/running+stale）→ renew owner fencing → release → recoverStale 兜底：
 * ① deadline 超期 → timeout；② queued 丢 job → 重入队；③ waiting+审批已终态/过期 → 唤醒；
 * ④ waiting+子 AgentRun 已终态 → 唤醒；⑤ lease 过期 → 重入队。唤醒 jobId 一律唯一键。
 */
@Injectable()
export class WorkflowLeaseService {
  private readonly logger = new Logger('WorkflowLease');

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @InjectQueue(WORKFLOW_QUEUE) private readonly workflowQueue: Queue,
    @Inject(QuotaService) private readonly quota: QuotaService,
    // D2-04：兜底巡检是"丢事件"场景下唯一的唤醒路径——唤醒的同时回收子 run 终态订阅
    // （否则事件丢失 = 订阅永不触发、永不回收；D2-04 的泄漏只在正常事件路径被堵住是不够的）
    @Inject(WorkflowWakeService) private readonly wake: WorkflowWakeService,
  ) {}

  async deadlineMs(): Promise<number> {
    const row = await this.prisma.systemSetting.findUnique({ where: { key: 'limits' } });
    return workflowDeadlineMsFromSetting(row?.value);
  }

  async claim(runId: string, workerId: string, ttlMs: number): Promise<{ acquired: boolean; status?: string }> {
    const now = new Date();
    const done = await this.prisma.workflowRun.updateMany({
      where: {
        id: runId,
        OR: [
          { status: 'queued', OR: [{ workerId: null }, { leaseUntil: { lt: now } }] },
          { status: 'running', workerId: { not: null }, OR: [{ leaseUntil: null }, { leaseUntil: { lt: now } }] },
        ],
      },
      data: { status: 'running', workerId, leaseUntil: new Date(now.getTime() + ttlMs), heartbeatAt: now },
    });
    if (done.count > 0) return { acquired: true };
    const row = await this.prisma.workflowRun.findUnique({ where: { id: runId }, select: { status: true } });
    return { acquired: false, status: row?.status };
  }

  async renew(runId: string, workerId: string, ttlMs: number): Promise<{ count: number }> {
    const now = new Date();
    return this.prisma.workflowRun.updateMany({
      where: { id: runId, workerId, status: 'running' },
      data: { leaseUntil: new Date(now.getTime() + ttlMs), heartbeatAt: now },
    });
  }

  async release(runId: string, workerId: string): Promise<void> {
    await this.prisma.workflowRun.updateMany({
      where: { id: runId, workerId, status: 'running' },
      data: { leaseUntil: null },
    });
  }

  getStatus(runId: string) {
    return this.prisma.workflowRun.findUnique({
      where: { id: runId },
      select: { id: true, status: true, workerId: true, leaseUntil: true },
    });
  }

  /** 唤醒唯一键（M6 教训：绝不复用创建时的 jobId——BullMQ 同键去重吞 job） */
  private enqueueRecover(runId: string, now: number): Promise<void> {
    // Pre-M9 G4：恢复重投是 best-effort（下一轮 recoverStale 巡检会再试）；有界 2s，失败告警不冒泡
    return addJobBestEffort(this.workflowQueue,
      'execute',
      { runId },
      {
        jobId: `wf-${runId}-recover-${now}`,
        attempts: 2, backoff: { type: 'exponential', delay: 2000 },
        removeOnComplete: true, removeOnFail: { count: 500 },
      },
      `recover:${runId}`).then(() => undefined);
  }

  /** M9-P4 ⑥：当前步骤是否为「已到期的时间窗 wait」（stepType='wait' + waitingUntil <= now） */
  private async isDueTimeWait(runId: string, stepIndex: number, now: Date): Promise<boolean> {
    const row = await this.prisma.workflowStepRun.findUnique({
      where: { workflowRunId_stepIndex: { workflowRunId: runId, stepIndex } },
      select: { stepType: true, status: true, output: true },
    });
    if (!row || row.stepType !== 'wait' || row.status !== 'waiting') return false;
    const until = parseWaitingUntil(row.output);
    return until !== null && until <= now.getTime();
  }

  async recoverStale(): Promise<{ reEnqueued: number; timedOut: number }> {
    const now = new Date();
    const deadlineMs = await this.deadlineMs();
    const rows = await this.prisma.workflowRun.findMany({
      where: { status: { in: ['queued', 'running', 'waiting'] } },
      select: {
        id: true, status: true, startedAt: true, workerId: true, leaseUntil: true,
        waitingOnApprovalId: true, waitingOnAgentRunId: true, currentStep: true,
      },
    });
    let reEnqueued = 0;
    let timedOut = 0;
    for (const row of rows) {
      if (now.getTime() - row.startedAt.getTime() > deadlineMs) {
        const done = await this.prisma.workflowRun.updateMany({
          where: { id: row.id, status: { in: ['queued', 'running', 'waiting'] } },
          data: {
            status: 'timeout', errorCode: 'WORKFLOW_RUN_TIMEOUT', errorMessage: '执行超时', completedAt: now,
            waitingOnApprovalId: null, waitingOnAgentRunId: null, workerId: null, leaseUntil: null, heartbeatAt: null,
          },
        });
        if (done.count > 0) {
          timedOut++;
          this.logger.warn({ runId: row.id }, 'workflow run 超过 deadline → timeout');
          // Pre-M9 C1：timeout 终态释放配额预留
          await this.quota.release(row.id, 'workflow_run').catch(() => undefined);
          // D2-04：run 已终态（绝不再被唤醒）→ 子 run 终态订阅必须回收
          if (row.waitingOnAgentRunId) this.wake.clearChildSubscription(row.waitingOnAgentRunId);
        }
        continue;
      }
      if (row.status === 'queued') {
        if (now.getTime() - row.startedAt.getTime() > 2 * DEFAULT_LEASE_TTL_MS) {
          await this.enqueueRecover(row.id, now.getTime());
          reEnqueued++;
          this.logger.warn({ runId: row.id }, 'workflow queued 超时无执行迹象（job 丢失）→ 兜底重入队');
        }
        continue;
      }
      if (row.status === 'waiting' && row.waitingOnApprovalId) {
        const approval = await this.prisma.approval.findUnique({
          where: { id: row.waitingOnApprovalId }, select: { status: true, expiresAt: true },
        });
        const decided = approval && ['approved', 'rejected', 'cancelled', 'expired'].includes(approval.status);
        const pastExpiry = approval?.status === 'requested' && approval.expiresAt != null && approval.expiresAt.getTime() < now.getTime();
        if (decided || pastExpiry) {
          if (pastExpiry) {
            await this.prisma.approval.updateMany({ where: { id: row.waitingOnApprovalId!, status: 'requested' }, data: { status: 'expired' } });
          }
          const woken = await this.prisma.workflowRun.updateMany({
            where: { id: row.id, status: 'waiting', waitingOnApprovalId: row.waitingOnApprovalId },
            data: { status: 'queued', waitingOnApprovalId: null, workerId: null, leaseUntil: null, heartbeatAt: null },
          });
          if (woken.count > 0) {
            await this.enqueueRecover(row.id, now.getTime());
            reEnqueued++;
            this.logger.warn({ runId: row.id }, 'waiting 且审批已终态/过期（唤醒丢失）→ 兜底唤醒');
          }
        }
        continue;
      }
      if (row.status === 'waiting' && row.waitingOnAgentRunId) {
        const child = await this.prisma.agentRun.findUnique({
          where: { id: row.waitingOnAgentRunId }, select: { status: true },
        });
        if (child && CHILD_TERMINAL_STATUSES.includes(child.status)) {
          // D2-04：子 run 已终态 = 该子 run 观察订阅的终点（终态 run 不再产生终态事件；executor 也绝不
          // 对终态子 run 重新进入等待）——无论本次唤醒是否由本进程完成，都在这里回收：
          // 事件丢失（Pub/Sub at-most-once）时订阅永不会被触发，本巡检是唯一的净网。
          this.wake.clearChildSubscription(row.waitingOnAgentRunId);
          const woken = await this.prisma.workflowRun.updateMany({
            where: { id: row.id, status: 'waiting', waitingOnAgentRunId: row.waitingOnAgentRunId },
            data: { status: 'queued', waitingOnAgentRunId: null, workerId: null, leaseUntil: null, heartbeatAt: null },
          });
          if (woken.count > 0) {
            await this.enqueueRecover(row.id, now.getTime());
            reEnqueued++;
            this.logger.warn({ runId: row.id }, 'waiting 且子 AgentRun 已终态（唤醒丢失）→ 兜底唤醒');
          }
        }
        continue;
      }
      // ⑥ M9-P4：wait 步骤到期（时间窗）——主路径是 processor 投递的延迟作业；此处兜底丢 job / 调度丢失
      if (row.status === 'waiting' && !row.waitingOnApprovalId && !row.waitingOnAgentRunId) {
        if (await this.isDueTimeWait(row.id, row.currentStep, now)) {
          const woken = await this.prisma.workflowRun.updateMany({
            where: { id: row.id, status: 'waiting' },
            data: { status: 'queued', workerId: null, leaseUntil: null, heartbeatAt: null },
          });
          if (woken.count > 0) {
            await this.enqueueRecover(row.id, now.getTime());
            reEnqueued++;
            this.logger.warn({ runId: row.id }, 'wait 步骤已到期（延迟唤醒丢失）→ 兜底唤醒');
          }
        }
        continue;
      }
      const staleLease = row.workerId !== null
        && row.status === 'running'
        && (row.leaseUntil === null || row.leaseUntil.getTime() < now.getTime());
      if (staleLease) {
        await this.enqueueRecover(row.id, now.getTime());
        reEnqueued++;
        this.logger.warn({ runId: row.id }, 'lease 过期（worker 失联）→ 重新入队恢复');
      }
    }
    return { reEnqueued, timedOut };
  }
}
