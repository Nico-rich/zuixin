import { describe, it, expect, vi, afterEach } from 'vitest';
import type Redis from 'ioredis';
import {
  RedisTimeoutError, boundedRedisOptions, isRedisTimeoutError, redisCallDeadlineMs, redisCommandTimeoutMs, withDeadline,
} from './redis-resilience';
import { RedisKVService } from '../circuit-breaker/redis-kv.service';

afterEach(() => { vi.useRealTimers(); });

/** 挂起客户端：命令 Promise 永不 settle（模拟 Redis 半开/离线队列滞留） */
function hangClient() {
  const never = () => new Promise<never>(() => undefined);
  return {
    get: vi.fn(never), set: vi.fn(never), incr: vi.fn(never), expire: vi.fn(never), del: vi.fn(never),
    disconnect: vi.fn(),
  };
}

/** 正常客户端（记录调用，按预设返回） */
function okClient(overrides: Record<string, unknown> = {}) {
  return {
    get: vi.fn().mockResolvedValue('0'), set: vi.fn().mockResolvedValue('OK'),
    incr: vi.fn().mockResolvedValue(1), expire: vi.fn().mockResolvedValue(1),
    del: vi.fn().mockResolvedValue(1), disconnect: vi.fn(), ...overrides,
  };
}

describe('Pre-M9 G4：Redis 韧性基线（命令超时 + 有界重试 + 显式失败）', () => {
  it('withDeadline：正常完成透传结果（不改变语义）', async () => {
    await expect(withDeadline(Promise.resolve(42), 50, 'unit')).resolves.toBe(42);
    await expect(withDeadline(Promise.reject(new Error('boom')), 50, 'unit')).rejects.toThrow('boom');
  });

  it('withDeadline：永不 settle 的 Promise → RedisTimeoutError（含 label/超时值），绝不无限挂起', async () => {
    vi.useFakeTimers();
    const p = withDeadline(new Promise<never>(() => undefined), 1_000, 'kv:get');
    const assertion = expect(p).rejects.toBeInstanceOf(RedisTimeoutError);
    await vi.advanceTimersByTimeAsync(1_100);
    await assertion;
    // 显式断言错误载荷（label / 超时值）——降级日志据此可区分"超时"与"业务错误"
    const second = withDeadline(new Promise<never>(() => undefined), 1_000, 'kv:set').catch((e) => e as RedisTimeoutError);
    await vi.advanceTimersByTimeAsync(1_100);
    const err = await second;
    expect(err.label).toBe('kv:set');
    expect(err.timeoutMs).toBe(1_000);
    expect(err.message).toContain('kv:set');
  });

  it('withDeadline：超时后原 Promise 的拒绝仍被消费（不产生 unhandled rejection）', async () => {
    vi.useFakeTimers();
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    let rejectLater!: (e: Error) => void;
    const late = new Promise<never>((_, rej) => { rejectLater = rej; });
    const race = withDeadline(late, 10, 'kv:late');
    const assertion = expect(race).rejects.toBeInstanceOf(RedisTimeoutError);
    await vi.advanceTimersByTimeAsync(20);
    await assertion;
    rejectLater(new Error('after timeout'));
    await vi.advanceTimersByTimeAsync(0);
    process.off('unhandledRejection', unhandled);
    expect(unhandled).not.toHaveBeenCalled();
  });

  it('isRedisTimeoutError：识别自身与 ioredis 的 commandTimeout 文案，普通错误不误判', () => {
    expect(isRedisTimeoutError(new RedisTimeoutError('kv:get', 1000))).toBe(true);
    expect(isRedisTimeoutError(new Error('Command timed out'))).toBe(true);
    expect(isRedisTimeoutError(new Error('Connection is closed.'))).toBe(false);
    expect(isRedisTimeoutError(new Error('WRONGTYPE'))).toBe(false);
  });

  it('boundedRedisOptions：命令超时 + 建连超时 + 有界重试 + 有界退避（env 可覆盖）', () => {
    const opts = boundedRedisOptions();
    expect(opts.commandTimeout).toBe(redisCommandTimeoutMs());
    expect(typeof opts.connectTimeout).toBe('number');
    expect(typeof opts.maxRetriesPerRequest).toBe('number'); // 绝非 null（那是"无限重试"）
    const retry = opts.retryStrategy as (n: number) => number;
    expect(retry(1)).toBeLessThanOrEqual(2_000);
    expect(retry(100)).toBeLessThanOrEqual(2_000); // 退避有上界
    expect(boundedRedisOptions({ maxRetriesPerRequest: 1 }).maxRetriesPerRequest).toBe(1); // 显式覆盖优先
  });

  it('RedisKVService：命令挂起 → 各方法显式抛 RedisTimeoutError（登录锁/chat 锁不再挂住）', async () => {
    vi.useFakeTimers();
    const kv = new RedisKVService(hangClient() as unknown as Redis);
    // 逐个发起（每个都要先挂上断言再推进定时器；否则未挂 handler 的拒绝会成 unhandled rejection）
    const calls: Array<() => Promise<unknown>> = [
      () => kv.get('k'), () => kv.set('k', 'v'), () => kv.set('k', 'v', 10),
      () => kv.setNX('k', 'v', 10), () => kv.incr('k', 10), () => kv.del('k'),
    ];
    for (const call of calls) {
      const assertion = expect(call()).rejects.toBeInstanceOf(RedisTimeoutError);
      await vi.advanceTimersByTimeAsync(redisCallDeadlineMs() + 50);
      await assertion;
    }
  });

  it('RedisKVService：正常路径语义不变（setNX 布尔、incr 首次设 TTL、del 透传）', async () => {
    const client = okClient();
    const kv = new RedisKVService(client as unknown as Redis);
    await kv.set('k', 'v', 30);
    expect(client.set).toHaveBeenCalledWith('k', 'v', 'EX', 30);
    await kv.setNX('lock', 'req', 120);
    expect(client.set).toHaveBeenCalledWith('lock', 'req', 'EX', 120, 'NX');
    expect(await kv.incr('c', 60)).toBe(1);
    expect(client.expire).toHaveBeenCalledWith('c', 60); // 首次计数才设 TTL
    expect(await kv.get('c')).toBe('0');
    await kv.del('c');
    expect(client.del).toHaveBeenCalledWith('c');
  });

  it('RedisKVService：非超时错误原样抛出（不吞、不伪装成超时）', async () => {
    const client = okClient({ get: vi.fn().mockRejectedValue(new Error('WRONGTYPE')) });
    const kv = new RedisKVService(client as unknown as Redis);
    await expect(kv.get('k')).rejects.toThrow('WRONGTYPE');
  });
});
