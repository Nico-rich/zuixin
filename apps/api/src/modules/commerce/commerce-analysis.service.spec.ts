import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Prisma } from '@prisma/client';
import { CommerceAnalysisService } from './commerce-analysis.service';

function makeService(ledgerOutput: unknown = null) {
  // Pre-M9 G11：ToolCall 幂等账本替身（output 非空即"首次执行已提交"）
  const ledger = { output: ledgerOutput as unknown };
  const tx = {
    toolCall: {
      findUnique: vi.fn(async () => ({ output: ledger.output })),
      updateMany: vi.fn(async ({ where, data }: { where: { output?: { equals?: unknown } }; data: { output: unknown } }) => {
        if (where.output?.equals === Prisma.DbNull && ledger.output !== null) return { count: 0 };
        ledger.output = data.output;
        return { count: 1 };
      }),
    },
    commerceAnalysis: { create: vi.fn(async (args: { data: Record<string, unknown> }) => ({ id: 'an-tx', createdAt: new Date(), ...args.data })) },
    creativeBrief: { create: vi.fn(async (args: { data: Record<string, unknown> }) => ({ id: 'cb-tx', ...args.data })) },
  };
  const prisma = {
    commerceAnalysis: {
      create: vi.fn(async (args: { data: Record<string, unknown> }) => ({ id: 'an-1', createdAt: new Date(), ...args.data })),
      findFirst: vi.fn().mockResolvedValue(null),
      // M13-W9 只读列表面
      findMany: vi.fn().mockResolvedValue([]),
    },
    creativeBrief: {
      create: vi.fn(async (args: { data: Record<string, unknown> }) => ({ id: 'cb-1', ...args.data })),
      findFirst: vi.fn().mockResolvedValue(null),
      update: vi.fn().mockResolvedValue({}),
      // M13-W9 只读列表面
      findMany: vi.fn().mockResolvedValue([]),
    },
    memory: { findMany: vi.fn().mockResolvedValue([]) },
    $transaction: vi.fn(async (fn: (t: unknown) => Promise<unknown>) => fn(tx)),
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
  return { svc, prisma, commerce, artifacts, tx, ledger };
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

  it('G11 generateAnalysis（ToolCall）：分析事实与账本同事务提交', async () => {
    const { svc, prisma, tx, ledger } = makeService();
    const res = await svc.generateAnalysis('u1', { analysisType: 'sales' }, { agentRunId: 'run-1', toolCallId: 'tc-an' });
    expect(res).toMatchObject({ analysisId: 'an-tx', layering: { facts: 'service-computed' } });
    expect(prisma.commerceAnalysis.create).not.toHaveBeenCalled(); // 走 tx（同事务）
    expect(tx.commerceAnalysis.create).toHaveBeenCalledTimes(1);
    expect(tx.toolCall.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'tc-an', output: { equals: Prisma.DbNull } },
      data: { output: expect.objectContaining({ analysisId: 'an-tx' }) }, // 账本值 = 工具返回值（LLM 所见逐字一致）
    }));
    expect(ledger.output).toMatchObject({ analysisId: 'an-tx' });
  });

  it('G11 generateAnalysis 崩溃重放：账本命中 → 复用首次分析，绝不产生第二份', async () => {
    const recorded = { analysisId: 'an-first', facts: { revenue: 800 }, layering: { facts: 'service-computed' } };
    const { svc, tx } = makeService(recorded);
    const res = await svc.generateAnalysis('u1', { analysisType: 'sales' }, { toolCallId: 'tc-an' });
    expect(res).toEqual(recorded);
    expect(tx.commerceAnalysis.create).not.toHaveBeenCalled();
  });

  it('G11 createBrief（ToolCall）：简报行经账本事务；重放复用首次结果（制品镜像另有一重幂等键）', async () => {
    const { svc, prisma, tx } = makeService();
    const res = await svc.createBrief('u1', { problem: 'p', objective: 'o' }, { toolCallId: 'tc-cb', idempotencyKey: 'idem-9' });
    expect(res).toMatchObject({ briefId: 'cb-tx', artifactId: 'art-1' });
    expect(prisma.creativeBrief.create).not.toHaveBeenCalled();
    expect(tx.creativeBrief.create).toHaveBeenCalledTimes(1);

    const recorded = { id: 'cb-first', problem: 'p', objective: 'o', status: 'ready', platform: null };
    const replay = makeService(recorded);
    const res2 = await replay.svc.createBrief('u1', { problem: 'p', objective: 'o' }, { toolCallId: 'tc-cb', idempotencyKey: 'idem-9' });
    expect(res2.briefId).toBe('cb-first'); // 复用首次简报行，绝不重复建
    expect(replay.tx.creativeBrief.create).not.toHaveBeenCalled();
  });
});

describe('CommerceAnalysisService 只读列表面（M13-W9）', () => {
  it('listAnalyses：userId 恒为首条件 + 只投影列表字段（证据体不进列表）', async () => {
    const { svc, prisma } = makeService();
    (prisma.commerceAnalysis.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
      { id: 'an-1', analysisType: 'sales', status: 'ready', timeRange: { start: 'S', end: 'E' }, agentRunId: null, createdAt: new Date('2026-01-01') },
    ]);

    const rows = await svc.listAnalyses('u1');

    expect(prisma.commerceAnalysis.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { userId: 'u1' }, // 归属只在服务端判定（无任何客户端传入的 userId/org 参与）
      orderBy: { createdAt: 'desc' },
      take: 30,
    }));
    // select 白名单：facts/derived/anomalies/possibleCauses/recommendations 一律不取
    const select = (prisma.commerceAnalysis.findMany as ReturnType<typeof vi.fn>).mock.calls[0][0].select as Record<string, boolean>;
    expect(Object.keys(select).sort()).toEqual(['agentRunId', 'analysisType', 'createdAt', 'id', 'status', 'timeRange']);
    expect(rows).toEqual([{ analysisId: 'an-1', analysisType: 'sales', status: 'ready', timeRange: { start: 'S', end: 'E' }, agentRunId: null, createdAt: expect.any(Date) }]);
  });

  it('listAnalyses：limit 收敛到 1..100（0/负数/超限/小数都不产生越界查询）', async () => {
    const { svc, prisma } = makeService();
    const calls = () => (prisma.commerceAnalysis.findMany as ReturnType<typeof vi.fn>).mock.calls.map((c) => (c[0] as { take: number }).take);

    await svc.listAnalyses('u1', 0);
    await svc.listAnalyses('u1', -5);
    await svc.listAnalyses('u1', 10_000);
    await svc.listAnalyses('u1', 7.9);

    expect(calls()).toEqual([1, 1, 100, 7]);
  });

  it('listBriefs：userId 归属 + 只投影列表字段（problem/objective/platform/status/artifactId）', async () => {
    const { svc, prisma } = makeService();
    (prisma.creativeBrief.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
      { id: 'cb-1', problem: 'p', objective: 'o', platform: 'meta', status: 'ready', artifactId: 'art-1', commerceAnalysisId: 'an-1', createdAt: new Date('2026-01-02') },
    ]);

    const rows = await svc.listBriefs('u1', 5);

    expect(prisma.creativeBrief.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { userId: 'u1' }, take: 5 }));
    const select = (prisma.creativeBrief.findMany as ReturnType<typeof vi.fn>).mock.calls[0][0].select as Record<string, boolean>;
    expect(Object.keys(select).sort()).toEqual(['artifactId', 'commerceAnalysisId', 'createdAt', 'id', 'objective', 'platform', 'problem', 'status']);
    expect(rows).toEqual([{
      briefId: 'cb-1', problem: 'p', objective: 'o', platform: 'meta', status: 'ready',
      artifactId: 'art-1', analysisId: 'an-1', createdAt: expect.any(Date),
    }]);
  });

  it('listAnalyses/listBriefs 无数据 → 空数组（列表端点不回退到"最新一条"）', async () => {
    const { svc } = makeService();
    await expect(svc.listAnalyses('u1')).resolves.toEqual([]);
    await expect(svc.listBriefs('u1')).resolves.toEqual([]);
  });
});
