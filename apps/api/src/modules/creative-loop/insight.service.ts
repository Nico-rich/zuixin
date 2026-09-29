/**
 * M9-P5 洞察服务（Performance 事实聚合 + LLM 解读分层隔离）。
 *
 * 事实来源（**全部复用既有系统，绝不新建第二套**）：
 * - 绩效回流：M7-P8 `Feedback`（评分）+ `CreativePerformance`（曝光/点击/花费/转化/营收/订单原始事实）——
 *   只读聚合，事实层 = 窗口内行的求和（规则层由 insight-rules.ts 纯函数计算）；
 *   **只计入非 agent 来源的行**（M12-P1 来源判别：`performance.capture` 是 agent 可写工具，
 *   排除计数随事实留痕 `sources.agentExcluded`，绝不静默丢弃）；
 * - 判定先例（M12-P1 verdict→下一次决策桥）：本组织/项目**既有** validated/rejected 假设的判定结论
 *   （`facts.verdicts`）——**只读引用**，绝不改写历史假设行；新洞察把先例作为决策输入事实；
 * - 评测事实：M9-P1 `EvaluationRunsService`（列出组织内 run + 读其 `scores` 摘要——聚合口径由 P1 的
 *   `summarizeScores` 独家提供，本模块**不重算**评测分数）；
 * - 解读层：LLM 文本（可选）经 `attachInterpretation` 独立字段写入，**绝不触碰 facts/derived**
 *   （写入前 `assertFactsUnchanged` 断言 + `factsHash` 条件更新双保险）。
 *
 * 分层标注（消费方按 layering 字段区分；与 M7-P5 CommerceAnalysis 同一口径）：
 *   facts=service-computed / derived=service-computed / interpretation=llm-interpretation。
 */

import { Inject, Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { EvaluationRunsService } from '../evaluation/evaluation-runs.service';
import { AppError, ErrorCode } from '../../common/errors/app-error';
import { CreativeLoopAccessService, LoopScope } from './creative-loop-access.service';
import { HypothesisStore, InsightDoc, InsightStore, StoredDoc, VERDICT_PRECEDENT_TAKE } from './creative-loop-store';
import {
  ComparisonEntry, InsightThresholds, RatingFacts, assertFactsUnchanged, comparePeriods, derivePerfMetrics,
  excludeAgentPerformance, factsHashOf, sumPerfFacts, summarizeRatings,
} from './insight-rules';
import { PerformanceProvenanceService } from './performance-provenance.service';
import { readPolicyThresholds } from '../system-settings/policy-thresholds';

/** 洞察窗口默认跨度（天） */
export const DEFAULT_INSIGHT_DAYS = 30;
/** 单次洞察聚合的评测 run 上限（读路径有界） */
const EVALUATION_RUN_LIMIT = 5;

export interface InsightView extends InsightDoc {
  id: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface BuildInsightInput {
  organizationId?: string;
  projectId?: string;
  days?: number;
  /** 限定单个创意（artifactId）/ 广告（campaignId）；缺省 = 项目/用户全量 */
  artifactId?: string;
  campaignId?: string;
  /** 是否聚合评测事实（默认 true；关掉 = 纯绩效事实，便于最小读） */
  includeEvaluation?: boolean;
}

@Injectable()
export class InsightService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(InsightStore) private readonly store: InsightStore,
    @Inject(HypothesisStore) private readonly hypotheses: HypothesisStore,
    @Inject(CreativeLoopAccessService) private readonly access: CreativeLoopAccessService,
    @Inject(EvaluationRunsService) private readonly evaluationRuns: EvaluationRunsService,
    @Inject(PerformanceProvenanceService) private readonly provenance: PerformanceProvenanceService,
  ) {}

  /**
   * 生成洞察快照（当期 vs 前一期；事实/派生/解读三层，解读留空）。
   * 窗口口径：以 `capturedAt` 落窗（回流事实的捕获时间）——[now-days, now] 为当期，[now-2*days, now-days) 为前一期。
   */
  async build(userId: string, input: BuildInsightInput): Promise<InsightView> {
    const scope = await this.access.resolveScope(userId, {
      organizationId: input.organizationId,
      projectId: input.projectId,
    });
    await this.access.requireRead(userId, scope.organizationId);

    const days = input.days ?? DEFAULT_INSIGHT_DAYS;
    const now = new Date();
    const dayMs = 86400_000;
    const currentStart = new Date(now.getTime() - days * dayMs);
    const previousStart = new Date(now.getTime() - 2 * days * dayMs);

    const perfWhere = {
      userId,
      ...(scope.projectId ? { projectId: scope.projectId } : {}),
      ...(input.artifactId ? { artifactId: input.artifactId } : {}),
      ...(input.campaignId ? { campaignId: input.campaignId } : {}),
    };

    const [currentRows, previousRows, feedbackRows] = await Promise.all([
      this.prisma.creativePerformance.findMany({ where: { ...perfWhere, capturedAt: { gte: currentStart } } }),
      this.prisma.creativePerformance.findMany({ where: { ...perfWhere, capturedAt: { gte: previousStart, lt: currentStart } } }),
      this.prisma.feedback.findMany({
        where: {
          userId,
          ...(scope.projectId ? { projectId: scope.projectId } : {}),
          subjectType: { in: ['artifact', 'creativeBrief', 'generationTask'] },
          createdAt: { gte: currentStart },
        },
        select: { rating: true },
      }),
    ]);

    // M12-P1 来源判别：agent 工具写入的绩效行绝不进入事实层（排除计数留痕——绝不静默丢弃）
    const provenance = await this.provenance.agentAuthoredIds(userId);
    const current = excludeAgentPerformance(currentRows, provenance.ids);
    const previous = excludeAgentPerformance(previousRows, provenance.ids);
    const currentFacts = sumPerfFacts(current.rows);
    const previousFacts = sumPerfFacts(previous.rows);
    const currentDerived = derivePerfMetrics(currentFacts);
    const previousDerived = derivePerfMetrics(previousFacts);
    // M12-P4：洞察阈值 = SystemSetting 优先 / 编译期常量兜底（纯函数只接收显式阈值——无隐式全局态）
    const thresholds: InsightThresholds = (await readPolicyThresholds(this.prisma)).insight;
    const ratings: RatingFacts = summarizeRatings(feedbackRows.map((f) => f.rating), thresholds);
    const comparison: ComparisonEntry[] = comparePeriods(
      currentDerived as unknown as Record<string, number>,
      previousDerived as unknown as Record<string, number>,
      ['ctr', 'cvr', 'roas', 'cpc'],
      thresholds.comparisonPct,
    );
    const evaluation = input.includeEvaluation === false
      ? { runs: [], aggregate: null }
      : await this.evaluationFacts(scope.organizationId);

    const verdicts = await this.verdictFacts(scope);
    const facts: Record<string, unknown> = {
      window: { start: currentStart.toISOString(), end: now.toISOString(), days },
      performance: {
        current: currentFacts,
        previous: previousFacts,
        sources: {
          current: current.rows.length,
          previous: previous.rows.length,
          agentExcluded: { current: current.excludedAgentRows, previous: previous.excludedAgentRows },
        },
        provenance: {
          rule: provenance.rule,
          scanned: provenance.scanned,
          complete: provenance.complete,
          ...(provenance.complete ? {} : { reason: 'agent 工具账本枚举触顶：事实层可能仍含 agent 来源行，消费方须自行复核' }),
        },
        rule: 'server-sum',
      },
      ratings: { ...ratings, rule: 'server-sum' },
      evaluation: { runs: evaluation.runs, rule: 'evaluation-run-summary' },
      verdicts,
    };
    const derived: Record<string, unknown> = {
      metrics: currentDerived,
      baseline: previousDerived,
      comparison,
      ratingSummary: { avgRating: ratings.avgRating, positiveRate: ratings.positiveRate, negativeRate: ratings.negativeRate },
      evaluation: evaluation.aggregate,
      rule: 'server-comparison',
    };

    const doc: InsightDoc = {
      kind: 'creative_insight',
      organizationId: scope.organizationId,
      projectId: scope.projectId,
      window: { start: currentStart.toISOString(), end: now.toISOString(), days },
      filters: {
        artifactId: input.artifactId ?? null,
        campaignId: input.campaignId ?? null,
        projectId: scope.projectId,
      },
      facts,
      derived,
      factsHash: factsHashOf(facts, derived),
      interpretation: null,
      layering: {
        facts: 'service-computed',
        derived: 'service-computed',
        interpretation: 'llm-interpretation',
      },
    };
    const stored = await this.store.create(userId, doc);
    return this.toView(stored);
  }

  async list(userId: string, query: { organizationId?: string; projectId?: string; limit?: number }): Promise<{ insights: InsightView[] }> {
    const scope = await this.access.resolveScope(userId, {
      organizationId: query.organizationId,
      projectId: query.projectId,
    });
    await this.access.requireRead(userId, scope.organizationId);
    const rows = await this.store.list({
      organizationId: scope.organizationId,
      projectId: scope.projectId ?? undefined,
      take: query.limit ?? 50,
    });
    return { insights: rows.map((r) => this.toView(r)) };
  }

  async get(userId: string, id: string): Promise<InsightView> {
    const stored = await this.requireReadable(userId, id);
    return this.toView(stored);
  }

  /**
   * 写入 LLM 解读（**隔离不变量**：facts/derived 逐字节不变 + factsHash 条件更新；
   * 并发不覆盖：条件更新同时锚定**读取时行版本**——期间任何写入都让本次写入 count=0，M11-P5/D2-02）。
   * 事实层在本方法内**只读**（复制自存储行，绝不接收调用方传入的 facts/derived）。
   */
  async attachInterpretation(
    userId: string,
    id: string,
    input: { items: string[]; model?: string | null },
  ): Promise<InsightView> {
    const stored = await this.requireWritable(userId, id);
    const attachedAt = new Date().toISOString();
    const next: InsightDoc = {
      ...stored.doc,
      interpretation: {
        source: 'llm-interpretation',
        items: input.items,
        model: input.model ?? null,
        attachedAt,
      },
    };
    // 双保险①：事实层不变断言（违反 → INTERNAL，绝不落库）
    assertFactsUnchanged(stored.doc, next);
    // 双保险②：factsHash **+ 读取时版本** 条件更新（事实已变 → 拒写，解读必须基于最新事实重生成；
    // 期间其它写入 → 拒写，并发解读绝不互相静默覆盖）
    const count = await this.store.saveInterpretation(id, stored.doc.factsHash, next, stored.version);
    if (count === 0) {
      throw new AppError(ErrorCode.VALIDATION_ERROR, '洞察已被并发修改（事实层更新或并发解读写入），请刷新后重试');
    }
    return this.toView({ ...stored, doc: next });
  }

  /** 读路径（服务层内部用；loop 编排按 id 引用洞察事实） */
  async requireReadable(userId: string, id: string): Promise<StoredDoc<InsightDoc>> {
    const stored = await this.store.get(id);
    if (!stored) throw new AppError(ErrorCode.NOT_FOUND, '洞察不存在');
    // M10-P15（BUG-12）：非成员 404 的文案与上方"洞察不存在"逐字相同（反枚举）
    await this.access.authorizeResource(userId, { organizationId: stored.doc.organizationId, userId: stored.userId }, 'workflow.read', '洞察不存在');
    return stored;
  }

  private async requireWritable(userId: string, id: string): Promise<StoredDoc<InsightDoc>> {
    const stored = await this.store.get(id);
    if (!stored) throw new AppError(ErrorCode.NOT_FOUND, '洞察不存在');
    await this.access.authorizeResource(userId, { organizationId: stored.doc.organizationId, userId: stored.userId }, 'workflow.write', '洞察不存在');
    return stored;
  }

  /**
   * 判定先例事实（M12-P1 verdict→下一次决策桥的**事实输入**；只读、服务端聚合）。
   *
   * 为什么属于事实层：先例是"系统内已发生的治理判定"记录（谁在何时依据什么判成什么），
   * 不是解读——新洞察/新假设据此建立"上一轮学到什么"的上下文（此前 verdict 无任何消费方，
   * 闭环在 validated/rejected 处断裂）。**只读引用**：绝不改写来源假设行，也绝不把先例当成
   * 新假设的判定（判定仍只由判据收敛或人工显式 decision 产生）。
   *
   * scope 口径与绩效事实一致：同组织；给了项目则收窄到项目（绝不跨租户）。
   * 有界：按 `updatedAt` 倒序取最近 `VERDICT_PRECEDENT_TAKE` 条。
   */
  private async verdictFacts(scope: LoopScope): Promise<Record<string, unknown>> {
    const rows = await this.hypotheses.listVerdicts({
      organizationId: scope.organizationId,
      projectId: scope.projectId,
      take: VERDICT_PRECEDENT_TAKE,
    });
    const entries: Array<Record<string, unknown>> = [];
    for (const row of rows) {
      const verdict = row.doc.verdict;
      if (!verdict || (verdict.decision !== 'validated' && verdict.decision !== 'rejected')) continue;
      entries.push({
        hypothesisId: row.id,
        statement: row.doc.statement,
        status: row.doc.status,
        projectId: row.doc.projectId,
        decision: verdict.decision,
        decidedBy: verdict.decidedBy,
        reason: verdict.reason,
        decidedAt: verdict.decidedAt,
        criteria: verdict.criteria,
        rule: 'historical-verdict',
      });
    }
    const countBy = (decision: 'validated' | 'rejected') => entries.filter((e) => e.decision === decision).length;
    const byDecider = (by: string) => entries.filter((e) => e.decidedBy === by).length;
    return {
      entries,
      totals: {
        entries: entries.length,
        validated: countBy('validated'),
        rejected: countBy('rejected'),
        byDecider: { criteria: byDecider('criteria'), manual: byDecider('manual'), system: byDecider('system') },
      },
      source: 'historical-verdicts',
      rule: 'server-aggregate',
    };
  }

  /** 评测事实聚合（**只读 P1 摘要**：avgScore/passRate 由 EvaluationRunsService 独家计算） */
  private async evaluationFacts(organizationId: string): Promise<{
    runs: Array<Record<string, unknown>>;
    aggregate: Record<string, unknown> | null;
  }> {
    const runs = await this.evaluationRuns.list(organizationId, { limit: EVALUATION_RUN_LIMIT });
    const completed = runs.filter((r) => r.status === 'completed');
    const rows: Array<Record<string, unknown>> = [];
    for (const run of completed.slice(0, EVALUATION_RUN_LIMIT)) {
      const detail = await this.evaluationRuns.get(organizationId, run.id);
      rows.push({
        runId: run.id,
        datasetId: run.datasetId,
        datasetVersion: run.datasetVersion,
        agentId: run.agentId,
        baselineRunId: run.baselineRunId,
        completedAt: run.completedAt,
        overall: detail.scores.overall,
        rule: 'evaluation-run-summary',
      });
    }
    const withScores = rows.filter((r) => (r.overall as { evaluated?: number } | null)?.evaluated);
    const avg = (pick: (r: Record<string, unknown>) => number) => {
      if (withScores.length === 0) return null;
      return Math.round((withScores.reduce((s, r) => s + pick(r), 0) / withScores.length) * 1e6) / 1e6;
    };
    const aggregate = withScores.length === 0 ? null : {
      runs: withScores.length,
      avgScore: avg((r) => (r.overall as { avgScore: number }).avgScore),
      passRate: avg((r) => (r.overall as { passRate: number }).passRate),
      rule: 'server-mean',
    };
    return { runs: rows, aggregate };
  }

  private toView(stored: StoredDoc<InsightDoc>): InsightView {
    return { ...stored.doc, id: stored.id, createdAt: stored.createdAt, updatedAt: stored.updatedAt };
  }
}
