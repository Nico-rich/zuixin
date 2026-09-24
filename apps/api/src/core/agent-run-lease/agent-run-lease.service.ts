import { Inject, Injectable, Logger } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { PrismaService } from '../../modules/prisma/prisma.service';
import { AGENT_RUN_QUEUE } from '../queue/queue.module';

/** M6-P3 默认时间分层（可被 system_settings.limits 覆盖；lease ≠ run deadline，绝不混用） */
export const DEFAULT_LEASE_TTL_MS = 60_000;
export const DEFAULT_HEARTBEAT_MS = 15_000;
export const DEFAULT_RUN_DEADLINE_MS = 40 * 60_000;

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
   * ① run deadline（startedAt + limits.agentRunDeadlineMs）已过 → timeout 终态（条件更新，绝不复活终态）；
   * ② 未超期但 async run lease 已过期/已释放 → 重新入队（claim 条件更新是最终防线，重复入队幂等）。
   * 同步 run（workerId null）不在此恢复域（sweepAgentRuns 120s 语义负责）。
   */
  async recoverStale(): Promise<{ reEnqueued: number; timedOut: number }> {
    const now = new Date();
    const deadlineMs = await this.runDeadlineMs();
    const rows = await this.prisma.agentRun.findMany({
      where: { status: { in: ['queued', 'running'] } },
      select: { id: true, status: true, startedAt: true, workerId: true, leaseUntil: true },
    });
    let reEnqueued = 0;
    let timedOut = 0;
    for (const row of rows) {
      const pastDeadline = now.getTime() - row.startedAt.getTime() > deadlineMs;
      if (pastDeadline) {
        const done = await this.prisma.agentRun.updateMany({
          where: { id: row.id, status: { in: ['queued', 'running'] } },
          data: { status: 'timeout', errorCode: 'AGENT_RUN_TIMEOUT', errorMessage: '执行超时', completedAt: now },
        });
        if (done.count > 0) {
          timedOut++;
          this.logger.warn({ runId: row.id, status: row.status }, 'run 超过 deadline → timeout');
        }
        continue;
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
        reEnqueued++;
        this.logger.warn({ runId: row.id }, 'lease 过期（worker 失联）→ 重新入队恢复');
      }
    }
    return { reEnqueued, timedOut };
  }
}
