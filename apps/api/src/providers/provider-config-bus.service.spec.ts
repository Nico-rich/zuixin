import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ProviderConfigBusService, PROVIDER_CONFIG_CHANNEL } from './provider-config-bus.service';

/**
 * M13+ 跨进程 provider 配置传播单测（离线，注入假 Redis 客户端）。
 * 断言：
 * - 订阅：init 即 subscribe 到固定 channel；message 到达 → 按 type 刷新**对应** manager；
 * - 未知 type / 坏消息：warn 丢弃，绝不抛；
 * - notify：发布 JSON 载荷（含 type/instanceId/at），发布失败只 warn；
 * - 销毁：两条连接都 disconnect。
 */
function fakeRedis() {
  const handlers: Record<string, Array<(channel: string, message: string) => void>> = {};
  return {
    client: {
      on: vi.fn((ev: string, fn: (...args: unknown[]) => void) => { handlers[ev] = [...(handlers[ev] ?? []), fn as never]; }),
      subscribe: vi.fn(async () => undefined),
      publish: vi.fn(async () => 1),
      disconnect: vi.fn(),
    },
    emit(ev: string, ...args: unknown[]): void {
      for (const fn of handlers[ev] ?? []) (fn as (...a: unknown[]) => void)(...args);
    },
  };
}

function makeBus(over: { publishFails?: boolean } = {}) {
  const redis = fakeRedis();
  if (over.publishFails) redis.client.publish.mockRejectedValue(new Error('redis down'));
  const manager = { refresh: vi.fn(async () => undefined) };
  const svc = new ProviderConfigBusService(
    redis.client as never, redis.client as never,
    manager as never, manager as never, manager as never, manager as never,
  );
  return { svc, redis, manager };
}

describe('ProviderConfigBusService', () => {
  beforeEach(() => { delete process.env.REDIS_URL; });
  afterEach(() => { delete process.env.REDIS_URL; });

  it('init 订阅固定 channel；message → 按 type 刷新对应 manager（四种类型各就各位）', async () => {
    const buses = ['llm', 'image', 'video', 'embedding'].map((type) => {
      const b = makeBus();
      b.svc.onModuleInit();
      return { type, ...b };
    });
    for (const b of buses) {
      expect(b.redis.client.subscribe).toHaveBeenCalledWith(PROVIDER_CONFIG_CHANNEL);
      b.redis.emit('message', PROVIDER_CONFIG_CHANNEL, JSON.stringify({ type: b.type, instanceId: 'x', at: 1 }));
      expect(b.manager.refresh).toHaveBeenCalledTimes(1);
      b.svc.onModuleDestroy();
    }
  });

  it('未知 type / 坏消息 → 只丢弃不抛（绝不打断订阅循环）', async () => {
    const b = makeBus();
    b.svc.onModuleInit();
    b.redis.emit('message', PROVIDER_CONFIG_CHANNEL, JSON.stringify({ type: 'unknown', instanceId: 'x', at: 1 }));
    b.redis.emit('message', PROVIDER_CONFIG_CHANNEL, 'not-json');
    expect(b.manager.refresh).not.toHaveBeenCalled();
    b.svc.onModuleDestroy();
  });

  it('其他 channel 的消息被忽略（channel 名是跨 Agent 契约）', async () => {
    const b = makeBus();
    b.svc.onModuleInit();
    b.redis.emit('message', 'session-events', JSON.stringify({ type: 'llm', instanceId: 'x', at: 1 }));
    expect(b.manager.refresh).not.toHaveBeenCalled();
    b.svc.onModuleDestroy();
  });

  it('notify：发布 JSON 载荷；发布失败只 warn 不抛（本实例已本地刷新）', async () => {
    const ok = makeBus();
    await ok.svc.notify('llm');
    const call = ok.redis.client.publish.mock.calls[0] as unknown as [string, string];
    const published = JSON.parse(call[1]);
    expect(call[0]).toBe(PROVIDER_CONFIG_CHANNEL);
    expect(published.type).toBe('llm');
    expect(typeof published.instanceId).toBe('string');
    expect(typeof published.at).toBe('number');
    ok.svc.onModuleDestroy();

    const down = makeBus({ publishFails: true });
    await expect(down.svc.notify('image')).resolves.toBeUndefined();
    down.svc.onModuleDestroy();
  });

  it('销毁：两条连接都 disconnect', () => {
    const b = makeBus();
    b.svc.onModuleInit();
    b.svc.onModuleDestroy();
    expect(b.redis.client.disconnect).toHaveBeenCalledTimes(2);
  });
});
