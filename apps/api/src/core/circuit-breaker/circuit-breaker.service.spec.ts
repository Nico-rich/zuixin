import { describe, it, expect, beforeEach } from 'vitest';
import { CircuitBreakerService } from './circuit-breaker.service';
import { KVStore } from './kv-store.interface';

class FakeKV implements KVStore {
  store = new Map<string, { v: string; expireAt: number }>();
  now = 0;
  async incr(key: string) { const cur = this.store.get(key); const n = (cur ? Number(cur.v) : 0) + 1; this.store.set(key, { v: String(n), expireAt: this.now + 60_000 }); return n; }
  async get(key: string) { const e = this.store.get(key); return e && e.expireAt > this.now ? e.v : null; }
  async set(key: string, value: string, ttlSec?: number) {
    if (value === '') this.store.delete(key);
    else this.store.set(key, { v: value, expireAt: ttlSec ? this.now + ttlSec * 1000 : Number.POSITIVE_INFINITY });
  }
  async setNX(key: string, value: string, ttlSec: number) {
    if (this.store.get(key)) return false;
    await this.set(key, value, ttlSec);
    return true;
  }
  async del(key: string) { this.store.delete(key); }
}

describe('CircuitBreakerService', () => {
  let kv: FakeKV; let cb: CircuitBreakerService;
  beforeEach(() => { kv = new FakeKV(); cb = new CircuitBreakerService(kv, () => kv.now); });

  it('连续 5 次失败 → open，拒绝调用', async () => {
    for (let i = 0; i < 4; i++) { expect(await cb.recordFailure('p1')).toBe(false); }
    expect(await cb.recordFailure('p1')).toBe(true); // 第 5 次触发
    expect(await cb.state('p1')).toBe('open');
    expect(await cb.canCall('p1')).toBe(false);
  });

  it('冷却期后 half_open，仅探测放行', async () => {
    for (let i = 0; i < 5; i++) await cb.recordFailure('p1');
    kv.now = 61_000; // 60s 冷却过去
    expect(await cb.state('p1')).toBe('half_open');
    expect(await cb.canCall('p1')).toBe(false);
    expect(await cb.canCall('p1', {}, true)).toBe(true); // 探测请求放行
  });

  it('探测成功 → healthy', async () => {
    for (let i = 0; i < 5; i++) await cb.recordFailure('p1');
    kv.now = 61_000;
    await cb.recordSuccess('p1');
    expect(await cb.state('p1')).toBe('healthy');
  });

  it('成功重置连续失败计数', async () => {
    for (let i = 0; i < 3; i++) await cb.recordFailure('p1');
    await cb.recordSuccess('p1');
    expect(await cb.recordFailure('p1')).toBe(false);
    expect(await cb.recordFailure('p1')).toBe(false);
    expect(await cb.recordFailure('p1')).toBe(false);
    expect(await cb.recordFailure('p1')).toBe(false); // 累计第 4 次
    expect(await cb.recordFailure('p1')).toBe(true);  // 第 5 次触发
  });
});
