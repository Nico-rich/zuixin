import { describe, it, expect } from 'vitest';
import { ModelRouterService, ModelCandidate } from './model-router.service';
import { CircuitBreakerService } from '../circuit-breaker/circuit-breaker.service';
import { KVStore } from '../circuit-breaker/kv-store.interface';

const kv: KVStore = {
  incr: async () => 1, get: async () => null,
  set: async () => undefined,
  setNX: async () => true, del: async () => undefined,
};
const cb = new CircuitBreakerService(kv, () => 0);
const noSleep = async () => undefined;

const candidates: ModelCandidate[] = [
  { modelId: 'm-cheap', providerId: 'p1', priority: 200, cost: 0.01, latencyMs: 500 },
  { modelId: 'm-fast', providerId: 'p2', priority: 100, cost: 0.05, latencyMs: 100 },
  { modelId: 'm-best', providerId: 'p3', priority: 50, cost: 0.1, latencyMs: 300 },
];

describe('ModelRouterService', () => {
  it('候选按 priority 升序', async () => {
    const r = new ModelRouterService(cb, noSleep);
    const ordered = await r.order(candidates);
    expect(ordered.map((c) => c.modelId)).toEqual(['m-best', 'm-fast', 'm-cheap']);
  });

  it('execute 依次回退：p3 失败(可重试) → p2 成功', async () => {
    const r = new ModelRouterService(cb, noSleep);
    const calls: string[] = [];
    const { result, usedModel, fallbacks } = await r.execute(candidates, async (c) => {
      calls.push(c.modelId);
      if (c.modelId === 'm-best') { const e = new Error('x') as Error & { status?: number }; e.status = 429; throw e; }
      return `ok-${c.modelId}`;
    });
    expect(result).toBe('ok-m-fast');
    expect(usedModel.modelId).toBe('m-fast');
    expect(fallbacks.map((c) => c.modelId)).toEqual(['m-best']);
    expect(calls).toEqual(['m-best', 'm-fast']);
  });

  it('不可重试错误不触发回退，直接抛出', async () => {
    const r = new ModelRouterService(cb, noSleep);
    const e = new Error('bad') as Error & { status?: number }; e.status = 401;
    await expect(r.execute(candidates, async () => { throw e; })).rejects.toMatchObject({ code: 'PROVIDER_AUTH' });
  });

  it('全部失败 → 聚合错误', async () => {
    const r = new ModelRouterService(cb, noSleep);
    await expect(r.execute(candidates, async () => { throw new Error('down'); }))
      .rejects.toMatchObject({ code: 'PROVIDER_UNKNOWN' });
  });
});
