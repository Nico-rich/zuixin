import { Inject, Injectable, Logger } from '@nestjs/common';
import { LIMITS, ErrorCode } from '@ai-agent/shared';
import { PrismaService } from '../prisma/prisma.service';
import { UsageService } from '../usage/usage.service';
import { QuotaService } from '../billing/quota.service';
import { AgentRunResumeTrigger } from '../../core/agent-run-resume/agent-run-resume-trigger.service';
import { MediaGenerationService } from './media-generation.service';
import { ExternalActionsService } from '../external-actions/external-actions.service';

const DEFAULT_AGENT_RUN_TIMEOUT_MS = 120_000;

/**
 * Pre-M9 G7：远端仍报 processing 时的护栏倍数——超过「任务超时 × 本倍数」仍未终态，
 * 才按超时兜底裁决（远端权威 ≠ 永不动它；否则 UI 会永久停在"生成中"）。
 */
const REMOTE_PROCESSING_GRACE_FACTOR = 2;

/**
 * 孤儿任务清扫（GenerationTask + AgentRun + ExternalAction 三个域）：
 * ① 超时的 GenerationTask → **先按 remoteTaskId 问 provider 真实状态**（G7 恢复：远端已完成就恢复结果，
 *    而不是一律判超时），远端无终态证据才 failed(MEDIA_TASK_TIMEOUT)；
 * ② running 且超时的 AgentRun → timeout(AGENT_RUN_TIMEOUT)（M4 Audit MUST-1）；
 * ③ executing 静默过久的 ExternalAction → 按远端幂等键问 provider 真实状态（G7 恢复）。
 * - 幂等：条件更新（只动 processing/pending/running/executing），重复执行/多 Worker/并发清扫安全；
 * - 不动任何已终态记录；不影响正常执行中的任务（未超时/未静默不触碰）；
 * - 超时阈值来自 system_settings.limits（Agent Loop 与清扫同源，不写死）。
 */
@Injectable()
export class MediaCleanupService {
  private readonly logger = new Logger('MediaCleanup');

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(UsageService) private readonly usage: UsageService,
    @Inject(QuotaService) private readonly quota: QuotaService,
    @Inject(AgentRunResumeTrigger) private readonly resume: AgentRunResumeTrigger,
    // Pre-M9 G7：GenerationTask 远端恢复（转存/用量/事件/配额语义全部复用媒体域，不在清扫侧重写）
    @Inject(MediaGenerationService) private readonly media: MediaGenerationService,
    // Pre-M9 G7：ExternalAction executing 残留行恢复（同周期不同域；恢复逻辑在动作域内）
    @Inject(ExternalActionsService) private readonly externalActions: ExternalActionsService,
  ) {}

  /** 清扫 GenerationTask（返回本轮**置失败**的任务数；远端恢复为终态的不计入失败，另记 recoveredTasks） */
  async sweep(): Promise<number> {
    const now = Date.now();
    const rows = await this.prisma.generationTask.findMany({
      // G7：pending 也在清扫面内——投递失败（队列投递超时）会让行永久停在 pending（无人 claim、无 remoteTaskId）
      where: { status: { in: ['processing', 'pending'] } },
      select: {
        id: true, type: true, status: true, startedAt: true, createdAt: true, remoteTaskId: true,
        userId: true, providerId: true, modelId: true, conversationId: true, messageId: true, runId: true,
      },
    });
    let swept = 0;
    let recovered = 0;
    for (const row of rows) {
      const timeout = row.type === 'video' ? LIMITS.VIDEO_TASK_TIMEOUT_MS : LIMITS.IMAGE_TASK_TIMEOUT_MS;
      // processing 起算于 claim 时刻（startedAt）；pending 起算于创建时刻（从未被 claim）
      const base = (row.status === 'processing' ? row.startedAt?.getTime() : row.createdAt.getTime()) ?? now;
      if (now <= base + timeout) continue;

      // Pre-M9 G7：先问 provider 真实状态——远端已完成的任务绝不能被本地判超时（钱花了、结果丢了）
      if (row.remoteTaskId) {
        const outcome = await this.media.recoverRemoteGenerationTask(row.id)
          .catch((err) => { this.logger.warn({ taskId: row.id, err: (err as Error).message }, '远端恢复失败（转入超时兜底）'); return 'unknown' as const; });
        if (outcome === 'completed' || outcome === 'failed') {
          recovered++;
          this.logger.log({ taskId: row.id, outcome }, '孤儿任务已按远端真实状态恢复（未判超时）');
          continue;
        }
        // 远端仍在执行：护栏内保持非终态（远端权威）；超出护栏才按超时兜底
        if (outcome === 'processing' && now <= base + timeout * REMOTE_PROCESSING_GRACE_FACTOR) continue;
      }

      const done = await this.prisma.generationTask.updateMany({
        where: { id: row.id, status: { in: ['processing', 'pending'] } },
        data: {
          status: 'failed', statusMessage: '任务超时', errorCode: ErrorCode.MEDIA_TASK_TIMEOUT, errorMessage: '任务超时', completedAt: new Date(),
        },
      });
      if (done.count === 0) continue; // 竞态：已被正常路径终态
      await this.usage.recordMediaUsage({
        userId: row.userId, conversationId: row.conversationId ?? undefined, messageId: row.messageId ?? undefined, taskId: row.id,
        kind: row.type, providerId: row.providerId ?? '', modelId: row.modelId ?? '',
        imageCount: 0, videoSeconds: 0, latencyMs: now - base,
        status: 'failed', errorCode: ErrorCode.MEDIA_TASK_TIMEOUT, runId: row.runId ?? undefined,
      }).catch(() => undefined);
      // Pre-M9 C1：清扫终态释放配额预留
      await this.quota.release(row.id, row.type === 'image' ? 'image_generation' : 'video_seconds').catch(() => undefined);
      // M6-P4：任务超时也是终态 → 唤醒 run（任务超时 ≠ run 超时；失败回喂模型由 LLM 决策）
      await this.resume.onTaskTerminal(row.id).catch(() => undefined);
      swept++;
      this.logger.warn({ taskId: row.id, type: row.type, status: row.status, provider: row.providerId ?? 'unknown' }, '孤儿任务已清扫为失败（超时）');
    }
    // Pre-M9 G7：同一清扫周期内恢复外部动作域的 executing 残留行（域内幂等；失败绝不打断媒体清扫）
    const actions = await this.externalActions.recoverStaleExecutingActions()
      .catch((err) => { this.logger.warn({ err: (err as Error).message }, '外部动作恢复失败（本轮跳过）'); return { scanned: 0, recovered: 0 }; });
    if (swept > 0 || recovered > 0 || actions.recovered > 0) {
      this.logger.log(`清扫完成: ${swept} 个超时任务, ${recovered} 个远端恢复, 外部动作恢复 ${actions.recovered}/${actions.scanned}`);
    }
    return swept;
  }

  /**
   * 清扫 stale AgentRun（M4 Audit MUST-1）：running 且 startedAt 超过阈值 → timeout。返回清扫数。
   * M6-A2：只扫 `workerId IS NULL` 的同步 run（M5 语义不变）；异步 run（workerId 非空）由 lease 恢复链路
   * （P3）接管——cleanup worker 绝不把合法 long-running async run 直接 timeout。
   */
  async sweepAgentRuns(): Promise<number> {
    const now = Date.now();
    const limits = await this.prisma.systemSetting.findUnique({ where: { key: 'limits' } });
    const timeoutMs = (limits?.value as { agentRunTimeoutMs?: number } | null)?.agentRunTimeoutMs ?? DEFAULT_AGENT_RUN_TIMEOUT_MS;
    const rows = await this.prisma.agentRun.findMany({
      where: { status: 'running', workerId: null },
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
      // Pre-M9 C1：清扫终态释放配额预留
      await this.quota.release(row.id, 'agent_run').catch(() => undefined);
      swept++;
      this.logger.warn({ runId: row.id, agentId: row.agentId }, '孤儿 AgentRun 已清扫为 timeout');
    }
    if (swept > 0) this.logger.log(`AgentRun 清扫完成: ${swept} 个超时 run`);
    return swept;
  }
}
