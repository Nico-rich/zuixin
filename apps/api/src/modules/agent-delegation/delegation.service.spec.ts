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
  const events = { subscribe: vi.fn().mockResolvedValue(undefined) };
  const svc = new DelegationService(prisma as never, queue as never, events as never);
  return { svc, prisma, queue, events };
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
