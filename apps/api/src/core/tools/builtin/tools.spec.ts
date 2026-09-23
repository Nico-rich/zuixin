import { describe, it, expect, vi } from 'vitest';
import { createImageGenerateTool, createVideoGenerateTool, createArtifactTool, createMemoryCandidateTool } from './tools';
import { ToolContext } from '../tool.types';

function makeCtx(over: Partial<ToolContext> = {}): ToolContext {
  return {
    userId: 'u1', projectId: 'p1', conversationId: 'c1', messageId: 'm1',
    agentRunId: 'run1', agentRunStepId: 'step1', idempotencyKey: 'ik-1',
    signal: new AbortController().signal,
    ...over,
  };
}

describe('image.generate Tool（Agent → Tool → Service 分层）', () => {
  it('透传身份上下文 + 幂等键，返回任务引用', async () => {
    const generations = {
      prepareMediaTask: vi.fn().mockResolvedValue({ id: 'task-1', status: 'pending' }),
    };
    const tool = createImageGenerateTool(generations as never);
    const out = await tool.execute({ prompt: '主图', count: 2 }, makeCtx());
    expect(generations.prepareMediaTask).toHaveBeenCalledWith(expect.objectContaining({
      userId: 'u1', conversationId: 'c1', messageId: 'm1', type: 'image',
      params: { prompt: '主图', count: 2, aspectRatio: undefined, referenceImages: undefined },
      idempotencyKey: 'ik-1',
    }));
    expect(out).toEqual({ taskId: 'task-1', status: 'pending' });
  });

  it('输入 schema 拒绝身份字段（防越权）', async () => {
    const generations = { prepareMediaTask: vi.fn() };
    const tool = createImageGenerateTool(generations as never);
    expect(() => tool.inputSchema.parse({ prompt: 'x', userId: 'hacker' })).toThrow();
  });
});

describe('video.generate Tool', () => {
  it('透传 duration 并带幂等键', async () => {
    const generations = {
      prepareMediaTask: vi.fn().mockResolvedValue({ id: 'task-2', status: 'pending' }),
    };
    const tool = createVideoGenerateTool(generations as never);
    await tool.execute({ prompt: '广告', duration: 10 }, makeCtx());
    expect(generations.prepareMediaTask).toHaveBeenCalledWith(expect.objectContaining({
      type: 'video', params: { prompt: '广告', duration: 10, aspectRatio: undefined, referenceImages: undefined },
    }));
  });
});

describe('artifact.create Tool', () => {
  it('继承 project/conversation/message，创建制品', async () => {
    const artifacts = {
      create: vi.fn().mockResolvedValue({ id: 'art-1', status: 'ready' }),
    };
    const tool = createArtifactTool(artifacts as never);
    const out = await tool.execute({ type: 'creative_brief', title: '主图方案', content: { audience: '科技感' } }, makeCtx());
    expect(artifacts.create).toHaveBeenCalledWith('u1', expect.objectContaining({
      type: 'creative_brief', projectId: 'p1', conversationId: 'c1', messageId: 'm1',
    }));
    expect(out).toEqual({ artifactId: 'art-1', status: 'ready' });
  });
});

describe('memory.create_candidate Tool（只产候选，不绕过状态机）', () => {
  it('有 projectId → 项目级候选；source=agent', async () => {
    const memories = {
      create: vi.fn().mockResolvedValue({ id: 'mem-1', status: 'candidate' }),
    };
    const tool = createMemoryCandidateTool(memories as never);
    const out = await tool.execute({ content: '主图 2000×2000', category: 'preference', confidence: 0.9 }, makeCtx());
    expect(memories.create).toHaveBeenCalledWith('u1', expect.objectContaining({
      scope: 'project', projectId: 'p1', status: 'candidate', source: 'agent', sourceMessageId: 'm1',
    }));
    expect(out).toEqual({ memoryId: 'mem-1', status: 'candidate' });
  });

  it('无 projectId → 用户级候选', async () => {
    const memories = { create: vi.fn().mockResolvedValue({ id: 'mem-2', status: 'candidate' }) };
    const tool = createMemoryCandidateTool(memories as never);
    await tool.execute({ content: '偏好', category: 'preference' }, makeCtx({ projectId: undefined }));
    expect(memories.create).toHaveBeenCalledWith('u1', expect.objectContaining({ scope: 'user', projectId: undefined }));
  });
});
