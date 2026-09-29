import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AnalyticsService, addDays, dayRange, finalizeMetrics, mergeMetrics, periodOf, rangeOf } from './analytics.service';

const DAY_START = new Date('2026-09-25T00:00:00.000Z');

function makeService(org: { id: string; isPersonal: boolean; ownerUserId: string } | null = { id: 'org-1', isPersonal: true, ownerUserId: 'u1' }) {
  const prisma = {
    organization: {
      findFirst: vi.fn().mockResolvedValue(org),
      // M12-P5：周期聚合（refreshStaleOrganizations）按 id 升序轮转
      findMany: vi.fn().mockResolvedValue([]),
    },
    organizationMember: {
      count: vi.fn().mockResolvedValue(2),
      // M12-P5：snapshotSummary 的成员归属（默认空 ⇒ 走"两侧都空 → 不查快照表"的短路分支）
      findMany: vi.fn().mockResolvedValue([]),
    },
    project: { findMany: vi.fn().mockResolvedValue([]) },
    // M12-P5：PerformanceSnapshot 死端接线（overview.snapshots）
    performanceSnapshot: { findMany: vi.fn().mockResolvedValue([]) },
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

  it('refreshOrganization：五维度各一行，source 标注事务来源，period=指定日，userId=组织级 global 哨兵（Pre-M9 S1）', async () => {
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
      expect(row.userId).toBe('global');
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

  it('kind=agent：状态分布 + 时长合计/样本/均值（未终态无时长样本）+ M12-P2 byAgent 维度逐 agent 投影', async () => {
    const { svc, prisma } = makeService();
    prisma.agentRun.findMany.mockResolvedValue([
      { id: 'r1', agentId: 'agent-general', status: 'completed', startedAt: DAY_START, completedAt: new Date(DAY_START.getTime() + 10_000) },
      { id: 'r2', agentId: 'agent-general', status: 'completed', startedAt: DAY_START, completedAt: new Date(DAY_START.getTime() + 20_000) },
      { id: 'r3', agentId: 'agent-general', status: 'failed', startedAt: DAY_START, completedAt: new Date(DAY_START.getTime() + 500) },
      { id: 'r4', agentId: 'agent-x', status: 'cancelled', startedAt: DAY_START, completedAt: null },
      { id: 'r5', agentId: 'agent-x', status: 'timeout', startedAt: DAY_START, completedAt: new Date(DAY_START.getTime() + 30_000) },
    ]);
    await svc.refreshOrganization('org-1', '2026-09-25');
    const row = createdRow(prisma, 'agent')!;
    expect(row.metrics).toMatchObject({
      runs: 5, completed: 2, failed: 1, cancelled: 1, timeout: 1, queued: 0, running: 0, waiting: 0,
      durationSamples: 4, durationMsTotal: 60_500, avgDurationMs: 15_125,
      // 逐 agent 同一套事实 + 读时派生（终态口径的成功率/失败率/均值）
      byAgent: {
        'agent-general': {
          runs: 3, completed: 2, failed: 1, cancelled: 0, timeout: 0, terminal: 3,
          durationSamples: 3, durationMsTotal: 30_500, avgDurationMs: 10_166.666667,
          successRate: 0.666667, failureRate: 0.333333,
        },
        'agent-x': {
          runs: 2, completed: 0, cancelled: 1, timeout: 1, terminal: 2,
          durationSamples: 1, durationMsTotal: 30_000, avgDurationMs: 30_000,
          successRate: 0, failureRate: 0, // 失败率只数 failed（cancelled/timeout 各自独立计数，绝不混算）
        },
      },
    });
    expect(row.dimensions).toMatchObject({ agents: ['agent-general', 'agent-x'] }); // agentId 维度可追溯
  });

  it('kind=agent：run 无 agentId（历史行）只进顶层合计，绝不伪造 agent 桶', async () => {
    const { svc, prisma } = makeService();
    prisma.agentRun.findMany.mockResolvedValue([
      { id: 'r1', agentId: '', status: 'completed', startedAt: DAY_START, completedAt: null },
    ]);
    await svc.refreshOrganization('org-1', '2026-09-25');
    const row = createdRow(prisma, 'agent')!;
    expect(row.metrics).toMatchObject({ runs: 1, completed: 1 });
    expect((row.metrics as Record<string, unknown>).byAgent).toBeUndefined();
    expect(row.dimensions).toMatchObject({ agents: [] });
  });

  it('finalizeMetrics：byAgent 维度的均值/派生按合并后的 facts 重算（绝不跨天求平均的平均）', () => {
    const merged = mergeMetrics(
      { byAgent: { a: { runs: 2, completed: 2, durationMsTotal: 100, durationSamples: 2, avgDurationMs: 50 } } },
      { byAgent: { a: { runs: 8, failed: 8, durationMsTotal: 200, durationSamples: 8, avgDurationMs: 25 } } },
    );
    const out = finalizeMetrics('agent', merged);
    expect(out.byAgent).toMatchObject({
      a: {
        runs: 10, completed: 2, failed: 8, terminal: 10,
        durationMsTotal: 300, durationSamples: 10,
        avgDurationMs: 30, // 300/10；绝不是 (50+25)/2 = 37.5 的"平均的平均"
        successRate: 0.2, failureRate: 0.8,
      },
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
      // Pre-M9 U1：provider 维度按 kind 拆成本（llmChat/media）——成本单一事实源 = usage_records
      { kind: 'provider', period: '2026-09-25', metrics: { calls: 5, estimatedCost: 1.5, llmCost: 1.2, mediaCost: 0.3 }, dimensions: null, source: 'usage_record', refreshedAt: new Date('2026-09-25T10:00:00.000Z') },
    ]);
    const res = await svc.overview('org-1', 'day');
    // Pre-M9 U1 回归证明：usage.llm_cost(账本)=3.5 绝不与 provider(usage_records)=1.5 相加（相加必双计=5）；
    // totalCost 单一源 = llmCost 1.2 + mediaCost 0.3 = 1.5
    expect(res.derived).toMatchObject({
      totalCost: 1.5, llmCost: 1.2, providerCost: 1.5,
      runSuccessRate: 0.75, avgRunDurationMs: 100, costPerRun: 0.375, costPerMember: 0.375, costPerDay: 1.5, runsPerDay: 4,
    });
    expect(res.context.members).toBe(4);
    expect(res.meta.layering).toMatchObject({ facts: 'deterministic-projection', derived: 'service-computed', interpretation: 'none' });
    expect(JSON.stringify(res)).not.toMatch(/insight|narrative|recommend/i); // 绝不含 LLM 解读字段
  });

  it('sources：聚合行 source 追溯（kind → 事务表 + 指标键 + 刷新时间）', async () => {
    const { svc, prisma } = makeService();
    prisma.analyticsAggregate.findMany.mockResolvedValue([
      { kind: 'agent', source: 'agent_run', period: '2026-09-25', userId: 'global', dimensions: null, metrics: { runs: 2, completed: 2 }, refreshedAt: new Date('2026-09-25T10:00:00.000Z') },
      { kind: 'provider', source: 'usage_record', period: '2026-09-25', userId: 'global', dimensions: { providers: ['p1'] }, metrics: { calls: 1 }, refreshedAt: new Date('2026-09-25T10:00:00.000Z') },
    ]);
    const res = await svc.sources('org-1', '2026-09-25');
    expect(res.count).toBe(2);
    expect(res.kindSourceMap.usage).toBe('usage_ledger');
    expect(res.sources[0]).toMatchObject({ kind: 'agent', source: 'agent_run', scope: 'organization', metricKeys: ['completed', 'runs'] });
    expect(res.sources[1].dimensions).toMatchObject({ providers: ['p1'] });
  });

  it('P2 读路径：overview(month) 只补刷当日（1 天 × 17 查询），绝不内联刷新 30 天', async () => {
    const { svc, prisma } = makeService();
    prisma.analyticsAggregate.findMany.mockResolvedValue([]);
    await svc.overview('org-1', 'month');
    // 每日刷新 = usageLedgerEntry/generationTask/usageRecord/workflowRun 各 1 次 + agentRun 2 次（当日 + 归因回看窗）
    expect(prisma.usageLedgerEntry.findMany).toHaveBeenCalledTimes(1);
    expect(prisma.generationTask.findMany).toHaveBeenCalledTimes(1);
    expect(prisma.usageRecord.findMany).toHaveBeenCalledTimes(1);
    expect(prisma.workflowRun.findMany).toHaveBeenCalledTimes(1);
    expect(prisma.agentRun.findMany).toHaveBeenCalledTimes(2);
    // 5 维度各一行（单日）；原实现 month = 30 天 × 5 行 = 150 行
    expect(prisma.analyticsAggregate.create).toHaveBeenCalledTimes(5);
    const periods = prisma.analyticsAggregate.create.mock.calls.map((c) => (c as unknown as [{ data: { period: string } }])[0].data.period);
    expect(new Set(periods)).toEqual(new Set([periodOf(new Date())])); // 只刷当日
    expect(prisma.analyticsAggregate.findMany).toHaveBeenCalledTimes(1); // 读只读聚合表
  });

  it('P2 读路径：breakdown(days=366) 仍只补刷当日（5 行），历史日只读已有聚合行', async () => {
    const { svc, prisma } = makeService();
    await svc.breakdown('org-1', { kind: 'usage', days: 366 });
    expect(prisma.analyticsAggregate.create).toHaveBeenCalledTimes(5);
    expect(prisma.usageLedgerEntry.findMany).toHaveBeenCalledTimes(1);
    const query = (prisma.analyticsAggregate.findMany.mock.calls[0] as unknown as [{ where: { period: { gte: string; lte: string } } }])[0];
    expect(query.where.period.gte).toBe(addDays(periodOf(new Date()), -365)); // 读窗口仍是 366 天
    expect(query.where.period.lte).toBe(periodOf(new Date()));
  });

  it('P2 刷新语义：refreshOrganization/refreshAll 行为不变（显式入口仍可刷历史区间）；sources/query 保持只读', async () => {
    const { svc, prisma } = makeService();
    await svc.refreshOrganization('org-1', '2026-09-01');
    expect(prisma.analyticsAggregate.create).toHaveBeenCalledTimes(5);
    expect(prisma.analyticsAggregate.create.mock.calls.map((c) => (c as unknown as [{ data: { period: string } }])[0].data.period))
      .toEqual(['2026-09-01', '2026-09-01', '2026-09-01', '2026-09-01', '2026-09-01']);

    prisma.analyticsAggregate.create.mockClear();
    await svc.refreshAll('org-1', '2026-08-30', '2026-08-31');
    expect(prisma.analyticsAggregate.create).toHaveBeenCalledTimes(10); // 显式刷新仍按天循环

    prisma.analyticsAggregate.create.mockClear();
    prisma.analyticsAggregate.findMany.mockResolvedValue([]);
    await svc.query('org-1', { from: '2026-08-27', to: '2026-09-25' });
    await svc.sources('org-1', '2026-09-25');
    expect(prisma.analyticsAggregate.create).not.toHaveBeenCalled(); // 只读端点绝不写
  });

  it('query：agent facts 的 byAgent 维度逐 agent 重算（跨天合并后成功率/失败率/均值正确）', async () => {
    const { svc, prisma } = makeService();
    prisma.analyticsAggregate.findMany.mockResolvedValue([
      { kind: 'agent', period: '2026-09-24', metrics: { runs: 2, byAgent: { a: { runs: 2, completed: 2, durationMsTotal: 100, durationSamples: 2 } } }, dimensions: { agents: ['a'] }, source: 'agent_run', refreshedAt: new Date('2026-09-24T23:00:00.000Z') },
      { kind: 'agent', period: '2026-09-25', metrics: { runs: 2, byAgent: { a: { runs: 2, failed: 2, durationMsTotal: 900, durationSamples: 2 } } }, dimensions: { agents: ['a'] }, source: 'agent_run', refreshedAt: new Date('2026-09-25T10:00:00.000Z') },
    ]);
    const res = await svc.query('org-1', { from: '2026-09-24', to: '2026-09-25' });
    expect(res.facts.agent.byAgent).toMatchObject({
      a: { runs: 4, completed: 2, failed: 2, terminal: 4, durationSamples: 4, avgDurationMs: 250, successRate: 0.5, failureRate: 0.5 },
    });
  });

  it('agentMetrics（组织级读面）：按 agent 的成功率/平均时长/失败率——有界只读，绝不写聚合/绝不建汇总表', async () => {
    const { svc, prisma } = makeService();
    prisma.analyticsAggregate.findMany.mockResolvedValue([
      { period: '2026-09-24', metrics: { byAgent: { a: { runs: 2, completed: 2, durationMsTotal: 100, durationSamples: 2 } } } },
      { period: '2026-09-25', metrics: { byAgent: { a: { runs: 2, failed: 2, durationMsTotal: 900, durationSamples: 2 }, b: { runs: 3, completed: 3, durationMsTotal: 30, durationSamples: 3 } } } },
    ]);
    const res = await svc.agentMetrics({ organizationId: 'org-1', days: 3, now: new Date('2026-09-25T10:00:00.000Z') });
    expect(res).toMatchObject({
      scope: 'organization', organizationId: 'org-1', from: '2026-09-23', to: '2026-09-25', days: 3,
      meta: { source: 'analytics_aggregate', kind: 'agent', layering: { facts: 'deterministic-projection', interpretation: 'none' } },
    });
    expect(res.agents.map((a) => a.agentId)).toEqual(['a', 'b']);
    expect(res.agents[0]).toMatchObject({
      runs: 4, terminal: 4, successRate: 0.5, failureRate: 0.5, avgDurationMs: 250, durationSamples: 4,
    });
    expect(res.agents[1]).toMatchObject({ runs: 3, terminal: 3, successRate: 1, failureRate: 0, avgDurationMs: 10 });
    expect(prisma.analyticsAggregate.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { kind: 'agent', period: { gte: '2026-09-23', lte: '2026-09-25' }, organizationId: 'org-1' },
      orderBy: [{ period: 'desc' }],
    }));
    expect(prisma.analyticsAggregate.create).not.toHaveBeenCalled(); // 只读：绝不触发刷新/写入
    expect(prisma.analyticsAggregate.update).not.toHaveBeenCalled();
    expect(prisma.agentRun.findMany).not.toHaveBeenCalled(); // 绝不回扫事务表
  });

  it('agentMetrics（缺省作用域）：平台级 = 不带 organizationId 过滤（仅内部排序输入；窗口上限夹取 90 天）', async () => {
    const { svc, prisma } = makeService();
    prisma.analyticsAggregate.findMany.mockResolvedValue([]);
    const res = await svc.agentMetrics({ days: 10_000 });
    expect(res).toMatchObject({ scope: 'platform', organizationId: null, days: 90 });
    const call = (prisma.analyticsAggregate.findMany.mock.calls[0] as unknown as [{ where: Record<string, unknown> }])[0];
    expect(call.where).toEqual({ kind: 'agent', period: { gte: addDays(periodOf(new Date()), -89), lte: periodOf(new Date()) } });
    expect(call.where.organizationId).toBeUndefined();
    expect(res.agents).toEqual([]); // 无数据 → 消费方回退静态顺序
  });

  // ===== M12-P5（审计项）：PerformanceSnapshot 死端接线 + 聚合 cron 化 =====

  it('M12-P5 snapshotSummary：窗口按 period 相交（非 capturedAt）+ 白名单六标量求和 + derived 由合计重算', async () => {
    const { svc, prisma } = makeService();
    prisma.organizationMember.findMany.mockResolvedValue([{ userId: 'u1' }, { userId: 'u2' }]);
    prisma.project.findMany.mockResolvedValue([{ id: 'p1' }]);
    // 按 capturedAt desc 给出（与 DB orderBy 一致）：latest = 第一行
    prisma.performanceSnapshot.findMany.mockResolvedValue([
      {
        id: 'snap-a', source: 'agent', projectId: null,
        periodStart: new Date('2026-09-25T00:00:00.000Z'), periodEnd: new Date('2026-09-26T00:00:00.000Z'),
        capturedAt: new Date('2026-09-26T02:00:00.000Z'),
        metrics: { impressions: 1000, clicks: 50, spend: 100, conversions: 5, revenue: 400, orders: 4 },
      },
      {
        id: 'snap-b', source: 'manual', projectId: 'p2',
        periodStart: new Date('2026-09-24T00:00:00.000Z'), periodEnd: new Date('2026-09-25T00:00:00.000Z'),
        capturedAt: new Date('2026-09-25T02:00:00.000Z'),
        metrics: { impressions: 1000, clicks: 50, spend: 100, conversions: 5, revenue: 400, orders: 4, extra: 999 },
      },
    ]);

    const from = new Date('2026-09-25T00:00:00.000Z');
    const to = new Date('2026-09-26T00:00:00.000Z');
    const res = await svc.snapshotSummary('org-1', from, to);

    const query = (prisma.performanceSnapshot.findMany.mock.calls[0] as unknown as [{
      where: { periodStart: { lt: Date }; periodEnd: { gte: Date }; OR: unknown[] };
      orderBy: unknown; take: number; select: Record<string, boolean>;
    }])[0];
    // 窗口 = 周期相交（快照陈述的是"它覆盖的那段时间"；capturedAt 不参与过滤）
    expect(query.where.periodStart.lt).toEqual(to);
    expect(query.where.periodEnd.gte).toEqual(from);
    expect(query.where.OR).toEqual([{ userId: { in: ['u1', 'u2'] } }, { projectId: { in: ['p1'] } }]);
    expect(query.take).toBe(201); // 有界读：上限 200 + 1（判截断）
    expect(query.select.metrics).toBe(true);

    expect(res.count).toBe(2);
    expect(res.truncated).toBe(false);
    expect(res.bySource).toEqual({ manual: 1, agent: 1 });
    expect(res.projects).toBe(1); // projectId 去重（null 不计）
    expect(res.newestCapturedAt).toEqual(new Date('2026-09-26T02:00:00.000Z'));
    expect(res.oldestCapturedAt).toEqual(new Date('2026-09-25T02:00:00.000Z'));
    // facts：只求和六个白名单标量（extra 绝不进摘要）+ entries 计数
    expect(res.facts).toEqual({ impressions: 2000, clicks: 100, spend: 200, conversions: 10, revenue: 800, orders: 8, entries: 2 });
    // derived 由**合计值**重算（绝不把各快照 derived 相加/求平均）
    expect(res.derived).toEqual({ ctr: 0.05, cvr: 0.1, roas: 4, cpc: 2, cpa: 20, costPerOrder: 25 });
    expect(res.latest).toMatchObject({ id: 'snap-a', source: 'agent', projectId: null, capturedAt: new Date('2026-09-26T02:00:00.000Z') });
    // latest 给**原文**：metrics 全部键照抄（含白名单外的 extra），摘要聚合里绝不出现
    expect(res.latest!.metrics).toEqual({ impressions: 1000, clicks: 50, spend: 100, conversions: 5, revenue: 400, orders: 4 });
    expect(res.facts).not.toHaveProperty('extra');
    expect(res.window).toEqual({ from: from.toISOString(), to: to.toISOString() });
    expect(res.layering).toEqual({ facts: 'reported', derived: 'service-computed', interpretation: 'none' });
    expect(JSON.stringify(res)).not.toMatch(/insight|narrative|recommend/i);
  });

  it('M12-P5 snapshotSummary：超上限截断（读 201 只用 200）、分母为 0 的比率一律 0', async () => {
    const { svc, prisma } = makeService();
    prisma.organizationMember.findMany.mockResolvedValue([{ userId: 'u1' }]);
    prisma.performanceSnapshot.findMany.mockResolvedValue(
      Array.from({ length: 201 }, (_, i) => ({
        id: `snap-${i}`, source: 'manual', projectId: null,
        periodStart: new Date('2026-09-25T00:00:00.000Z'), periodEnd: new Date('2026-09-26T00:00:00.000Z'),
        capturedAt: new Date(Date.UTC(2026, 8, 25, 0, 0, i % 60)),
        metrics: { impressions: 1, clicks: 1, spend: 1, conversions: 1, revenue: 1, orders: 1 },
      })),
    );
    const res = await svc.snapshotSummary('org-1', new Date('2026-09-25T00:00:00.000Z'), new Date('2026-09-26T00:00:00.000Z'));
    expect(res.count).toBe(200);
    expect(res.truncated).toBe(true); // 超上限必须明说，绝不假装完整
    expect(res.facts.entries).toBe(200);

    prisma.performanceSnapshot.findMany.mockResolvedValue([
      {
        id: 'snap-zero', source: 'manual', projectId: null,
        periodStart: new Date('2026-09-25T00:00:00.000Z'), periodEnd: new Date('2026-09-26T00:00:00.000Z'),
        capturedAt: new Date('2026-09-25T01:00:00.000Z'),
        metrics: { impressions: 0, clicks: 0, spend: 0, conversions: 0, revenue: 0, orders: 0 },
      },
    ]);
    const zero = await svc.snapshotSummary('org-1', new Date('2026-09-25T00:00:00.000Z'), new Date('2026-09-26T00:00:00.000Z'));
    expect(zero.derived).toEqual({ ctr: 0, cvr: 0, roas: 0, cpc: 0, cpa: 0, costPerOrder: 0 });
  });

  it('M12-P5 snapshotSummary：组织无成员且无项目 ⇒ 空摘要（短路，不查快照表，避免 in:[] 恒假的全表扫）', async () => {
    const { svc, prisma } = makeService();
    const res = await svc.snapshotSummary('org-1', new Date('2026-09-25T00:00:00.000Z'), new Date('2026-09-26T00:00:00.000Z'));
    expect(res.count).toBe(0);
    expect(res.truncated).toBe(false);
    expect(res.bySource).toEqual({});
    expect(res.projects).toBe(0);
    expect(res.newestCapturedAt).toBeNull();
    expect(res.oldestCapturedAt).toBeNull();
    expect(res.latest).toBeNull();
    expect(res.facts).toEqual({ impressions: 0, clicks: 0, spend: 0, conversions: 0, revenue: 0, orders: 0, entries: 0 });
    expect(prisma.performanceSnapshot.findMany).not.toHaveBeenCalled();
  });

  it('M12-P5 overview：snapshots 摘要接到概览（死端接线）——窗口与 range 同日粒度对齐、不改既有 derived 口径', async () => {
    const { svc, prisma } = makeService();
    prisma.organizationMember.count.mockResolvedValue(4);
    prisma.project.findMany.mockResolvedValue([{ id: 'p1' }]);
    prisma.performanceSnapshot.findMany.mockResolvedValue([
      {
        id: 'snap-1', source: 'manual', projectId: 'p1',
        periodStart: new Date('2026-09-25T00:00:00.000Z'), periodEnd: new Date('2026-09-26T00:00:00.000Z'),
        capturedAt: new Date('2026-09-25T03:00:00.000Z'),
        metrics: { impressions: 100, clicks: 10, spend: 20, conversions: 2, revenue: 80, orders: 2 },
      },
    ]);
    const res = await svc.overview('org-1', 'day');
    expect(res.snapshots.count).toBe(1);
    expect(res.snapshots.facts).toMatchObject({ impressions: 100, clicks: 10, spend: 20, revenue: 80 });
    expect(res.snapshots.derived).toMatchObject({ ctr: 0.1, roas: 4, cpc: 2, cpa: 10, costPerOrder: 10 });
    // 窗口 = 本次 overview 的 [from, to] 闭开端（day ⇒ 当日 00:00 → 次日 00:00 UTC）
    expect(res.snapshots.window).toEqual({
      from: dayRange(res.from).start.toISOString(),
      to: dayRange(res.to).end.toISOString(),
    });
    // 既有 derived/context 口径不变（快照只增字段，不参与成本/成功率计算）
    expect(res.context.members).toBe(4);
    expect(res.derived).toMatchObject({ totalCost: 0, costPerMember: 0, runsPerDay: 0 });
  });

  it('M12-P5 refreshStaleOrganizations：按 id 升序轮转 + take=上限+1 判截断 + 每组织刷 days 天', async () => {
    const { svc, prisma } = makeService();
    prisma.organization.findMany.mockResolvedValue([{ id: 'org-a' }, { id: 'org-b' }, { id: 'org-c' }]);
    const res = await svc.refreshStaleOrganizations(); // 默认：50 组织 / analyticsAggregationDays() 天
    const query = (prisma.organization.findMany.mock.calls[0] as unknown as [{
      where: Record<string, unknown>; select: Record<string, boolean>; orderBy: unknown; take: number;
    }])[0];
    expect(query.where).toEqual({ deletedAt: null }); // 软删组织不刷
    expect(query.orderBy).toEqual({ id: 'asc' });
    expect(query.take).toBe(51);
    expect(res.organizations).toBe(3);
    expect(res.truncated).toBe(false);
    expect(res.nextCursor).toBeNull(); // 取不满 ⇒ 已扫到末尾，下轮从头开始
    expect(res.days).toBe(2); // 默认 2 天：昨日在当日被重算（跨零点补齐）+ 今日
    expect(res.periods).toBe(2);
    expect(res.from).toBe(addDays(res.to, -1));
    expect(res.refreshed).toBe(6); // 3 组织 × 2 天
    expect(res.failed).toBe(0);
    expect(prisma.analyticsAggregate.create).toHaveBeenCalledTimes(30); // 6 次刷新 × 5 维度
  });

  it('M12-P5 refreshStaleOrganizations：超预算 ⇒ truncated + nextCursor，下一轮从游标之后继续（组织多也轮得到）', async () => {
    const { svc, prisma } = makeService();
    const orgs = [{ id: 'org-a' }, { id: 'org-b' }, { id: 'org-c' }];
    // 模拟真实 DB：where.id.gt 游标 + take 截断（否则"第二轮继续"无从验证）
    prisma.organization.findMany.mockImplementation(async (args: { where: { id?: { gt: string } }; take: number }) => {
      const rest = args.where.id?.gt ? orgs.filter((o) => o.id > args.where.id!.gt) : orgs;
      return rest.slice(0, args.take);
    });
    const first = await svc.refreshStaleOrganizations({ maxOrganizations: 2, days: 1 });
    expect(first.organizations).toBe(2);
    expect(first.truncated).toBe(true);
    expect(first.nextCursor).toBe('org-b');
    expect(first.refreshed).toBe(2);

    const second = await svc.refreshStaleOrganizations({ maxOrganizations: 2, days: 1 });
    const secondQuery = (prisma.organization.findMany.mock.calls[1] as unknown as [{ where: { id?: { gt: string } } }])[0];
    expect(secondQuery.where.id).toEqual({ gt: 'org-b' }); // 游标分页：绝不总是刷前 N 个
    expect(second.truncated).toBe(false);
    expect(second.nextCursor).toBeNull();
  });

  it('M12-P5 refreshStaleOrganizations：单组织失败只记 warn 并计入 failed，绝不打断整轮（失败隔离）+ days 上下界收敛', async () => {
    const { svc, prisma } = makeService();
    prisma.organization.findMany.mockResolvedValue([{ id: 'org-a' }, { id: 'org-b' }]);
    prisma.analyticsAggregate.create.mockImplementation(async ({ data }: { data: { organizationId: string } }) => {
      if (data.organizationId === 'org-a') throw new Error('boom');
      return { id: 'agg-x' };
    });
    const res = await svc.refreshStaleOrganizations({ days: 1 });
    expect(res.failed).toBe(1);
    expect(res.refreshed).toBe(1); // org-b 照常完成
    expect(res.organizations).toBe(2);

    const clamped = await svc.refreshStaleOrganizations({ days: 99, maxOrganizations: 0 });
    expect(clamped.days).toBe(31); // 上限 31（防止一轮长占 worker）
    expect(clamped.organizations).toBeGreaterThanOrEqual(1); // maxOrganizations 下界 1
  });

  it('mergeMetrics：数字求和、嵌套对象递归（byProvider），非数字原样覆盖', () => {
    expect(mergeMetrics({ a: 1, byProvider: { p1: { calls: 1 } }, tag: 'x' }, { a: 2, byProvider: { p1: { calls: 3 }, p2: { calls: 1 } }, tag: 'y' }))
      .toEqual({ a: 3, byProvider: { p1: { calls: 4 }, p2: { calls: 1 } }, tag: 'y' });
  });
});
