import { describe, it, expect, vi } from 'vitest';
import { Logger } from '@nestjs/common';
import { LLMMemoryExtractor } from './memory-extractor';

function makeExtractor(llmReply: string, opts: { failChat?: boolean; count?: number; limit?: number } = {}) {
  const adapter = {
    chat: opts.failChat
      ? vi.fn().mockRejectedValue(new Error('provider down'))
      : vi.fn().mockResolvedValue({ content: llmReply }),
  };
  const modelResolver = {
    resolveDefaultLLM: vi.fn().mockResolvedValue({ adapter, apiModelId: 'm', timeoutMs: 1000, providerId: 'p', providerName: 'p', modelId: 'm1' }),
  };
  const prisma = {
    systemSetting: {
      findUnique: vi.fn().mockResolvedValue({ key: 'limits', value: { dailyImage: 50, dailyMemoryCandidates: opts.limit ?? 20, videoConcurrency: 1, monthlyTokenBudget: 0 } }),
    },
    memory: {
      count: vi.fn().mockResolvedValue(opts.count ?? 0),
      create: vi.fn().mockImplementation(({ data }) => Promise.resolve({ id: 'm-new', ...data })),
    },
  };
  const svc = new LLMMemoryExtractor(modelResolver as never, prisma as never);
  return { svc, prisma, adapter };
}

const input = {
  userId: 'u1', conversationId: 'c1', projectId: 'p1',
  userMessage: '以后亚马逊主图都按照 2000×2000 做',
  assistantReply: '好的，已记录',
  sourceMessageId: 'm1',
};

const goodReply = JSON.stringify({
  memories: [
    { content: '用户偏好亚马逊主图尺寸为 2000×2000', category: 'preference', importance: 80, confidence: 0.95 },
    { content: '随口一提的内容', category: 'other', importance: 20, confidence: 0.3 }, // 低于阈值
  ],
});

describe('LLMMemoryExtractor', () => {
  it('提取候选：置信度 ≥0.7 才保存，保存为 candidate + 来源追踪', async () => {
    const { svc, prisma } = makeExtractor(goodReply);
    const saved = await svc.extractCandidates(input);
    expect(saved).toBe(1);
    expect(prisma.memory.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        scope: 'project', projectId: 'p1', status: 'candidate',
        source: 'extractor', sourceMessageId: 'm1',
        content: '用户偏好亚马逊主图尺寸为 2000×2000',
        importance: 80, confidence: 0.95,
      }),
    }));
  });

  it('无 projectId → 存为用户级记忆', async () => {
    const { svc, prisma } = makeExtractor(goodReply);
    await svc.extractCandidates({ ...input, projectId: undefined });
    expect(prisma.memory.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ scope: 'user', projectId: null }),
    }));
  });

  it('LLM 返回非法 JSON → 0 候选（安全降级）', async () => {
    const { svc, prisma } = makeExtractor('不是JSON');
    const saved = await svc.extractCandidates(input);
    expect(saved).toBe(0);
    expect(prisma.memory.create).not.toHaveBeenCalled();
  });

  it('D30：非法 JSON / 不合 schema 都有 warn 日志（不再静默 0 候选），且不落模型原文', async () => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    try {
      const bad = makeExtractor('不是JSON');
      expect(await bad.svc.extractCandidates(input)).toBe(0);
      expect(warn.mock.calls.some((c) => String(c[0]).includes('不是合法 JSON'))).toBe(true);

      // JSON 合法但结构不符（memories 缺 importance/confidence）
      const snowflake = '{"memories":[{"content":"泄露候选文本","category":"preference"}]}';
      const mismatch = makeExtractor(snowflake);
      expect(await mismatch.svc.extractCandidates(input)).toBe(0);
      const schemaWarn = warn.mock.calls.map((c) => String(c[0])).find((m) => m.includes('不符合约定 schema'));
      expect(schemaWarn).toBeTruthy();
      expect(schemaWarn).toContain('memories.0.importance'); // 只记 issue 路径/码
      expect(schemaWarn).not.toContain('泄露候选文本'); // 脱敏：模型原文绝不进日志
      expect(mismatch.prisma.memory.create).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it('LLM 抛错 → 0 候选（不阻断聊天）', async () => {
    const { svc, prisma } = makeExtractor('', { failChat: true });
    const saved = await svc.extractCandidates(input);
    expect(saved).toBe(0);
    expect(prisma.memory.create).not.toHaveBeenCalled();
  });

  it('每日候选上限：已超限 → 不再提取（防无限保存）', async () => {
    const { svc, prisma, adapter } = makeExtractor(goodReply, { count: 20, limit: 20 });
    const saved = await svc.extractCandidates(input);
    expect(saved).toBe(0);
    expect(adapter.chat).not.toHaveBeenCalled();
    expect(prisma.memory.create).not.toHaveBeenCalled();
  });
});
