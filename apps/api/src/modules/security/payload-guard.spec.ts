import { describe, it, expect } from 'vitest';
import { WEBHOOK_LIMITS, checkJsonComplexity, isPlainPayload } from './payload-guard';

describe('payload-guard / isPlainPayload', () => {
  it('只接受普通对象（数组/标量/null 拒绝）', () => {
    expect(isPlainPayload({})).toBe(true);
    expect(isPlainPayload({ a: 1 })).toBe(true);
    expect(isPlainPayload([])).toBe(false);
    expect(isPlainPayload([{ a: 1 }])).toBe(false);
    expect(isPlainPayload('{"a":1}')).toBe(false);
    expect(isPlainPayload(1)).toBe(false);
    expect(isPlainPayload(null)).toBe(false);
    expect(isPlainPayload(undefined)).toBe(false);
  });
});

describe('payload-guard / checkJsonComplexity', () => {
  it('正常载荷通过', () => {
    expect(checkJsonComplexity({ orderId: 'x', items: [{ sku: 'a', qty: 2 }], note: null }).ok).toBe(true);
  });

  it('深嵌套（JSON bomb 变体）拒绝', () => {
    let deep: Record<string, unknown> = { end: true };
    for (let i = 0; i < 30; i++) deep = { child: deep };
    const r = checkJsonComplexity(deep, WEBHOOK_LIMITS);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/嵌套/);
  });

  it('键总数超限拒绝', () => {
    const wide: Record<string, unknown> = {};
    for (let i = 0; i < WEBHOOK_LIMITS.maxKeys + 10; i++) wide[`k${i}`] = i;
    expect(checkJsonComplexity(wide).ok).toBe(false);
  });

  it('超长数组拒绝', () => {
    const arr = { items: new Array(WEBHOOK_LIMITS.maxArrayLength + 1).fill(1) };
    expect(checkJsonComplexity(arr).ok).toBe(false);
  });

  it('超长字符串拒绝', () => {
    expect(checkJsonComplexity({ note: 'x'.repeat(WEBHOOK_LIMITS.maxStringLength + 1) }).ok).toBe(false);
    expect(checkJsonComplexity({ note: 'x'.repeat(1000) }).ok).toBe(true);
  });

  it('非 JSON 值（函数/符号/类实例）拒绝', () => {
    expect(checkJsonComplexity({ fn: () => 1 }).ok).toBe(false);
    expect(checkJsonComplexity({ d: new Date() }).ok).toBe(false);
    expect(checkJsonComplexity({ sym: Symbol('x') }).ok).toBe(false);
  });

  it('边界内载荷照常放行（不误伤正常业务）', () => {
    const ok = { a: { b: { c: { d: 1 } } }, list: new Array(10).fill({ n: 'x' }) };
    expect(checkJsonComplexity(ok).ok).toBe(true);
  });
});
