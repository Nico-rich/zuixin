import { Inject, Injectable, Logger } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../../modules/prisma/prisma.service';
import { QuotaService } from '../../modules/billing/quota.service';
import { AGENT_RUN_QUEUE } from '../queue/queue.module';
import { EventBusService, agentRunChannel } from '../events/event-bus.service';

/** M6-P3 默认时间分层（可被 system_settings.limits 覆盖；lease ≠ run deadline，绝不混用） */
export const DEFAULT_LEASE_TTL_MS = 60_000;
export const DEFAULT_HEARTBEAT_MS = 15_000;
export const DEFAULT_RUN_DEADLINE_MS = 40 * 60_000;

/** 恢复域状态集合（终态绝不进入；与各分支条件更新的谓词对齐） */
const ACTIVE_RUN_STATUSES = ['queued', 'running', 'waiting'] as const;

/**
 * M11-P7 D2-11（无界载入治理）：单批载入上限 + 单周期批数上限。
 * 原实现 `findMany` 一次载入**全部** queued/running/waiting 行（活跃 run 越多内存/RT 越不可控）；
 * 现改为「deadline 判定下推 SQL + 游标分页」：单批最多 200 行、单周期最多 10 批（2000 行），
 * 余量由下一个清扫周期（5min）继续——**有界工作**，绝不无限循环。
 */
const RECOVER_BATCH = 200;
const RECOVER_MAX_BATCHES = 10;

/** 恢复域投影列（只取判定必需的事实；绝不载入 transcript/metadata 等大字段） */
const RECOVER_SELECT = {
  id: true, status: true, startedAt: true, workerId: true, leaseUntil: true,
  waitingOnTaskId: true, waitingOnApprovalId: true, waitingOnDelegationId: true,
} as const;

/** 恢复域行（= RECOVER_SELECT 的投影结果） */
type RecoverRow = {
  id: string; status: string; startedAt: Date; workerId: string | null; leaseUntil: Date | null;
  waitingOnTaskId: string | null; waitingOnApprovalId: string | null; waitingOnDelegationId: string | null;
};

interface RecoverStats { reEnqueued: number; timedOut: number }

export interface ClaimResult {
  /** true = 本 worker 独占执行权（split-brain 由条件更新原子裁决） */
  acquired: boolean;
  /** 当前 run 状态（acquired=false 时的诊断信息） */
  status?: string;
  /** 当前持有者 */
  workerId?: string | null;
}

/**
 * AgentRun Lease（DB 条件更新 = 唯一裁决者；不引入 Redis 锁）：
 * - claim：queued（未持有）或 running（stale lease 接管）→ running + 本 workerId + lease；
 * - renew：只续自己持有的 lease（owner fencing），count=0 ⇒ 已被接管/已终态 ⇒ 必须停止执行；
 * - release：正常退出置 leaseUntil=null（保留 workerId 作可观测记录；null lease 对新 claim 立即可接管）。
 * terminal/waiting 不可 claim。
 */
@Injectable()
export class AgentRunLeaseService {
  private readonly logger = new Logger('AgentRunLease');

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @InjectQueue(AGENT_RUN_QUEUE) private readonly agentRunQueue: Queue,
    @Inject(EventBusService) private readonly events: EventBusService,
    // M10 Final Audit H2c：recoverStale 超时终态不经 Driver → 必须自行释放 C1 预留
    @Inject(QuotaService) private readonly quota: QuotaService,
  ) {}

  private ttlMs(value: unknown, fallback: number): number {
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? n : fallback;
  }

  /** limits.agentRunLeaseTtlMs（无配置走默认 60s） */
  async leaseTtlMs(): Promise<number> {
    const row = await this.prisma.systemSetting.findUnique({ where: { key: 'limits' } });
    return this.ttlMs((row?.value as { agentRunLeaseTtlMs?: number } | null)?.agentRunLeaseTtlMs, DEFAULT_LEASE_TTL_MS);
  }

  /** limits.agentRunDeadlineMs（无配置走默认 40min） */
  async runDeadlineMs(): Promise<number> {
    const row = await this.prisma.systemSetting.findUnique({ where: { key: 'limits' } });
    return this.ttlMs((row?.value as { agentRunDeadlineMs?: number } | null)?.agentRunDeadlineMs, DEFAULT_RUN_DEADLINE_MS);
  }

  async heartbeatIntervalMs(): Promise<number> {
    const row = await this.prisma.systemSetting.findUnique({ where: { key: 'limits' } });
    return this.ttlMs((row?.value as { agentRunHeartbeatMs?: number } | null)?.agentRunHeartbeatMs, DEFAULT_HEARTBEAT_MS);
  }

  /**
   * 原子 claim（split-brain 防线）：
   * queued → running + 本 workerId（首次执行）；running + lease 过期/null → 接管（崩溃恢复）。
   * 两个 worker 同时 claim 时 DB 只放行一个。
   */
  async claim(runId: string, workerId: string, ttlMs: number): Promise<ClaimResult> {
    const now = new Date();
    const leaseUntil = new Date(now.getTime() + ttlMs);
    const done = await this.prisma.agentRun.updateMany({
      where: {
        id: runId,
        OR: [
          // 首次执行：queued 且未被持有
          { status: 'queued', OR: [{ workerId: null }, { leaseUntil: { lt: now } }] },
          // 崩溃恢复：running 但 lease 已过期/已释放（workerId 非空 = async run，同步 run 不在此列）
          { status: 'running', workerId: { not: null }, OR: [{ leaseUntil: null }, { leaseUntil: { lt: now } }] },
        ],
      },
      data: { status: 'running', workerId, leaseUntil, heartbeatAt: now },
    });
    if (done.count > 0) return { acquired: true };
    const row = await this.prisma.agentRun.findUnique({ where: { id: runId }, select: { status: true, workerId: true } });
    return { acquired: false, status: row?.status, workerId: row?.workerId };
  }

  /**
   * 续期（owner fencing）：count=0 ⇒ 已被接管或已终态 ⇒ 调用方必须立即停止 Engine。
   */
  async renew(runId: string, workerId: string, ttlMs: number): Promise<{ count: number }> {
    const now = new Date();
    return this.prisma.agentRun.updateMany({
      where: { id: runId, workerId, status: 'running' },
      data: { leaseUntil: new Date(now.getTime() + ttlMs), heartbeatAt: now },
    });
  }

  /** 释放：正常退出（终态/等待/shutdown）置 leaseUntil=null；workerId 保留作记录 */
  async release(runId: string, workerId: string): Promise<void> {
    await this.prisma.agentRun.updateMany({
      where: { id: runId, workerId, status: 'running' },
      data: { leaseUntil: null },
    });
  }

  /** 读当前状态（取消检测等） */
  getStatus(runId: string) {
    return this.prisma.agentRun.findUnique({ where: { id: runId }, select: { id: true, status: true, workerId: true, leaseUntil: true } });
  }

  /**
   * Stale recovery（清理调度器兜底；lease 过期 ≠ run 超时）：
   * ① run deadline（startedAt + limits.agentRunDeadlineMs，含 waiting 时间）已过 → timeout 终态（条件更新，绝不复活终态）；
   * ② 未超期但 async run lease 已过期/已释放 → 重新入队（claim 条件更新是最终防线，重复入队幂等）；
   * ③ P4-6 兜底：waiting 且任务已终态（hook 丢失）→ 唤醒（waiting→queued + 入队）；任务仍在执行 → 不动。
   * 同步 run（workerId null）不在此恢复域（sweepAgentRuns 120s 语义负责）。
   *
   * M11-P7 D2-11：不再一次性载入全部活跃行——deadline 判定下推 SQL + 游标分页（见 sweepActive）。
   * 逐行条件更新（唯一裁决者）与竞态安全语义完全不变。
   */
  async recoverStale(): Promise<{ reEnqueued: number; timedOut: number }> {
    const now = new Date();
    const deadlineMs = await this.runDeadlineMs();
    const cutoff = new Date(now.getTime() - deadlineMs);
    const stats: RecoverStats = { reEnqueued: 0, timedOut: 0 };
    // ① deadline 判定下推 SQL：只载入**必然超期**的活跃行（now - startedAt > deadline ⇔ startedAt < now - deadline，
    //    判定与条件等价 ⇒ 绝不漏判、绝不误判）；
    // ② 未超期活跃行：lease 过期接管 / job 丢失重投 / hook 丢失唤醒三类兜底（逐行分支判定不变）。
    // 两段条件互斥且并在 SQL 侧覆盖全部活跃行——内存只承载单页，不再承载全表。
    await this.sweepActive({ status: { in: [...ACTIVE_RUN_STATUSES] }, startedAt: { lt: cutoff } }, now, deadlineMs, stats);
    await this.sweepActive({ status: { in: [...ACTIVE_RUN_STATUSES] }, startedAt: { gte: cutoff } }, now, deadlineMs, stats);
    return stats;
  }

  /**
   * M11-P7 D2-11：游标分页扫描恢复域。按 (startedAt, id) 稳定排序——startedAt 不可变 ⇒ 页与页之间
   * 绝不漏行/重复行（写入只改 status/lease，不移动游标位置）。单批 RECOVER_BATCH 行、单周期最多
   * RECOVER_MAX_BATCHES 批；达上限即返回（剩余行由下一个清扫周期继续，绝不无限循环）。
   */
  private async sweepActive(
    where: Prisma.AgentRunWhereInput,
    now: Date,
    deadlineMs: number,
    stats: RecoverStats,
  ): Promise<void> {
    let cursorId: string | undefined;
    for (let batch = 0; batch < RECOVER_MAX_BATCHES; batch++) {
      const rows: RecoverRow[] = await this.prisma.agentRun.findMany({
        where,
        select: RECOVER_SELECT,
        orderBy: [{ startedAt: 'asc' }, { id: 'asc' }],
        take: RECOVER_BATCH,
        ...(cursorId ? { cursor: { id: cursorId }, skip: 1 } : {}),
      });
      for (const row of rows) await this.recoverRow(row, now, deadlineMs, stats);
      const last = rows[rows.length - 1];
      // 末批（不足一批）或游标未前进（行被并发删除等）→ 结束本轮
      if (rows.length < RECOVER_BATCH || !last || last.id === cursorId) return;
      cursorId = last.id;
    }
    this.logger.warn({ batch: RECOVER_BATCH, maxBatches: RECOVER_MAX_BATCHES }, 'recoverStale 达到单周期分页上限 → 剩余行由下个清扫周期继续');
  }

  /** 逐行恢复（原 recoverStale 循环体，逐行独立判定；条件更新仍是唯一裁决者） */
  private async recoverRow(row: RecoverRow, now: Date, deadlineMs: number, stats: RecoverStats): Promise<void> {
    const pastDeadline = now.getTime() - row.startedAt.getTime() > deadlineMs;
    if (pastDeadline) {
      const done = await this.prisma.agentRun.updateMany({
        where: { id: row.id, status: { in: [...ACTIVE_RUN_STATUSES] } },
        data: {
          status: 'timeout', errorCode: 'AGENT_RUN_TIMEOUT', errorMessage: '执行超时', completedAt: now,
          waitingOnTaskId: null, workerId: null, leaseUntil: null, heartbeatAt: null,
        },
      });
      if (done.count > 0) {
        stats.timedOut++;
        // M10 Final Audit H2c：timeout 终态不经 Driver 释放路径——这里释放 C1 预留（幂等；TTL 兜底）
        await this.quota.release(row.id, 'agent_run').catch(() => undefined);
        this.logger.warn({ runId: row.id, status: row.status }, 'run 超过 deadline → timeout');
        // M6-P6 观察通道：SSE 订阅者实时看到 timeout 终态（并收流）
        await this.events.publish(agentRunChannel(row.id), { type: 'run.timeout', runId: row.id, status: 'timeout' }).catch(() => undefined);
      }
      return;
    }
    if (row.status === 'queued') {
      // 丢失 job 兜底（dead-letter 语义）：job 因同键碰撞/重试耗尽消失而 run 仍 queued → 重新入队
      // （claim 条件更新为最终防线，重复入队幂等——绝不产生重复执行）
      const queuedFor = now.getTime() - row.startedAt.getTime();
      if (queuedFor > 2 * DEFAULT_LEASE_TTL_MS) {
        await this.agentRunQueue.add(
          'execute',
          { runId: row.id },
          {
            jobId: `run-${row.id}-recover-${now.getTime()}`,
            attempts: 2, backoff: { type: 'exponential', delay: 2000 },
            removeOnComplete: true, removeOnFail: { count: 500 },
          },
        );
        stats.reEnqueued++;
        this.logger.warn({ runId: row.id }, 'queued 超时无执行迹象（job 丢失）→ 兜底重入队');
      }
      return;
    }
    if (row.status === 'waiting' && row.waitingOnTaskId) {
      // hook 丢失兜底：任务已终态但 run 仍 waiting → 唤醒（hook 与 sweep 双通道，至少一次语义 + 幂等）
      const task = await this.prisma.generationTask.findUnique({
        where: { id: row.waitingOnTaskId }, select: { status: true },
      });
      if (task && ['completed', 'failed', 'cancelled'].includes(task.status)) {
        const woken = await this.prisma.agentRun.updateMany({
          where: { id: row.id, status: 'waiting', waitingOnTaskId: row.waitingOnTaskId },
          data: { status: 'queued', waitingOnTaskId: null, workerId: null, leaseUntil: null, heartbeatAt: null },
        });
        if (woken.count > 0) {
          await this.agentRunQueue.add(
            'execute',
            { runId: row.id },
            {
              jobId: `run-${row.id}-recover-${now.getTime()}`,
              attempts: 2, backoff: { type: 'exponential', delay: 2000 },
              removeOnComplete: true, removeOnFail: { count: 500 },
            },
          );
          stats.reEnqueued++;
          this.logger.warn({ runId: row.id, taskId: row.waitingOnTaskId }, 'waiting 且任务已终态（hook 丢失）→ 兜底唤醒');
        }
      }
      return;
    }
    if (row.status === 'waiting' && row.waitingOnApprovalId) {
      // M7-P1 审批等待兜底：审批已终态（hook 丢失）→ 唤醒；requested 且过期 → 先 expire 再唤醒（resume 失败回喂）
      const approval = await this.prisma.approval.findUnique({
        where: { id: row.waitingOnApprovalId }, select: { status: true, expiresAt: true },
      });
      const approvalId = row.waitingOnApprovalId;
      const decided = approval && ['approved', 'rejected', 'cancelled', 'expired'].includes(approval.status);
      const pastExpiry = approval?.status === 'requested' && approval.expiresAt != null && approval.expiresAt.getTime() < now.getTime();
      if (decided || pastExpiry) {
        if (pastExpiry) {
          await this.prisma.approval.updateMany({ where: { id: approvalId, status: 'requested' }, data: { status: 'expired' } });
        }
        const woken = await this.prisma.agentRun.updateMany({
          where: { id: row.id, status: 'waiting', waitingOnApprovalId: approvalId },
          data: { status: 'queued', waitingOnApprovalId: null, workerId: null, leaseUntil: null, heartbeatAt: null },
        });
        if (woken.count > 0) {
          await this.agentRunQueue.add(
            'execute',
            { runId: row.id },
            {
              jobId: `run-${row.id}-recover-${now.getTime()}`,
              attempts: 2, backoff: { type: 'exponential', delay: 2000 },
              removeOnComplete: true, removeOnFail: { count: 500 },
            },
          );
          stats.reEnqueued++;
          this.logger.warn({ runId: row.id, approvalId }, 'waiting 且审批已终态/过期（hook 丢失）→ 兜底唤醒');
        }
      }
      return;
    }
    if (row.status === 'waiting' && row.waitingOnDelegationId) {
      // M7-P7 委派等待兜底：子 run 已终态（唤醒事件丢失）→ 唤醒父 run
      const delegation = await this.prisma.agentDelegation.findUnique({
        where: { id: row.waitingOnDelegationId }, select: { childRunId: true, status: true },
      });
      const child = delegation
        ? await this.prisma.agentRun.findUnique({ where: { id: delegation.childRunId }, select: { status: true } })
        : null;
      if (child && ['completed', 'failed', 'cancelled', 'timeout'].includes(child.status)) {
        const woken = await this.prisma.agentRun.updateMany({
          where: { id: row.id, status: 'waiting', waitingOnDelegationId: row.waitingOnDelegationId },
          data: { status: 'queued', waitingOnDelegationId: null, workerId: null, leaseUntil: null, heartbeatAt: null },
        });
        if (woken.count > 0) {
          await this.agentRunQueue.add(
            'execute',
            { runId: row.id },
            {
              jobId: `run-${row.id}-recover-${now.getTime()}`,
              attempts: 2, backoff: { type: 'exponential', delay: 2000 },
              removeOnComplete: true, removeOnFail: { count: 500 },
            },
          );
          stats.reEnqueued++;
          this.logger.warn({ runId: row.id, delegationId: row.waitingOnDelegationId }, 'waiting 且子 run 已终态（唤醒丢失）→ 兜底唤醒');
        }
      }
      return;
    }
    const staleLease = row.workerId !== null
      && row.status === 'running'
      && (row.leaseUntil === null || row.leaseUntil.getTime() < now.getTime());
    if (staleLease) {
      await this.agentRunQueue.add(
        'execute',
        { runId: row.id },
        {
          jobId: `run-${row.id}-recover-${now.getTime()}`,
          attempts: 2, backoff: { type: 'exponential', delay: 2000 },
          removeOnComplete: true, removeOnFail: { count: 500 },
        },
      );
      stats.reEnqueued++;
      this.logger.warn({ runId: row.id }, 'lease 过期（worker 失联）→ 重新入队恢复');
    }
  }
}
