import { describe, it, expect } from 'vitest';
import { EventBusService, RedisPubSubLike, EVENT_BATCH_MAX, EVENT_BATCH_WINDOW_MS } from './event-bus.service';

/**
 * 内存 fake：publish → 'message' 分发器（与生产 wrapRedis 的 Redis 回环语义一致）。
 * 记录 publishBatch 调用次数/批量大小——P5 断言「N 事件 = 1 次 pipeline 往返」。
 */
function make(options: { pipeline?: boolean } = {}) {
  let dispatcher: (ch: string, msg: string) => void = () => {};
  const calls: number[] = [];
  const batches: Array<Array<{ channel: string; message: string }>> = [];
  const single: Array<{ channel: string; message: string }> = [];
  let disconnected = 0;
  const base = {
    publish: async (ch: string, msg: string) => { single.push({ channel: ch, message: msg }); dispatcher(ch, msg); return 1; },
    subscribe: async () => {},
    on: (_event: string, cb: (ch: string, msg: string) => void) => { dispatcher = cb; },
    disconnect: () => { disconnected += 1; },
  };
  const pubsub = (options.pipeline === false ? base : {
    ...base,
    publishBatch: async (entries: Array<{ channel: string; message: string }>) => {
      calls.push(entries.length);
      batches.push(entries);
      for (const e of entries) dispatcher(e.channel, e.message);
    },
  }) as RedisPubSubLike;
  const bus = new EventBusService(pubsub);
  return { bus, calls, batches, single, disconnected: () => disconnected };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('EventBusService（P5 批量发布）', () => {
  it('publish 后订阅者收到解析后的 JSON 事件（经 flush）', async () => {
    const { bus } = make();
    const received: unknown[] = [];
    await bus.subscribe('task', (evt) => received.push(evt));
    await bus.publish('task', { type: 'task.progress', taskId: 't1', progress: 50 });
    await bus.flush();
    expect(received).toEqual([{ type: 'task.progress', taskId: 't1', progress: 50 }]);
  });

  it('批量：同一频道连续 3 事件 = 1 次 pipeline（3 条），内容与顺序不变', async () => {
    const { bus, calls, batches } = make();
    const received: Array<Record<string, unknown>> = [];
    await bus.subscribe('task', (evt) => received.push(evt));
    for (const progress of [10, 20, 30]) await bus.publish('task', { type: 'task.progress', taskId: 't1', progress });
    expect(bus.pendingEvents()).toBe(3); // 已入缓冲、尚未发布
    expect(calls).toHaveLength(0);
    await bus.flush();
    expect(calls).toEqual([3]); // 单次批量往返
    expect(batches[0].every((e) => e.channel === 'agent:events:task')).toBe(true);
    expect(received.map((e) => e.progress)).toEqual([10, 20, 30]); // 顺序不变
    expect(received[1]).toEqual({ type: 'task.progress', taskId: 't1', progress: 20 }); // 内容不变
  });

  it('窗口自动冲刷：不显式 flush 也会在窗口内送达，且延迟 < 50ms（SSE 预算）', async () => {
    const { bus } = make();
    const received: Array<Record<string, unknown>> = [];
    await bus.subscribe('task', (evt) => received.push(evt));
    const t0 = performance.now();
    await bus.publish('task', { type: 'task.progress', taskId: 't1', progress: 1 });
    expect(received).toHaveLength(0); // 缓冲中：绝不在此刻发布
    while (!received.length && performance.now() - t0 < 50) await sleep(1);
    const elapsed = performance.now() - t0;
    expect(received).toHaveLength(1);
    expect(elapsed).toBeLessThan(50); // 窗口 10ms + 投递 → 远小于 SSE 50ms 预算
    expect(elapsed).toBeGreaterThanOrEqual(EVENT_BATCH_WINDOW_MS - 2); // 确实走了窗口聚合（非同步直发）
  });

  it('突发上限：达到 EVENT_BATCH_MAX 立即发布（不等窗口）', async () => {
    const { bus, calls } = make();
    await bus.subscribe('task', () => undefined);
    for (let i = 0; i < EVENT_BATCH_MAX; i++) await bus.publish('task', { type: 'task.progress', progress: i });
    expect(calls).toEqual([EVENT_BATCH_MAX]); // 第 128 条入缓冲即触发发布
    expect(bus.pendingEvents()).toBe(0);
  });

  it('多频道混排：各频道内顺序不变（跨频道共享缓冲但不乱序）', async () => {
    const { bus, batches } = make();
    const a: number[] = [];
    const b: number[] = [];
    await bus.subscribe('a', (evt) => a.push(evt.n as number));
    await bus.subscribe('b', (evt) => b.push(evt.n as number));
    await bus.publish('a', { n: 1 });
    await bus.publish('b', { n: 1 });
    await bus.publish('a', { n: 2 });
    await bus.publish('b', { n: 2 });
    await bus.flush();
    expect(batches[0].map((e) => e.channel)).toEqual(['agent:events:a', 'agent:events:b', 'agent:events:a', 'agent:events:b']); // 入队顺序
    expect(a).toEqual([1, 2]);
    expect(b).toEqual([1, 2]);
  });

  it('flush 幂等：空缓冲不产生任何发布；重复 flush 不重发', async () => {
    const { bus, calls } = make();
    await bus.flush();
    await bus.publish('task', { n: 1 });
    await bus.flush();
    await bus.flush();
    expect(calls).toEqual([1]);
    expect(bus.pendingEvents()).toBe(0);
  });

  it('订阅回调抛错不影响 publish 与其他订阅者', async () => {
    const { bus } = make();
    const received: unknown[] = [];
    await bus.subscribe('task', () => { throw new Error('boom'); });
    await bus.subscribe('task', (evt) => received.push(evt));
    await expect(bus.publish('task', { type: 'task.progress', taskId: 't1', progress: 1 })).resolves.toBeUndefined();
    await bus.flush();
    expect(received).toHaveLength(1); // 异常订阅者被隔离，正常订阅者仍收到
  });

  it('无 publishBatch 实现：退化为逐个 publish（语义与顺序不变）', async () => {
    const { bus, single } = make({ pipeline: false });
    const received: number[] = [];
    await bus.subscribe('task', (evt) => received.push(evt.n as number));
    await bus.publish('task', { n: 1 });
    await bus.publish('task', { n: 2 });
    await bus.flush();
    expect(single.map((e) => e.channel)).toEqual(['agent:events:task', 'agent:events:task']);
    expect(received).toEqual([1, 2]);
  });

  it('发布失败：pipeline 抛错被记录并吞掉（publish/flush 不抛，后续事件仍可发布）', async () => {
    let fail = true;
    const seen: string[] = [];
    const pubsub = {
      publish: async () => 1,
      publishBatch: async (entries: Array<{ channel: string; message: string }>) => {
        seen.push(...entries.map((e) => e.message));
        if (fail) throw new Error('redis down');
      },
      subscribe: async () => {},
      on: () => {},
      disconnect: () => {},
    } as RedisPubSubLike;
    const bus = new EventBusService(pubsub);
    await bus.publish('task', { n: 1 });
    await expect(bus.flush()).resolves.toBeUndefined(); // 失败不冒泡
    fail = false;
    await bus.publish('task', { n: 2 });
    await bus.flush();
    expect(seen).toEqual([JSON.stringify({ n: 1 }), JSON.stringify({ n: 2 })]); // 链路未卡死
  });

  it('不同频道互不串扰', async () => {
    const { bus } = make();
    const received: unknown[] = [];
    await bus.subscribe('other', (evt) => received.push(evt));
    await bus.publish('task', { type: 'task.progress', taskId: 't1', progress: 1 });
    await bus.flush();
    expect(received).toEqual([]);
  });

  it('M6-P6 unsubscribe：精确移除单个 handler，不影响同频道其他订阅者', async () => {
    const { bus } = make();
    const received: string[] = [];
    const a = (evt: Record<string, unknown>) => received.push(`a:${evt.progress}`);
    const b = (evt: Record<string, unknown>) => received.push(`b:${evt.progress}`);
    await bus.subscribe('task', a);
    await bus.subscribe('task', b);
    bus.unsubscribe('task', a);
    await bus.publish('task', { type: 'task.progress', taskId: 't1', progress: 50 });
    await bus.flush();
    expect(received).toEqual(['b:50']);
    // 全部移除后不再派发
    bus.unsubscribe('task', b);
    await bus.publish('task', { type: 'task.progress', taskId: 't1', progress: 60 });
    await bus.flush();
    expect(received).toEqual(['b:50']);
  });

  it('P5 cleanup：onModuleDestroy 冲刷在途事件、清空订阅并断开连接', async () => {
    const { bus, calls, disconnected } = make();
    const received: unknown[] = [];
    await bus.subscribe('task', (evt) => received.push(evt));
    await bus.publish('task', { type: 'task.progress', taskId: 't1', progress: 99 });
    await bus.onModuleDestroy();
    expect(calls).toEqual([1]); // 关停前冲刷（事件不丢）
    expect(received).toEqual([{ type: 'task.progress', taskId: 't1', progress: 99 }]);
    expect(disconnected()).toBe(2); // pub + sub 均断开
    await bus.publish('task', { type: 'task.progress', taskId: 't1', progress: 100 });
    await bus.flush();
    expect(received).toHaveLength(1); // 订阅已清理，不再派发
  });
});
