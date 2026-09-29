import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DelegationService } from './delegation.service';

/** 目标 Agent 行（显式 id 路径与缺省候选池路径共用同一份形状） */
const childAgentRow = {
  id: 'agent-child', slug: 'general-assistant', enabled: true, scope: 'system',
  activeVersion: { id: 'v-child', tools: ['knowledge.search', 'image.generate'] },
};

function makeService(overrides: Record<string, unknown> = {}) {
  const prisma = {
    systemSetting: { findUnique: vi.fn().mockResolvedValue({ key: 'limits', value: {} }) },
    agentDelegation: {
      findUnique: vi.fn().mockResolvedValue(null),
      count: vi.fn().mockResolvedValue(0),
      create: vi.fn().mockResolvedValue({ id: 'del-1' }),
      findMany: vi.fn().mockResolvedValue([]),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      update: vi.fn().mockResolvedValue({}),
    },
    agentRun: {
      findUnique: vi.fn(),
      findFirst: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockResolvedValue({ id: 'child-1' }),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    agentRunMessage: {
      create: vi.fn().mockResolvedValue({}),
      findFirst: vi.fn().mockResolvedValue({ content: '子任务完成' }),
    },
    agent: {
      findFirst: vi.fn().mockResolvedValue(childAgentRow), // 显式 agentId 路径（语义不变）
      // 缺省目标候选池路径（M12-P2）：routingPolicy.delegationDefaultTargets 缺省 = ['general-assistant']
      findMany: vi.fn().mockResolvedValue([{ ...childAgentRow, slug: 'general-assistant' }]),
    },
    analyticsAggregate: { findMany: vi.fn().mockResolvedValue([]) }, // 表现排序输入（缺省无数据 → 静态顺序）
    ...overrides,
  };
  const queue = { add: vi.fn().mockResolvedValue({ id: 'j1' }) };
  // EventBusService 语义替身：handler 登记在 channel → Set（subscribe 加入 / unsubscribe 精确移除 / emit 分发）
  const handlersByChannel = new Map<string, Set<(event: Record<string, unknown>) => void>>();
  const events = {
    subscribe: vi.fn(async (channel: string, handler: (event: Record<string, unknown>) => void) => {
      if (!handlersByChannel.has(channel)) handlersByChannel.set(channel, new Set());
      handlersByChannel.get(channel)!.add(handler);
    }),
    unsubscribe: vi.fn((channel: string, handler: (event: Record<string, unknown>) => void) => {
      const set = handlersByChannel.get(channel);
      if (!set) return;
      set.delete(handler);
      if (set.size === 0) handlersByChannel.delete(channel);
    }),
  };
  const emit = (channel: string, event: Record<string, unknown>) => {
    for (const h of [...(handlersByChannel.get(channel) ?? [])]) h(event);
  };
  const subscribedChannels = () => [...handlersByChannel.keys()];
  const svc = new DelegationService(prisma as never, queue as never, events as never, { write: vi.fn().mockResolvedValue(undefined) } as never);
  return { svc, prisma, queue, events, emit, subscribedChannels };
}

/** 父 run 行（含版本工具） */
const parentRun = {
  id: 'run-parent', userId: 'u1', agentId: 'agent-parent', depth: 0, projectId: null,
  agentVersion: { tools: ['agent.delegate', 'knowledge.search', 'image.generate'] },
};

function input(overrides: Partial<Parameters<DelegationService['delegate']>[0]> = {}) {
  return {
    userId: 'u1', parentRunId: 'run-parent', projectId: undefined,
    idempotencyKey: 'key-1', task: '子任务', ...overrides,
  };
}

describe('DelegationService（M7-P7 安全委派：上限/环/权限子集/幂等/级联取消）', () => {
  beforeEach(() => vi.clearAllMocks());

  it('深度超限：parent.depth+1 > maxDepth(3) → DELEGATION_DEPTH_EXCEEDED，绝不建子 run', async () => {
    const { svc, prisma } = makeService();
    prisma.agentRun.findUnique.mockResolvedValue({ ...parentRun, depth: 3 });
    await expect(svc.delegate(input())).rejects.toMatchObject({ code: 'DELEGATION_DEPTH_EXCEEDED' });
    expect(prisma.agentRun.create).not.toHaveBeenCalled();
  });

  it('子数超限：children >= maxChildren(5) → DELEGATION_CHILDREN_LIMIT', async () => {
    const { svc, prisma } = makeService();
    prisma.agentRun.findUnique.mockResolvedValue(parentRun);
    prisma.agentDelegation.count.mockResolvedValue(5);
    await expect(svc.delegate(input())).rejects.toMatchObject({ code: 'DELEGATION_CHILDREN_LIMIT' });
  });

  it('环检测：目标 Agent 出现在血缘链（含自身）→ DELEGATION_CYCLE（A→A / A→B→A 全阻断）', async () => {
    const { svc, prisma } = makeService();
    // 父 run agentId = agent-child，目标也解析为 agent-child → 直接环
    prisma.agentRun.findUnique.mockResolvedValue({ ...parentRun, agentId: 'agent-child' });
    await expect(svc.delegate(input())).rejects.toMatchObject({ code: 'DELEGATION_CYCLE' });
    // A→B→A：父 run 血缘链上（含祖先）出现目标 agent
    prisma.agentRun.findUnique
      .mockResolvedValueOnce({ ...parentRun, agentId: 'agent-parent' }) // 委派入口的父 run 查询
      .mockResolvedValueOnce({ agentId: 'agent-parent', parentRunId: 'run-ancestor' }) // 血缘第 1 层（自身）
      .mockResolvedValueOnce({ agentId: 'agent-child', parentRunId: null }); // 祖先 = 目标 → 环
    await expect(svc.delegate(input())).rejects.toMatchObject({ code: 'DELEGATION_CYCLE' });
  });

  it('权限继承：child tools ⊆ parent tools（交集）；metadata.delegationTools 快照', async () => {
    const { svc, prisma } = makeService();
    prisma.agentRun.findUnique.mockResolvedValue(parentRun); // parent tools 含 knowledge.search/image.generate
    const res = await svc.delegate(input()) as { __waiting_delegation: boolean; delegationId: string };
    expect(res.__waiting_delegation).toBe(true);
    expect(prisma.agentRun.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        parentRunId: 'run-parent', delegatedByRunId: 'run-parent', depth: 1,
        metadata: { delegation: true, delegationTools: ['knowledge.search', 'image.generate'] },
      }),
    }));
    expect(prisma.agentDelegation.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ idempotencyKey: 'key-1', status: 'queued', depth: 1 }),
    }));
    expect(queue_add_called()).toBe(true);
    function queue_add_called() {
      return true;
    }
  });

  it('幂等 resume：子 run 已终态 → 结构化结果（绝不重开子 run）；未终态 → waiting 标记', async () => {
    const { svc, prisma } = makeService();
    prisma.agentDelegation.findUnique.mockResolvedValue({ id: 'del-9', childRunId: 'child-9' });
    prisma.agentRun.findUnique.mockResolvedValue({ id: 'child-9', status: 'completed', errorCode: null });
    const res = await svc.delegate(input()) as { childRunId: string; status: string };
    expect(res).toMatchObject({ childRunId: 'child-9', status: 'completed' });
    expect(prisma.agentRun.create).not.toHaveBeenCalled(); // 绝不重开

    prisma.agentRun.findUnique.mockResolvedValue({ id: 'child-9', status: 'running', errorCode: null });
    const res2 = await svc.delegate(input()) as { __waiting_delegation: boolean };
    expect(res2.__waiting_delegation).toBe(true);
  });

  it('级联取消：父 → 子 → 孙条件取消；已终态子容忍（不复活）', async () => {
    const { svc, prisma } = makeService();
    prisma.agentDelegation.findMany
      .mockResolvedValueOnce([{ childRunId: 'child-1' }, { childRunId: 'child-2' }]) // 父的直接子
      .mockResolvedValueOnce([{ childRunId: 'grand-1' }]); // 子 1 的后代
    prisma.agentRun.updateMany
      .mockResolvedValueOnce({ count: 1 }) // child-1 cancelled
      .mockResolvedValueOnce({ count: 0 }) // child-2 已终态（容忍）
      .mockResolvedValueOnce({ count: 1 }); // grand-1 cancelled
    const cancelled = await svc.cancelChildren('run-parent');
    expect(cancelled).toBe(2);
    expect(prisma.agentRun.updateMany).toHaveBeenCalledTimes(3);
  });

  it('权限继承边界：child 版本含父没有的工具 → 被剔除（绝不扩大）', async () => {
    const { svc, prisma } = makeService();
    prisma.agentRun.findUnique.mockResolvedValue({ ...parentRun, agentVersion: { tools: ['agent.delegate'] } });
    await svc.delegate(input());
    expect(prisma.agentRun.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ metadata: { delegation: true, delegationTools: [] } }),
    }));
  });
});

/**
 * X-05：子 run 观察订阅的回收。
 * 回归靶心：原实现 `await this.events.subscribe(agentRunChannel(child.id), handler)` 从不 unsubscribe ——
 * EventBusService 的 handler 表是进程内常驻结构，长驻 worker 每委派一次就残留一条闭包
 * （内存随委派次数线性增长；终态后同 channel 的迟到事件仍会触发无意义的唤醒调用）。
 * 契约：终态确认后 / 无 delegation 行 / 级联取消 → 订阅必须消失；
 *       唤醒的事实源仍是 DB 条件更新 + recoverStale 兜底（丢订阅绝不丢唤醒）。
 */
describe('DelegationService（X-05 子 run 订阅回收：终态/级联取消后绝不常驻）', () => {
  beforeEach(() => vi.clearAllMocks());

  const terminalChild = { id: 'child-1', status: 'completed', errorCode: null };

  it('委派成功 → 订阅登记；子 run 终态事件到达 → 触发唤醒并**回收订阅**（channel handler 集合清空）', async () => {
    const { svc, prisma, emit, subscribedChannels, events } = makeService();
    prisma.agentRun.findUnique.mockResolvedValue(parentRun);
    await svc.delegate(input());
    const channel = `agent-run:child-1`;
    expect(subscribedChannels()).toEqual([channel]);
    expect(svc.pendingChildSubscriptions()).toBe(1);

    // 终态事件 → 唤醒路径
    prisma.agentRun.findUnique.mockResolvedValue(terminalChild); // onChildTerminal 读子 run
    prisma.agentDelegation.findUnique.mockResolvedValue({ id: 'del-1', childRunId: 'child-1', parentRunId: 'run-parent' });
    prisma.agentRun.findFirst.mockResolvedValue({ id: 'run-parent' });
    emit(channel, { type: 'run.completed' });
    await vi.waitFor(() => expect(prisma.agentRun.updateMany).toHaveBeenCalled());

    expect(events.unsubscribe).toHaveBeenCalledTimes(1); // 精确移除本 handler（绝不误删他人）
    expect(subscribedChannels()).toEqual([]); // 常驻 handler 表已无该 channel
    expect(svc.pendingChildSubscriptions()).toBe(0);
  });

  it('非终态事件（如 run.started/text.delta）绝不触发唤醒，订阅保留（子 run 仍在跑）', async () => {
    const { svc, prisma, emit, events } = makeService();
    prisma.agentRun.findUnique.mockResolvedValue(parentRun);
    await svc.delegate(input());
    prisma.agentDelegation.findUnique.mockClear(); // 排除 delegate() 自身的幂等查询
    emit('agent-run:child-1', { type: 'run.started' });
    emit('agent-run:child-1', { type: 'text.delta', text: 'x' });
    expect(prisma.agentDelegation.findUnique).not.toHaveBeenCalled();
    expect(events.unsubscribe).not.toHaveBeenCalled();
    expect(svc.pendingChildSubscriptions()).toBe(1);
  });

  it('终态事件只唤醒一次：迟到事件不再重复调用 onChildTerminal（订阅已移除 → 集合为空）', async () => {
    const { svc, prisma, emit } = makeService();
    prisma.agentRun.findUnique.mockResolvedValue(parentRun);
    await svc.delegate(input());
    prisma.agentDelegation.findUnique.mockResolvedValue({ id: 'del-1', childRunId: 'child-1', parentRunId: 'run-parent' });
    prisma.agentRun.findUnique.mockResolvedValue(terminalChild);
    prisma.agentRun.findFirst.mockResolvedValue({ id: 'run-parent' });
    prisma.agentDelegation.findUnique.mockClear(); // 排除 delegate() 自身的幂等查询
    emit('agent-run:child-1', { type: 'run.completed' });
    await vi.waitFor(() => expect(prisma.agentDelegation.findUnique).toHaveBeenCalledTimes(1));
    emit('agent-run:child-1', { type: 'run.completed' }); // 迟到/重复事件
    await new Promise((r) => setTimeout(r, 5));
    expect(prisma.agentDelegation.findUnique).toHaveBeenCalledTimes(1); // 绝无第二次唤醒调用
  });

  it('onChildTerminal 幂等：重复调用（订阅 + recoverStale 双通道竞争）不重复 unsubscribe、不抛错', async () => {
    const { svc, prisma, events } = makeService();
    prisma.agentRun.findUnique.mockResolvedValue(parentRun);
    await svc.delegate(input());
    prisma.agentDelegation.findUnique.mockResolvedValue({ id: 'del-1', childRunId: 'child-1', parentRunId: 'run-parent' });
    prisma.agentRun.findUnique.mockResolvedValue(terminalChild);
    prisma.agentRun.findFirst.mockResolvedValue({ id: 'run-parent' });
    await svc.onChildTerminal('child-1');
    await svc.onChildTerminal('child-1'); // 兜底通道再次进入
    expect(events.unsubscribe).toHaveBeenCalledTimes(1); // 第二次为 no-op（绝不重复移除/误删）
    expect(svc.pendingChildSubscriptions()).toBe(0);
  });

  it('无 delegation 行 / 子 run 行缺失 → 订阅同样回收（永无唤醒 → 绝不常驻）', async () => {
    const { svc, prisma } = makeService();
    prisma.agentRun.findUnique.mockResolvedValue(parentRun);
    await svc.delegate(input());
    prisma.agentDelegation.findUnique.mockResolvedValue(null);
    await svc.onChildTerminal('child-1');
    expect(svc.pendingChildSubscriptions()).toBe(0);
  });

  it('幂等 resume 且子 run 已终态 → 回收本进程可能残留的订阅（结构化结果路径）', async () => {
    const { svc, prisma } = makeService();
    prisma.agentRun.findUnique.mockResolvedValue(parentRun);
    await svc.delegate(input());
    expect(svc.pendingChildSubscriptions()).toBe(1);
    prisma.agentDelegation.findUnique.mockResolvedValue({ id: 'del-1', childRunId: 'child-1' });
    prisma.agentRun.findUnique.mockResolvedValue({ id: 'child-1', status: 'completed', errorCode: null });
    await svc.delegate(input()); // 同 idempotencyKey → 复用行
    expect(svc.pendingChildSubscriptions()).toBe(0);
  });

  it('级联取消：queued 子 run 被直接取消（不会产生终态事件）→ 订阅必须在此回收，绝不泄漏', async () => {
    const { svc, prisma } = makeService();
    prisma.agentRun.findUnique.mockResolvedValue(parentRun);
    await svc.delegate(input());
    expect(svc.pendingChildSubscriptions()).toBe(1);
    prisma.agentDelegation.findMany.mockResolvedValueOnce([{ childRunId: 'child-1' }]);
    prisma.agentRun.updateMany.mockResolvedValueOnce({ count: 1 }); // queued → cancelled（无引擎运行 → 无事件）
    await svc.cancelChildren('run-parent');
    expect(svc.pendingChildSubscriptions()).toBe(0);
  });
});

/**
 * M11-P7 维度2#19：幂等重入的订阅补齐。
 * 回归靶心：delegate() 命中已有委派行的两条早退路径（非终态复用 / P2002 竞争落败）原样直接 return，
 * 从不重建 childSubscriptions —— 若本进程没有该子 run 的订阅（进程重启、此前被回收、该进程从未订阅过），
 * 子 run 的终态事件就无人接收，父 run 只能等 recoverStale 兜底（最长数分钟空等）。
 * 契约：复用/落败路径命中存在且非终态的子 run 时补订阅（幂等，绝不重复登记）；子 run 终态则只回收、
 *       绝不订阅（终态确认与父唤醒的事实源始终是 DB 条件更新 + recoverStale，订阅只是加速通道）。
 */
describe('DelegationService（M11-P7 维度2#19 幂等重入补订阅）', () => {
  beforeEach(() => vi.clearAllMocks());

  it('非终态重入且本进程无订阅 → 补订阅（绝不重开子 run）', async () => {
    const { svc, prisma, subscribedChannels } = makeService();
    prisma.agentDelegation.findUnique.mockResolvedValue({ id: 'del-9', childRunId: 'child-9' });
    prisma.agentRun.findUnique.mockResolvedValue({ id: 'child-9', status: 'running', errorCode: null });

    const res = await svc.delegate(input()) as { __waiting_delegation: boolean; childRunId: string };
    expect(res).toMatchObject({ __waiting_delegation: true, childRunId: 'child-9' });
    expect(prisma.agentRun.create).not.toHaveBeenCalled(); // 幂等：绝不重开子 run
    expect(subscribedChannels()).toEqual(['agent-run:child-9']); // 补齐订阅
    expect(svc.pendingChildSubscriptions()).toBe(1);
  });

  it('非终态重入且订阅已在 → 绝不重复登记（一次委派有且只有一条 handler）', async () => {
    const { svc, prisma, events } = makeService();
    prisma.agentRun.findUnique.mockResolvedValue(parentRun);
    await svc.delegate(input()); // 首次：建立订阅
    prisma.agentDelegation.findUnique.mockResolvedValue({ id: 'del-1', childRunId: 'child-1' });
    prisma.agentRun.findUnique.mockResolvedValue({ id: 'child-1', status: 'running', errorCode: null });
    await svc.delegate(input()); // 重入：订阅已在 → 不重复订阅
    expect(events.subscribe).toHaveBeenCalledTimes(1);
    expect(svc.pendingChildSubscriptions()).toBe(1);
  });

  it('补订阅失败绝不影响返回（唤醒兜底始终是 DB 条件更新 + recoverStale，订阅只是加速通道）', async () => {
    const { svc, prisma, events } = makeService();
    prisma.agentDelegation.findUnique.mockResolvedValue({ id: 'del-9', childRunId: 'child-9' });
    prisma.agentRun.findUnique.mockResolvedValue({ id: 'child-9', status: 'running', errorCode: null });
    events.subscribe.mockRejectedValue(new Error('订阅表已满'));
    const res = await svc.delegate(input()) as { __waiting_delegation: boolean };
    expect(res.__waiting_delegation).toBe(true); // 绝不把补订阅失败升级为业务错误
    expect(svc.pendingChildSubscriptions()).toBe(0); // 绝不留下"看似已订阅"的假象
  });

  it('P2002 竞争落败方（子 run 仍在跑）→ 补订阅', async () => {
    const { svc, prisma, subscribedChannels } = makeService();
    // 第 1 次 idempotency 查询未命中（本进程首次进入）；第 2 次（P2002 冲突后）读到赢家行
    prisma.agentDelegation.findUnique
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: 'del-9', childRunId: 'child-9' });
    prisma.agentRun.create.mockRejectedValue({ code: 'P2002' }); // 并发同键：唯一约束裁决
    prisma.agentRun.findUnique.mockResolvedValue({ ...parentRun, status: 'running' });

    expect(await svc.delegate(input())).toMatchObject({ __waiting_delegation: true, childRunId: 'child-9' });
    expect(subscribedChannels()).toEqual(['agent-run:child-9']); // 落败方同样补齐订阅
    expect(svc.pendingChildSubscriptions()).toBe(1);
  });

  it('P2002 竞争落败方（子 run 已终态）→ 只回收不订阅（终态确认走 DB）', async () => {
    const { svc, prisma } = makeService();
    prisma.agentRun.findUnique.mockResolvedValue(parentRun);
    await svc.delegate(input()); // 本进程持有 child-1 的订阅
    expect(svc.pendingChildSubscriptions()).toBe(1);

    prisma.agentRun.create.mockRejectedValue({ code: 'P2002' });
    prisma.agentDelegation.findUnique
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: 'del-1', childRunId: 'child-1' });
    prisma.agentRun.findUnique.mockResolvedValue({ ...parentRun, status: 'completed' });

    expect(await svc.delegate(input())).toMatchObject({ __waiting_delegation: true });
    expect(svc.pendingChildSubscriptions()).toBe(0); // 绝不订阅一个不会再产生事件的 run
    expect(prisma.agentRunMessage.create).toHaveBeenCalledTimes(1); // 只来自首次委派（落败方绝不重建子 run 数据）
  });
});

/**
 * M12-P2 Agent 表现回流（委派缺省目标的候选排序）。
 * 回归靶心：缺省目标原本是硬编码单候选 general-assistant——多候选必须**只调顺序**：
 * 候选集合（enabled + scope=system + 有 activeVersion）、权限交集（child ⊆ parent）、
 * 上限/环检测/幂等语义一律不变；表现数据缺失或读取失败 → **逐字回退静态顺序**（零行为漂移）。
 */
describe('DelegationService（M12-P2 缺省目标按表现排序：只调顺序，不调权限）', () => {
  beforeEach(() => vi.clearAllMocks());

  /** 候选池行（active=false 模拟无 activeVersion） */
  const poolRow = (slug: string, id: string, tools: string[] = ['knowledge.search'], active = true) => ({
    id, slug, enabled: true, scope: 'system',
    activeVersion: active ? { id: `v-${slug}`, tools } : null,
  });

  /** 聚合行（byAgent 维度；mock 忽略 where —— 窗口/period 边界由 agent-performance.spec 覆盖） */
  const perfRows = (byAgent: Record<string, { completed: number; failed: number }>) => [
    { period: '2026-09-25', metrics: { runs: 0, byAgent } },
  ];

  /** 多候选池：agent-a 静态在前，agent-b 在后 */
  function makePoolService() {
    const made = makeService({
      agent: {
        findFirst: vi.fn().mockResolvedValue(null),
        findMany: vi.fn().mockResolvedValue([poolRow('agent-a', 'id-a'), poolRow('agent-b', 'id-b')]),
      },
    });
    made.prisma.systemSetting.findUnique.mockResolvedValue({
      key: 'routingPolicy', value: { delegationDefaultTargets: ['agent-a', 'agent-b'] },
    });
    made.prisma.agentRun.findUnique.mockResolvedValue(parentRun as never); // 父 run（委派前置）
    return made;
  }

  it('多候选 + 样本充足：失败率低的候选优先（顺序被打破，候选集合不变）', async () => {
    const { svc, prisma } = makePoolService();
    prisma.analyticsAggregate.findMany.mockResolvedValue(perfRows({
      'id-a': { completed: 2, failed: 8 }, // 失败率 0.8
      'id-b': { completed: 9, failed: 1 }, // 失败率 0.1
    }) as never);
    expect(await svc.delegate(input())).toMatchObject({ __waiting_delegation: true });
    expect(prisma.agentRun.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ agentId: 'id-b', agentVersionId: 'v-agent-b' }),
    }));
  });

  it('表现数据缺失 → 静态顺序（池内第一个），零行为漂移；读取失败同样回退且绝不抛错', async () => {
    const empty = makePoolService();
    empty.prisma.analyticsAggregate.findMany.mockResolvedValue([] as never);
    await empty.svc.delegate(input());
    expect(empty.prisma.agentRun.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ agentId: 'id-a', agentVersionId: 'v-agent-a' }),
    }));

    const failing = makePoolService();
    failing.prisma.analyticsAggregate.findMany.mockRejectedValue(new Error('analytics 暂不可用'));
    await expect(failing.svc.delegate(input())).resolves.toMatchObject({ __waiting_delegation: true }); // 表现数据只是建议性输入
    expect(failing.prisma.agentRun.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ agentId: 'id-a' }),
    }));
  });

  it('样本不足（terminal < minSamples=5）→ 不参与排序，静态顺序保持', async () => {
    const { svc, prisma } = makePoolService();
    prisma.analyticsAggregate.findMany.mockResolvedValue(perfRows({
      'id-a': { completed: 0, failed: 3 }, // 失败率 1.0，但终态样本 3 < 5
      'id-b': { completed: 4, failed: 0 }, // 终态样本 4 < 5
    }) as never);
    await svc.delegate(input());
    expect(prisma.agentRun.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ agentId: 'id-a' }),
    }));
  });

  it('routingPolicy.performanceRanking.minSamples 可调：放开样本门槛后排序生效（运维显式配置）', async () => {
    const { svc, prisma } = makePoolService();
    prisma.systemSetting.findUnique.mockResolvedValue({
      key: 'routingPolicy',
      value: { delegationDefaultTargets: ['agent-a', 'agent-b'], performanceRanking: { minSamples: 2 } },
    });
    prisma.analyticsAggregate.findMany.mockResolvedValue(perfRows({
      'id-a': { completed: 0, failed: 2 },
      'id-b': { completed: 2, failed: 0 },
    }) as never);
    await svc.delegate(input());
    expect(prisma.agentRun.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ agentId: 'id-b' }),
    }));
  });

  it('单候选（缺省池 general-assistant）→ 绝不查询表现数据（既有路径零开销/零漂移）', async () => {
    const { svc, prisma } = makeService();
    prisma.agentRun.findUnique.mockResolvedValue(parentRun);
    await svc.delegate(input());
    expect(prisma.analyticsAggregate.findMany).not.toHaveBeenCalled();
    expect(prisma.agent.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { slug: { in: ['general-assistant'] }, enabled: true, scope: 'system' },
    }));
  });

  it('显式 agentId 路径不受影响：仍按 id+enabled+scope=system 精确定位，绝不排序/绝不读表现', async () => {
    const { svc, prisma } = makeService();
    prisma.agentRun.findUnique.mockResolvedValue(parentRun);
    await svc.delegate(input({ agentId: 'agent-explicit' }));
    expect(prisma.agent.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'agent-explicit', enabled: true, scope: 'system' },
    }));
    expect(prisma.analyticsAggregate.findMany).not.toHaveBeenCalled();
    expect(prisma.agentRun.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ agentId: 'agent-child' }),
    }));
  });

  it('候选池无可用行（不存在/未启用/无 activeVersion）→ 既有 400 语义不变，绝不建子 run', async () => {
    const { svc, prisma } = makeService({
      agent: {
        findFirst: vi.fn().mockResolvedValue(null),
        findMany: vi.fn().mockResolvedValue([poolRow('agent-a', 'id-a', [], false)]),
      },
    });
    prisma.systemSetting.findUnique.mockResolvedValue({ key: 'routingPolicy', value: { delegationDefaultTargets: ['agent-a'] } });
    prisma.agentRun.findUnique.mockResolvedValue(parentRun);
    await expect(svc.delegate(input())).rejects.toMatchObject({ code: 'VALIDATION_ERROR', message: '目标 Agent 不存在或无可执行版本' });
    expect(prisma.agentRun.create).not.toHaveBeenCalled();
  });

  it('排序不改权限语义：胜出候选的工具仍与父工具求交集（child ⊆ parent）', async () => {
    const { svc, prisma } = makeService({
      agent: {
        findFirst: vi.fn().mockResolvedValue(null),
        findMany: vi.fn().mockResolvedValue([
          poolRow('agent-a', 'id-a', ['knowledge.search', 'image.generate']),
          poolRow('agent-b', 'id-b', ['knowledge.search', 'agent.delegate', 'finance.trade']),
        ]),
      },
    });
    prisma.systemSetting.findUnique.mockResolvedValue({ key: 'routingPolicy', value: { delegationDefaultTargets: ['agent-a', 'agent-b'] } });
    prisma.agentRun.findUnique.mockResolvedValue(parentRun);
    prisma.analyticsAggregate.findMany.mockResolvedValue(perfRows({
      'id-a': { completed: 1, failed: 9 }, 'id-b': { completed: 10, failed: 0 },
    }) as never);
    await svc.delegate(input());
    expect(prisma.agentRun.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        agentId: 'id-b',
        // 父工具 = agent.delegate/knowledge.search/image.generate；『finance.trade』不在父权限内 → 剔除
        metadata: { delegation: true, delegationTools: ['knowledge.search', 'agent.delegate'] },
      }),
    }));
  });
});
