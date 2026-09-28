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
  /** 命令台账（M11-P2：区分"直接命令"与"pipeline 内命令"——断言往返次数用） */
  readonly ops: Array<{ op: string; viaPipeline: boolean }> = [];
  /** pipeline exec 次数 = 该路径的 Redis 往返次数 */
  pipelineRuns = 0;
  private pipelineDepth = 0;
  private readonly handlers = new Map<string, Array<(...args: unknown[]) => void>>();

  /** ioredis pipeline 替身（M11-P2）：命令入队，exec() 时**逐条应用**——与真实 pipeline 的
   *  "非事务、可部分应用、逐条返回 [err, result]"语义一致（pipeline ≠ MULTI/EXEC）。 */
  pipeline(): FakePipeline { return new FakePipeline(this); }

  /** pipeline 内部执行时标记台账（供断言"这些命令走的是 pipeline"） */
  enterPipeline(): void { this.pipelineDepth += 1; }
  exitPipeline(): void { this.pipelineDepth -= 1; this.pipelineRuns += 1; }

  private log(op: string): void {
    this.ops.push({ op, viaPipeline: this.pipelineDepth > 0 });
  }

  private guard(op: string): void {
    if (this.failure && this.failure.op === op) {
      const err = this.failure.error;
      this.failure = null;
      throw err;
    }
  }

  async publish(channel: string, message: string): Promise<number> {
    this.guard('publish');
    this.log('publish');
    this.published.push({ channel, message });
    return 1;
  }

  async zadd(key: string, score: number, member: string): Promise<number> {
    this.guard('zadd');
    this.log('zadd');
    const z = this.zsets.get(key) ?? new Map<string, number>();
    const added = z.has(member) ? 0 : 1;
    z.set(member, Number(score));
    this.zsets.set(key, z);
    return added;
  }

  async expire(key: string, ttl: number): Promise<number> {
    this.guard('expire');
    this.log('expire');
    this.expires.push({ key, ttl });
    return 1;
  }

  async set(key: string, value: string, _ex?: string, ttl?: number): Promise<'OK'> {
    this.guard('set');
    this.log('set');
    this.strings.set(key, ttl);
    return 'OK';
  }

  async zrangebyscore(key: string, min: string, max: string, ...rest: string[]): Promise<string[]> {
    this.guard('zrangebyscore');
    this.log('zrangebyscore');
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

  /** M11-P2：按 score 区间删成员（ZREMRANGEBYSCORE） */
  async zremrangebyscore(key: string, min: string, max: string): Promise<number> {
    this.guard('zremrangebyscore');
    this.log('zremrangebyscore');
    const z = this.zsets.get(key);
    if (!z) return 0;
    const lo = min === '-inf' ? Number.NEGATIVE_INFINITY : min.startsWith('(') ? Number(min.slice(1)) : Number(min);
    const hi = max === '+inf' ? Number.POSITIVE_INFINITY : Number(max);
    let removed = 0;
    for (const [member, score] of [...z.entries()]) {
      if (score >= lo && score <= hi) { z.delete(member); removed += 1; }
    }
    return removed;
  }

  async del(key: string): Promise<number> {
    this.guard('del');
    this.log('del');
    const a = this.zsets.delete(key);
    const b = this.strings.delete(key);
    return a || b ? 1 : 0;
  }

  async exists(key: string): Promise<number> {
    this.guard('exists');
    this.log('exists');
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

/** pipeline 替身：顺序入队，exec() 逐条应用并返回 [err, result]（与 ioredis 语义一致） */
class FakePipeline {
  private readonly queue: Array<() => Promise<unknown>> = [];
  constructor(private readonly client: FakeRedis) {}

  zadd(key: string, score: number, member: string): this {
    this.queue.push(() => this.client.zadd(key, score, member));
    return this;
  }
  zremrangebyscore(key: string, min: string, max: string): this {
    this.queue.push(() => this.client.zremrangebyscore(key, min, max));
    return this;
  }
  expire(key: string, ttl: number): this {
    this.queue.push(() => this.client.expire(key, ttl));
    return this;
  }
  set(key: string, value: string, ex?: string, ttl?: number): this {
    this.queue.push(() => this.client.set(key, value, ex, ttl));
    return this;
  }
  del(key: string): this {
    this.queue.push(() => this.client.del(key));
    return this;
  }

  async exec(): Promise<Array<[Error | null, unknown]>> {
    const out: Array<[Error | null, unknown]> = [];
    this.client.enterPipeline();
    try {
      for (const run of this.queue) {
        try { out.push([null, await run()]); } catch (err) { out.push([err as Error, null]); }
      }
    } finally {
      this.client.exitPipeline();
    }
    return out;
  }
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

/**
 * M11-P2（D1-11）jti ZSET 治理：懒触发清理 + 批量写入。
 * M10 审计两条：① ZSET 成员无逐条过期（集合 key 的 TTL 被每次签发刷新 → 过期成员永久堆积）；
 * ② `blacklistAllUserJtis` 逐条 SET 串行（尾部延迟 = N×RTT）。
 */
describe('SessionEventsService：M11-P2 jti ZSET 治理（懒清理 + pipeline 批量）', () => {
  it('trackJti：ZADD 后顺手 ZREMRANGEBYSCORE 删掉已过期成员（集合规模 = 最近 ACCESS_TTL 内签发数）', async () => {
    const { svc, command } = makeService();
    const now = Math.floor(Date.now() / 1000);
    await command.zadd('auth:jti:u1', now - 5000, 'jti-ancient'); // 早已过期的历史成员（模拟无清理时的堆积）
    await command.zadd('auth:jti:u1', now - 10, 'jti-just-expired');

    await svc.trackJti('u1', 'jti-new', now + 900);

    const z = command.zsets.get('auth:jti:u1');
    expect(z?.has('jti-ancient')).toBe(false);      // 过期成员被清理
    expect(z?.has('jti-just-expired')).toBe(false); // 边界：score ≤ now 即过期
    expect(z?.get('jti-new')).toBe(now + 900);      // 本次签发保留
    expect(command.ops.some((o) => o.op === 'zremrangebyscore')).toBe(true);
  });

  it('trackJti：ZADD + 清理 + TTL 合并为**单次 pipeline**（3 条命令 1 个往返）', async () => {
    const { svc, command } = makeService();
    await svc.trackJti('u1', 'jti-1', Math.floor(Date.now() / 1000) + 900);

    expect(command.pipelineRuns).toBe(1);
    const direct = command.ops.filter((o) => !o.viaPipeline).map((o) => o.op);
    expect(direct).not.toContain('zadd');              // 三条命令都在 pipeline 里
    expect(direct).not.toContain('zremrangebyscore');
    expect(direct).not.toContain('expire');
    expect(command.ops.filter((o) => o.viaPipeline).map((o) => o.op)).toEqual(['zadd', 'zremrangebyscore', 'expire']);
    expect(command.expires[0].key).toBe('auth:jti:u1');
  });

  it('trackJti：pipeline 失败 → warn 且不抛（记账丢失只影响"登出全部"覆盖面，会话撤销不受影响）', async () => {
    const { svc, command } = makeService();
    command.failure = { op: 'zadd', error: new Error('Redis 不可用') };
    await expect(svc.trackJti('u1', 'jti-1', Math.floor(Date.now() / 1000) + 60)).resolves.toBeUndefined();
  });

  it('blacklistAllUserJtis：N 条墓碑改**单次 pipeline**（往返 2 次：zrange + pipeline，而不是 N+2 次串行）', async () => {
    const { svc, command } = makeService();
    const now = Math.floor(Date.now() / 1000);
    for (let i = 0; i < 25; i += 1) await command.zadd('auth:jti:u1', now + 100 + i, `jti-${i}`);
    command.ops.length = 0; // 只统计被测调用的命令台账

    const count = await svc.blacklistAllUserJtis('u1');

    expect(count).toBe(25);
    expect(command.pipelineRuns).toBe(1);
    // 直连命令只有 1 条（读集合）；25 条墓碑 + 清集合全部在同一次 pipeline 内
    expect(command.ops.filter((o) => !o.viaPipeline).map((o) => o.op)).toEqual(['zrangebyscore']);
    const pipelined = command.ops.filter((o) => o.viaPipeline).map((o) => o.op);
    expect(pipelined.filter((op) => op === 'set')).toHaveLength(25);
    expect(pipelined).toContain('del');
    // TTL 语义不变：每条墓碑 TTL = 该 token 剩余寿命
    expect(command.strings.get('auth:jti:blacklist:jti-0')).toBeGreaterThan(90);
    expect(command.strings.get('auth:jti:blacklist:jti-0')).toBeLessThanOrEqual(101);
  });

  it('blacklistAllUserJtis：pipeline 内**逐条**核对返回项——失败条目不计数（绝不乐观上报）', async () => {
    const { svc, command } = makeService();
    const now = Math.floor(Date.now() / 1000);
    await command.zadd('auth:jti:u1', now + 100, 'jti-a');
    await command.zadd('auth:jti:u1', now + 100, 'jti-b');
    await command.zadd('auth:jti:u1', now + 100, 'jti-c');
    command.failure = { op: 'set', error: new Error('单条命令失败（pipeline 非事务）') };

    const count = await svc.blacklistAllUserJtis('u1');

    expect(count).toBe(2); // 3 条中 1 条失败 → 只报 2（真实成功的条数）
    expect(command.strings.has('auth:jti:blacklist:jti-a')).toBe(false); // 失败那条确实没有墓碑
    expect(command.strings.has('auth:jti:blacklist:jti-b')).toBe(true);
    expect(command.strings.has('auth:jti:blacklist:jti-c')).toBe(true);
  });
});

/**
 * M11-P2（D1-01）：设备下线**原因标记**。
 * 只用于把"已拒绝"的 401 细化为 DEVICE_REVOKED —— 撤销权威恒在 DB `revokedAt`（见 AccessGuardService 注释）。
 */
describe('SessionEventsService：M11-P2 设备下线原因标记', () => {
  it('markDeviceRevoked：批量写 `auth:session:device-revoked:{sid}`，TTL = 传入的 token 上限寿命（单次 pipeline）', async () => {
    const { svc, command } = makeService();
    await svc.markDeviceRevoked(['s1', 's2'], 900);

    expect(command.pipelineRuns).toBe(1);
    expect(command.strings.get('auth:session:device-revoked:s1')).toBe(900);
    expect(command.strings.get('auth:session:device-revoked:s2')).toBe(900);
  });

  it('markDeviceRevoked：空集合/TTL ≤ 0 → 不发任何命令（无意义写入不发）', async () => {
    const { svc, command } = makeService();
    await svc.markDeviceRevoked([], 900);
    await svc.markDeviceRevoked(['s1'], 0);
    await svc.markDeviceRevoked(['s1'], Number.NaN);
    expect(command.pipelineRuns).toBe(0);
    expect(command.strings.size).toBe(0);
  });

  it('markDeviceRevoked 失败只 warn（撤销仍生效；随后 401 退化为通用文案）', async () => {
    const { svc, command } = makeService();
    command.failure = { op: 'set', error: new Error('Redis 不可用') };
    await expect(svc.markDeviceRevoked(['s1'], 900)).resolves.toBeUndefined();
  });

  it('isSessionDeviceRevoked：有标记 → true；无标记 → false（fail-open，只有文案受影响）', async () => {
    const { svc } = makeService();
    await svc.markDeviceRevoked(['s1'], 900);
    expect(await svc.isSessionDeviceRevoked('s1')).toBe(true);
    expect(await svc.isSessionDeviceRevoked('s-other')).toBe(false);
  });

  it('isSessionDeviceRevoked：Redis 故障 → false + warn（**绝不**因查不到原因而改变放行/拒绝结论）', async () => {
    const { svc, command } = makeService();
    command.failure = { op: 'exists', error: new Error('Redis 不可用') };
    await expect(svc.isSessionDeviceRevoked('s1')).resolves.toBe(false);
  });

  it('设备标记与 jti 面互不影响：标记不写任何 jti 键（撤销权威仍在 DB）', async () => {
    const { svc, command } = makeService();
    await svc.markDeviceRevoked(['s1'], 900);
    expect([...command.strings.keys()]).toEqual(['auth:session:device-revoked:s1']);
  });
});
