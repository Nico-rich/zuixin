import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AnalyticsService, addDays, dayRange, mergeMetrics, periodOf, rangeOf } from './analytics.service';

const DAY_START = new Date('2026-09-25T00:00:00.000Z');

function makeService(org: { id: string; isPersonal: boolean; ownerUserId: string } | null = { id: 'org-1', isPersonal: true, ownerUserId: 'u1' }) {
  const prisma = {
    organization: { findFirst: vi.fn().mockResolvedValue(org) },
    organizationMember: { count: vi.fn().mockResolvedValue(2) },
    agentRun: { findMany: vi.fn().mockResolvedValue([]) },
    usageLedgerEntry: { findMany: vi.fn().mockResolvedValue([]) },
    generationTask: { findMany: vi.fn().mockResolvedValue([]) },
    usageRecord: { findMany: vi.fn().mockResolvedValue([]) },
    workflowRun: { findMany: vi.fn().mockResolvedValue([]) },
    analyticsAggregate: {
      findFirst: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({ id: `agg-${String(data.kind)}`, ...data })),
      update: vi.fn().mockResolvedValue({}),
      findMany: vi.fn().mockResolvedValue([]),
    },
  };
  const svc = new AnalyticsService(prisma as never);
  return { svc, prisma };
}

/** 从 create 调用中取出某 kind 的聚合行（刷新 = 5 个维度各一行） */
function createdRow(prisma: ReturnType<typeof makeService>['prisma'], kind: string) {
  const rows = prisma.analyticsAggregate.create.mock.calls.map((call) => (call as unknown as [{ data: Record<string, unknown> }])[0].data);
  return rows.find((row) => row.kind === kind);
}

describe('AnalyticsService（M8-P4 确定性聚合投影）', () => {
  beforeEach(() => vi.clearAllMocks());

  it('日粒度工具：period/dayRange/addDays/rangeOf 统一 UTC 边界', () => {
    expect(periodOf(new Date('2026-09-25T13:45:00.000Z'))).toBe('2026-09-25');
    const { start, end } = dayRange('2026-09-25');
    expect(start.toISOString()).toBe('2026-09-25T00:00:00.000Z');
    expect(end.toISOString()).toBe('2026-09-26T00:00:00.000Z');
    expect(addDays('2026-09-25', -6)).toBe('2026-09-19');
    expect(addDays('2026-09-30', 1)).toBe('2026-10-01');
    expect(rangeOf('day', DAY_START)).toMatchObject({ from: '2026-09-25', to: '2026-09-25', days: 1 });
    expect(rangeOf('week', DAY_START)).toMatchObject({ from: '2026-09-19', to: '2026-09-25', days: 7 });
    expect(rangeOf('month', DAY_START)).toMatchObject({ from: '2026-08-27', to: '2026-09-25', days: 30 });
  });

  it('refreshOrganization：五维度各一行，source 标注事务来源，period=指定日，userId=组织级 null', async () => {
    const { svc, prisma } = makeService();
    const res = await svc.refreshOrganization('org-1', '2026-09-25');
    expect(res).toMatchObject({ organizationId: 'org-1', period: '2026-09-25' });
    expect(res.kinds).toEqual(['usage', 'agent', 'generation', 'provider', 'workflow']);
    const rows = prisma.analyticsAggregate.create.mock.calls.map((call) => (call as unknown as [{ data: Record<string, unknown> }])[0].data);
    expect(rows).toHaveLength(5);
    expect(rows.map((r) => `${String(r.kind)}:${String(r.source)}`).sort()).toEqual([
      'agent:agent_run', 'generation:generation_task', 'provider:usage_record', 'usage:usage_ledger', 'workflow:workflow_run',
    ]);
    for (const row of rows) {
      expect(row.period).toBe('2026-09-25');
      expect(row.userId).toBeNull();
      expect(row.organizationId).toBe('org-1');
    }
  });

  it('kind=usage：UsageLedgerEntry 按 kind 求和（agent_run/llm_tokens/llm_cost/...）+ 条目数', async () => {
    const { svc, prisma } = makeService();
    prisma.usageLedgerEntry.findMany.mockResolvedValue([
      { kind: 'agent_run', quantity: 1, unit: 'count' },
      { kind: 'agent_run', quantity: 1, unit: 'count' },
      { kind: 'llm_tokens', quantity: 5000, unit: 'count' },
      { kind: 'llm_cost', quantity: 0.42, unit: 'cny' },
      { kind: 'image_generation', quantity: 3, unit: 'count' },
      { kind: 'external_api_call', quantity: 2, unit: 'count' },
    ]);
    await svc.refreshOrganization('org-1', '2026-09-25');
    expect(createdRow(prisma, 'usage')!.metrics).toMatchObject({
      agent_run: 2, llm_tokens: 5000, llm_cost: 0.42, image_generation: 3,
      video_seconds: 0, external_api_call: 2, workflow_run: 0, entries: 6,
    });
  });

  it('kind=agent：状态分布 + 时长合计/样本/均值（未终态无时长样本）', async () => {
    const { svc, prisma } = makeService();
    prisma.agentRun.findMany.mockResolvedValue([
      { id: 'r1', status: 'completed', startedAt: DAY_START, completedAt: new Date(DAY_START.getTime() + 10_000) },
      { id: 'r2', status: 'completed', startedAt: DAY_START, completedAt: new Date(DAY_START.getTime() + 20_000) },
      { id: 'r3', status: 'failed', startedAt: DAY_START, completedAt: new Date(DAY_START.getTime() + 500) },
      { id: 'r4', status: 'cancelled', startedAt: DAY_START, completedAt: null },
      { id: 'r5', status: 'timeout', startedAt: DAY_START, completedAt: new Date(DAY_START.getTime() + 30_000) },
    ]);
    await svc.refreshOrganization('org-1', '2026-09-25');
    expect(createdRow(prisma, 'agent')!.metrics).toMatchObject({
      runs: 5, completed: 2, failed: 1, cancelled: 1, timeout: 1, queued: 0, running: 0, waiting: 0,
      durationSamples: 4, durationMsTotal: 60_500, avgDurationMs: 15_125,
    });
  });

  it('kind=generation：image/video × 成功/失败/取消（按 run 归因 + 无 run 个人组织）', async () => {
    const { svc, prisma } = makeService();
    prisma.generationTask.findMany.mockResolvedValue([
      { type: 'image', status: 'completed', costEstimate: 0.2 },
      { type: 'image', status: 'completed', costEstimate: 0.2 },
      { type: 'image', status: 'failed', costEstimate: 0.1 },
      { type: 'video', status: 'completed', costEstimate: 1.5 },
      { type: 'video', status: 'cancelled', costEstimate: 0 },
    ]);
    await svc.refreshOrganization('org-1', '2026-09-25');
    expect(createdRow(prisma, 'generation')!.metrics).toMatchObject({
      tasks: 5, imageSucceeded: 2, imageFailed: 1, imageCancelled: 0,
      videoSucceeded: 1, videoFailed: 0, videoCancelled: 1, estimatedCost: 2,
    });
  });

  it('kind=provider：UsageRecord 按 providerId 分组（调用次数/estimatedCost/失败），无 provider → unknown', async () => {
    const { svc, prisma } = makeService();
    prisma.usageRecord.findMany.mockResolvedValue([
      { providerId: 'p-openai', estimatedCost: 0.3, status: 'success', kind: 'llm_chat' },
      { providerId: 'p-openai', estimatedCost: 0.2, status: 'failed', kind: 'llm_chat' },
      { providerId: 'p-doubao', estimatedCost: 1.1, status: 'success', kind: 'image' },
      { providerId: null, estimatedCost: 0, status: 'success', kind: 'llm_router' },
    ]);
    await svc.refreshOrganization('org-1', '2026-09-25');
    const row = createdRow(prisma, 'provider')!;
    expect(row.metrics).toMatchObject({
      calls: 4, estimatedCost: 1.6, failed: 1, providers: 3,
      byProvider: {
        'p-openai': { calls: 2, estimatedCost: 0.5, failed: 1 },
        'p-doubao': { calls: 1, estimatedCost: 1.1, failed: 0 },
        unknown: { calls: 1, estimatedCost: 0, failed: 0 },
      },
    });
    expect(row.dimensions).toMatchObject({ providers: ['p-doubao', 'p-openai', 'unknown'] });
  });

  it('kind=workflow：WorkflowRun（workflow.organizationId）total + 状态分布 + 触发类型', async () => {
    const { svc, prisma } = makeService();
    prisma.workflowRun.findMany.mockResolvedValue([
      { status: 'completed', triggerType: 'manual' },
      { status: 'completed', triggerType: 'webhook' },
      { status: 'failed', triggerType: 'manual' },
      { status: 'waiting', triggerType: 'schedule' },
    ]);
    await svc.refreshOrganization('org-1', '2026-09-25');
    expect(createdRow(prisma, 'workflow')!.metrics).toMatchObject({
      runs: 4, completed: 2, failed: 1, waiting: 1, cancelled: 0, timeout: 0,
      byTrigger: { manual: 2, webhook: 1, schedule: 1 },
    });
  });

  it('幂等：已存在聚合行 → update（绝不新增行）；create P2002 并发兜底 → update', async () => {
    const { svc, prisma } = makeService();
    prisma.analyticsAggregate.findFirst.mockResolvedValue({ id: 'agg-existing' });
    await svc.refreshOrganization('org-1', '2026-09-25');
    expect(prisma.analyticsAggregate.create).not.toHaveBeenCalled();
    expect(prisma.analyticsAggregate.update).toHaveBeenCalledTimes(5); // 5 维度各一次
    expect(prisma.analyticsAggregate.update).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'agg-existing' } }));

    // 并发：先查不到 → create 撞唯一键 P2002 → 兜底 update（唯一赢家建行，输家更新）
    const second = makeService();
    let calls = 0;
    second.prisma.analyticsAggregate.findFirst.mockImplementation(async () => (++calls % 2 === 1 ? null : { id: `agg-won-${calls}` }));
    second.prisma.analyticsAggregate.create.mockRejectedValue({ code: 'P2002' });
    second.prisma.analyticsAggregate.update.mockClear();
    await second.svc.refreshOrganization('org-1', '2026-09-25');
    expect(second.prisma.analyticsAggregate.create).toHaveBeenCalledTimes(5);
    expect(second.prisma.analyticsAggregate.update).toHaveBeenCalledTimes(5); // P2002 全部转为 update，无重复行
  });

  it('refreshAll：按天循环（含端点），区间倒置/超长 → 校验错误', async () => {
    const { svc } = makeService();
    const res = await svc.refreshAll('org-1', '2026-09-23', '2026-09-25');
    expect(res).toMatchObject({ days: 3, periods: ['2026-09-23', '2026-09-24', '2026-09-25'] });
    await expect(svc.refreshAll('org-1', '2026-09-25', '2026-09-23')).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    await expect(svc.refreshAll('org-1', '2025-01-01', '2026-09-25')).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });

  it('组织不存在：refreshOrganization 404；runsOfOrganization 返回空（绝不泄露）', async () => {
    const { svc, prisma } = makeService(null);
    await expect(svc.refreshOrganization('org-x', '2026-09-25')).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(svc.runsOfOrganization('org-x', DAY_START, new Date(DAY_START.getTime() + 86_400_000))).resolves.toEqual([]);
    expect(prisma.agentRun.findMany).not.toHaveBeenCalled();
  });

  it('归因 helper：个人组织 = 项目组织 ∨（无项目 ∨ 项目无组织）且属主；非个人组织仅项目组织', async () => {
    const personal = makeService();
    await personal.svc.runsOfOrganization('org-1', DAY_START, new Date(DAY_START.getTime() + 86_400_000));
    const personalWhere = (personal.prisma.agentRun.findMany.mock.calls[0] as unknown as [{ where: { OR: unknown[]; createdAt: { gte: Date; lt: Date } } }])[0].where;
    expect(personalWhere.OR).toHaveLength(3);
    expect(personalWhere.createdAt.gte).toEqual(DAY_START);

    const team = makeService({ id: 'org-2', isPersonal: false, ownerUserId: 'u2' });
    await team.svc.runsOfOrganization('org-2', DAY_START, new Date(DAY_START.getTime() + 86_400_000));
    const teamWhere = (team.prisma.agentRun.findMany.mock.calls[0] as unknown as [{ where: { OR: Array<{ project?: { organizationId?: string } }> } }])[0].where;
    expect(teamWhere.OR).toEqual([{ project: { organizationId: 'org-2' } }]);
  });

  it('query：逐日 series + 区间合并 facts（均值按 totals/samples 重算，绝不跨天求平均的平均）', async () => {
    const { svc, prisma } = makeService();
    prisma.analyticsAggregate.findMany.mockResolvedValue([
      { kind: 'agent', period: '2026-09-24', metrics: { runs: 2, completed: 1, durationMsTotal: 1000, durationSamples: 2, avgDurationMs: 500 }, dimensions: null, source: 'agent_run', refreshedAt: new Date('2026-09-24T23:00:00.000Z') },
      { kind: 'agent', period: '2026-09-25', metrics: { runs: 4, completed: 3, durationMsTotal: 8000, durationSamples: 2, avgDurationMs: 4000 }, dimensions: null, source: 'agent_run', refreshedAt: new Date('2026-09-25T10:00:00.000Z') },
      { kind: 'usage', period: '2026-09-25', metrics: { llm_cost: 0.5, agent_run: 4 }, dimensions: null, source: 'usage_ledger', refreshedAt: new Date('2026-09-25T10:00:00.000Z') },
    ]);
    const res = await svc.query('org-1', { from: '2026-09-24', to: '2026-09-25' });
    expect(res.series).toHaveLength(3);
    expect(res.facts.agent).toMatchObject({ runs: 6, completed: 4, durationMsTotal: 9000, durationSamples: 4, avgDurationMs: 2250 });
    expect(res.facts.usage).toMatchObject({ llm_cost: 0.5, agent_run: 4 });
    expect(res.meta.source).toEqual(['agent_run', 'usage_ledger']);
    expect(res.meta.refreshedAt).toEqual(new Date('2026-09-25T10:00:00.000Z'));
    expect(res.meta.layering.facts).toBe('deterministic-projection');
  });

  it('overview：跨 kind 汇总 + derived 服务端计算（成功率/人均成本），标注 interpretation=none', async () => {
    const { svc, prisma } = makeService();
    prisma.organizationMember.count.mockResolvedValue(4);
    prisma.analyticsAggregate.findMany.mockResolvedValue([
      { kind: 'usage', period: '2026-09-25', metrics: { llm_cost: 3.5, agent_run: 4 }, dimensions: null, source: 'usage_ledger', refreshedAt: new Date('2026-09-25T10:00:00.000Z') },
      { kind: 'agent', period: '2026-09-25', metrics: { runs: 4, completed: 3, durationMsTotal: 400, durationSamples: 4 }, dimensions: null, source: 'agent_run', refreshedAt: new Date('2026-09-25T10:00:00.000Z') },
      { kind: 'provider', period: '2026-09-25', metrics: { calls: 5, estimatedCost: 1.5 }, dimensions: null, source: 'usage_record', refreshedAt: new Date('2026-09-25T10:00:00.000Z') },
    ]);
    const res = await svc.overview('org-1', 'day');
    expect(res.derived).toMatchObject({
      totalCost: 5, llmCost: 3.5, providerCost: 1.5,
      runSuccessRate: 0.75, avgRunDurationMs: 100, costPerRun: 1.25, costPerMember: 1.25, costPerDay: 5, runsPerDay: 4,
    });
    expect(res.context.members).toBe(4);
    expect(res.meta.layering).toMatchObject({ facts: 'deterministic-projection', derived: 'service-computed', interpretation: 'none' });
    expect(JSON.stringify(res)).not.toMatch(/insight|narrative|recommend/i); // 绝不含 LLM 解读字段
  });

  it('sources：聚合行 source 追溯（kind → 事务表 + 指标键 + 刷新时间）', async () => {
    const { svc, prisma } = makeService();
    prisma.analyticsAggregate.findMany.mockResolvedValue([
      { kind: 'agent', source: 'agent_run', period: '2026-09-25', userId: null, dimensions: null, metrics: { runs: 2, completed: 2 }, refreshedAt: new Date('2026-09-25T10:00:00.000Z') },
      { kind: 'provider', source: 'usage_record', period: '2026-09-25', userId: null, dimensions: { providers: ['p1'] }, metrics: { calls: 1 }, refreshedAt: new Date('2026-09-25T10:00:00.000Z') },
    ]);
    const res = await svc.sources('org-1', '2026-09-25');
    expect(res.count).toBe(2);
    expect(res.kindSourceMap.usage).toBe('usage_ledger');
    expect(res.sources[0]).toMatchObject({ kind: 'agent', source: 'agent_run', scope: 'organization', metricKeys: ['completed', 'runs'] });
    expect(res.sources[1].dimensions).toMatchObject({ providers: ['p1'] });
  });

  it('mergeMetrics：数字求和、嵌套对象递归（byProvider），非数字原样覆盖', () => {
    expect(mergeMetrics({ a: 1, byProvider: { p1: { calls: 1 } }, tag: 'x' }, { a: 2, byProvider: { p1: { calls: 3 }, p2: { calls: 1 } }, tag: 'y' }))
      .toEqual({ a: 3, byProvider: { p1: { calls: 4 }, p2: { calls: 1 } }, tag: 'y' });
  });
});
