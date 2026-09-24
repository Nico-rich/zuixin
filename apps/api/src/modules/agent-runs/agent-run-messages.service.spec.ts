import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AgentRunMessagesService } from './agent-run-messages.service';

function makeService() {
  const rows: Array<Record<string, unknown>> = [];
  const prisma = {
    agentRun: {
      findFirst: vi.fn().mockResolvedValue({ id: 'run-1' }), // 归属校验通过
    },
    agentRunMessage: {
      findFirst: vi.fn(async () => (rows.length ? rows[rows.length - 1] : null)),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        rows.push(data);
        return { id: 'msg-' + rows.length, ...data };
      }),
      findMany: vi.fn(async () => [...rows]),
    },
  };
  return { svc: new AgentRunMessagesService(prisma as never), prisma, rows };
}

describe('AgentRunMessagesService（transcript 数据层）', () => {
  let ctx: ReturnType<typeof makeService>;
  beforeEach(() => { ctx = makeService(); });

  it('append：sequence 自动递增，CRUD 完整（system/user/assistant(toolCalls)/tool(toolCallId)）', async () => {
    const { svc, rows } = ctx;
    await svc.append('u1', 'run-1', { role: 'system', content: '你是助手' });
    await svc.append('u1', 'run-1', { role: 'user', content: '画一张图' });
    await svc.append('u1', 'run-1', { role: 'assistant', content: '', toolCalls: [{ id: 'call-1', name: 'image.generate', arguments: '{}' }] });
    await svc.append('u1', 'run-1', { role: 'tool', content: '{"taskId":"t1"}', toolCallId: 'call-1' });

    expect(rows.map((r) => r.sequence)).toEqual([0, 1, 2, 3]);
    expect(rows[2]).toMatchObject({ role: 'assistant', toolCalls: [{ id: 'call-1' }] });
    expect(rows[3]).toMatchObject({ role: 'tool', toolCallId: 'call-1' });

    const replay = await svc.list('u1', 'run-1');
    expect(replay).toHaveLength(4);
    expect(replay.map((r) => r.sequence)).toEqual([0, 1, 2, 3]); // 重放顺序 = 追加顺序
  });

  it('reconstruction：合法 tool-calling 序列完整恢复（assistant.tool_calls 与 tool.toolCallId 配对）', async () => {
    const { svc } = ctx;
    await svc.append('u1', 'run-1', { role: 'system', content: 'S' });
    await svc.append('u1', 'run-1', { role: 'assistant', content: '', toolCalls: [{ id: 'c1', name: 'a', arguments: '{}' }, { id: 'c2', name: 'b', arguments: '{}' }] });
    await svc.append('u1', 'run-1', { role: 'tool', content: 'r1', toolCallId: 'c1' });
    await svc.append('u1', 'run-1', { role: 'tool', content: 'r2', toolCallId: 'c2' });
    const replay = await svc.list('u1', 'run-1');
    const assistant = replay[1];
    const toolIds = replay.slice(2).map((r) => r.toolCallId).sort();
    const callIds = (assistant.toolCalls as Array<{ id: string }>).map((c) => c.id).sort();
    expect(toolIds).toEqual(callIds); // 配对完整
  });

  it('userId 首条件：非本人 run → NOT_FOUND（append 与 list 均拒绝）', async () => {
    const { svc, prisma } = ctx;
    prisma.agentRun.findFirst.mockResolvedValue(null);
    await expect(svc.append('other-user', 'run-1', { role: 'user', content: 'x' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(svc.list('other-user', 'run-1')).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('sequence 竞态：P2002 → 重算后重试成功（UNIQUE(runId, sequence) 兜底）', async () => {
    const { svc, prisma } = ctx;
    prisma.agentRunMessage.create
      .mockRejectedValueOnce(Object.assign(new Error('unique'), { code: 'P2002' }))
      .mockImplementationOnce(async ({ data }: { data: Record<string, unknown> }) => ({ id: 'msg-x', ...data }));
    const row = await svc.append('u1', 'run-1', { role: 'user', content: 'retry' });
    expect(row).toMatchObject({ role: 'user', content: 'retry' });
  });
});
