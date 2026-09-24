import { describe, it, expect, vi } from 'vitest';
import { KnowledgeSource } from './knowledge.source';

function makeKnowledge(results: Array<{ documentId: string; documentName: string; chunkIndex: number; content: string; similarity: number }> = []) {
  return { search: vi.fn().mockResolvedValue(results) };
}

describe('KnowledgeSource（Path A：自动检索，触发机制）', () => {
  it('disabled → 空数组且不检索', async () => {
    const knowledge = makeKnowledge();
    const source = new KnowledgeSource(knowledge as never);
    const blocks = await source.collect({ userId: 'u1', conversationId: 'c1', userMessage: '问题', knowledge: { enabled: false } });
    expect(blocks).toEqual([]);
    expect(knowledge.search).not.toHaveBeenCalled();
  });

  it('enabled 但无用户消息 → 不检索', async () => {
    const knowledge = makeKnowledge();
    const source = new KnowledgeSource(knowledge as never);
    expect(await source.collect({ userId: 'u1', conversationId: 'c1', knowledge: { enabled: true } })).toEqual([]);
    expect(knowledge.search).not.toHaveBeenCalled();
  });

  it('enabled + 命中 → 注入 [Knowledge] 块（来源 + 内容 + order=40 + citation）', async () => {
    const knowledge = makeKnowledge([
      { documentId: 'd1', documentName: '产品规格', chunkIndex: 0, content: '产品尺寸 2000×2000', similarity: 0.85 },
    ]);
    const source = new KnowledgeSource(knowledge as never);
    const blocks = await source.collect({ userId: 'u1', conversationId: 'c1', projectId: 'p1', userMessage: '产品尺寸多少', knowledge: { enabled: true } });
    expect(knowledge.search).toHaveBeenCalledWith('u1', 'p1', '产品尺寸多少', expect.objectContaining({ topK: 3, similarityThreshold: 0.3 }));
    expect(blocks).toHaveLength(1);
    expect(blocks[0].content).toContain('[Knowledge]');
    expect(blocks[0].content).toContain('Source: 产品规格');
    expect(blocks[0].content).toContain('产品尺寸 2000×2000');
    expect(blocks[0].order).toBe(40);
    expect(blocks[0].source).toMatchObject({ kind: 'knowledge', documentId: 'd1' });
  });

  it('无结果 → 空数组（score threshold 过滤后的空集不注入）', async () => {
    const knowledge = makeKnowledge([]);
    const source = new KnowledgeSource(knowledge as never);
    expect(await source.collect({ userId: 'u1', conversationId: 'c1', userMessage: 'x', knowledge: { enabled: true } })).toEqual([]);
  });
});
