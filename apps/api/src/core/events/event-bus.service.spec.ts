import { describe, it, expect } from 'vitest';
import { EventBusService, RedisPubSubLike } from './event-bus.service';

/** 内存 fake：publish → 'message' 分发器（与生产 wrapRedis 的 Redis 回环语义一致） */
function make() {
  let dispatcher: (ch: string, msg: string) => void = () => {};
  const pubsub: RedisPubSubLike = {
    publish: async (ch, msg) => { dispatcher(ch, msg); return 1; },
    subscribe: async () => {},
    on: (_event, cb) => { dispatcher = cb; },
    disconnect: () => {},
  };
  const bus = new EventBusService(pubsub);
  return { bus };
}

describe('EventBusService', () => {
  it('publish 后订阅者收到解析后的 JSON 事件', async () => {
    const { bus } = make();
    const received: unknown[] = [];
    await bus.subscribe('task', (evt) => received.push(evt));
    await bus.publish('task', { type: 'task.progress', taskId: 't1', progress: 50 });
    expect(received).toEqual([{ type: 'task.progress', taskId: 't1', progress: 50 }]);
  });

  it('订阅回调抛错不影响 publish 与其他订阅者', async () => {
    const { bus } = make();
    const received: unknown[] = [];
    await bus.subscribe('task', () => { throw new Error('boom'); });
    await bus.subscribe('task', (evt) => received.push(evt));
    await expect(bus.publish('task', { type: 'task.progress', taskId: 't1', progress: 1 })).resolves.toBeUndefined();
    expect(received).toHaveLength(1); // 异常订阅者被隔离，正常订阅者仍收到
  });

  it('不同频道互不串扰', async () => {
    const { bus } = make();
    const received: unknown[] = [];
    await bus.subscribe('other', (evt) => received.push(evt));
    await bus.publish('task', { type: 'task.progress', taskId: 't1', progress: 1 });
    expect(received).toEqual([]);
  });

  it('M6-P6 unsubscribe：精确移除单个 handler，不影响同频道其他订阅者', async () => {
    const { bus } = make();
    const received: unknown[] = [];
    const a = (evt: Record<string, unknown>) => received.push(`a:${evt.progress}`);
    const b = (evt: Record<string, unknown>) => received.push(`b:${evt.progress}`);
    await bus.subscribe('task', a);
    await bus.subscribe('task', b);
    bus.unsubscribe('task', a);
    await bus.publish('task', { type: 'task.progress', taskId: 't1', progress: 50 });
    expect(received).toEqual(['b:50']);
    // 全部移除后不再派发
    bus.unsubscribe('task', b);
    await bus.publish('task', { type: 'task.progress', taskId: 't1', progress: 60 });
    expect(received).toEqual(['b:50']);
  });
});
