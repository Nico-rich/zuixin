import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TaskIntent } from '@ai-agent/shared';
import { AgentRegistryService, candidateSlugs } from './agent-registry.service';

/** Agent 行（Registry 只读 enabled + activeVersion） */
const agentRow = (id: string, slug: string, kind = 'builtin') => ({
  id, slug, kind, enabled: true,
  activeVersion: {
    id: `v-${slug}`, version: 1, systemPrompt: '你是助手', modelId: null,
    tools: ['knowledge.search'], temperature: 0.7, maxTokens: null, config: {},
  },
});

const intent = (type: string) => ({ type, confidence: 0.9, parameters: { prompt: '你好' } }) as unknown as TaskIntent;

/** 表现聚合行（byAgent 维度） */
const perfRow = (byAgent: Record<string, { completed: number; failed: number }>) => ({
  period: '2026-09-25', metrics: { runs: 0, byAgent },
});

function makeRegistry(options: {
  rows?: unknown[];
  policy?: unknown;
  perf?: unknown[];
  perfRejects?: boolean;
} = {}) {
  const prisma = {
    agent: { findMany: vi.fn().mockResolvedValue(options.rows ?? [agentRow('id-general', 'general-assistant')]) },
    systemSetting: { findUnique: vi.fn().mockResolvedValue({ key: 'routingPolicy', value: options.policy ?? {} }) },
    analyticsAggregate: {
      findMany: options.perfRejects
        ? vi.fn().mockRejectedValue(new Error('analytics 暂不可用'))
        : vi.fn().mockResolvedValue(options.perf ?? []),
    },
  };
  const svc = new AgentRegistryService(prisma as never, {} as never, {} as never, {} as never);
  return { svc, prisma };
}

describe('AgentRegistryService（M12-P2 候选排序消费：只调顺序，不调权限）', () => {
  beforeEach(() => vi.clearAllMocks());

  it('candidateSlugs：单 slug 与列表等价；空串/非字符串丢弃，重复去重（顺序 = 静态顺序）', () => {
    expect(candidateSlugs('general-assistant')).toEqual(['general-assistant']);
    expect(candidateSlugs(['a', 'b', 'a'])).toEqual(['a', 'b']);
    expect(candidateSlugs(['a', '', 'b'] as string[])).toEqual(['a', 'b']);
    expect(candidateSlugs(undefined)).toEqual([]);
    expect(candidateSlugs(null)).toEqual([]);
    expect(candidateSlugs([1, null, 'a'] as unknown as string[])).toEqual(['a']);
  });

  it('单候选映射（seed 默认 chat→general-assistant）→ 绝不查询表现数据（既有路径零开销/零漂移）', async () => {
    const { svc, prisma } = makeRegistry({ policy: { agentMapping: { chat: 'general-assistant' } } });
    await svc.refresh();
    const agent = await svc.resolveForIntent(intent('chat'));
    expect(agent).toBe(svc.get('general-assistant'));
    expect(prisma.analyticsAggregate.findMany).not.toHaveBeenCalled();
  });

  it('多候选映射 + 样本充足：失败率低的候选优先（归因键 = Agent 主键 id，非实例 id）', async () => {
    const { svc, prisma } = makeRegistry({
      rows: [agentRow('id-general', 'general-assistant'), agentRow('id-alt', 'alt-assistant', 'custom')],
      policy: { agentMapping: { chat: ['general-assistant', 'alt-assistant'] } },
      perf: [perfRow({
        'id-general': { completed: 2, failed: 8 }, // 失败率 0.8
        'id-alt': { completed: 9, failed: 1 }, // 失败率 0.1
      })],
    });
    await svc.refresh();
    const agent = await svc.resolveForIntent(intent('chat'));
    expect(agent).toBe(svc.get('alt-assistant'));
    expect(prisma.analyticsAggregate.findMany).toHaveBeenCalledTimes(1);
  });

  it('多候选 + 无表现数据 → 静态顺序（映射内第一个），零行为漂移', async () => {
    const { svc, prisma } = makeRegistry({
      rows: [agentRow('id-general', 'general-assistant'), agentRow('id-alt', 'alt-assistant', 'custom')],
      policy: { agentMapping: { chat: ['general-assistant', 'alt-assistant'] } },
      perf: [],
    });
    await svc.refresh();
    expect(await svc.resolveForIntent(intent('chat'))).toBe(svc.get('general-assistant'));
    expect(prisma.analyticsAggregate.findMany).toHaveBeenCalledTimes(1); // 多候选才查表现（单候选不查）
  });

  it('表现数据读取失败 → 回退静态顺序且不抛错（统计数据故障绝不影响用户请求）', async () => {
    const { svc } = makeRegistry({
      rows: [agentRow('id-general', 'general-assistant'), agentRow('id-alt', 'alt-assistant', 'custom')],
      policy: { agentMapping: { chat: ['general-assistant', 'alt-assistant'] } },
      perfRejects: true,
    });
    await svc.refresh();
    expect(await svc.resolveForIntent(intent('chat'))).toBe(svc.get('general-assistant'));
  });

  it('样本不足（terminal < minSamples）→ 不重排；performanceRanking.minSamples 可显式放开', async () => {
    const rows = [agentRow('id-general', 'general-assistant'), agentRow('id-alt', 'alt-assistant', 'custom')];
    const perf = [perfRow({ 'id-general': { completed: 0, failed: 3 }, 'id-alt': { completed: 3, failed: 0 } })];

    const strict = makeRegistry({ rows, policy: { agentMapping: { chat: ['general-assistant', 'alt-assistant'] } }, perf });
    await strict.svc.refresh();
    expect(await strict.svc.resolveForIntent(intent('chat'))).toBe(strict.svc.get('general-assistant'));

    const relaxed = makeRegistry({
      rows,
      policy: { agentMapping: { chat: ['general-assistant', 'alt-assistant'] }, performanceRanking: { minSamples: 2 } },
      perf,
    });
    await relaxed.svc.refresh();
    expect(await relaxed.svc.resolveForIntent(intent('chat'))).toBe(relaxed.svc.get('alt-assistant'));
  });

  it('候选列表中未加载（禁用/无版本/未知 slug）的项被跳过，仍按静态顺序+表现排序选出可用者', async () => {
    const { svc } = makeRegistry({
      rows: [agentRow('id-general', 'general-assistant'), agentRow('id-alt', 'alt-assistant', 'custom')],
      // 'ghost' 未在注册表中（未启用/未知 slug）→ 绝不成为候选
      policy: { agentMapping: { chat: ['ghost', 'general-assistant', 'alt-assistant'] } },
      perf: [perfRow({ 'id-general': { completed: 1, failed: 9 }, 'id-alt': { completed: 9, failed: 1 } })],
    });
    await svc.refresh();
    expect(await svc.resolveForIntent(intent('chat'))).toBe(svc.get('alt-assistant'));
  });

  it('映射目标全部不可用 → 既有兜底 general-assistant（零行为漂移）', async () => {
    const { svc } = makeRegistry({
      rows: [agentRow('id-general', 'general-assistant')],
      policy: { agentMapping: { chat: ['ghost', 'also-ghost'] } },
    });
    await svc.refresh();
    expect(await svc.resolveForIntent(intent('chat'))).toBe(svc.get('general-assistant'));
  });

  it('注册表为空（含 general-assistant）→ 既有硬失败语义不变（绝不静默放行）', async () => {
    const { svc } = makeRegistry({ rows: [] });
    await svc.refresh();
    await expect(svc.resolveForIntent(intent('chat'))).rejects.toThrow('没有可用的 Agent');
  });

  it('排序不改候选集合：返回的实例必然来自注册表已加载实例（同一引用）', async () => {
    const { svc } = makeRegistry({
      rows: [agentRow('id-general', 'general-assistant'), agentRow('id-alt', 'alt-assistant', 'custom')],
      policy: { agentMapping: { chat: ['general-assistant', 'alt-assistant'] } },
      perf: [perfRow({ 'id-alt': { completed: 10, failed: 0 }, 'id-general': { completed: 0, failed: 10 } })],
    });
    await svc.refresh();
    const agent = await svc.resolveForIntent(intent('chat'));
    expect(agent).toBe(svc.get('alt-assistant'));
    expect(svc.list()).toHaveLength(2); // 候选集合不变（绝不因表现数据增删 agent）
  });

  it('归因键取 Agent 行主键：media 实例 id 是 slug（image），表现数据按行 id 命中才重排', async () => {
    const { svc } = makeRegistry({
      // image 行主键 id-image ≠ 实例 id（'image' 是 slug）——若误用实例 id 查表现数据则永远查不到
      rows: [agentRow('id-image', 'image'), agentRow('id-general', 'general-assistant')],
      policy: { agentMapping: { image_generation: ['image', 'general-assistant'] } },
      perf: [perfRow({
        'id-image': { completed: 0, failed: 10 }, // 静态在前但表现差
        'id-general': { completed: 10, failed: 0 },
      })],
    });
    await svc.refresh();
    const agent = await svc.resolveForIntent(intent('image_generation'));
    expect(agent).toBe(svc.get('general-assistant')); // 用实例 id（slug）查必查不到 → 会错判为无数据、留在静态首位
    expect(svc.get('image')!.id).toBe('image'); // media 实例 id 为 slug（既有语义，不改）
  });

  it('routingPolicy 缺失/非法 → 走 DEFAULT_AGENT_MAPPING（chat→general-assistant），绝不抛错', async () => {
    const missing = makeRegistry({ rows: [agentRow('id-general', 'general-assistant')], policy: null });
    await missing.svc.refresh();
    expect(await missing.svc.resolveForIntent(intent('chat'))).toBe(missing.svc.get('general-assistant'));

    const broken = makeRegistry({ rows: [agentRow('id-general', 'general-assistant')], policy: { agentMapping: { chat: 42 } } });
    await broken.svc.refresh();
    expect(await broken.svc.resolveForIntent(intent('chat'))).toBe(broken.svc.get('general-assistant'));
  });
});
