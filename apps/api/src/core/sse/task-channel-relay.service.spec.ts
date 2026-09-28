import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PrismaService } from '../../modules/prisma/prisma.service';
import { SseConnectionSink, SseRegistryService } from './sse-registry.service';
import { TASK_RELAY_RETRY_MS, TaskChannelRelayService, matchesOwner, writeSseFrame } from './task-channel-relay.service';

/** 可写 sink 的测试替身（记录收到的帧） */
function sink(opts: { writableEnded?: boolean } = {}) {
  const chunks: string[] = [];
  const s: SseConnectionSink = {
    get writableEnded() { return opts.writableEnded ?? false; },
    write(chunk: string) { chunks.push(chunk); },
    end: () => undefined,
  };
  return { s, text: () => chunks.join('') };
}

/** EventBusService 的最小替身：只保留 subscribe/unsubscribe + 手动触发投递 */
function fakeBus(opts: { failSubscribe?: boolean } = {}) {
  const handlers = new Map<string, Set<(e: Record<string, unknown>) => void>>();
  const subscribeCalls: string[] = [];
  const unsubscribeCalls: string[] = [];
  let failing = opts.failSubscribe ?? false;
  return {
    subscribeCalls,
    unsubscribeCalls,
    setFailing: (v: boolean) => { failing = v; },
    async subscribe(channel: string, handler: (e: Record<string, unknown>) => void) {
      subscribeCalls.push(channel);
      if (failing) throw new Error('redis 不可用');
      if (!handlers.has(channel)) handlers.set(channel, new Set());
      handlers.get(channel)!.add(handler);
    },
    unsubscribe(channel: string, handler: (e: Record<string, unknown>) => void) {
      unsubscribeCalls.push(channel);
      handlers.get(channel)?.delete(handler);
    },
    async emit(channel: string, event: Record<string, unknown>) {
      for (const h of [...(handlers.get(channel) ?? [])]) h(event);
    },
    has(channel: string) { return (handlers.get(channel)?.size ?? 0) > 0; },
  };
}

function fakePrisma(rows: Record<string, { userId: string; conversationId: string | null }>) {
  const findUnique = vi.fn(async (args: { where: { id: string } }) => rows[args.where.id] ?? null);
  return { prisma: { generationTask: { findUnique } } as unknown as PrismaService, findUnique };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe('TaskChannelRelayService（ARCH-07：Redis task 通道 → SSE 连接）', () => {
  let sse: SseRegistryService;
  let bus: ReturnType<typeof fakeBus>;

  beforeEach(() => {
    sse = new SseRegistryService();
    bus = fakeBus();
  });

  afterEach(() => { vi.useRealTimers(); });

  it('启动即订阅 task 通道（含前缀由总线内部处理），degraded 复位为 false', async () => {
    const { prisma } = fakePrisma({});
    const relay = new TaskChannelRelayService(sse, bus as never, prisma);
    await relay.onModuleInit();
    expect(bus.subscribeCalls).toEqual(['task']);
    expect(relay.isDegraded()).toBe(false);
    await relay.onModuleDestroy();
    expect(bus.unsubscribeCalls).toEqual(['task']);
  });

  it('task.progress 只投递给归属匹配的连接（user 相等；conversation 双侧已知时要求相等）', async () => {
    const { prisma } = fakePrisma({ 't-1': { userId: 'u1', conversationId: 'c1' } });
    const sameUserSameConv = sink();
    const sameUserOtherConv = sink();
    const otherUser = sink();
    const unknownOwner = sink();
    sse.add('chat', sameUserSameConv.s, { userId: 'u1', conversationId: 'c1' });
    sse.add('chat', sameUserOtherConv.s, { userId: 'u1', conversationId: 'c2' });
    sse.add('chat', otherUser.s, { userId: 'u2', conversationId: 'c1' });
    sse.add('chat', unknownOwner.s); // 归属未知（无 res.req 的 fake sink）→ fail-closed

    const relay = new TaskChannelRelayService(sse, bus as never, prisma);
    await relay.onModuleInit();
    await bus.emit('task', { type: 'task.progress', taskId: 't-1', progress: 42, message: '生成中 42%' });
    await flush();

    expect(sameUserSameConv.text()).toBe('event: task.progress\ndata: {"type":"task.progress","taskId":"t-1","progress":42,"message":"生成中 42%"}\n\n');
    expect(sameUserOtherConv.text()).toBe('');
    expect(otherUser.text()).toBe('');
    expect(unknownOwner.text()).toBe('');
    expect(relay.stats()).toMatchObject({ degraded: false, forwarded: 1 });
    await relay.onModuleDestroy();
  });

  it('同一 user 但连接 conversationId 未知（如 agent-run 流/新建会话）→ 按 user 匹配照常投递', async () => {
    const { prisma } = fakePrisma({ 't-2': { userId: 'u1', conversationId: 'c1' } });
    const runStream = sink();
    sse.add('agent-run-events', runStream.s, { userId: 'u1', conversationId: null });
    const relay = new TaskChannelRelayService(sse, bus as never, prisma);
    await relay.onModuleInit();
    await bus.emit('task', { type: 'task.completed', taskId: 't-2', progress: 100 });
    await flush();
    expect(runStream.text()).toContain('event: task.completed');
    await relay.onModuleDestroy();
  });

  it('未知 taskId / 非 task.* 事件 / 缺 taskId → 一律不转发（fail-closed，绝不广播）', async () => {
    const { prisma, findUnique } = fakePrisma({ 't-1': { userId: 'u1', conversationId: null } });
    const conn = sink();
    sse.add('chat', conn.s, { userId: 'u1' });
    const relay = new TaskChannelRelayService(sse, bus as never, prisma);
    await relay.onModuleInit();
    await bus.emit('task', { type: 'task.progress', taskId: 'ghost', progress: 1 });     // DB 无此任务
    await bus.emit('task', { type: 'run.completed', taskId: 't-1' });                    // 非 task.* 事件
    await bus.emit('task', { type: 'task.progress' });                                   // 缺 taskId
    await bus.emit('task', { type: 'task.progress', taskId: 't-1' });                    // 合法
    await flush();
    expect(conn.text()).toBe('event: task.progress\ndata: {"type":"task.progress","taskId":"t-1"}\n\n');
    expect(findUnique).toHaveBeenCalledTimes(2); // ghost + t-1（非任务事件未触达归属解析）
    expect(relay.stats().skipped).toBe(3);
    await relay.onModuleDestroy();
  });

  it('归属解析带 TTL 缓存（同任务连续事件只查一次 DB；过期后重查）', async () => {
    const { prisma, findUnique } = fakePrisma({ 't-1': { userId: 'u1', conversationId: null } });
    const conn = sink();
    sse.add('chat', conn.s, { userId: 'u1' });
    const relay = new TaskChannelRelayService(sse, bus as never, prisma);
    await relay.onModuleInit();

    await bus.emit('task', { type: 'task.progress', taskId: 't-1', progress: 10 });
    await bus.emit('task', { type: 'task.progress', taskId: 't-1', progress: 20 });
    await flush();
    expect(findUnique).toHaveBeenCalledTimes(1);
    expect(relay.stats().cachedOwners).toBe(1);

    // 只伪造 Date（真实定时器保留，便于 flush 微任务）：把时钟推过 TTL → 下一事件重查
    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + 61_000 });
    await bus.emit('task', { type: 'task.progress', taskId: 't-1', progress: 30 });
    await flush();
    expect(findUnique).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
    await relay.onModuleDestroy();
  });

  it('DB 归属解析失败（DB 抖动）→ 本条丢弃并计数，不冒泡、不影响后续事件', async () => {
    const findUnique = vi.fn()
      .mockRejectedValueOnce(new Error('connection reset'))
      .mockResolvedValue({ userId: 'u1', conversationId: null });
    const prisma = { generationTask: { findUnique } } as unknown as PrismaService;
    const conn = sink();
    sse.add('chat', conn.s, { userId: 'u1' });
    const relay = new TaskChannelRelayService(sse, bus as never, prisma);
    await relay.onModuleInit();
    await bus.emit('task', { type: 'task.progress', taskId: 't-1', progress: 1 });
    await bus.emit('task', { type: 'task.progress', taskId: 't-2', progress: 2 });
    await flush();
    expect(conn.text()).toContain('"taskId":"t-2"');
    expect(conn.text()).not.toContain('"taskId":"t-1"');
    await relay.onModuleDestroy();
  });

  it('已结束的连接（writableEnded）被跳过（不产生写入异常）', async () => {
    const { prisma } = fakePrisma({ 't-1': { userId: 'u1', conversationId: null } });
    const dead = sink({ writableEnded: true });
    sse.add('chat', dead.s, { userId: 'u1' });
    const relay = new TaskChannelRelayService(sse, bus as never, prisma);
    await relay.onModuleInit();
    await bus.emit('task', { type: 'task.progress', taskId: 't-1', progress: 5 });
    await flush();
    expect(dead.text()).toBe('');
    await relay.onModuleDestroy();
  });

  it('Redis 不可用（订阅失败）→ 不抛错、标记 degraded + 计数 + 按间隔重试成功后自愈', async () => {
    const { prisma } = fakePrisma({});
    const failing = fakeBus({ failSubscribe: true });
    const relay = new TaskChannelRelayService(sse, failing as never, prisma);

    vi.useFakeTimers();
    await relay.onModuleInit(); // 绝不抛错（否则 API 无法启动）
    expect(relay.isDegraded()).toBe(true);
    expect(relay.stats().subscribeFailures).toBe(1);
    expect(failing.subscribeCalls).toHaveLength(1);

    // 重试仍未成功 → 计数累加（可观测，不静默）
    await vi.advanceTimersByTimeAsync(TASK_RELAY_RETRY_MS);
    await vi.advanceTimersByTimeAsync(0);
    expect(relay.stats().subscribeFailures).toBe(2);

    // Redis 恢复 → 下一次重试建立订阅，degraded 复位
    failing.setFailing(false);
    await vi.advanceTimersByTimeAsync(TASK_RELAY_RETRY_MS);
    await vi.advanceTimersByTimeAsync(0);
    expect(relay.isDegraded()).toBe(false);
    expect(failing.has('task')).toBe(true);

    vi.useRealTimers();
    await relay.onModuleDestroy();
  });

  it('onModuleDestroy：退订、清缓存、清除重试定时器（幂等，不再投递）', async () => {
    const { prisma } = fakePrisma({ 't-1': { userId: 'u1', conversationId: null } });
    const conn = sink();
    sse.add('chat', conn.s, { userId: 'u1' });
    const relay = new TaskChannelRelayService(sse, bus as never, prisma);
    await relay.onModuleInit();
    await relay.onModuleDestroy();
    expect(bus.has('task')).toBe(false);
    expect(relay.stats().cachedOwners).toBe(0);
    await bus.emit('task', { type: 'task.progress', taskId: 't-1', progress: 1 });
    await flush();
    expect(conn.text()).toBe('');
    await relay.onModuleDestroy(); // 幂等
  });

  it('matchesOwner：user 缺失/不等一律不匹配；conversation 只在双侧已知时比较', () => {
    const task = { userId: 'u1', conversationId: 'c1' };
    expect(matchesOwner({}, task)).toBe(false);
    expect(matchesOwner({ userId: 'u2' }, task)).toBe(false);
    expect(matchesOwner({ userId: 'u1' }, task)).toBe(true);
    expect(matchesOwner({ userId: 'u1', conversationId: null }, task)).toBe(true);
    expect(matchesOwner({ userId: 'u1', conversationId: 'c1' }, task)).toBe(true);
    expect(matchesOwner({ userId: 'u1', conversationId: 'c2' }, task)).toBe(false);
    // 任务无 conversationId（非会话场景）→ 只按 user
    expect(matchesOwner({ userId: 'u1', conversationId: 'c2' }, { userId: 'u1', conversationId: null })).toBe(true);
  });

  it('writeSseFrame：帧格式与 SSEWriter 一致（event 行 + 单行 JSON data + 空行）；不可写 sink 抛错', () => {
    const { s, text } = sink();
    writeSseFrame(s, 'task.progress', { type: 'task.progress', taskId: 't', progress: 1 });
    expect(text()).toBe('event: task.progress\ndata: {"type":"task.progress","taskId":"t","progress":1}\n\n');
    expect(() => writeSseFrame({ end: () => undefined } as SseConnectionSink, 'x', {})).toThrow('SSE sink 不支持 write');
  });
});
