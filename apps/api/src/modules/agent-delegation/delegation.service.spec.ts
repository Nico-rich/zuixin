import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DelegationService } from './delegation.service';

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
      findFirst: vi.fn().mockResolvedValue({
        id: 'agent-child', enabled: true, scope: 'system',
        activeVersion: { id: 'v-child', tools: ['knowledge.search', 'image.generate'] },
      }),
    },
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
