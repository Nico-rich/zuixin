import { Inject, Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AppError, ErrorCode } from '../../common/errors/app-error';
import { CommerceService, TimeRangeInput } from './commerce.service';
import { ArtifactService } from '../artifacts/artifact.service';
import { withToolCallLedger } from '../../core/tools/tool-call-ledger';
import { readPolicyThresholds } from '../system-settings/policy-thresholds';

export interface AnalysisToolInput {
  provider?: string;
  connectionId?: string;
  analysisType: string;
  timeRange?: TimeRangeInput;
  possibleCauses?: string[];
  recommendations?: string[];
}

export interface BriefToolInput {
  problem: string;
  objective: string;
  target?: string;
  creativeAngle?: string;
  visualDirection?: string;
  copyDirection?: string;
  constraints?: Record<string, unknown>;
  platform?: string;
  product?: Record<string, unknown>;
  analysisId?: string;
}

const ANALYSIS_TYPES = new Set(['sales', 'traffic', 'conversion', 'ads', 'roas', 'revenue', 'inventory', 'composite']);
/**
 * 异常规则阈值（服务端规则，非 LLM）：较前一期变化超过阈值 → anomaly（含 base/compare 事实）。
 * M12-P4：由编译期常量改为 **SystemSetting('policyThresholds').commerce.anomalyPct 优先、本常量兜底**
 * （调用方仍可显式传参——纯函数的确定性不变；阈值永远来自服务端配置，绝不来自 LLM/请求体）。
 */
export const ANOMALY_THRESHOLD_PCT = 10;

const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * M7-P5 电商分析 + 创意决策环（事实/推测严格分层）：
 * - CommerceAnalysis：facts/derived/anomalies 全部服务端计算（CommerceService 输出 + 规则异常检测）；
 *   possibleCauses/recommendations 由 LLM 提供，独立字段存储并标注 source='llm-interpretation'——绝不混入事实；
 * - CreativeBrief：证据快照自 Analysis（facts/derived/anomalies，标注 service-computed）；
 *   LLM 提供的创意方向（angle/visual/copy）原样存储并标注 source='llm-suggestion'；
 *   镜像 Artifact(creative_brief)（与现有制品体系整合，idempotencyKey 幂等）。
 */
@Injectable()
export class CommerceAnalysisService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(CommerceService) private readonly commerce: CommerceService,
    @Inject(ArtifactService) private readonly artifacts: ArtifactService,
  ) {}

  /** 服务端异常规则：当前窗 vs 前一期同长窗口，指标下降 ≥ 阈值 → anomaly（threshold 标注，绝不含 LLM 归因）。
   *  指标值优先取 facts（原始），派生类指标（roas/ctr/conversionRate）取 derived。 */
  private detectAnomalies(
    current: { facts: Record<string, unknown>; derived: Record<string, unknown> },
    previous: { facts: Record<string, unknown>; derived: Record<string, unknown> },
    thresholdPct: number = ANOMALY_THRESHOLD_PCT,
  ): Array<Record<string, unknown>> {
    const anomalies: Array<Record<string, unknown>> = [];
    const watch = ['revenue', 'netRevenue', 'orders', 'conversionRate', 'roas', 'ctr', 'visits'] as const;
    const valueOf = (s: { facts: Record<string, unknown>; derived: Record<string, unknown> }, metric: string) =>
      s.facts[metric] ?? s.derived[metric];
    for (const metric of watch) {
      const cur = Number(valueOf(current, metric));
      const prev = Number(valueOf(previous, metric));
      if (!Number.isFinite(cur) || !Number.isFinite(prev) || prev === 0) continue;
      const changePct = round2(((cur - prev) / prev) * 100);
      if (changePct <= -thresholdPct) {
        anomalies.push({
          metric, direction: 'decline', changePct,
          base: prev, compare: cur,
          threshold: `较前一期下降 ≥ ${thresholdPct}%`,
          rule: 'server-threshold', // 服务端规则，非 LLM 判定
        });
      }
    }
    return anomalies;
  }

  async generateAnalysis(userId: string, input: AnalysisToolInput, ctx: { agentRunId?: string; projectId?: string; toolCallId?: string | null } = {}) {
    if (!ANALYSIS_TYPES.has(input.analysisType)) throw new AppError(ErrorCode.VALIDATION_ERROR, '不支持的分析类型');
    const timeRange = this.commerce.resolveTimeRange(input.timeRange);
    const base = { provider: input.provider, connectionId: input.connectionId, timeRange };
    // 当前窗事实 + 前一期对比（异常检测基线）
    const prevStart = new Date(timeRange.start.getTime() - (timeRange.end.getTime() - timeRange.start.getTime()));
    const prev = { ...base, timeRange: { start: prevStart, end: timeRange.start } };
    const [summary, prevSummary] = await Promise.all([
      this.gather(userId, input.analysisType, base),
      this.gather(userId, input.analysisType, prev).catch(() => null), // 前一期无数据 → 无异常（不阻断）
    ]);
    // M12-P4：异常阈值 = SystemSetting 优先 / 编译期常量兜底（服务端规则，绝不采信 LLM 或请求体阈值）
    const { commerce } = await readPolicyThresholds(this.prisma);
    const anomalies = prevSummary ? this.detectAnomalies(summary, prevSummary, commerce.anomalyPct) : [];

    // G11：分析事实写入走 ToolCall 幂等账本（崩溃重放复用首次结果，绝不产生第二份分析事实）
    return withToolCallLedger(this.prisma, ctx.toolCallId, async (tx) => {
      const row = await tx.commerceAnalysis.create({
        data: {
          userId, projectId: ctx.projectId ?? null, agentRunId: ctx.agentRunId ?? null,
          connectionId: input.connectionId ?? null, analysisType: input.analysisType,
          timeRange: { start: timeRange.start.toISOString(), end: timeRange.end.toISOString() } as never,
          facts: summary.facts as never,
          derived: summary.derived as never,
          anomalies: anomalies as never,
          // LLM 推测独立存储：source 标注，绝不写入 facts/derived/anomalies
          possibleCauses: (input.possibleCauses?.length
            ? { source: 'llm-interpretation', items: input.possibleCauses }
            : null) as never,
          recommendations: (input.recommendations?.length
            ? { source: 'llm-recommendation', items: input.recommendations }
            : null) as never,
          status: 'ready',
        },
      });
      return this.view(row);
    });
  }

  /** 按分析类型聚合事实（全部来自 CommerceService，服务端计算） */
  private async gather(userId: string, analysisType: string, base: { provider?: string; connectionId?: string; timeRange: { start: Date; end: Date } }) {
    const input = {
      provider: base.provider, connectionId: base.connectionId,
      timeRange: { start: base.timeRange.start.toISOString(), end: base.timeRange.end.toISOString() },
    };
    switch (analysisType) {
      case 'traffic': return this.commerce.trafficSummary(userId, input);
      case 'ads': case 'roas': {
        const r = await this.commerce.adsPerformance(userId, input);
        return { facts: this.flattenFacts(r.facts), derived: {} };
      }
      case 'inventory': return this.commerce.inventorySummary(userId, input);
      case 'sales': case 'conversion': case 'revenue': case 'composite':
      default: return this.commerce.analyticsSummary(userId, input);
    }
  }

  private flattenFacts(rows: Record<string, unknown>[]): Record<string, unknown> {
    const out: Record<string, number> = {};
    for (const r of rows) {
      for (const [k, v] of Object.entries(r)) {
        if (typeof v === 'number') out[k] = (out[k] ?? 0) + v;
      }
    }
    return out;
  }

  async getAnalysis(userId: string, id: string) {
    const row = await this.prisma.commerceAnalysis.findFirst({ where: { id, userId } });
    if (!row) throw new AppError(ErrorCode.NOT_FOUND, '分析不存在');
    return this.view(row);
  }

  private view(row: {
    id: string; analysisType: string; timeRange: unknown; facts: unknown; derived: unknown;
    anomalies: unknown; possibleCauses: unknown; recommendations: unknown; status: string;
    agentRunId: string | null; createdAt: Date;
  }) {
    return {
      analysisId: row.id, analysisType: row.analysisType, timeRange: row.timeRange,
      facts: row.facts, derived: row.derived, anomalies: row.anomalies,
      possibleCauses: row.possibleCauses, recommendations: row.recommendations,
      status: row.status, agentRunId: row.agentRunId, createdAt: row.createdAt,
      // 显式标注：哪些是事实，哪些是推测——消费者（前端/后续 Agent）不得混淆
      layering: { facts: 'service-computed', derived: 'service-computed', anomalies: 'service-rule', possibleCauses: 'llm-interpretation', recommendations: 'llm-recommendation' },
    };
  }

  /**
   * 创意简报：problem/objective 必填；evidence = 最新/指定 Analysis 的 facts/derived/anomalies 快照
   * （service-computed 标注）+ 绩效记忆候选（M7-P8 学习闭环：历史创意表现沉淀，performance-memory 标注）；
   * LLM 创意方向字段原样存储（llm-suggestion 标注）；镜像 Artifact(creative_brief)。
   */
  async createBrief(userId: string, input: BriefToolInput, ctx: { agentRunId?: string; projectId?: string; conversationId?: string; messageId?: string; idempotencyKey?: string; toolCallId?: string | null } = {}) {
    let analysis: { id: string; facts: unknown; derived: unknown; anomalies: unknown } | null = null;
    if (input.analysisId) {
      const a = await this.prisma.commerceAnalysis.findFirst({ where: { id: input.analysisId, userId } });
      if (!a) throw new AppError(ErrorCode.NOT_FOUND, '分析不存在');
      analysis = a;
    } else {
      // 未指定 → 自动关联最近一次 ready 分析（创意决策环的默认数据底座）
      analysis = await this.prisma.commerceAnalysis.findFirst({ where: { userId, status: 'ready' }, orderBy: { createdAt: 'desc' } });
    }
    // M7-P8 学习闭环：绩效记忆候选作为证据底座（标注 performance-memory，与事实层严格分离）
    const performanceMemory = await this.prisma.memory.findMany({
      where: { userId, status: { in: ['candidate', 'active'] }, metadata: { path: ['kind'], equals: 'performance' } },
      orderBy: { updatedAt: 'desc' },
      take: 5,
    });

    // G11：简报事实写入走 ToolCall 幂等账本（崩溃重放复用首次结果，绝不产生第二份简报）
    const row = await withToolCallLedger(this.prisma, ctx.toolCallId, (tx) => tx.creativeBrief.create({
      data: {
        userId, projectId: ctx.projectId ?? null, agentRunId: ctx.agentRunId ?? null,
        commerceAnalysisId: analysis?.id ?? null,
        problem: input.problem, objective: input.objective,
        target: input.target, creativeAngle: input.creativeAngle,
        visualDirection: input.visualDirection, copyDirection: input.copyDirection,
        constraints: (input.constraints ?? null) as never,
        platform: input.platform,
        product: (input.product ? { source: 'llm-suggestion', data: input.product } : null) as never,
        evidence: (analysis || performanceMemory.length > 0
          ? {
              source: 'commerce-analysis-snapshot', analysisId: analysis?.id ?? null,
              layering: { facts: 'service-computed', derived: 'service-computed', anomalies: 'service-rule', performanceMemory: 'memory-candidate' },
              facts: analysis?.facts ?? null, derived: analysis?.derived ?? null, anomalies: analysis?.anomalies ?? null,
              performanceMemory: performanceMemory.map((m) => ({ id: m.id, content: m.content, status: m.status })),
            }
          : null) as never,
        status: 'ready',
      },
    }));

    // Artifact 镜像（creative_brief 制品；幂等键 = ToolCall 级，resume 重放绝不重复建）
    let artifactId: string | null = null;
    if (ctx.idempotencyKey) {
      const artifact = await this.artifacts.create(userId, {
        type: 'creative_brief', title: input.problem.slice(0, 80), summary: input.objective,
        content: { briefId: row.id, analysisId: analysis?.id ?? null, creativeAngle: input.creativeAngle, visualDirection: input.visualDirection },
        projectId: ctx.projectId, conversationId: ctx.conversationId, messageId: ctx.messageId,
        runId: ctx.agentRunId, toolCallId: undefined,
        idempotencyKey: ctx.idempotencyKey,
      }).catch(() => null);
      artifactId = artifact?.id ?? null;
    }
    if (artifactId) {
      await this.prisma.creativeBrief.update({ where: { id: row.id }, data: { artifactId } }).catch(() => undefined);
    }
    return {
      briefId: row.id, artifactId, status: row.status,
      problem: row.problem, objective: row.objective, creativeAngle: row.creativeAngle,
      visualDirection: row.visualDirection, platform: row.platform,
      analysisId: analysis?.id ?? null,
      evidenceSummary: analysis ? { factsKeys: Object.keys((analysis.facts as Record<string, unknown>) ?? {}) } : null,
      layering: { creativeAngle: 'llm-suggestion', visualDirection: 'llm-suggestion', evidence: 'service-computed' },
    };
  }

  async getBrief(userId: string, id: string) {
    const row = await this.prisma.creativeBrief.findFirst({ where: { id, userId } });
    if (!row) throw new AppError(ErrorCode.NOT_FOUND, '创意简报不存在');
    return row;
  }
}
