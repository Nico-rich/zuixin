import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SESSION_EVENTS_CHANNEL, SessionEventsService } from './session-events.service';
import type { SessionEvent } from './session-events.service';

/**
 * M10-P1 SA-1/X-10/SA-4/X-20：会话治理（跨实例传播 + jti 黑名单）单测。
 * 用内存版 Redis 替身断言**协议层事实**（channel 名、key 名、TTL、ZSET 语义），
 * 并逐条覆盖降级口径（发布失败/记账失败/查询失败 → 各自可解释的行为）。
 */

class FakeRedis {
  readonly strings = new Map<string, number | undefined>(); // key → 显式 TTL 秒
  readonly zsets = new Map<string, Map<string, number>>();
  readonly expires: Array<{ key: string; ttl: number }> = [];
  readonly published: Array<{ channel: string; message: string }> = [];
  readonly subs: string[] = [];
  subscribeCalls = 0;
  /** 订阅**尝试**次数（含失败尝试；与 subscribeCalls 区分：失败时也证明"试过了"） */
  subscribeAttempts = 0;
  disconnected = false;
  /** 故障注入：命中一次后自清（op = 方法名） */
  failure: { op: string; error: Error } | null = null;
  private readonly handlers = new Map<string, Array<(...args: unknown[]) => void>>();

  private guard(op: string): void {
    if (this.failure && this.failure.op === op) {
      const err = this.failure.error;
      this.failure = null;
      throw err;
    }
  }

  async publish(channel: string, message: string): Promise<number> {
    this.guard('publish');
    this.published.push({ channel, message });
    return 1;
  }

  async zadd(key: string, score: number, member: string): Promise<number> {
    this.guard('zadd');
    const z = this.zsets.get(key) ?? new Map<string, number>();
    const added = z.has(member) ? 0 : 1;
    z.set(member, Number(score));
    this.zsets.set(key, z);
    return added;
  }

  async expire(key: string, ttl: number): Promise<number> {
    this.guard('expire');
    this.expires.push({ key, ttl });
    return 1;
  }

  async set(key: string, value: string, _ex?: string, ttl?: number): Promise<'OK'> {
    this.guard('set');
    this.strings.set(key, ttl);
    return 'OK';
  }

  async zrangebyscore(key: string, min: string, max: string, ...rest: string[]): Promise<string[]> {
    this.guard('zrangebyscore');
    const z = this.zsets.get(key);
    if (!z) return [];
    const exclusive = min.startsWith('(');
    const lo = exclusive ? Number(min.slice(1)) : Number(min);
    const hi = max === '+inf' ? Number.POSITIVE_INFINITY : Number(max);
    const rows = [...z.entries()]
      .filter(([, score]) => (exclusive ? score > lo : score >= lo) && score <= hi)
      .sort((a, b) => a[1] - b[1]);
    return rest.includes('WITHSCORES') ? rows.flatMap(([m, s]) => [m, String(s)]) : rows.map(([m]) => m);
  }

  async del(key: string): Promise<number> {
    this.guard('del');
    const a = this.zsets.delete(key);
    const b = this.strings.delete(key);
    return a || b ? 1 : 0;
  }

  async exists(key: string): Promise<number> {
    this.guard('exists');
    return this.strings.has(key) ? 1 : 0;
  }

  async subscribe(channel: string): Promise<number> {
    this.subscribeAttempts += 1;
    this.guard('subscribe');
    this.subscribeCalls += 1;
    this.subs.push(channel);
    return 1;
  }

  on(event: string, fn: (...args: unknown[]) => void): this {
    const list = this.handlers.get(event) ?? [];
    list.push(fn);
    this.handlers.set(event, list);
    return this;
  }

  emit(event: string, ...args: unknown[]): void {
    for (const fn of this.handlers.get(event) ?? []) fn(...args);
  }

  disconnect(): void { this.disconnected = true; }
}

function makeService() {
  const command = new FakeRedis();
  const subscriber = new FakeRedis();
  const svc = new SessionEventsService(command as never, subscriber as never);
  return { svc, command, subscriber };
}

describe('SessionEventsService：跨实例契约（A12 多进程 e2e 依赖）', () => {
  it('channel 名恒为 `session-events`（契约名，改动即破坏 A12 断言矩阵）', () => {
    expect(SESSION_EVENTS_CHANNEL).toBe('session-events');
  });

  it('发布载荷严格是契约字段（type/instanceId/at + 可选 sessionId/userId）；**绝不含任何 token**', async () => {
    const { svc, command } = makeService();
    await svc.publish({ type: 'session.revoked', sessionId: 's1', userId: 'u1' });

    expect(command.published).toHaveLength(1);
    expect(command.published[0].channel).toBe('session-events');
    const payload = JSON.parse(command.published[0].message) as SessionEvent;
    expect(Object.keys(payload).sort()).toEqual(['at', 'instanceId', 'sessionId', 'type', 'userId']);
    expect(payload.type).toBe('session.revoked');
    expect(payload.instanceId).toBe(svc.instanceId);
    expect(typeof payload.at).toBe('number');
    expect(payload.sessionId).toBe('s1');
    expect(payload.userId).toBe('u1');
    // 载荷里不可能出现凭证：连字符串值都只能是 id/类型
    for (const v of Object.values(payload)) {
      expect(['string', 'number']).toContain(typeof v);
    }
  });

  it('实例 id 各不相同（同进程双实例 e2e 也能区分发布者）', () => {
    expect(makeService().svc.instanceId).not.toBe(makeService().svc.instanceId);
  });

  it('发布后**本地立即生效**（不等 pub/sub 回环）', async () => {
    const { svc, command } = makeService();
    const seen: SessionEvent[] = [];
    svc.registerListener((e) => seen.push(e));
    await svc.publish({ type: 'user.sessions_revoked', userId: 'u1' });
    expect(seen).toHaveLength(1);
    expect(seen[0].userId).toBe('u1');
    expect(command.published).toHaveLength(1);
  });

  it('发布失败 → 降级：warn + 本实例仍生效（撤销正确性不依赖 Redis）', async () => {
    const { svc, command } = makeService();
    const seen: SessionEvent[] = [];
    svc.registerListener((e) => seen.push(e));
    command.failure = { op: 'publish', error: new Error('Redis 不可用') };

    await expect(svc.publish({ type: 'session.revoked', sessionId: 's1' })).resolves.toBeUndefined();
    expect(seen).toHaveLength(1); // 本地已生效
  });

  it('registerListener 返回注销函数；监听者异常不打断其他监听者', async () => {
    const { svc } = makeService();
    const good = vi.fn();
    const off = svc.registerListener(good);
    svc.registerListener(() => { throw new Error('bad listener'); });
    expect(svc.listenerCount()).toBe(2);

    await svc.publish({ type: 'session.revoked', sessionId: 's1' });
    expect(good).toHaveBeenCalledTimes(1);

    off();
    expect(svc.listenerCount()).toBe(1);
  });
});

describe('SessionEventsService：订阅生命周期', () => {
  it('onModuleInit 订阅契约 channel（订阅失败不抛错，不阻塞启动）', async () => {
    const { svc, subscriber } = makeService();
    subscriber.failure = { op: 'subscribe', error: new Error('Redis 未就绪') };
    expect(() => svc.onModuleInit()).not.toThrow();
    await new Promise((r) => setTimeout(r, 10));
    expect(subscriber.subscribeAttempts).toBeGreaterThanOrEqual(1); // 尝试过（失败被 warn 吞掉，不阻塞启动）
    // 恢复后 ready 事件触发重订阅并成功（自愈路径）
    subscriber.emit('ready');
    await new Promise((r) => setTimeout(r, 10));
    expect(subscriber.subscribeCalls).toBeGreaterThanOrEqual(1);
  });

  it('连接 ready 时自动重订阅（Redis 晚起也能自愈）', async () => {
    const { svc, subscriber } = makeService();
    svc.onModuleInit();
    await new Promise((r) => setTimeout(r, 10));
    const before = subscriber.subscribeCalls;
    subscriber.emit('ready'); // 模拟重连
    await new Promise((r) => setTimeout(r, 10));
    expect(subscriber.subscribeCalls).toBeGreaterThan(before);
  });

  it('isSubscribed 只在服务端确认订阅后为 true（e2e 就绪判定依赖它，不能用 NUMSUB——通道跨 DB 全局）', async () => {
    const { svc, subscriber } = makeService();
    expect(svc.isSubscribed()).toBe(false); // onModuleInit 之前绝不谎报就绪
    subscriber.failure = { op: 'subscribe', error: new Error('Redis 未就绪') };
    svc.onModuleInit();
    await new Promise((r) => setTimeout(r, 10));
    expect(svc.isSubscribed()).toBe(false); // 订阅失败 → 保持 false（迟到的事件确实会丢，必须如实反映）

    subscriber.failure = null;
    subscriber.emit('ready'); // 重连后自愈订阅
    await new Promise((r) => setTimeout(r, 10));
    expect(svc.isSubscribed()).toBe(true);
    // 重连（ready 再次触发）会先清标记再重订阅：标记始终反映"当前这条连接是否已订阅"
    subscriber.emit('ready');
    await new Promise((r) => setTimeout(r, 10));
    expect(svc.isSubscribed()).toBe(true);
  });

  it('收到本 channel 消息 → 分发给监听者；其他 channel 忽略；坏消息丢弃不中断循环', () => {
    const { svc, subscriber } = makeService();
    const seen: SessionEvent[] = [];
    svc.registerListener((e) => seen.push(e));
    svc.onModuleInit();

    subscriber.emit('message', 'other-channel', JSON.stringify({ type: 'session.revoked' }));
    subscriber.emit('message', SESSION_EVENTS_CHANNEL, 'not-json{{{');
    subscriber.emit('message', SESSION_EVENTS_CHANNEL, JSON.stringify({ noType: true }));
    expect(seen).toHaveLength(0);

    subscriber.emit('message', SESSION_EVENTS_CHANNEL, JSON.stringify({ type: 'user.disabled', instanceId: 'other', at: 1, userId: 'u9' }));
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ type: 'user.disabled', userId: 'u9' });
  });

  it('坏消息缺字段时补安全默认（instanceId=unknown / at=now），绝不因一条消息打断订阅', () => {
    const { svc, subscriber } = makeService();
    const seen: SessionEvent[] = [];
    svc.registerListener((e) => seen.push(e));
    svc.onModuleInit();

    subscriber.emit('message', SESSION_EVENTS_CHANNEL, JSON.stringify({ type: 'session.revoked' }));
    expect(seen[0].instanceId).toBe('unknown');
    expect(typeof seen[0].at).toBe('number');
    expect(seen[0].sessionId).toBeUndefined();
    expect(seen[0].userId).toBeUndefined();
  });

  it('onModuleDestroy 断开两条连接（不泄漏 Redis 连接）', () => {
    const { svc, command, subscriber } = makeService();
    svc.onModuleDestroy();
    expect(subscriber.disconnected).toBe(true);
    expect(command.disconnected).toBe(true);
  });
});

describe('SessionEventsService：jti 记账与黑名单（SA-4/X-20）', () => {
  it('trackJti：ZADD score = token 过期时刻（秒）+ 集合 TTL = 最晚过期 + 60s 余量', async () => {
    const { svc, command } = makeService();
    const exp = Math.floor(Date.now() / 1000) + 900;
    await svc.trackJti('u1', 'jti-1', exp);

    expect(command.zsets.get('auth:jti:u1')?.get('jti-1')).toBe(exp);
    expect(command.expires[0].key).toBe('auth:jti:u1');
    expect(command.expires[0].ttl).toBeGreaterThanOrEqual(955);
    expect(command.expires[0].ttl).toBeLessThanOrEqual(965);
  });

  it('trackJti 失败只 warn（记账丢失不影响会话撤销）', async () => {
    const { svc, command } = makeService();
    command.failure = { op: 'zadd', error: new Error('Redis 不可用') };
    await expect(svc.trackJti('u1', 'jti-1', Math.floor(Date.now() / 1000) + 60)).resolves.toBeUndefined();
  });

  it('blacklistJti：写 `auth:jti:blacklist:{jti}` 且 TTL = 剩余寿命（≤ 剩余寿命，绝不留更久墓碑）', async () => {
    const { svc, command } = makeService();
    await svc.blacklistJti('jti-1', 300);
    expect(command.strings.get('auth:jti:blacklist:jti-1')).toBe(300);
  });

  it('blacklistJti：TTL ≤ 0（token 已过期）→ 不写墓碑（墓碑没有意义）', async () => {
    const { svc, command } = makeService();
    await svc.blacklistJti('jti-1', 0);
    await svc.blacklistJti('jti-2', -5);
    await svc.blacklistJti('jti-3', Number.NaN);
    expect(command.strings.size).toBe(0);
  });

  it('blacklistAllUserJtis：**只**拉黑仍在有效期的 jti（过期 token 本就无效，无需墓碑）+ 清空记账集合', async () => {
    const { svc, command } = makeService();
    const now = Math.floor(Date.now() / 1000);
    await command.zadd('auth:jti:u1', now - 100, 'jti-expired');
    await command.zadd('auth:jti:u1', now + 120, 'jti-live-1');
    await command.zadd('auth:jti:u1', now + 600, 'jti-live-2');

    const count = await svc.blacklistAllUserJtis('u1');

    expect(count).toBe(2);
    expect(command.strings.has('auth:jti:blacklist:jti-expired')).toBe(false);
    expect(command.strings.has('auth:jti:blacklist:jti-live-1')).toBe(true);
    expect(command.strings.get('auth:jti:blacklist:jti-live-2')).toBeGreaterThan(500);
    expect(command.zsets.has('auth:jti:u1')).toBe(false); // 记账集合已清（避免重复拉黑）
  });

  it('blacklistAllUserJtis：从未签发过 → 0（不是错误）', async () => {
    const { svc } = makeService();
    expect(await svc.blacklistAllUserJtis('u-never')).toBe(0);
  });

  it('blacklistAllUserJtis：Redis 故障 → 返回 0 + warn（尽力而为，会话撤销仍生效）', async () => {
    const { svc, command } = makeService();
    command.failure = { op: 'zrangebyscore', error: new Error('Redis 不可用') };
    expect(await svc.blacklistAllUserJtis('u1')).toBe(0);
  });

  it('isJtiBlacklisted：墓碑存在 → true；不存在 → false', async () => {
    const { svc } = makeService();
    await svc.blacklistJti('jti-1', 60);
    expect(await svc.isJtiBlacklisted('jti-1')).toBe(true);
    expect(await svc.isJtiBlacklisted('jti-other')).toBe(false);
  });

  it('isJtiBlacklisted：Redis 故障 → **fail-open**（false）+ warn（权威判定在 DB 会话状态）', async () => {
    const { svc, command } = makeService();
    command.failure = { op: 'exists', error: new Error('Redis 不可用') };
    await expect(svc.isJtiBlacklisted('jti-1')).resolves.toBe(false);
  });
});
