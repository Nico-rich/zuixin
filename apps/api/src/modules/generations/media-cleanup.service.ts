import { Inject, Injectable, Logger } from '@nestjs/common';
import { LIMITS, ErrorCode } from '@ai-agent/shared';
import { PrismaService } from '../prisma/prisma.service';
import { UsageService } from '../usage/usage.service';

/**
 * 孤儿任务清扫（M2 Audit 唯一 Must Fix）：
 * processing 且超过该类型超时上限的任务 → failed(MEDIA_TASK_TIMEOUT)。
 * - 幂等：条件更新 status='processing'，重复执行/多 Worker 安全；
 * - 不动 completed/failed/cancelled/pending；
 * - usage 失败行按 attempt 时写入的 provider/model 归因（G2 修复的一部分）。
 */
@Injectable()
export class MediaCleanupService {
  private readonly logger = new Logger('MediaCleanup');

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(UsageService) private readonly usage: UsageService,
  ) {}

  /** 返回本次清扫的失败任务数 */
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
}
