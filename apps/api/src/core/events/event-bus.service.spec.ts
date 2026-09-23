import { describe, it, expect } from 'vitest';
import { EventBusService } from './event-bus.service';

interface FakePubSub {
  publish: (ch: string, msg: string) => Promise<number>;
  subscribe: (ch: string, cb: (ch: string, msg: string) => void) => Promise<void>;
  on: (event: string, cb: (ch: string, msg: string) => void) => void;
}

function make() {
  const subs = new Map<string, Array<(ch: string, msg: string) => void>>();
  const handlers: Array<(ch: string, msg: string) => void> = [];
  const pubsub: FakePubSub = {
    publish: async (ch, msg) => { handlers.forEach((cb) => cb(ch, msg)); return 1; },
    subscribe: async (ch, cb) => { subs.set(ch, [...(subs.get(ch) ?? []), cb]); },
    on: (_event, cb) => { handlers.push(cb); },
  };
  const bus = new EventBusService(pubsub as never);
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

  it('订阅回调抛错不影响 publish', async () => {
    const { bus } = make();
    await bus.subscribe('task', () => { throw new Error('boom'); });
    await expect(bus.publish('task', { type: 'task.progress', taskId: 't1', progress: 1 })).resolves.toBeUndefined();
  });

  it('不同频道互不串扰', async () => {
    const { bus } = make();
    const received: unknown[] = [];
    await bus.subscribe('other', (evt) => received.push(evt));
    await bus.publish('task', { type: 'task.progress', taskId: 't1', progress: 1 });
    expect(received).toEqual([]);
  });
});
