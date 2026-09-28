import { describe, it, expect, vi } from 'vitest';
import { InsightService } from './insight.service';
import { InsightDoc, StoredDoc } from './creative-loop-store';
import { factsHashOf } from './insight-rules';

const DOMAIN = 'org1';

function makeHarness(over: {
  current?: Array<Record<string, number>>;
  previous?: Array<Record<string, number>>;
  ratings?: Array<{ rating: number }>;
  runs?: Array<Record<string, unknown>>;
  saveCount?: number;
  doc?: InsightDoc | null;
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
      ? { id: 'ins-1', userId: 'u1', doc: over.doc, createdAt: new Date('2026-01-01T00:00:00Z'), updatedAt: new Date('2026-01-01T00:00:00Z') }
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
  return {
    service: new InsightService(prisma as never, store as never, access as never, runs as never),
    prisma, store, access, runs,
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
    // 落库内容 = 原事实 + 新解读（解读分支绝不构造 facts/derived）
    const [, hash, next] = h.store.saveInterpretation.mock.calls[0] as unknown as [string, string, InsightDoc];
    expect(hash).toBe(doc.factsHash);
    expect(next.facts).toEqual(doc.facts);
    expect(next.derived).toEqual(doc.derived);
    expect(next.interpretation?.source).toBe('llm-interpretation');
    expect(h.access.authorizeResource).toHaveBeenCalledWith('u1', { organizationId: DOMAIN, userId: 'u1' }, 'workflow.write');
  });

  it('attachInterpretation：事实层已更新（factsHash CAS 未命中）→ 400，拒绝用旧事实承载新解读', async () => {
    const h = makeHarness({ doc: baseDoc(), saveCount: 0 });
    await expect(h.service.attachInterpretation('u1', 'ins-1', { items: ['解读'] }))
      .rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });

  it('attachInterpretation：洞察不存在 → 404（绝不隐式创建）', async () => {
    const h = makeHarness({ doc: null });
    await expect(h.service.attachInterpretation('u1', 'ins-x', { items: ['解读'] }))
      .rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(h.store.saveInterpretation).not.toHaveBeenCalled();
  });
});
