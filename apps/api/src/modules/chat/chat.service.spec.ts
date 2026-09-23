import { describe, it, expect, vi } from 'vitest';
import { AgentEvent } from '@ai-agent/shared';
import { ChatService, ChatRunContext } from './chat.service';
import { SSEWriter, SSESink } from './sse-writer';
import { Agent } from '../../agents/agent.types';

function makeChat(agentEvents?: () => AsyncIterable<AgentEvent>, agentId = 'general-assistant') {
  const prisma = {
    conversation: {
      findFirst: vi.fn().mockResolvedValue({ id: 'c1', userId: 'u1', title: '旧标题' }),
      create: vi.fn().mockResolvedValue({ id: 'c-new', userId: 'u1', title: '新对话', projectId: null }),
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
  const events = agentEvents ?? (async function* () {
    yield { type: 'status', stage: 'llm', message: '正在生成回答…' };
    yield { type: 'text.delta', text: '你好' };
    yield { type: 'done', messageId: 'm-assistant' };
  });
  const agent: Agent = { id: agentId, execute: () => events() };
  const agentRegistry = { resolveForIntent: vi.fn().mockResolvedValue(agent) };
  const svc = new ChatService(prisma as never, kv as never, router as never, context as never, attachmentsService as never, memoryExtractor as never, agentRegistry as never);
  return { svc, prisma, kv, context, memoryExtractor, agentRegistry, agent };
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
    lockKey: 'chat:lock:c1', startedAt: Date.now(), userId: 'u1',
    attachments: [],
  };
}

describe('ChatService.prepareChat', () => {
  it('conversationId 为空 → 自动创建会话 + 两条消息', async () => {
    const { svc, prisma } = makeChat();
    await svc.prepareChat('u1', { conversationId: null, message: '你好' }, 'req1');
    expect(prisma.conversation.create).toHaveBeenCalled();
    expect(prisma.message.create).toHaveBeenCalledTimes(2);
  });

  it('上下文组装走 ContextAssembler（排除当前用户消息）', async () => {
    const { svc, context } = makeChat();
    await svc.prepareChat('u1', { conversationId: null, message: '你好' }, 'req1');
    expect(context.assemble).toHaveBeenCalledWith(expect.objectContaining({
      userId: 'u1', conversationId: 'c-new', excludeMessageId: 'm-user',
    }));
  });

  it('projectId 挂载：本人项目 → 会话带 projectId 创建', async () => {
    const { svc, prisma } = makeChat();
    await svc.prepareChat('u1', { conversationId: null, projectId: 'p1', message: 'hi' }, 'req1');
    expect(prisma.conversation.create).toHaveBeenCalledWith({ data: { userId: 'u1', projectId: 'p1' } });
  });

  it('projectId 挂载：非本人项目 → NOT_FOUND', async () => {
    const { svc, prisma } = makeChat();
    prisma.project.findFirst.mockResolvedValue(null);
    await expect(svc.prepareChat('u1', { conversationId: null, projectId: 'p-other', message: 'hi' }, 'req1'))
      .rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('锁被占用 → CONCURRENT_CHAT', async () => {
    const { svc, kv } = makeChat();
    kv.setNX.mockResolvedValue(false);
    await expect(svc.prepareChat('u1', { conversationId: 'c1', message: 'hi' }, 'req1'))
      .rejects.toMatchObject({ code: 'CONCURRENT_CHAT' });
  });

  it('prepareChat 中途失败会释放锁', async () => {
    const { svc, kv, prisma } = makeChat();
    prisma.message.create.mockRejectedValueOnce(new Error('db down'));
    await expect(svc.prepareChat('u1', { conversationId: 'c1', message: 'hi' }, 'req1')).rejects.toThrow();
    expect(kv.del).toHaveBeenCalledWith('chat:lock:c1');
  });
});

describe('ChatService.streamChat（Agent 注册表驱动）', () => {
  it('正常流：Agent 经注册表解析；done → message_end(completed)，内容持久化', async () => {
    const { svc, prisma, kv, agentRegistry } = makeChat();
    const { writer, events } = collectFrames();
    await svc.streamChat(baseCtx(), writer, new AbortController().signal, 'req1');
    expect(agentRegistry.resolveForIntent).toHaveBeenCalledWith(expect.objectContaining({ type: 'chat' }));
    expect(events.map((e) => e.event)).toEqual(['message_start', 'status', 'message_delta', 'message_end']);
    expect(prisma.message.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'm-assistant' },
      data: expect.objectContaining({ content: '你好', status: 'completed' }),
    }));
    expect(kv.del).toHaveBeenCalledWith('chat:lock:c1');
  });

  it('Loop Agent：agent.start/tool.*/run.* 事件透传；agent.end(completed) → message_end(completed)', async () => {
    const { svc } = makeChat(async function* () {
      yield { type: 'run.created', runId: 'run-1', agentId: 'a1' };
      yield { type: 'agent.start', agentId: 'a1', runId: 'run-1' };
      yield { type: 'tool.start', toolName: 'image.generate', runId: 'run-1' };
      yield { type: 'task.created', taskId: 't1', kind: 'image' };
      yield { type: 'tool.end', toolName: 'image.generate', runId: 'run-1', status: 'completed' };
      yield { type: 'text.delta', text: '已为你创建任务' };
      yield { type: 'agent.end', agentId: 'a1', runId: 'run-1', status: 'completed' };
      yield { type: 'run.completed', runId: 'run-1', status: 'completed' };
    });
    const { writer, events } = collectFrames();
    await svc.streamChat(baseCtx(), writer, new AbortController().signal, 'req1');
    const names = events.map((e) => e.event);
    expect(names).toContain('agent.start');
    expect(names).toContain('tool.start');
    expect(names).toContain('run.completed');
    expect(events.filter((e) => e.event === 'message_end').at(-1)!.data).toMatchObject({ status: 'completed' });
  });

  it('agent.end(failed) → message_end(failed) + DB failed', async () => {
    const { svc, prisma } = makeChat(async function* () {
      yield { type: 'agent.start', agentId: 'a1', runId: 'r1' };
      yield { type: 'error', code: 'PROVIDER_TIMEOUT', message: '超时' };
      yield { type: 'agent.end', agentId: 'a1', runId: 'r1', status: 'failed' };
      yield { type: 'run.completed', runId: 'r1', status: 'failed' };
    });
    const { writer, events } = collectFrames();
    await svc.streamChat(baseCtx(), writer, new AbortController().signal, 'req1');
    expect(events.filter((e) => e.event === 'message_end').at(-1)!.data).toMatchObject({ status: 'failed' });
    expect(prisma.message.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: 'failed', errorCode: 'PROVIDER_TIMEOUT' }),
    }));
  });

  it('agent.end(cancelled) → message_end(stopped) + DB cancelled', async () => {
    const { svc, prisma } = makeChat(async function* () {
      yield { type: 'agent.start', agentId: 'a1', runId: 'r1' };
      yield { type: 'agent.end', agentId: 'a1', runId: 'r1', status: 'cancelled' };
    });
    const { writer, events } = collectFrames();
    await svc.streamChat(baseCtx(), writer, new AbortController().signal, 'req1');
    expect(events.filter((e) => e.event === 'message_end').at(-1)!.data).toMatchObject({ status: 'stopped' });
    expect(prisma.message.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: 'cancelled' }),
    }));
  });

  it('AbortError → 保留部分内容 status=cancelled，不发 error', async () => {
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
});
