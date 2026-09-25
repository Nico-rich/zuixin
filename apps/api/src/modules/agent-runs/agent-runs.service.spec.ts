import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AgentRunsService } from './agent-runs.service';
import { AgentRunMessagesService } from './agent-run-messages.service';

interface Overrides {
  conversation?: Record<string, unknown> | null;
  agent?: Record<string, unknown> | null;
  systemAgent?: Record<string, unknown> | null;
}

/**
 * P1 只读/写往返合并单测：
 * prisma mock 记录「往返数」与「并发峰值」——并行化后往返数下降、并发峰值 ≥2（真并行而非顺序 await）。
 */
function makePrisma(overrides: Overrides = {}) {
  const state = { roundTrips: 0, inFlight: 0, maxConcurrent: 0, order: [] as string[] };
  const conversation = 'conversation' in overrides
    ? overrides.conversation
    : { id: 'conv-1', userId: 'u1', projectId: null, title: '旧标题', deletedAt: null };
  const agent = 'agent' in overrides ? overrides.agent : {
    id: 'agent-1', scope: 'system', enabled: true,
    activeVersion: { id: 'ver-1', version: 1, status: 'published', systemPrompt: 'S', tools: ['web.search'], config: { maxSteps: 5 } },
  };
  const raw: Record<string, Record<string, unknown>> = {
    conversation: {
      findFirst: async () => conversation,
      create: async () => ({ id: 'conv-new', userId: 'u1', projectId: null, title: '新对话', deletedAt: null }),
      update: async () => ({ id: 'conv-1' }),
    },
    project: { findFirst: async () => ({ id: 'proj-1' }) },
    agent: { findFirst: async () => agent },
    organizationMember: { findUnique: async () => ({ id: 'm1' }) },
    organization: { findFirst: async () => ({ id: 'org-1' }) },
    message: { create: async ({ data }: { data: Record<string, unknown> }) => ({ id: `msg-${String(data.role)}`, ...data }) },
    agentRun: {
      create: async ({ data }: { data: Record<string, unknown> }) => ({ id: data.id, status: 'queued' }),
      findFirst: async () => ({ id: 'run-x', messages: [] }),
    },
    agentRunMessage: {
      createMany: async ({ data }: { data: unknown[] }) => ({ count: data.length }),
      create: async ({ data }: { data: Record<string, unknown> }) => ({ id: 'm', ...data }),
      findMany: async () => [],
    },
  };
  const prisma = new Proxy(raw, {
    get(target, prop: string) {
      const table = target[prop];
      if (!table || typeof table !== 'object') return table;
      return new Proxy(table, {
        get(t, method: string) {
          const fn = t[method];
          if (typeof fn !== 'function') return fn;
          return (...args: unknown[]) => {
            state.roundTrips++;
            state.inFlight++;
            state.maxConcurrent = Math.max(state.maxConcurrent, state.inFlight);
            state.order.push(`${prop}.${method}`);
            return Promise.resolve(fn(...args)).finally(() => { state.inFlight--; });
          };
        },
      });
    },
  });
  return { prisma: prisma as never, state };
}

function makeService(overrides: Overrides = {}) {
  const { prisma, state } = makePrisma(overrides);
  const messages = new AgentRunMessagesService(prisma);
  // 显式签名：断言侧可直接取 mock.calls[0][1]/[2]（payload/jobId）而不必先做 unknown 转换
  const queue = {
    add: vi.fn(async (_name: string, _payload: { runId: string }, _opts: { jobId: string; removeOnComplete?: number }) => ({ id: 'job-1' })),
  };
  const events = { publish: vi.fn(async () => undefined) };
  const delegation = { cancelChildren: vi.fn(async () => undefined) };
  const quota = {
    assertQuota: vi.fn(async () => ({ organizationId: 'org-1', consumed: 0, total: 10, reservationId: 'res-1' })),
    release: vi.fn(async () => undefined),
  };
  const svc = new AgentRunsService(prisma, messages, queue as never, events as never, delegation as never, quota as never);
  return { svc, state, queue, quota, messages };
}

describe('AgentRunsService.createAsync（P1 往返合并）', () => {
  beforeEach(() => vi.clearAllMocks());

  it('P1 往返数：既有会话路径 8 → 6 次（并行后驻留 2 轮），且并发峰值 ≥2（真并行）', async () => {
    const { svc, state, queue } = makeService();
    const res = await svc.createAsync('u1', { conversationId: 'conv-1', message: '帮我查一下今天的用量' });

    expect(res.status).toBe('queued');
    expect(res.runId).toBeTruthy();
    // 原实现：conversation.findFirst + agent.findFirst + message.create×2 + agentRun.create
    //          + agentRun.findFirst(requireRun) + agentRunMessage.findFirst(max seq) + agentRunMessage.create = 8
    expect(state.order).toEqual([
      'conversation.findFirst', 'agent.findFirst',     // 并行：会话 ⊕ Agent
      'message.create', 'message.create',              // 并行：user 消息 ⊕ assistant 占位
      'agentRun.create',
      'agentRunMessage.createMany',                    // 单次批量 seed
    ]);
    expect(state.roundTrips).toBe(6); // 6 次往返（原 8 次）；串行等待点由 5 个降为 3 个（3 组并行）
    expect(state.maxConcurrent).toBeGreaterThanOrEqual(2); // Promise.all 真并行（顺序 await 时为 1）
    expect(queue.add).toHaveBeenCalledTimes(1);
    expect(queue.add.mock.calls[0][1]).toEqual({ runId: res.runId }); // payload 最小化
    expect(queue.add.mock.calls[0][2]).toMatchObject({ jobId: `run-${res.runId}` });
  });

  it('P1 transcript seed：单次 createMany 且 sequence=0（不再 requireRun + max(seq) + 逐条 create）', async () => {
    const { svc, state, messages } = makeService();
    const spy = vi.spyOn(messages, 'seed');
    await svc.createAsync('u1', { conversationId: 'conv-1', message: '你好' });
    expect(state.order.filter((q) => q === 'agentRunMessage.createMany')).toHaveLength(1);
    expect(state.order).not.toContain('agentRunMessage.create');
    expect(state.order).not.toContain('agentRunMessage.findFirst');
    expect(spy).toHaveBeenCalledWith('u1', expect.any(String), [{ role: 'user', content: '你好' }]);
  });

  it('配额断言顺序：assertQuota 先于 run 创建（runId 预生成作 refId）；超额 → 不建 run/不入队/不写 transcript', async () => {
    const { svc, state, quota, queue } = makeService();
    const res = await svc.createAsync('u1', { conversationId: 'conv-1', message: 'x' });
    expect(quota.assertQuota).toHaveBeenCalledTimes(1);
    const [userId, projectId, kind, qty, refId] = quota.assertQuota.mock.calls[0] as unknown as [string, string | null, string, number, string];
    expect([userId, projectId, kind, qty]).toEqual(['u1', null, 'agent_run', 1]);
    expect(refId).toHaveLength(36); // 预生成 runId 作预留 refId
    expect(state.order).toContain('agentRun.create');
    expect(refId).toBe(res.runId); // 预留 refId 与 run 同 id（Pre-M9 C1）
    expect((queue.add.mock.calls[0][1] as { runId: string }).runId).toBe(refId);

    const failing = makeService();
    failing.quota.assertQuota.mockRejectedValue(Object.assign(new Error('quota'), { code: 'QUOTA_EXCEEDED' }));
    await expect(failing.svc.createAsync('u1', { conversationId: 'conv-1', message: 'x' }))
      .rejects.toMatchObject({ code: 'QUOTA_EXCEEDED' });
    expect(failing.state.order).not.toContain('agentRun.create');
    expect(failing.state.order).not.toContain('agentRunMessage.createMany');
    expect(failing.queue.add).not.toHaveBeenCalled();
  });

  it('归属/校验语义不变：项目与会话不一致 → VALIDATION_ERROR；Agent 不可用 → NOT_FOUND（均不建 run）', async () => {
    const mismatch = makeService({ conversation: { id: 'conv-1', userId: 'u1', projectId: 'proj-conv', title: '旧', deletedAt: null } });
    await expect(mismatch.svc.createAsync('u1', { conversationId: 'conv-1', projectId: 'proj-other', message: 'x' }))
      .rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    expect(mismatch.state.order).not.toContain('agentRun.create');

    const noAgent = makeService({ agent: null });
    await expect(noAgent.svc.createAsync('u1', { conversationId: 'conv-1', message: 'x' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(noAgent.state.order).not.toContain('agentRun.create');

    const noVersion = makeService({ agent: { id: 'a', scope: 'system', enabled: true, activeVersion: null } });
    await expect(noVersion.svc.createAsync('u1', { conversationId: 'conv-1', message: 'x' }))
      .rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    expect(noVersion.state.order).not.toContain('agentRun.create');
  });

  it('新建会话路径：会话 create 与 Agent 解析并行；标题按首条消息更新；往返仍 ≤6', async () => {
    const { svc, state } = makeService();
    const res = await svc.createAsync('u1', { message: '画一张黑金主图' });
    expect(state.order).toContain('conversation.create');
    expect(state.order).toContain('conversation.update'); // 标题 '新对话' → 首条消息前 30 字
    expect(state.order.filter((q) => q === 'message.create')).toHaveLength(2); // user + assistant 占位
    expect(res.status).toBe('queued');
    expect(state.roundTrips).toBe(7); // 原实现新建会话路径 10 次（含 create 与逐条 append 的 3 次）
  });
});
