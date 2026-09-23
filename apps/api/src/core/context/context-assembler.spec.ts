import { describe, it, expect, vi } from 'vitest';
import { ContextAssembler } from './context-assembler';
import { MemoryBlock } from './types';

function makeAssembler() {
  const prisma = {
    message: {
      findMany: vi.fn().mockResolvedValue([
        { id: 'm9', role: 'user', content: '倒数第1条（最新）' },
        { id: 'm8', role: 'assistant', content: '倒数第2条' },
      ]),
    },
  };
  const svc = new ContextAssembler(prisma as never);
  return { svc, prisma };
}

describe('ContextAssembler（内置最近消息源，行为与 M1 buildHistory 一致）', () => {
  it('倒序取 limit 条（默认 8）并按时间正序返回', async () => {
    const { svc, prisma } = makeAssembler();
    const { messages } = await svc.assemble({ userId: 'u1', conversationId: 'c1', excludeMessageId: 'm-user' });
    expect(prisma.message.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { conversationId: 'c1', id: { not: 'm-user' } },
      orderBy: { createdAt: 'desc' },
      take: 8,
    }));
    // 倒序查询结果被反转为正序
    expect(messages).toEqual([
      { role: 'assistant', content: '倒数第2条' },
      { role: 'user', content: '倒数第1条（最新）' },
    ]);
  });

  it('无 excludeMessageId 时不加 id 过滤（与 M1 兼容）', async () => {
    const { svc, prisma } = makeAssembler();
    await svc.assemble({ userId: 'u1', conversationId: 'c1' });
    expect(prisma.message.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { conversationId: 'c1' },
    }));
  });

  it('recentMessagesLimit 可覆盖默认值', async () => {
    const { svc, prisma } = makeAssembler();
    await svc.assemble({ userId: 'u1', conversationId: 'c1', recentMessagesLimit: 4 });
    expect(prisma.message.findMany).toHaveBeenCalledWith(expect.objectContaining({ take: 4 }));
  });

  it('空历史返回空消息数组', async () => {
    const { svc, prisma } = makeAssembler();
    prisma.message.findMany.mockResolvedValue([]);
    const { messages, blocks } = await svc.assemble({ userId: 'u1', conversationId: 'c1' });
    expect(messages).toEqual([]);
    expect(blocks).toEqual([]);
  });

  it('register 注册未来源后，块按 order 排序合并（未来 Memory/RAG 扩展点）', async () => {
    const { svc } = makeAssembler();
    const futureSource = {
      scope: 'system' as const,
      collect: async (): Promise<MemoryBlock[]> => [
        { scope: 'system', role: 'system', content: '系统提示', order: 0 },
        { scope: 'system', role: 'user', content: '用户记忆', order: 10 },
      ],
    };
    svc.register(futureSource);
    const { messages, blocks } = await svc.assemble({ userId: 'u1', conversationId: 'c1' });
    expect(blocks.map((b) => b.content)).toEqual(['系统提示', '用户记忆', '倒数第2条', '倒数第1条（最新）']);
    expect(messages[0]).toEqual({ role: 'system', content: '系统提示' });
  });
});
