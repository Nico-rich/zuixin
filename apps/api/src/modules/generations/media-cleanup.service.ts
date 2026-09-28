import { Inject, Injectable, Logger } from '@nestjs/common';
import { LIMITS, ErrorCode } from '@ai-agent/shared';
import type { Prisma } from '@prisma/client';
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
 * M11-P7 D2-12（无界载入治理）：单批载入上限 + 单周期批数上限 + 游标分页。
 * 原实现两处 `findMany` 一次载入**全部** processing/pending 任务与全部同步 running run
 * （积压越多内存/RT 越不可控）；现改为「超时判定下推 SQL + take 分页」：单批 200 行、单周期最多 10 批；
 * 余量由下个清扫周期（5min）继续——有界工作，绝不无限循环，也绝不漏行（游标列不可变）。
 */
const SWEEP_BATCH = 200;
const SWEEP_MAX_BATCHES = 10;

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
    const videoCutoff = new Date(now - LIMITS.VIDEO_TASK_TIMEOUT_MS);
    const imageCutoff = new Date(now - LIMITS.IMAGE_TASK_TIMEOUT_MS);
    // M11-P7 D2-12：超时判定下推 SQL——只有**必然进入清扫面**的行才会被载入：
    //   processing 起算 startedAt、pending 起算 createdAt；type 决定阈值（video/image）。
    // 下推条件与逐行判定 `now > base + timeout` **严格等价**（不漏判），且**不收紧**：超过基础超时但仍在
    // 「远端护栏」内的行同样被载入（远端恢复/护栏保活都发生在超时之后，绝不能因下推而跳过问远端）。
    const where: Prisma.GenerationTaskWhereInput = {
      OR: [
        { status: 'processing', type: 'video', startedAt: { lt: videoCutoff } },
        { status: 'processing', type: 'image', startedAt: { lt: imageCutoff } },
        { status: 'pending', type: 'video', createdAt: { lt: videoCutoff } },
        { status: 'pending', type: 'image', createdAt: { lt: imageCutoff } },
      ],
    };
    let swept = 0;
    let recovered = 0;
    let cursorId: string | undefined;
    for (let batch = 0; batch < SWEEP_MAX_BATCHES; batch++) {
      const rows = await this.prisma.generationTask.findMany({
        where,
        select: {
          id: true, type: true, status: true, startedAt: true, createdAt: true, remoteTaskId: true,
          userId: true, providerId: true, modelId: true, conversationId: true, messageId: true, runId: true,
        },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], // 最旧优先（createdAt 不可变 ⇒ 游标页绝不漏行/重复行）
        take: SWEEP_BATCH,
        ...(cursorId ? { cursor: { id: cursorId }, skip: 1 } : {}),
      });
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
      const last = rows[rows.length - 1];
      if (rows.length < SWEEP_BATCH || !last || last.id === cursorId) break; // 末批/游标未前进 → 本轮结束
      cursorId = last.id;
      if (batch === SWEEP_MAX_BATCHES - 1) {
        this.logger.warn({ batch: SWEEP_BATCH, maxBatches: SWEEP_MAX_BATCHES }, 'GenerationTask 清扫达到单周期分页上限 → 剩余任务由下个清扫周期继续');
      }
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
    // M11-P7 D2-12：超时判定下推 SQL（now - startedAt > timeoutMs ⇔ startedAt < now - timeoutMs，严格等价 ⇒ 不漏判）
    // + take 分页：不再一次载入全部同步 running run（积压时内存/RT 不可控）；startedAt 不可变 ⇒ 游标页绝不漏行/重复行。
    const cutoff = new Date(now - timeoutMs);
    let swept = 0;
    let cursorId: string | undefined;
    for (let batch = 0; batch < SWEEP_MAX_BATCHES; batch++) {
      const rows = await this.prisma.agentRun.findMany({
        where: { status: 'running', workerId: null, startedAt: { lt: cutoff } },
        select: { id: true, startedAt: true, agentId: true, userId: true },
        orderBy: [{ startedAt: 'asc' }, { id: 'asc' }], // 最旧优先
        take: SWEEP_BATCH,
        ...(cursorId ? { cursor: { id: cursorId }, skip: 1 } : {}),
      });
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
      const last = rows[rows.length - 1];
      if (rows.length < SWEEP_BATCH || !last || last.id === cursorId) break; // 末批/游标未前进 → 本轮结束
      cursorId = last.id;
      if (batch === SWEEP_MAX_BATCHES - 1) {
        this.logger.warn({ batch: SWEEP_BATCH, maxBatches: SWEEP_MAX_BATCHES }, 'AgentRun 清扫达到单周期分页上限 → 剩余 run 由下个清扫周期继续');
      }
    }
    if (swept > 0) this.logger.log(`AgentRun 清扫完成: ${swept} 个超时 run`);
    return swept;
  }
}
