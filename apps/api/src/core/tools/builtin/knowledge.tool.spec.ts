import { describe, it, expect, vi } from 'vitest';
import { createKnowledgeSearchTool } from './knowledge.tool';
import { ToolContext } from '../tool.types';

function makeCtx(over: Partial<ToolContext> = {}): ToolContext {
  return {
    userId: 'u1', projectId: 'p1', conversationId: 'c1', messageId: 'm1',
    agentRunId: 'run1', agentRunStepId: 'step1', toolCallId: 'tc-1',
    idempotencyKey: 'ik-1', signal: new AbortController().signal,
    ...over,
  };
}

describe('knowledge.search Tool（Path B：主动检索）', () => {
  it('schema 拒绝身份字段（userId 必须来自 ToolContext）', () => {
    const tool = createKnowledgeSearchTool({} as never);
    expect(() => tool.inputSchema.parse({ query: 'x', userId: 'hacker' })).toThrow();
    expect(() => tool.inputSchema.parse({ query: 'x', projectId: 'p-other' })).toThrow();
  });

  it('执行：用 ToolContext 身份检索，返回摘要结构', async () => {
    const knowledge = {
      search: vi.fn().mockResolvedValue([
        { documentId: 'd1', documentName: '品牌规范', chunkIndex: 0, content: '品牌色为蓝色', similarity: 0.88 },
      ]),
    };
    const tool = createKnowledgeSearchTool(knowledge as never);
    const out = await tool.execute({ query: '品牌色', topK: 3 }, makeCtx());
    expect(knowledge.search).toHaveBeenCalledWith('u1', 'p1', '品牌色', { topK: 3, similarityThreshold: undefined });
    expect(out).toEqual({
      count: 1,
      results: [{ documentId: 'd1', documentName: '品牌规范', chunkIndex: 0, content: '品牌色为蓝色', similarity: 0.88 }],
    });
  });

  it('项目 scope：无 projectId 时以 user scope 检索', async () => {
    const knowledge = { search: vi.fn().mockResolvedValue([]) };
    const tool = createKnowledgeSearchTool(knowledge as never);
    await tool.execute({ query: 'x' }, makeCtx({ projectId: undefined }));
    expect(knowledge.search).toHaveBeenCalledWith('u1', undefined, 'x', expect.anything());
  });
});
