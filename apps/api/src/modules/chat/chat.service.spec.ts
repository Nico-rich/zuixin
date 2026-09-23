import { describe, it, expect, vi } from 'vitest';
import { AgentEvent } from '@ai-agent/shared';
import { ChatService, ChatRunContext } from './chat.service';
import { SSEWriter, SSESink } from './sse-writer';

function makeChat(agentEvents?: () => AsyncIterable<AgentEvent>) {
  const prisma = {
    conversation: {
      findFirst: vi.fn().mockResolvedValue({ id: 'c1', userId: 'u1', title: '旧标题' }),
      create: vi.fn().mockResolvedValue({ id: 'c-new', userId: 'u1', title: '新对话' }),
      update: vi.fn(),
    },
    project: { findFirst: vi.fn().mockResolvedValue({ id: 'p1', userId: 'u1' }) },
    message: {
      create: vi.fn().mockImplementation(({ data }) => Promise.resolve({ id: 'm-' + data.role, ...data })),
      update: vi.fn().mockResolvedValue({}),
    },
  };
  const kv = {
    get: vi.fn().mockResolvedValue('0'), incr: vi.fn(), set: vi.fn(),
    setNX: vi.fn().mockResolvedValue(true), del: vi.fn().mockResolvedValue(undefined),
  };
  const router = { classify: vi.fn().mockResolvedValue({ type: 'chat', confidence: 1, parameters: { prompt: 'x' } }) };
  const context = { assemble: vi.fn().mockResolvedValue({ messages: [], blocks: [] }) };
  const attachmentsService = { getById: vi.fn(), imageDataUrl: vi.fn().mockResolvedValue(null) };
  const memoryExtractor = { extractCandidates: vi.fn().mockResolvedValue(0) };
  const resolved = { providerId: 'p1', providerName: 'Mock', modelId: 'm1', apiModelId: 'mock-echo', timeoutMs: 1000, adapter: {} as never };
  const modelResolver = { resolveDefaultLLM: vi.fn().mockResolvedValue(resolved) };
  const usage = { recordChatUsage: vi.fn().mockResolvedValue(undefined) };
  const events = agentEvents ?? (async function* () {
    yield { type: 'status', stage: 'llm', message: '正在生成回答…' };
    yield { type: 'text.delta', text: '你好' };
    yield { type: 'done', messageId: 'm-assistant' };
  });
  const agentFactory = { create: vi.fn(() => ({ id: 'chat', execute: () => events() })) };
  const imageAgentFactory = { create: vi.fn(() => ({ id: 'image', execute: () => events() })) };
  const svc = new ChatService(prisma as never, kv as never, router as never, context as never, attachmentsService as never, memoryExtractor as never, modelResolver as never, usage as never, agentFactory as never, imageAgentFactory as never);
  return { svc, prisma, kv, usage, context, memoryExtractor, attachmentsService, agentFactory, imageAgentFactory };
}

/** 收集 SSE 帧的 fake sink（缓冲式按 \n\n 分帧解析） */
function collectFrames(): { writer: SSEWriter; events: Array<{ event: string; data: Record<string, unknown> }> } {
  const events: Array<{ event: string; data: Record<string, unknown> }> = [];
  let buf = '';
  const sink: SSESink = {
    writeHead: () => undefined, flushHeaders: () => undefined,
    write: (s: string) => {
      buf += s;
      let idx: number;
      while ((idx = buf.indexOf('\n\n')) >= 0) {
        const frame = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        let event = 'message';
        const datas: string[] = [];
        for (const line of frame.split('\n')) {
          if (line.startsWith('event:')) event = line.slice(6).trim();
          else if (line.startsWith('data:')) datas.push(line.slice(5).trim());
        }
        if (datas.length) events.push({ event, data: JSON.parse(datas.join('\n')) });
      }
    },
    end: () => undefined,
  };
  return { writer: new SSEWriter(sink), events };
}

function baseCtx(): ChatRunContext {
  return {
    conversationId: 'c1', userMessageId: 'm-user', assistantMessageId: 'm-assistant',
    userMessage: '你好', history: [],
    intent: { type: 'chat', confidence: 1, parameters: { prompt: '你好' } },
    resolved: { providerId: 'p1', providerName: 'Mock', modelId: 'm1', apiModelId: 'mock-echo', timeoutMs: 1000, adapter: {} as never },
    lockKey: 'chat:lock:c1', startedAt: Date.now(), userId: 'u1',
    attachments: [],
  };
}

describe('ChatService.prepareChat', () => {
  it('conversationId 为空 → 自动创建会话 + 两条消息', async () => {
    const { svc, prisma } = makeChat();
    await svc.prepareChat('u1', { conversationId: null, message: '你好' }, 'req1');
    expect(prisma.conversation.create).toHaveBeenCalled();
    expect(prisma.message.create).toHaveBeenCalledTimes(2); // user + assistant
  });

  it('上下文组装走 ContextAssembler（排除当前用户消息）', async () => {
    const { svc, context } = makeChat();
    await svc.prepareChat('u1', { conversationId: null, message: '你好' }, 'req1');
    expect(context.assemble).toHaveBeenCalledWith(expect.objectContaining({
      userId: 'u1', conversationId: 'c-new', excludeMessageId: 'm-user',
    }));
  });

  it('projectId 挂载：非本人项目 → NOT_FOUND', async () => {
    const { svc, prisma } = makeChat();
    prisma.project.findFirst.mockResolvedValue(null);
    await expect(svc.prepareChat('u1', { conversationId: null, projectId: 'p-other', message: 'hi' }, 'req1'))
      .rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('projectId 挂载：本人项目 → 会话带 projectId 创建', async () => {
    const { svc, prisma } = makeChat();
    await svc.prepareChat('u1', { conversationId: null, projectId: 'p1', message: 'hi' }, 'req1');
    expect(prisma.conversation.create).toHaveBeenCalledWith({ data: { userId: 'u1', projectId: 'p1' } });
  });

  it('锁被占用 → CONCURRENT_CHAT', async () => {
    const { svc, kv } = makeChat();
    kv.setNX.mockResolvedValue(false);
    await expect(svc.prepareChat('u1', { conversationId: 'c1', message: 'hi' }, 'req1'))
      .rejects.toMatchObject({ code: 'CONCURRENT_CHAT' });
  });

  it('非本人会话 → NOT_FOUND', async () => {
    const { svc, prisma } = makeChat();
    prisma.conversation.findFirst.mockResolvedValue(null);
    await expect(svc.prepareChat('u2', { conversationId: 'c1', message: 'hi' }, 'req1'))
      .rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('首条消息自动生成标题', async () => {
    const { svc, prisma } = makeChat();
    prisma.conversation.findFirst.mockResolvedValue({ id: 'c1', userId: 'u1', title: '新对话' });
    await svc.prepareChat('u1', { conversationId: 'c1', message: '帮我写个标题很长很长很长很长很长' }, 'req1');
    expect(prisma.conversation.update).toHaveBeenCalledWith({ where: { id: 'c1' }, data: { title: expect.any(String) } });
  });

  it('prepareChat 中途失败会释放锁', async () => {
    const { svc, kv, prisma } = makeChat();
    prisma.message.create.mockRejectedValueOnce(new Error('db down'));
    await expect(svc.prepareChat('u1', { conversationId: 'c1', message: 'hi' }, 'req1')).rejects.toThrow();
    expect(kv.del).toHaveBeenCalledWith('chat:lock:c1');
  });
});

describe('ChatService.streamChat', () => {
  it('正常流：message_start → status → message_delta → message_end(completed)，内容持久化', async () => {
    const { svc, prisma, kv, usage } = makeChat();
    const { writer, events } = collectFrames();
    await svc.streamChat(baseCtx(), writer, new AbortController().signal, 'req1');
    expect(events.map((e) => e.event)).toEqual(['message_start', 'status', 'message_delta', 'message_end']);
    expect(events.at(-1)!.data).toMatchObject({ status: 'completed', messageId: 'm-assistant' });
    expect(prisma.message.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'm-assistant' },
      data: expect.objectContaining({ content: '你好', status: 'completed' }),
    }));
    expect(kv.del).toHaveBeenCalledWith('chat:lock:c1');
    expect(usage.recordChatUsage).toHaveBeenCalled();
  });

  it('agent 出错：error + message_end(failed)，DB 状态 failed 保留部分内容', async () => {
    const { svc, prisma } = makeChat(async function* () {
      yield { type: 'text.delta', text: '部分内容' };
      yield { type: 'error', code: 'PROVIDER_TIMEOUT', message: '超时' };
    });
    const { writer, events } = collectFrames();
    await svc.streamChat(baseCtx(), writer, new AbortController().signal, 'req1');
    expect(events.map((e) => e.event)).toEqual(['message_start', 'message_delta', 'error', 'message_end']);
    expect(events.at(-1)!.data).toMatchObject({ status: 'failed' });
    expect(prisma.message.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ content: '部分内容', status: 'failed', errorCode: 'PROVIDER_TIMEOUT' }),
    }));
  });

  it('用户中止（AbortError）：DB 状态 cancelled 保留部分内容，不发 error', async () => {
    const { svc, prisma } = makeChat(async function* () {
      yield { type: 'text.delta', text: '部分' };
      throw Object.assign(new Error('aborted'), { name: 'AbortError' });
    });
    const { writer, events } = collectFrames();
    await svc.streamChat(baseCtx(), writer, new AbortController().signal, 'req1');
    expect(events.some((e) => e.event === 'error')).toBe(false);
    expect(prisma.message.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ content: '部分', status: 'cancelled' }),
    }));
  });

  it('done 携带 usage → 传入 finalize', async () => {
    const { svc, usage } = makeChat(async function* () {
      yield { type: 'text.delta', text: 'x' };
      yield { type: 'done', messageId: 'm-assistant', usage: { inputTokens: 3, outputTokens: 4 } };
    });
    const { writer } = collectFrames();
    await svc.streamChat(baseCtx(), writer, new AbortController().signal, 'req1');
    expect(usage.recordChatUsage).toHaveBeenCalledWith(expect.objectContaining({ inputTokens: 3, outputTokens: 4 }));
  });

  it('image_generation 意图 → 走 ImageAgent（task.created 透传，不触碰 LLM Agent）', async () => {
    const { svc, agentFactory, imageAgentFactory } = makeChat(async function* () {
      yield { type: 'status', stage: 'image_generation', message: '正在创建图片生成任务…' };
      yield { type: 'task.created', taskId: 't1', kind: 'image' };
      yield { type: 'done', messageId: 'm-assistant' };
    });
    const { writer, events } = collectFrames();
    await svc.streamChat({ ...baseCtx(), intent: { type: 'image_generation', confidence: 0.98, parameters: { prompt: '主图' } } }, writer, new AbortController().signal, 'req1');
    expect(imageAgentFactory.create).toHaveBeenCalled();
    expect(agentFactory.create).not.toHaveBeenCalled();
    expect(events.map((e) => e.event)).toContain('task.created');
  });
});
