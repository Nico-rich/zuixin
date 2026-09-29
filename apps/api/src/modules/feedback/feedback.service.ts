import { Inject, Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { MemoryService } from '../../core/memory/memory.service';
import { AppError, ErrorCode } from '../../common/errors/app-error';
import { withToolCallLedger } from '../../core/tools/tool-call-ledger';
import { readPolicyThresholds } from '../system-settings/policy-thresholds';

const SUBJECT_TYPES = ['artifact', 'creativeBrief', 'product', 'campaign', 'ad', 'generationTask', 'agentRun', 'analysis'] as const;
/**
 * 绩效记忆阈值（服务端规则，非 LLM）：好/差两档。
 *
 * M12-P4：由编译期常量改为 **SystemSetting('policyThresholds').feedback 优先、本常量兜底**
 * （运营者可在 `PATCH /system-settings/policyThresholds` 调档；仅平台管理员可写、强制审计）。
 * 本常量仍是**最后一跳兜底**——与 `DEFAULT_POLICY_THRESHOLDS.feedback` 逐字节一致（单测锁死）。
 */
export const GOOD_CTR = 0.03;
export const GOOD_ROAS = 2;
export const BAD_CTR = 0.01;
export const BAD_ROAS = 1;

/**
 * M7-P8 Feedback + Performance Learning（不改模型权重——学习 = Memory 闭环）：
 * - Feedback：用户/Agent 对制品/简报/素材的评分（1~5）→ 高分/低分派生记忆候选（source=feedback）；
 * - CreativePerformance：发布后绩效回流——facts（原始回流）+ derived（服务端计算 ctr/cvr/roas/cpc）；
 *   达标/不达标 → 记忆候选（source=performance）；PerformanceSnapshot 为通用快照层；
 * - insights：绩效记忆 + 近期绩效事实（labeled：service-computed 事实 vs memory 候选）；
 * - 记忆去重：同一 (subjectType, subjectId) 只产一条候选（metadata 判定，幂等）。
 *
 * Pre-M9 G11：作为 Agent 写副作用工具（feedback.submit / performance.capture）的落点，
 * 两处事实写入均走 ToolCall 幂等账本（`withToolCallLedger`）——执行中崩溃后 resume 重放
 * 绝不产生第二条 Feedback / CreativePerformance 事实（HTTP 直调路径无 toolCallId，行为不变）。
 */
@Injectable()
export class FeedbackService {
  private readonly logger = new Logger('Feedback');

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(MemoryService) private readonly memories: MemoryService,
  ) {}

  /**
   * M10-P15（BUG-15）：`projectId` 一律**服务端归属裁决**。
   *
   * 旧实现把请求体的 `projectId` 原样落库（`submit` / `capturePerformance` 两条路径，
   * 仅 `artifactId` 做了归属校验）——跨租户者可把他人项目 id 写进自己的事实行，
   * 形成跨租户引用注入（归属链断裂：后续按 projectId 归集/配额/审计会把行记到他人项目下）。
   * 与 knowledge/memories/projects 同口径：非本人项目 → 404「项目不存在」（防枚举，不区分"他人项目"与"不存在"）。
   */
  private async requireOwnedProject(userId: string, projectId: string | null | undefined): Promise<void> {
    if (!projectId) return;
    const p = await this.prisma.project.findFirst({ where: { id: projectId, userId, deletedAt: null }, select: { id: true } });
    if (!p) throw new AppError(ErrorCode.NOT_FOUND, '项目不存在');
  }

  async submit(userId: string, input: {
    projectId?: string | null;
    subjectType: string; subjectId: string;
    rating: number; comment?: string;
  }, opts: { toolCallId?: string | null } = {}) {
    if (!(SUBJECT_TYPES as readonly string[]).includes(input.subjectType)) {
      throw new AppError(ErrorCode.VALIDATION_ERROR, '不支持的反馈对象类型');
    }
    if (!Number.isInteger(input.rating) || input.rating < 1 || input.rating > 5) {
      throw new AppError(ErrorCode.VALIDATION_ERROR, '评分必须为 1~5');
    }
    await this.requireOwnedProject(userId, input.projectId);
    // G11：Feedback 事实 + ToolCall 账本同事务（崩溃重放复用账本，绝不产生第二条反馈）
    const row = await withToolCallLedger(this.prisma, opts.toolCallId, (tx) => tx.feedback.create({
      data: {
        userId, projectId: input.projectId ?? null,
        subjectType: input.subjectType, subjectId: input.subjectId,
        rating: input.rating, comment: input.comment,
      },
    }));
    // 学习闭环：高分/低分 → 记忆候选（元数据幂等——同一对象只产一条）
    if (input.rating >= 4 || input.rating <= 2) {
      await this.upsertPerformanceMemory(userId, input.projectId ?? null, {
        kind: 'feedback',
        subjectType: input.subjectType, subjectId: input.subjectId,
        content: `${input.subjectType} ${input.subjectId} 获得评分 ${input.rating}${input.comment ? `（${input.comment}）` : ''}`,
        importance: input.rating >= 4 ? 60 : 40,
      });
    }
    this.logger.log({ userId, subjectType: input.subjectType, rating: input.rating }, '反馈已记录');
    return row;
  }

  async list(userId: string, filters: { subjectType?: string; subjectId?: string } = {}) {
    return this.prisma.feedback.findMany({
      where: { userId, ...(filters.subjectType ? { subjectType: filters.subjectType } : {}), ...(filters.subjectId ? { subjectId: filters.subjectId } : {}) },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
  }

  /** 绩效回流：facts 原始 + derived 服务端派生（绝不混入 LLM 解读）+ 阈值记忆 */
  async capturePerformance(userId: string, input: {
    projectId?: string | null;
    artifactId?: string; campaignId?: string; adId?: string;
    platform?: string; periodStart?: string; periodEnd?: string;
    metrics: { impressions: number; clicks: number; spend: number; conversions: number; revenue: number; orders: number };
  }, opts: { toolCallId?: string | null } = {}) {
    if (input.artifactId) {
      const a = await this.prisma.artifact.findFirst({ where: { id: input.artifactId, userId } });
      if (!a) throw new AppError(ErrorCode.NOT_FOUND, '制品不存在');
    }
    await this.requireOwnedProject(userId, input.projectId); // M10-P15（BUG-15）
    const m = input.metrics;
    const periodEnd = input.periodEnd ? new Date(input.periodEnd) : new Date();
    const periodStart = input.periodStart ? new Date(input.periodStart) : new Date(periodEnd.getTime() - 30 * 86400_000);
    const derived = this.derive(m);
    // G11：绩效事实 + 通用快照 + ToolCall 账本同事务。
    // 快照原为 best-effort（吞错）——事务内吞错会让整个事务进入 aborted 状态，故改为同生同死：
    // 事实与快照要么都写入，要么都不写入（重放时账本命中，绝不产生第二行事实/快照）。
    const result = await withToolCallLedger(this.prisma, opts.toolCallId, async (tx) => {
      const row = await tx.creativePerformance.create({
        data: {
          userId, projectId: input.projectId ?? null,
          artifactId: input.artifactId, campaignId: input.campaignId, adId: input.adId,
          platform: input.platform ?? 'mock', periodStart, periodEnd,
          impressions: m.impressions, clicks: m.clicks, spend: m.spend,
          conversions: m.conversions, revenue: m.revenue, orders: m.orders,
        },
      });
      await tx.performanceSnapshot.create({
        data: {
          userId, projectId: input.projectId ?? null,
          source: 'mock', periodStart, periodEnd,
          metrics: { ...m, derived, subject: { artifactId: input.artifactId, campaignId: input.campaignId, adId: input.adId } } as never,
        },
      });
      return {
        performanceId: row.id,
        facts: { impressions: m.impressions, clicks: m.clicks, spend: m.spend, conversions: m.conversions, revenue: m.revenue, orders: m.orders },
        derived,
        layering: { facts: 'reported', derived: 'service-computed', memory: 'service-rule' },
      };
    });

    // 阈值记忆：好/差（服务端规则；learning = Memory，不改模型）——metadata 幂等，重放再走也不产第二条。
    // M12-P4：阈值 = SystemSetting 优先 / 编译期常量兜底（绝不采信 LLM 或调用方传入的阈值）。
    const { feedback: t } = await readPolicyThresholds(this.prisma);
    if (derived.ctr >= t.goodCtr || derived.roas >= t.goodRoas) {
      await this.upsertPerformanceMemory(userId, input.projectId ?? null, {
        kind: 'performance',
        subjectType: 'creativePerformance', subjectId: result.performanceId,
        content: `创意${input.artifactId ? ` ${input.artifactId}` : ''}近一期 CTR ${(derived.ctr * 100).toFixed(1)}% ROAS ${derived.roas}（表现好）`,
        importance: 70,
      });
    } else if (derived.ctr <= t.badCtr || derived.roas <= t.badRoas) {
      await this.upsertPerformanceMemory(userId, input.projectId ?? null, {
        kind: 'performance',
        subjectType: 'creativePerformance', subjectId: result.performanceId,
        content: `创意${input.artifactId ? ` ${input.artifactId}` : ''}近一期 CTR ${(derived.ctr * 100).toFixed(1)}% ROAS ${derived.roas}（表现差，建议调整方向）`,
        importance: 70,
      });
    }
    return result;
  }

  async listPerformance(userId: string, filters: { artifactId?: string; campaignId?: string } = {}) {
    return this.prisma.creativePerformance.findMany({
      where: { userId, ...(filters.artifactId ? { artifactId: filters.artifactId } : {}), ...(filters.campaignId ? { campaignId: filters.campaignId } : {}) },
      orderBy: { capturedAt: 'desc' },
      take: 50,
    });
  }

  /** 学习洞察：绩效记忆候选 + 近期绩效事实（分层标注）——未来创意简报的数据底座 */
  async insights(userId: string, limit = 10) {
    const [memories, performances] = await Promise.all([
      this.prisma.memory.findMany({
        where: { userId, status: { in: ['candidate', 'active'] }, metadata: { path: ['kind'], equals: 'performance' } },
        orderBy: { updatedAt: 'desc' },
        take: limit,
      }),
      this.prisma.creativePerformance.findMany({
        where: { userId },
        orderBy: { capturedAt: 'desc' },
        take: limit,
      }),
    ]);
    return {
      performanceMemory: memories.map((m) => ({ id: m.id, content: m.content, status: m.status, source: 'memory' })),
      recentPerformance: performances.map((p) => ({
        performanceId: p.id, subject: { artifactId: p.artifactId, campaignId: p.campaignId },
        facts: { impressions: p.impressions, clicks: p.clicks, spend: p.spend, conversions: p.conversions, revenue: p.revenue, orders: p.orders },
        derived: this.derive(p),
        source: 'service-computed',
      })),
      layering: { performanceMemory: 'memory-candidate', recentPerformance: 'service-computed' },
    };
  }

  private derive(m: { impressions: number; clicks: number; spend: number; conversions: number; revenue: number }): Record<string, number> {
    const round2 = (n: number) => Math.round(n * 100) / 100;
    return {
      ctr: m.impressions > 0 ? round2(m.clicks / m.impressions) : 0,
      cvr: m.clicks > 0 ? round2(m.conversions / m.clicks) : 0,
      roas: m.spend > 0 ? round2(m.revenue / m.spend) : 0,
      cpc: m.clicks > 0 ? round2(m.spend / m.clicks) : 0,
    };
  }

  /** 绩效记忆幂等 upsert：同一 (kind, subjectType, subjectId) 只产一条候选 */
  private async upsertPerformanceMemory(userId: string, projectId: string | null, input: {
    kind: string; subjectType: string; subjectId: string; content: string; importance: number;
  }): Promise<void> {
    // 幂等去重：同 (derivedFrom, subjectId) 只产一条（metadata 判定；kind 统一为 'performance'）
    const existing = await this.prisma.memory.findFirst({
      where: {
        userId,
        metadata: { path: ['derivedFrom'], equals: input.kind },
      },
      select: { id: true, metadata: true },
    });
    const same = existing && (existing.metadata as { subjectId?: string } | null)?.subjectId === input.subjectId;
    if (same) return; // 幂等：绝不重复产记忆
    await this.memories.create(userId, {
      scope: projectId ? 'project' : 'user',
      projectId: projectId ?? undefined,
      content: input.content,
      category: 'other',
      importance: input.importance,
      confidence: 0.9,
      status: 'candidate',
      source: input.kind === 'feedback' ? 'feedback' : 'assistant',
      metadata: { kind: 'performance', subjectType: input.subjectType, subjectId: input.subjectId, derivedFrom: input.kind },
    }).catch((err) => this.logger.warn(`绩效记忆写入失败: ${(err as Error).message}`));
  }
}
