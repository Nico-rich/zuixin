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

  // ===== Pre-M9 G1：TTL 自动半开 / probe 自愈 =====

  it('G1 openedAt 带 TTL（非永久键），且冷却到期 → half_open', async () => {
    for (let i = 0; i < 5; i++) await cb.recordFailure('p1', { cooldownSec: 30 });
    const opened = kv.store.get('cb:p1:openedAt')!;
    expect(opened).toBeTruthy();
    expect(opened.expireAt).toBeGreaterThan(kv.now + 30_000); // TTL > 冷却期（冷却判定期间标记必可读）
    expect(opened.expireAt).toBeLessThanOrEqual(kv.now + (30_000 + 600_000) + 3_000); // 冷却 + 观察窗，绝不永久驻留
    kv.now = 31_000;
    expect(await cb.state('p1', { cooldownSec: 30 })).toBe('half_open');
    expect(await cb.canCall('p1', { cooldownSec: 30 })).toBe(false);        // 非探测被拒
    expect(await cb.canCall('p1', { cooldownSec: 30 }, true)).toBe(true);   // 探测放行
    kv.now = 31_000 + 601_000;
    expect(await cb.state('p1', { cooldownSec: 30 })).toBe('healthy');      // TTL 过期 → 自然自愈，不永久排除
  });

  it('G1 半开探测失败 → 重新 open（冷却重计时），不再放行普通调用', async () => {
    for (let i = 0; i < 5; i++) await cb.recordFailure('p1', { cooldownSec: 30 });
    kv.now = 31_000;
    expect(await cb.state('p1', { cooldownSec: 30 })).toBe('half_open');
    expect(await cb.recordFailure('p1', { cooldownSec: 30 })).toBe(true);   // 探测失败 → 重新熔断
    expect(await cb.state('p1', { cooldownSec: 30 })).toBe('open');         // 冷却从此刻重计时
    expect(await cb.canCall('p1', { cooldownSec: 30 }, true)).toBe(false);
    kv.now = 31_000 + 29_000;
    expect(await cb.state('p1', { cooldownSec: 30 })).toBe('open');
    kv.now = 31_000 + 31_000;
    expect(await cb.state('p1', { cooldownSec: 30 })).toBe('half_open');    // 再次自动半开
  });

  it('G1 半开探测成功 → healthy 复位（清除标记与探测槽）', async () => {
    for (let i = 0; i < 5; i++) await cb.recordFailure('p1', { cooldownSec: 30 });
    kv.now = 31_000;
    expect(await cb.canProbe('p1', { cooldownSec: 30 })).toBe(true);        // 抢占探测槽
    await cb.recordSuccess('p1');
    expect(await cb.state('p1', { cooldownSec: 30 })).toBe('healthy');
    expect(kv.store.has('cb:p1:openedAt')).toBe(false);
    expect(kv.store.has('cb:p1:probe')).toBe(false);                        // 探测槽释放
    expect(await cb.canProbe('p1', { cooldownSec: 30 })).toBe(true);
  });

  it('G1 半开探测槽单飞：同一冷却窗只有第一个探测被放行', async () => {
    for (let i = 0; i < 5; i++) await cb.recordFailure('p1', { cooldownSec: 30 });
    kv.now = 31_000;
    expect(await cb.canProbe('p1', { cooldownSec: 30 })).toBe(true);
    expect(await cb.canProbe('p1', { cooldownSec: 30 })).toBe(false);       // 在途探测未结束 → 不再放行
    expect(await cb.state('p1', { cooldownSec: 30 })).toBe('half_open');    // 状态仍是半开（等探测结果）
  });

  it('G1 canProbe：healthy 恒放行、open 恒拒绝（无副作用）', async () => {
    expect(await cb.canProbe('p2')).toBe(true);
    expect(kv.store.has('cb:p2:probe')).toBe(false);                        // healthy 不占槽
    for (let i = 0; i < 5; i++) await cb.recordFailure('p2');
    expect(await cb.canProbe('p2')).toBe(false);
    expect(await cb.canCall('p2', {}, true)).toBe(false);
  });
});
