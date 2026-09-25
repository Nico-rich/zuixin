import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CommerceAnalysisService } from './commerce-analysis.service';

function makeService() {
  const prisma = {
    commerceAnalysis: {
      create: vi.fn(async (args: { data: Record<string, unknown> }) => ({ id: 'an-1', createdAt: new Date(), ...args.data })),
      findFirst: vi.fn().mockResolvedValue(null),
    },
    creativeBrief: {
      create: vi.fn(async (args: { data: Record<string, unknown> }) => ({ id: 'cb-1', ...args.data })),
      findFirst: vi.fn().mockResolvedValue(null),
      update: vi.fn().mockResolvedValue({}),
    },
    memory: { findMany: vi.fn().mockResolvedValue([]) },
  };
  const commerce = {
    resolveTimeRange: vi.fn((input?: { start?: string; end?: string; days?: number }) => {
      const days = input?.days ?? 30;
      const end = new Date();
      return { start: new Date(end.getTime() - days * 86400_000), end };
    }),
    analyticsSummary: vi.fn().mockResolvedValue({
      facts: { revenue: 1000, orders: 10, visits: 100, impressions: 1000, clicks: 50, adSpend: 100, adRevenue: 300, netRevenue: 950, refunds: 50, adConversions: 5 },
      derived: { conversionRate: 0.1, ctr: 0.05, roas: 3, aov: 100 },
    }),
    trafficSummary: vi.fn(),
    adsPerformance: vi.fn(),
    inventorySummary: vi.fn(),
  };
  const artifacts = { create: vi.fn().mockResolvedValue({ id: 'art-1', status: 'ready' }) };
  const svc = new CommerceAnalysisService(prisma as never, commerce as never, artifacts as never);
  return { svc, prisma, commerce, artifacts };
}

describe('CommerceAnalysisService（M7-P5 事实/推测分层）', () => {
  beforeEach(() => vi.clearAllMocks());

  it('generateAnalysis：facts/derived 来自服务端；规则异常（前一期下降≥10%）；possibleCauses 独立标注 llm-interpretation', async () => {
    const { svc, prisma, commerce } = makeService();
    (commerce.analyticsSummary as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({ // 当前窗（较差）
        facts: { revenue: 800, orders: 8, visits: 90, impressions: 900, clicks: 40, adSpend: 100, adRevenue: 200, netRevenue: 780, refunds: 20, adConversions: 4 },
        derived: { conversionRate: 0.09, ctr: 0.04, roas: 2, aov: 100 },
      })
      .mockResolvedValueOnce({ // 前一期（基线，较好）
        facts: { revenue: 1000, orders: 10, visits: 100, impressions: 1000, clicks: 50, adSpend: 100, adRevenue: 300, netRevenue: 950, refunds: 50, adConversions: 5 },
        derived: { conversionRate: 0.1, ctr: 0.05, roas: 3, aov: 100 },
      });
    const res = await svc.generateAnalysis('u1', {
      analysisType: 'composite',
      possibleCauses: ['流量质量下降（推测）'],
      recommendations: ['优化主图'],
    }, { agentRunId: 'run-1' });
    const created = ((prisma.commerceAnalysis.create as ReturnType<typeof vi.fn>).mock.calls[0][0]).data as {
      facts: Record<string, unknown>; anomalies: Array<Record<string, unknown>>; possibleCauses: Record<string, unknown>; recommendations: Record<string, unknown>;
    };
    expect(created.facts).toMatchObject({ revenue: 800 }); // 事实 = 服务端计算
    expect(created.anomalies.some((a) => a.metric === 'revenue' && a.direction === 'decline' && a.rule === 'server-threshold')).toBe(true);
    expect(created.anomalies.some((a) => a.metric === 'roas')).toBe(true);
    expect(created.possibleCauses).toMatchObject({ source: 'llm-interpretation', items: ['流量质量下降（推测）'] });
    expect(created.recommendations).toMatchObject({ source: 'llm-recommendation' });
    expect(res).toMatchObject({
      layering: { facts: 'service-computed', possibleCauses: 'llm-interpretation', recommendations: 'llm-recommendation' },
    });
  });

  it('createBrief：problem/objective 必填落库；evidence 自动快照最新 analysis 事实层；镜像 Artifact', async () => {
    const { svc, prisma, artifacts } = makeService();
    prisma.commerceAnalysis.findFirst.mockResolvedValue({
      id: 'an-1', facts: { revenue: 800 }, derived: { roas: 2 }, anomalies: [{ metric: 'revenue' }],
    });
    const res = await svc.createBrief('u1', {
      problem: '转化率下降', objective: '提升点击率', creativeAngle: '黑金质感', visualDirection: '黑金配色',
    }, { agentRunId: 'run-2', idempotencyKey: 'idem-1' });
    expect(res).toMatchObject({ briefId: 'cb-1', artifactId: 'art-1', analysisId: 'an-1' });
    const created = (prisma.creativeBrief.create as ReturnType<typeof vi.fn>).mock.calls[0][0].data as {
      problem: string; objective: string; evidence: Record<string, unknown>; creativeAngle: string;
    };
    expect(created.problem).toBe('转化率下降');
    expect(created.evidence).toMatchObject({
      source: 'commerce-analysis-snapshot', analysisId: 'an-1',
      layering: { facts: 'service-computed', anomalies: 'service-rule' },
      facts: { revenue: 800 },
    });
    expect(artifacts.create).toHaveBeenCalledWith('u1', expect.objectContaining({
      type: 'creative_brief', idempotencyKey: 'idem-1', runId: 'run-2',
    }));
  });

  it('createBrief：无 analysis 数据（无证据可挂）→ 仍可建简报，evidence=null', async () => {
    const { svc, prisma } = makeService();
    prisma.commerceAnalysis.findFirst.mockResolvedValue(null);
    const res = await svc.createBrief('u1', { problem: 'p', objective: 'o' }, {});
    expect(res.analysisId).toBeNull();
    expect(res.evidenceSummary).toBeNull();
  });

  it('generateAnalysis：非法 analysisType → VALIDATION_ERROR', async () => {
    const { svc } = makeService();
    await expect(svc.generateAnalysis('u1', { analysisType: 'magic' })).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });
});
