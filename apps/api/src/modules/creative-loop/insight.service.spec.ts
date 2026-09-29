import { describe, it, expect, vi } from 'vitest';
import { InsightService } from './insight.service';
import { InsightDoc, StoredDoc } from './creative-loop-store';
import { factsHashOf } from './insight-rules';

const DOMAIN = 'org1';

function makeHarness(over: {
  current?: Array<Record<string, unknown>>;
  previous?: Array<Record<string, unknown>>;
  ratings?: Array<{ rating: number }>;
  runs?: Array<Record<string, unknown>>;
  saveCount?: number;
  doc?: InsightDoc | null;
  /** M12-P1 历史判定先例（HypothesisStore.listVerdicts 的返回值） */
  verdicts?: Array<{ id: string; doc: Record<string, unknown> }>;
  /** M12-P1 来源判别：被 agent 工具账本引用的绩效行 id + 账本枚举是否完整 */
  agentAuthoredIds?: string[];
  provenanceComplete?: boolean;
} = {}) {
  const prisma = {
    creativePerformance: {
      // 当期/前一期：真实实现以 capturedAt 区间区分（当期 gte，前一期 [prevStart, currentStart)）
      findMany: vi.fn(async (args: { where: { capturedAt: { gte: Date; lt?: Date } } }) =>
        args.where.capturedAt.lt ? (over.previous ?? []) : (over.current ?? [])),
    },
    feedback: { findMany: vi.fn(async () => (over.ratings ?? []).map((r) => ({ rating: r.rating }))) },
  };
  const store = {
    create: vi.fn(async (userId: string, doc: InsightDoc) => ({ id: 'ins-1', userId, doc, createdAt: new Date(), updatedAt: new Date() })),
    get: vi.fn(async (): Promise<StoredDoc<InsightDoc> | null> => (over.doc
      ? {
        id: 'ins-1', userId: 'u1', doc: over.doc, version: 1,
        createdAt: new Date('2026-01-01T00:00:00Z'), updatedAt: new Date('2026-01-01T00:00:00Z'),
      }
      : null)),
    list: vi.fn(async () => []),
    saveInterpretation: vi.fn(async () => over.saveCount ?? 1),
  };
  const access = {
    resolveScope: vi.fn(async () => ({ organizationId: DOMAIN, projectId: 'proj1' as string | null })),
    requireRead: vi.fn(async () => undefined),
    requireWrite: vi.fn(async () => undefined),
    authorizeResource: vi.fn(async () => undefined),
  };
  const runs = {
    list: vi.fn(async () => over.runs ?? []),
    get: vi.fn(async (_org: string, id: string) => ({
      run: { id, status: 'completed', datasetId: 'ds1' },
      scores: { overall: { evaluated: 4, passed: 3, failed: 1, avgScore: 0.75, passRate: 0.75 }, evaluators: [], caseRuns: {} },
    })),
  };
  const hypotheses = {
    listVerdicts: vi.fn(async () => (over.verdicts ?? []).map((v) => ({
      id: v.id, userId: 'u1', doc: v.doc, version: 1,
      createdAt: new Date('2026-01-01T00:00:00Z'), updatedAt: new Date('2026-01-01T00:00:00Z'),
    }))),
  };
  const provenance = {
    agentAuthoredIds: vi.fn(async () => {
      const ids = over.agentAuthoredIds ?? [];
      return { ids: new Set(ids), complete: over.provenanceComplete ?? true, scanned: ids.length, rule: 'agent-tool-ledger-exclusion' as const };
    }),
  };
  return {
    service: new InsightService(prisma as never, store as never, hypotheses as never, access as never, runs as never, provenance as never),
    prisma, store, access, runs, hypotheses, provenance,
  };
}

function baseDoc(over: Partial<InsightDoc> = {}): InsightDoc {
  const facts = { performance: { current: { impressions: 100 } }, ratings: { count: 0 } };
  const derived = { metrics: { ctr: 0.05 } };
  return {
    kind: 'creative_insight',
    organizationId: DOMAIN,
    projectId: 'proj1',
    window: { start: '2026-01-01T00:00:00.000Z', end: '2026-01-31T00:00:00.000Z', days: 30 },
    filters: { artifactId: null, campaignId: null, projectId: 'proj1' },
    facts,
    derived,
    factsHash: factsHashOf(facts, derived),
    interpretation: null,
    layering: { facts: 'service-computed', derived: 'service-computed', interpretation: 'llm-interpretation' },
    ...over,
  };
}

/**
 * 洞察服务单测：事实层服务端计算、分层标注、解读隔离（写入路径绝不触碰 facts/derived）。
 */
describe('InsightService（事实聚合 + 解读分层隔离）', () => {
  it('build：当期/前一期分别求和 → derived 派生 + 环比；分层标注 + 解读留空', async () => {
    const h = makeHarness({
      current: [{ impressions: 1000, clicks: 50, spend: 100, conversions: 5, revenue: 300, orders: 5 }],
      previous: [{ impressions: 1000, clicks: 40, spend: 100, conversions: 4, revenue: 150, orders: 4 }],
      ratings: [{ rating: 5 }, { rating: 4 }, { rating: 1 }],
    });
    const view = await h.service.build('u1', { days: 30 });
    expect(view.id).toBe('ins-1');
    const facts = view.facts as Record<string, never>;
    expect(facts.performance).toMatchObject({
      current: { impressions: 1000, clicks: 50, spend: 100, conversions: 5, revenue: 300, orders: 5 },
      previous: { impressions: 1000, clicks: 40, spend: 100, conversions: 4, revenue: 150, orders: 4 },
      sources: { current: 1, previous: 1 },
      rule: 'server-sum',
    });
    const derived = view.derived as Record<string, never>;
    expect(derived.metrics).toEqual({ ctr: 0.05, cvr: 0.1, roas: 3, cpc: 2 });
    expect(derived.baseline).toEqual({ ctr: 0.04, cvr: 0.1, roas: 1.5, cpc: 2.5 });
    expect((derived.comparison as unknown as Array<Record<string, unknown>>).map((c) => [c.metric, c.changePct, c.direction]))
      .toEqual([['ctr', 25, 'up'], ['cvr', 0, 'flat'], ['roas', 100, 'up'], ['cpc', -20, 'down']]);
    expect(derived.ratingSummary).toEqual({ avgRating: 3.33, positiveRate: 0.67, negativeRate: 0.33 });
    expect(view.interpretation).toBeNull();
    expect(view.layering).toEqual({ facts: 'service-computed', derived: 'service-computed', interpretation: 'llm-interpretation' });
    expect(view.factsHash).toBe(factsHashOf(view.facts, view.derived));
    expect(h.access.requireRead).toHaveBeenCalledWith('u1', DOMAIN);
  });

  it('build：无回流事实 → 事实层全 0、派生全 0（绝不臆造）；includeEvaluation=false 时绝不读评测', async () => {
    const h = makeHarness({ includeCheck: true } as never);
    const view = await h.service.build('u1', { days: 7, includeEvaluation: false });
    expect((view.facts as Record<string, never>).performance).toMatchObject({
      current: { impressions: 0, clicks: 0, spend: 0, conversions: 0, revenue: 0, orders: 0 },
      sources: { current: 0, previous: 0 },
    });
    expect((view.derived as Record<string, never>).metrics).toEqual({ ctr: 0, cvr: 0, roas: 0, cpc: 0 });
    expect((view.derived as Record<string, never>).comparison).toEqual([]);
    expect(h.runs.list).not.toHaveBeenCalled();
    expect(view.window.days).toBe(7);
  });

  it('build：评测事实走 M9-P1 摘要（avgScore/passRate 由其提供，本模块不重算）', async () => {
    const h = makeHarness({ runs: [{ id: 'run-1', status: 'completed', datasetId: 'ds1', datasetVersion: 1, agentId: 'ag1', baselineRunId: null, completedAt: null }] });
    const view = await h.service.build('u1', {});
    const evalFacts = (view.facts as Record<string, never>).evaluation as unknown as { runs: Array<Record<string, unknown>>; rule: string };
    expect(evalFacts.rule).toBe('evaluation-run-summary');
    expect(evalFacts.runs[0]).toMatchObject({ runId: 'run-1', overall: { avgScore: 0.75, passRate: 0.75 } });
    expect((view.derived as Record<string, never>).evaluation).toMatchObject({ runs: 1, avgScore: 0.75, passRate: 0.75, rule: 'server-mean' });
    expect(h.runs.get).toHaveBeenCalledWith(DOMAIN, 'run-1');
  });

  it('build（M12-P1 来源判别）：agent 工具写入的绩效行不进事实层（排除计数留痕，绝不静默丢弃）', async () => {
    const h = makeHarness({
      current: [
        { id: 'perf-agent', impressions: 100, clicks: 90, spend: 100, conversions: 9, revenue: 100_000, orders: 9 },
        { id: 'perf-ext', impressions: 1000, clicks: 50, spend: 100, conversions: 5, revenue: 300, orders: 5 },
      ],
      previous: [{ id: 'perf-agent-2', impressions: 500, clicks: 50, spend: 100, conversions: 5, revenue: 500, orders: 5 }],
      agentAuthoredIds: ['perf-agent', 'perf-agent-2'],
    });
    const view = await h.service.build('u1', { days: 30, includeEvaluation: false });
    expect(h.provenance.agentAuthoredIds).toHaveBeenCalledWith('u1');
    const perf = (view.facts as Record<string, never>).performance as unknown as Record<string, never>;
    // 当期只剩外部行；前一期被整段排除（0 行 → 事实全 0，绝不臆造）
    expect(perf.current).toMatchObject({ impressions: 1000, clicks: 50, revenue: 300 });
    expect(perf.previous).toMatchObject({ impressions: 0, clicks: 0, revenue: 0 });
    expect(perf.sources).toEqual({
      current: 1, previous: 0, agentExcluded: { current: 1, previous: 1 },
    });
    expect(perf.provenance).toMatchObject({ rule: 'agent-tool-ledger-exclusion', complete: true });
    expect((view.derived as Record<string, never>).metrics).toEqual({ ctr: 0.05, cvr: 0.1, roas: 3, cpc: 2 });
  });

  it('build（M12-P1）：账本枚举触顶 → 事实层带 complete=false 警示（消费方自行复核）', async () => {
    const h = makeHarness({ current: [{ id: 'perf-ext', impressions: 100, clicks: 5, spend: 100, conversions: 1, revenue: 300, orders: 1 }], provenanceComplete: false });
    const view = await h.service.build('u1', { days: 30, includeEvaluation: false });
    const perf = (view.facts as Record<string, never>).performance as unknown as Record<string, never>;
    expect(perf.provenance).toMatchObject({ complete: false, reason: expect.stringContaining('触顶') });
  });

  it('build（M12-P1 学习桥）：既有 verdict 作为事实输入（只读引用 + 服务端聚合 + 有界）', async () => {
    const h = makeHarness({
      verdicts: [
        {
          id: 'hyp-v',
          doc: {
            statement: '换用高对比主图可提升点击率', status: 'validated', projectId: 'proj1',
            verdict: {
              decision: 'validated', decidedBy: 'criteria', reason: 'roas=3 ≥ 2 → 成立',
              decidedAt: '2026-01-02T00:00:00.000Z', criteria: { metric: 'roas', op: 'gte', value: 2 },
            },
          },
        },
        {
          id: 'hyp-r',
          doc: {
            statement: '深色背景可提升转化率', status: 'rejected', projectId: 'proj1',
            verdict: { decision: 'rejected', decidedBy: 'system', reason: 'loop 运行 failed，未产出可用结果', decidedAt: '2026-01-03T00:00:00.000Z', criteria: null },
          },
        },
        { id: 'hyp-null', doc: { statement: '历史脏行（无 verdict）', status: 'rejected', projectId: 'proj1', verdict: null } },
      ],
    });
    const view = await h.service.build('u1', { days: 30, includeEvaluation: false });
    // 只读输入：同组织 + 项目 scope（server-side），有界 take
    expect(h.hypotheses.listVerdicts).toHaveBeenCalledWith({ organizationId: DOMAIN, projectId: 'proj1', take: 20 });
    const verdicts = (view.facts as Record<string, never>).verdicts as unknown as Record<string, never>;
    expect(verdicts.rule).toBe('server-aggregate');
    expect(verdicts.source).toBe('historical-verdicts');
    expect(verdicts.totals).toEqual({
      entries: 2, validated: 1, rejected: 1, byDecider: { criteria: 1, manual: 0, system: 1 },
    });
    expect(verdicts.entries).toEqual([
      expect.objectContaining({ hypothesisId: 'hyp-v', decision: 'validated', decidedBy: 'criteria', rule: 'historical-verdict' }),
      expect.objectContaining({ hypothesisId: 'hyp-r', decision: 'rejected', decidedBy: 'system', rule: 'historical-verdict' }),
    ]);
    // 先例只进事实层：解读层仍留空，事实指纹随新事实变化（可审计）
    expect(view.interpretation).toBeNull();
    expect(view.factsHash).toBe(factsHashOf(view.facts, view.derived));
  });

  it('attachInterpretation：解读独立落层，facts/derived 逐字节不变（隔离不变量）', async () => {
    const doc = baseDoc();
    const h = makeHarness({ doc });
    const view = await h.service.attachInterpretation('u1', 'ins-1', { items: ['点击率下滑可能与主图对比度不足有关（推测）'], model: 'mock-1' });
    expect(view.interpretation).toEqual({
      source: 'llm-interpretation',
      items: ['点击率下滑可能与主图对比度不足有关（推测）'],
      model: 'mock-1',
      attachedAt: expect.any(String),
    });
    // 事实层与指纹逐字节不变
    expect(view.facts).toEqual(doc.facts);
    expect(view.derived).toEqual(doc.derived);
    expect(view.factsHash).toBe(doc.factsHash);
    // 落库内容 = 原事实 + 新解读（解读分支绝不构造 facts/derived）；条件更新锚定**读取时的版本**
    const [, hash, next, expectedVersion] = h.store.saveInterpretation.mock.calls[0] as unknown as [string, string, InsightDoc, number];
    expect(hash).toBe(doc.factsHash);
    expect(expectedVersion).toBe(1); // 读取时版本（D2-02 第二锚点：并发解读绝不互相覆盖）
    expect(next.facts).toEqual(doc.facts);
    expect(next.derived).toEqual(doc.derived);
    expect(next.interpretation?.source).toBe('llm-interpretation');
    expect(h.access.authorizeResource).toHaveBeenCalledWith('u1', { organizationId: DOMAIN, userId: 'u1' }, 'workflow.write', '洞察不存在');
  });

  it('attachInterpretation：条件更新未命中（事实层已更新 / 期间被并发写入）→ 400，拒绝落库', async () => {
    const h = makeHarness({ doc: baseDoc(), saveCount: 0 });
    await expect(h.service.attachInterpretation('u1', 'ins-1', { items: ['解读'] }))
      .rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    // 双重锚点（factsHash + version）都由 store 侧谓词裁决，服务层绝不"先写后查"
    const [id, hash, , expectedVersion] = h.store.saveInterpretation.mock.calls[0] as unknown as [string, string, InsightDoc, number];
    expect(id).toBe('ins-1');
    expect(hash).toBe(baseDoc().factsHash);
    expect(expectedVersion).toBe(1);
  });

  it('attachInterpretation：洞察不存在 → 404（绝不隐式创建）', async () => {
    const h = makeHarness({ doc: null });
    await expect(h.service.attachInterpretation('u1', 'ins-x', { items: ['解读'] }))
      .rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(h.store.saveInterpretation).not.toHaveBeenCalled();
  });
});
