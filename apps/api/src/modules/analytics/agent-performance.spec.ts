import { describe, it, expect, vi } from 'vitest';
import {
  DEFAULT_PERFORMANCE_MIN_SAMPLES,
  DEFAULT_PERFORMANCE_WINDOW_DAYS,
  MAX_PERFORMANCE_ROWS,
  MAX_PERFORMANCE_WINDOW_DAYS,
  accumulateAgentFacts,
  finalizeAgentFacts,
  loadAgentPerformance,
  normalizeMinSamples,
  normalizePerformanceWindowDays,
  parsePerformanceRanking,
  performanceIndex,
  performanceWindow,
  rankByAgentPerformance,
  summarizeAgentAggregateRows,
  type AgentPerformanceStat,
} from './agent-performance';

/** 聚合行（byAgent 维度） */
const row = (byAgent: Record<string, unknown>, period = '2026-09-25') => ({ period, metrics: { runs: 9, byAgent } });

function reader(rows: unknown[]) {
  const findMany = vi.fn().mockResolvedValue(rows);
  return { prisma: { analyticsAggregate: { findMany } }, findMany };
}

const stat = (agentId: string, over: Partial<AgentPerformanceStat> = {}): AgentPerformanceStat => ({
  agentId,
  runs: 10, completed: 8, failed: 2, cancelled: 0, timeout: 0, queued: 0, running: 0, waiting: 0,
  durationMsTotal: 1000, durationSamples: 10, terminal: 10, successRate: 0.8, failureRate: 0.2, avgDurationMs: 100,
  ...over,
});

describe('agent-performance（M12-P2 表现投影原语）', () => {
  it('窗口夹取：缺省 14 天，越界夹到 [1, 90]，非法值回默认（绝不无界回看）', () => {
    expect(normalizePerformanceWindowDays()).toBe(DEFAULT_PERFORMANCE_WINDOW_DAYS);
    expect(normalizePerformanceWindowDays(7)).toBe(7);
    expect(normalizePerformanceWindowDays(0)).toBe(DEFAULT_PERFORMANCE_WINDOW_DAYS);
    expect(normalizePerformanceWindowDays(-5)).toBe(DEFAULT_PERFORMANCE_WINDOW_DAYS);
    expect(normalizePerformanceWindowDays(Number.NaN)).toBe(DEFAULT_PERFORMANCE_WINDOW_DAYS);
    expect(normalizePerformanceWindowDays(10_000)).toBe(MAX_PERFORMANCE_WINDOW_DAYS);
    expect(performanceWindow(3, new Date('2026-09-25T23:59:00.000Z'))).toEqual({ from: '2026-09-23', to: '2026-09-25', days: 3 });
  });

  it('最小样本夹取：缺省 5；显式 0 允许单次样本参与排序；负数/NaN 回默认', () => {
    expect(normalizeMinSamples()).toBe(DEFAULT_PERFORMANCE_MIN_SAMPLES);
    expect(normalizeMinSamples(0)).toBe(0);
    expect(normalizeMinSamples(2.7)).toBe(2);
    expect(normalizeMinSamples(-1)).toBe(DEFAULT_PERFORMANCE_MIN_SAMPLES);
    expect(normalizeMinSamples(Number.NaN)).toBe(DEFAULT_PERFORMANCE_MIN_SAMPLES);
  });

  it('routingPolicy.performanceRanking 解析：非法配置一律忽略回默认，绝不抛错', () => {
    expect(parsePerformanceRanking(undefined)).toEqual({});
    expect(parsePerformanceRanking('nope')).toEqual({});
    expect(parsePerformanceRanking([1, 2])).toEqual({});
    expect(parsePerformanceRanking({ windowDays: 30, minSamples: 0 })).toEqual({ windowDays: 30, minSamples: 0 });
    expect(parsePerformanceRanking({ windowDays: -3, minSamples: 'x' })).toEqual({});
  });

  it('累加：数字相加、缺失/脏值按 0，绝不因脏 JSON 抛错', () => {
    const target: Record<string, number> = { runs: 1 };
    accumulateAgentFacts(target, { runs: 2, completed: 3, avgDurationMs: 999, junk: 'x' });
    expect(target).toEqual({ runs: 3, completed: 3 });
    expect(accumulateAgentFacts({}, null as never)).toEqual({});
    expect(accumulateAgentFacts({}, [1, 2] as never)).toEqual({});
  });

  it('派生口径：成功率/失败率分母 = 终态 run（在途不进分母），无终态样本 → 0', () => {
    expect(finalizeAgentFacts({ runs: 10, completed: 6, failed: 2, cancelled: 1, timeout: 1, durationMsTotal: 900, durationSamples: 3 }))
      .toMatchObject({ terminal: 10, successRate: 0.6, failureRate: 0.2, avgDurationMs: 300 });
    expect(finalizeAgentFacts({ runs: 4, queued: 3, running: 1 })).toMatchObject({ terminal: 0, successRate: 0, failureRate: 0, avgDurationMs: 0 });
    expect(finalizeAgentFacts(undefined)).toMatchObject({ runs: 0, terminal: 0, successRate: 0 });
  });

  it('多行聚合（跨天/跨组织）：计数与时长求和，均值按 totals/samples 重算——绝不求平均的平均', () => {
    const stats = summarizeAgentAggregateRows([
      row({ 'agent-a': { runs: 2, completed: 2, durationMsTotal: 100, durationSamples: 2 } }, '2026-09-24'),
      row({ 'agent-a': { runs: 2, completed: 0, failed: 2, durationMsTotal: 800, durationSamples: 2 } }, '2026-09-25'),
      row({ 'agent-b': { runs: 5, completed: 5, durationMsTotal: 50, durationSamples: 5 } }),
    ]);
    expect(stats.map((s) => s.agentId)).toEqual(['agent-a', 'agent-b']); // 确定性输出顺序
    expect(stats[0]).toMatchObject({
      runs: 4, completed: 2, failed: 2, terminal: 4, successRate: 0.5, failureRate: 0.5,
      durationSamples: 4, durationMsTotal: 900, avgDurationMs: 225, // 绝不是 (50+400)/2
    });
    expect(stats[1]).toMatchObject({ runs: 5, successRate: 1, failureRate: 0, avgDurationMs: 10 });
  });

  it('历史行（无 byAgent 维度）不贡献任何 agent 样本：宁可无数据回退静态顺序，绝不凑样本', () => {
    expect(summarizeAgentAggregateRows([
      { period: '2026-09-24', metrics: { runs: 99, completed: 99 } }, // M12-P2 之前的行
      { period: '2026-09-25', metrics: null },
      { period: '2026-09-25', metrics: { byAgent: null } },
      { period: '2026-09-25', metrics: { byAgent: { '': { runs: 1 } } } }, // 空 agentId 丢弃
    ])).toEqual([]);
  });

  it('loadAgentPerformance：单次有界只读查询（kind=agent + 窗口 + period 倒序 + take），组织缺省 = 平台级', async () => {
    const { prisma, findMany } = reader([row({ 'agent-a': { runs: 3, completed: 3 } })]);
    const stats = await loadAgentPerformance(prisma as never, { days: 3, now: new Date('2026-09-25T10:00:00.000Z') });
    expect(findMany).toHaveBeenCalledWith({
      where: { kind: 'agent', period: { gte: '2026-09-23', lte: '2026-09-25' } },
      select: { period: true, metrics: true },
      orderBy: [{ period: 'desc' }],
      take: MAX_PERFORMANCE_ROWS,
    });
    expect(stats).toHaveLength(1);
    expect(stats[0]).toMatchObject({ agentId: 'agent-a', runs: 3, successRate: 1 });
  });

  it('loadAgentPerformance：显式 organizationId 组织级作用域 + maxRows 覆盖', async () => {
    const { prisma, findMany } = reader([]);
    await loadAgentPerformance(prisma as never, { organizationId: 'org-1', days: 1, maxRows: 10, now: new Date('2026-09-25T10:00:00.000Z') });
    expect(findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { kind: 'agent', period: { gte: '2026-09-25', lte: '2026-09-25' }, organizationId: 'org-1' },
      take: 10,
    }));
  });

  it('performanceIndex：agentId → 统计（排序输入索引）', () => {
    const index = performanceIndex([stat('a'), stat('b')]);
    expect([...index.keys()]).toEqual(['a', 'b']);
    expect(index.get('b')!.agentId).toBe('b');
  });

  it('排序：无数据 / 仅 1 个样本充足候选 → 静态顺序逐字不变（零行为漂移），且不修改入参', () => {
    const candidates = ['a', 'b', 'c'];
    expect(rankByAgentPerformance(candidates, { agentId: (c) => c, stats: [] })).toEqual(['a', 'b', 'c']);
    expect(rankByAgentPerformance(candidates, { agentId: (c) => c, stats: [stat('c')] })).toEqual(['a', 'b', 'c']);
    expect(candidates).toEqual(['a', 'b', 'c']);
  });

  it('排序：失败率低者优先，只在"有数据候选占据的位置"间重排——无数据候选原地不动', () => {
    const candidates = [{ id: 'a' }, { id: 'x' }, { id: 'b' }];
    const ranked = rankByAgentPerformance(candidates, {
      agentId: (c) => c.id,
      stats: [stat('a', { failureRate: 0.9, terminal: 10 }), stat('b', { failureRate: 0.1, terminal: 10 })],
    });
    // 槽位 = a/b 原本占的 0 与 2；x 保持槽位 1（冷启动候选绝不被挤到队尾）
    expect(ranked.map((c) => c.id)).toEqual(['b', 'x', 'a']);
  });

  it('排序：失败率相同 → 平均时长升序 → 静态序（确定性，绝不抖动）', () => {
    const opts = { agentId: (c: string) => c, stats: [stat('b', { failureRate: 0.2, avgDurationMs: 10 }), stat('a', { failureRate: 0.2, avgDurationMs: 10 })] };
    expect(rankByAgentPerformance(['a', 'b'], opts)).toEqual(['a', 'b']);
    expect(rankByAgentPerformance(['a', 'b'], {
      agentId: (c) => c,
      stats: [stat('a', { failureRate: 0.2, avgDurationMs: 500 }), stat('b', { failureRate: 0.2, avgDurationMs: 10 })],
    })).toEqual(['b', 'a']);
  });

  it('排序：样本门槛（缺省终态 ≥5）——不足者不参与重排；minSamples=0 时单次样本也生效', () => {
    const candidates = ['a', 'b'];
    const stats = [stat('a', { failureRate: 1, terminal: 4 }), stat('b', { failureRate: 0, terminal: 4 })];
    expect(rankByAgentPerformance(candidates, { agentId: (c) => c, stats })).toEqual(['a', 'b']); // 都不足以参与
    expect(rankByAgentPerformance(candidates, { agentId: (c) => c, stats, minSamples: 4 })).toEqual(['b', 'a']);
    expect(rankByAgentPerformance(candidates, { agentId: (c) => c, stats, minSamples: 0 })).toEqual(['b', 'a']);
  });

  it('排序绝不增删候选：长度与多重集恒等（表现数据无权改变候选集合）', () => {
    const candidates = ['a', 'b', 'c', 'd'];
    const ranked = rankByAgentPerformance(candidates, {
      agentId: (c) => c,
      stats: [stat('a', { failureRate: 0.5 }), stat('c', { failureRate: 0 }), stat('d', { failureRate: 0.9 }), stat('unknown', { failureRate: 0 })],
    });
    expect(ranked).toHaveLength(4);
    expect([...ranked].sort()).toEqual(['a', 'b', 'c', 'd']);
  });
});
