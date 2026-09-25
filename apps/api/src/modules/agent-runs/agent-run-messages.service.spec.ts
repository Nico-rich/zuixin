import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AgentRunMessagesService } from './agent-run-messages.service';

function makeService() {
  const rows: Array<Record<string, unknown>> = [];
  const prisma = {
    agentRun: {
      // P1：归属校验 + 末条 sequence 合并为一次查询（嵌套 select）；非本人/不存在 → null → NOT_FOUND
      findFirst: vi.fn(async (): Promise<{ id: string; messages: Array<{ sequence: number }> } | null> => ({
        id: 'run-1',
        messages: rows.length ? [{ sequence: Number(rows[rows.length - 1].sequence) }] : [],
      })),
    },
    agentRunMessage: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        rows.push(data);
        return { id: 'msg-' + rows.length, ...data };
      }),
      // createMany 模拟 PostgreSQL 语义：撞 @@unique([runId, sequence]) 的行被跳过（skipDuplicates）
      createMany: vi.fn(async ({ data, skipDuplicates }: { data: Array<Record<string, unknown>>; skipDuplicates?: boolean }) => {
        let count = 0;
        for (const row of data) {
          const conflict = rows.some((r) => r.runId === row.runId && r.sequence === row.sequence);
          if (conflict) {
            if (skipDuplicates) continue;
            throw Object.assign(new Error('unique'), { code: 'P2002' });
          }
          rows.push(row);
          count++;
        }
        return { count };
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

  it('P1 append：归属校验与末条 sequence 合并为 2 次往返（原 requireRun + max(seq) + create = 3 次）', async () => {
    const { svc, prisma } = ctx;
    await svc.append('u1', 'run-1', { role: 'user', content: 'x' });
    expect(prisma.agentRun.findFirst).toHaveBeenCalledTimes(1); // 归属 + 末条 sequence 一次查询
    expect(prisma.agentRunMessage.create).toHaveBeenCalledTimes(1);
    const where = (prisma.agentRun.findFirst.mock.calls[0] as unknown as [{ where: { id: string; userId: string } }])[0].where;
    expect(where).toMatchObject({ id: 'run-1', userId: 'u1' }); // userId 首条件仍是归属边界
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

  it('P1 seed：单次 createMany 批量写入（一次往返）+ sequence 按数组下标 0..n-1', async () => {
    const { svc, prisma, rows } = ctx;
    const count = await svc.seed('u1', 'run-1', [
      { role: 'system', content: 'S' },
      { role: 'user', content: 'U' },
      { role: 'assistant', content: '', toolCalls: [{ id: 'c1', name: 'a', arguments: '{}' }] },
      { role: 'tool', content: 'R', toolCallId: 'c1' },
    ]);
    expect(count).toBe(4);
    expect(prisma.agentRunMessage.createMany).toHaveBeenCalledTimes(1); // 一次往返
    expect(prisma.agentRunMessage.create).not.toHaveBeenCalled(); // 绝不逐条 create
    expect(rows.map((r) => r.sequence)).toEqual([0, 1, 2, 3]);
    expect(rows[2]).toMatchObject({ role: 'assistant', toolCalls: [{ id: 'c1' }] });
    expect(rows[3]).toMatchObject({ role: 'tool', toolCallId: 'c1' });
  });

  it('P1 seed 幂等：重复 seed 撞 UNIQUE(runId, sequence) → 跳过（绝不产生重复 transcript）', async () => {
    const { svc, rows } = ctx;
    await svc.seed('u1', 'run-1', [{ role: 'user', content: 'U' }]);
    const again = await svc.seed('u1', 'run-1', [{ role: 'user', content: 'U2' }]);
    expect(again).toBe(0); // skipDuplicates：冲突行跳过，不抛错
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ sequence: 0, content: 'U' }); // 既有事实绝不被覆盖
    expect((await svc.list('u1', 'run-1'))).toHaveLength(1);
  });

  it('P1 seed 降级：createMany 整体失败 → 逐条 append（带归属校验），绝不丢 transcript', async () => {
    const { svc, prisma } = ctx;
    prisma.agentRunMessage.createMany.mockRejectedValueOnce(new Error('createMany unsupported'));
    await svc.seed('u1', 'run-1', [{ role: 'user', content: 'U' }]);
    expect(prisma.agentRunMessage.create).toHaveBeenCalledTimes(1);
    expect(prisma.agentRun.findFirst).toHaveBeenCalledTimes(1); // 降级路径重做归属校验
    expect((await svc.list('u1', 'run-1'))).toHaveLength(1);
  });
});
