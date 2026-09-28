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
      // M10-P3 编辑/删除：归属+角色取数（默认"查不到"，用例内按需 mock）
      findFirst: vi.fn().mockResolvedValue(null),
      delete: vi.fn().mockResolvedValue({}),
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
  const quota = { assertQuota: vi.fn().mockResolvedValue({ organizationId: 'personal-test', consumed: 0, total: 1, reservationId: 'r-1' }), release: vi.fn().mockResolvedValue(undefined) };
  // M9-P2：增量摘要 + 候选提炼（fire-and-forget；单测只验证调用不被阻塞/失败不冒泡）
  const summaryRefiner = {
    maybeRefine: vi.fn().mockResolvedValue({ created: [], pendingMessages: 0 }),
    // M10-P3：编辑/删除路径接线的既有公开方法（markStale/detectStale/recomputeStale）
    markStale: vi.fn().mockResolvedValue(0),
    detectStale: vi.fn().mockResolvedValue(0),
    recomputeStale: vi.fn().mockResolvedValue({ removed: 0, created: [] }),
  };
  const memoryCandidates = { extractFromSummary: vi.fn().mockResolvedValue({ summaryId: null, skipped: null, extracted: 0, promoted: 0, rejected: 0, duplicated: 0 }) };
  const svc = new ChatService(prisma as never, kv as never, router as never, context as never, attachmentsService as never, memoryExtractor as never, agentRegistry as never, quota as never, summaryRefiner as never, memoryCandidates as never);
  return { svc, prisma, kv, context, memoryExtractor, agentRegistry, agent, summaryRefiner, memoryCandidates };
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

  it('Pre-M9 G4：会话锁 Redis 不可用/超时 → fail-closed（显式 INTERNAL，绝不放行并发生成）', async () => {
    const { svc, kv, prisma } = makeChat();
    kv.setNX.mockRejectedValue(new Error('Redis 操作超时（kv:setNX，>1500ms）'));
    await expect(svc.prepareChat('u1', { conversationId: 'c1', message: 'hi' }, 'req1'))
      .rejects.toMatchObject({ code: 'INTERNAL', message: expect.stringContaining('会话锁服务暂不可用') });
    expect(prisma.message.create).not.toHaveBeenCalled(); // 未产生任何副作用（不写消息/不占配额）
  });

  it('prepareChat 中途失败会释放锁', async () => {
    const { svc, kv, prisma } = makeChat();
    prisma.message.create.mockRejectedValueOnce(new Error('db down'));
    await expect(svc.prepareChat('u1', { conversationId: 'c1', message: 'hi' }, 'req1')).rejects.toThrow();
    expect(kv.del).toHaveBeenCalledWith('chat:lock:c1');
  });
});

/** 冲刷 fire-and-forget 的微任务链（摘要自愈是后台副作用，不阻塞响应） */
const flushAsync = () => new Promise((r) => setTimeout(r, 0));

/** 编辑/删除的授权取数命中行：本人 user 消息，挂在本人的会话下 */
function hitMessage(role = 'user') {
  return {
    id: 'm-1', conversationId: 'c1', role,
    conversation: { projectId: 'p1' },
  };
}

describe('ChatService 消息编辑/删除（M10-P3）', () => {
  it('编辑本人 user 消息：写 content + editedAt，并触发摘要陈旧传播', async () => {
    const { svc, prisma, summaryRefiner } = makeChat();
    prisma.message.findFirst.mockResolvedValue(hitMessage());
    prisma.message.update.mockResolvedValue({ id: 'm-1', content: '改后' });

    const r = await svc.editMessage('u1', 'm-1', { content: '改后' });

    // 归属校验同时约束消息 userId 与所在会话 userId（可靠归属链）
    expect(prisma.message.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'm-1', userId: 'u1', conversation: { userId: 'u1', deletedAt: null } },
    }));
    expect(prisma.message.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'm-1' },
      data: { content: '改后', editedAt: expect.any(Date) },
    }));
    expect(summaryRefiner.markStale).toHaveBeenCalledWith('c1', ['m-1']);
    await flushAsync();
    expect(summaryRefiner.detectStale).toHaveBeenCalledWith('c1');
    expect(summaryRefiner.recomputeStale).toHaveBeenCalledWith('c1', { userId: 'u1', projectId: 'p1' });
    expect(r).toMatchObject({ id: 'm-1' });
  });

  it('编辑他人/跨租户/不存在的消息 → 404（同一分支，不做存在性区分）且无写入副作用', async () => {
    const { svc, prisma, summaryRefiner } = makeChat();
    prisma.message.findFirst.mockResolvedValue(null); // 非本人消息对调用方不可见

    await expect(svc.editMessage('u1', 'm-other', { content: 'x' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(prisma.message.update).not.toHaveBeenCalled();
    expect(summaryRefiner.markStale).not.toHaveBeenCalled();
  });

  it('编辑本人的 assistant 消息 → 403 MESSAGE_EDIT_FORBIDDEN（不落库）', async () => {
    const { svc, prisma } = makeChat();
    prisma.message.findFirst.mockResolvedValue(hitMessage('assistant'));

    const err = await svc.editMessage('u1', 'm-1', { content: '冒充模型发言' }).catch((e) => e);
    expect(err).toMatchObject({ status: 403 });
    expect((err as { getResponse(): { code: string } }).getResponse()).toMatchObject({ code: 'MESSAGE_EDIT_FORBIDDEN' });
    expect(prisma.message.update).not.toHaveBeenCalled();
  });

  it('编辑成功但摘要钩子失败 → 编辑结果不受影响（副作用绝不回滚用户操作）', async () => {
    const { svc, prisma, summaryRefiner } = makeChat();
    prisma.message.findFirst.mockResolvedValue(hitMessage());
    prisma.message.update.mockResolvedValue({ id: 'm-1' });
    summaryRefiner.markStale.mockRejectedValue(new Error('summary db down'));
    summaryRefiner.detectStale.mockRejectedValue(new Error('summary db down'));
    summaryRefiner.recomputeStale.mockRejectedValue(new Error('summary db down'));

    await expect(svc.editMessage('u1', 'm-1', { content: '改后' })).resolves.toMatchObject({ id: 'm-1' });
    await flushAsync(); // 后台自愈失败不上抛（unhandled rejection 会让测试失败）
  });

  it('删除本人 user 消息：**先**标陈旧再硬删（顺序是正确性前提），随后自愈重算', async () => {
    const { svc, prisma, summaryRefiner } = makeChat();
    prisma.message.findFirst.mockResolvedValue(hitMessage());
    const order: string[] = [];
    summaryRefiner.markStale.mockImplementation(() => { order.push('markStale'); return Promise.resolve(1); });
    prisma.message.delete.mockImplementation(() => { order.push('delete'); return Promise.resolve({}); });

    const r = await svc.deleteMessage('u1', 'm-1');

    expect(order).toEqual(['markStale', 'delete']); // 先标后删（先删会导致锚点缺失漏标）
    expect(prisma.message.delete).toHaveBeenCalledWith({ where: { id: 'm-1' } }); // schema 无 deletedAt → 硬删
    await flushAsync();
    expect(summaryRefiner.detectStale).toHaveBeenCalledWith('c1');
    expect(summaryRefiner.recomputeStale).toHaveBeenCalledWith('c1', { userId: 'u1', projectId: 'p1' });
    expect(r).toEqual({ id: 'm-1', conversationId: 'c1', deleted: true });
  });

  it('删除他人的 assistant 消息 → 404（非 User 消息对非本人连存在性都不暴露）', async () => {
    const { svc, prisma } = makeChat();
    prisma.message.findFirst.mockResolvedValue(null);
    await expect(svc.deleteMessage('u1', 'm-other')).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(prisma.message.delete).not.toHaveBeenCalled();
  });

  it('删除本人的 assistant 消息 → 403 MESSAGE_DELETE_FORBIDDEN（不删除历史回答）', async () => {
    const { svc, prisma } = makeChat();
    prisma.message.findFirst.mockResolvedValue(hitMessage('assistant'));

    const err = await svc.deleteMessage('u1', 'm-1').catch((e) => e);
    expect(err).toMatchObject({ status: 403 });
    expect((err as { getResponse(): { code: string } }).getResponse()).toMatchObject({ code: 'MESSAGE_DELETE_FORBIDDEN' });
    expect(prisma.message.delete).not.toHaveBeenCalled();
  });

  it('删除：stale 钩子失败不阻塞删除（用户操作优先）', async () => {
    const { svc, prisma, summaryRefiner } = makeChat();
    prisma.message.findFirst.mockResolvedValue(hitMessage());
    summaryRefiner.markStale.mockRejectedValue(new Error('db down'));
    await expect(svc.deleteMessage('u1', 'm-1')).resolves.toMatchObject({ deleted: true });
    expect(prisma.message.delete).toHaveBeenCalled();
    await flushAsync();
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
