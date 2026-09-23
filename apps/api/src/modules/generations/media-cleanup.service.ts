import { Inject, Injectable, Logger } from '@nestjs/common';
import { LIMITS, ErrorCode } from '@ai-agent/shared';
import { PrismaService } from '../prisma/prisma.service';
import { UsageService } from '../usage/usage.service';

const DEFAULT_AGENT_RUN_TIMEOUT_MS = 120_000;

/**
 * 孤儿任务清扫（GenerationTask + AgentRun 两个域）：
 * ① processing 且超时的 GenerationTask → failed(MEDIA_TASK_TIMEOUT)；
 * ② running 且超时的 AgentRun → timeout(AGENT_RUN_TIMEOUT)（M4 Audit MUST-1）。
 * - 幂等：条件更新（只动 processing/running），重复执行/多 Worker/并发清扫安全；
 * - 不动任何已终态记录；不影响正常执行中的任务（未超时不触碰）；
 * - 超时阈值来自 system_settings.limits（Agent Loop 与清扫同源，不写死）。
 */
@Injectable()
export class MediaCleanupService {
  private readonly logger = new Logger('MediaCleanup');

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(UsageService) private readonly usage: UsageService,
  ) {}

  /** 清扫 GenerationTask（返回失败任务数） */
  async sweep(): Promise<number> {
    const now = Date.now();
    const rows = await this.prisma.generationTask.findMany({
      where: { status: 'processing' },
      select: { id: true, type: true, startedAt: true, userId: true, providerId: true, modelId: true, conversationId: true, messageId: true },
    });
    let swept = 0;
    for (const row of rows) {
      const timeout = row.type === 'video' ? LIMITS.VIDEO_TASK_TIMEOUT_MS : LIMITS.IMAGE_TASK_TIMEOUT_MS;
      const deadline = (row.startedAt?.getTime() ?? now) + timeout;
      if (now <= deadline) continue;
      const done = await this.prisma.generationTask.updateMany({
        where: { id: row.id, status: 'processing' },
        data: {
          status: 'failed', statusMessage: '任务超时', errorCode: ErrorCode.MEDIA_TASK_TIMEOUT, errorMessage: '任务超时', completedAt: new Date(),
        },
      });
      if (done.count === 0) continue; // 竞态：已被正常路径终态
      await this.usage.recordMediaUsage({
        userId: row.userId, conversationId: row.conversationId ?? undefined, messageId: row.messageId ?? undefined, taskId: row.id,
        kind: row.type, providerId: row.providerId ?? '', modelId: row.modelId ?? '',
        imageCount: 0, videoSeconds: 0, latencyMs: now - (row.startedAt?.getTime() ?? now),
        status: 'failed', errorCode: ErrorCode.MEDIA_TASK_TIMEOUT,
      }).catch(() => undefined);
      swept++;
      this.logger.warn({ taskId: row.id, type: row.type, provider: row.providerId ?? 'unknown' }, '孤儿任务已清扫为失败（超时）');
    }
    if (swept > 0) this.logger.log(`清扫完成: ${swept} 个超时任务`);
    return swept;
  }

  /** 清扫 stale AgentRun（M4 Audit MUST-1）：running 且 startedAt 超过阈值 → timeout。返回清扫数。 */
  async sweepAgentRuns(): Promise<number> {
    const now = Date.now();
    const limits = await this.prisma.systemSetting.findUnique({ where: { key: 'limits' } });
    const timeoutMs = (limits?.value as { agentRunTimeoutMs?: number } | null)?.agentRunTimeoutMs ?? DEFAULT_AGENT_RUN_TIMEOUT_MS;
    const rows = await this.prisma.agentRun.findMany({
      where: { status: 'running' },
      select: { id: true, startedAt: true, agentId: true, userId: true },
    });
    let swept = 0;
    for (const row of rows) {
      if (now - row.startedAt.getTime() <= timeoutMs) continue; // 正常执行中的 run 不触碰
      // 条件更新：与 cancel/正常终态竞争安全（一方 count=0）；终态绝不复活
      const done = await this.prisma.agentRun.updateMany({
        where: { id: row.id, status: 'running' },
        data: { status: 'timeout', errorCode: ErrorCode.AGENT_RUN_TIMEOUT, errorMessage: '执行超时', completedAt: new Date() },
      });
      if (done.count === 0) continue; // 竞态：已被正常路径终态
      swept++;
      this.logger.warn({ runId: row.id, agentId: row.agentId }, '孤儿 AgentRun 已清扫为 timeout');
    }
    if (swept > 0) this.logger.log(`AgentRun 清扫完成: ${swept} 个超时 run`);
    return swept;
  }
}
