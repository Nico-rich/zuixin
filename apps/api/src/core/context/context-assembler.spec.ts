import { describe, it, expect, vi } from 'vitest';
import { ContextAssembler } from './context-assembler';
import { ContextBudgetService } from './context-budget.service';
import { SimpleTokenEstimator } from './token-estimator';
import { MemoryBlock } from './types';

function makeAssembler() {
  const prisma = {
    systemSetting: { findUnique: vi.fn().mockResolvedValue({ key: 'limits', value: { contextBudgetTokens: 8000 } }) },
    message: {
      findMany: vi.fn().mockResolvedValue([
        { id: 'm9', role: 'user', content: '倒数第1条（最新）' },
        { id: 'm8', role: 'assistant', content: '倒数第2条' },
      ]),
    },
  };
  const svc = new ContextAssembler(prisma as never, new ContextBudgetService(new SimpleTokenEstimator()));
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

  it('D29 降级摘要：正常摘要排原位（order 30），降级块置尾（order 110）——绝不与正常摘要同权', async () => {
    const { svc } = makeAssembler();
    svc.register({
      scope: 'summary' as const,
      collect: async (): Promise<MemoryBlock[]> => [
        {
          scope: 'summary', role: 'user', content: '【对话摘要】【摘要降级：模型不可用，按消息原文压缩】\n用户：旧内容',
          order: 110, priority: 6, degraded: true, tokenCount: 40,
          source: { summaryId: 's-old', version: 1, segments: ['【摘要降级：模型不可用，按消息原文压缩】\n用户：旧内容'] },
        },
        {
          scope: 'summary', role: 'user', content: '【对话摘要】正常摘要', order: 30, tokenCount: 6,
          source: { summaryId: 's-new', version: 2, segments: ['正常摘要'] },
        },
      ],
    });
    const { messages, blocks } = await svc.assemble({ userId: 'u1', conversationId: 'c1' });
    expect(blocks.map((b) => b.content)).toEqual([
      '【对话摘要】正常摘要',
      '倒数第2条',
      '倒数第1条（最新）',
      '【对话摘要】【摘要降级：模型不可用，按消息原文压缩】\n用户：旧内容', // 降级 → 置尾
    ]);
    expect(messages.at(-1)!.content).toContain('摘要降级');
  });

  it('D29 降级摘要：预算不足时整块被丢弃（正常摘要与最近消息保留）', async () => {
    const { svc, prisma } = makeAssembler();
    // 预算只够 正常摘要(6) + 最近消息(10+10)，降级块(60) 放不下
    prisma.systemSetting.findUnique.mockResolvedValue({ key: 'limits', value: { contextBudgetTokens: 26 } });
    svc.register({
      scope: 'summary' as const,
      collect: async (): Promise<MemoryBlock[]> => [
        {
          scope: 'summary', role: 'user', content: '【对话摘要】【摘要降级】兜底原文', order: 110, degraded: true, tokenCount: 60,
          source: { summaryId: 's-old', version: 1, segments: ['【摘要降级】兜底原文'] },
        },
        {
          scope: 'summary', role: 'user', content: '【对话摘要】正常摘要', order: 30, tokenCount: 6,
          source: { summaryId: 's-new', version: 2, segments: ['正常摘要'] },
        },
      ],
    });
    const { blocks, truncated } = await svc.assemble({ userId: 'u1', conversationId: 'c1' });
    expect(truncated).toBe(true);
    expect(blocks.some((b) => b.degraded === true)).toBe(false); // 降级块绝不挤占正常内容预算
    expect(blocks.map((b) => b.content)).toContain('【对话摘要】正常摘要');
  });
});
