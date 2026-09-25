import { describe, it, expect } from 'vitest';
import {
  APPROVAL_BINDING_KEY, assertApprovalBinding, bindPayload, buildBinding, hashPayload, readBinding,
  requiresHumanApproval, stableStringify,
} from './approval-binding';

/**
 * Pre-M9 Approval Binding 单测（唯一 helper 的契约面）：
 * 稳定序列化（键序无关 / 数组保序）→ 摘要可复算；read/write 对称；执行前校验 fail-closed；
 * 统一审批 predicate 按权限分类（financial/destructive/external_action 全部需人工审批）。
 */
describe('Approval Binding（Pre-M9：审批绑定具体动作）', () => {
  it('stableStringify：对象键排序（键序无关）、数组保序、undefined 剔除、Date/非有限数归一', () => {
    expect(stableStringify({ b: 2, a: 1 })).toBe('{"a":1,"b":2}');
    expect(stableStringify({ z: 1, a: undefined })).toBe('{"z":1}');
    expect(stableStringify([2, 1])).toBe('[2,1]');           // 数组顺序有语义：绝不排序
    expect(stableStringify(new Date('2026-01-02T03:04:05.000Z'))).toBe('"2026-01-02T03:04:05.000Z"');
    expect(stableStringify(Number.NaN)).toBe('null');
    expect(stableStringify(undefined)).toBe('null');
  });

  it('hashPayload：键序无关（稳定序列化的核心保证）；键/值/数组顺序任一实质变化 → 摘要变化', () => {
    const a = hashPayload({ title: '主图', amount: 100, meta: { b: 1, a: 2 } });
    const b = hashPayload({ meta: { a: 2, b: 1 }, amount: 100, title: '主图' });
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(hashPayload({ amount: 100, title: '主图', meta: { b: 1, a: 2 }, extra: true })).not.toBe(a);
    expect(hashPayload({ title: '主图', amount: 101, meta: { b: 1, a: 2 } })).not.toBe(a);
    expect(hashPayload({ title: '主图', amount: 100, meta: { b: 2, a: 1 } })).not.toBe(a);
  });

  it('bindPayload：返回新对象（绝不修改入参）并把绑定嵌进 payload（readBinding 可复读）', () => {
    const original = { toolName: 'external_action.execute', input: { title: 'x' } };
    const bound = bindPayload(original, 'external_action.execute', { title: 'x' }, new Date('2026-01-02T03:04:05.000Z'));
    expect(original).not.toHaveProperty(APPROVAL_BINDING_KEY);      // 入参未被污染
    expect(bound.toolName).toBe('external_action.execute');          // 业务字段保留
    const binding = readBinding(bound);
    expect(binding).toEqual({
      actionType: 'external_action.execute',
      payloadHash: hashPayload({ title: 'x' }),
      boundAt: '2026-01-02T03:04:05.000Z',
    });
  });

  it('readBinding：缺失/结构非法/空值一律 null（由 assertApprovalBinding 统一拒绝）', () => {
    expect(readBinding(null)).toBeNull();
    expect(readBinding({})).toBeNull();
    expect(readBinding({ [APPROVAL_BINDING_KEY]: {} })).toBeNull();
    expect(readBinding({ [APPROVAL_BINDING_KEY]: { actionType: '', payloadHash: 'h' } })).toBeNull();
    expect(readBinding({ [APPROVAL_BINDING_KEY]: { actionType: 'a', payloadHash: '' } })).toBeNull();
    expect(readBinding(buildBinding('a', {}))).toBeNull(); // 绑定字段不在顶层 = 未绑定
  });

  it('assertApprovalBinding：一致放行；未绑定（旧审批）/actionType 不一致/载荷摘要不一致 → APPROVAL_BINDING_MISMATCH', () => {
    const action = { amount: 100 };
    const ok = { payload: bindPayload({}, 'shop.publish', action), actionType: 'shop.publish', action };
    expect(() => assertApprovalBinding(ok)).not.toThrow();
    // 键序不同但语义相同的动作 → 摘要一致，仍放行（稳定序列化的意义）
    expect(() => assertApprovalBinding({ ...ok, action: { amount: 100 } })).not.toThrow();

    const cases: Array<{ payload: unknown; actionType: string; action: unknown }> = [
      { payload: { toolName: 'x', input: action }, actionType: 'x', action },        // 升级前的旧审批：无 __binding
      { payload: bindPayload({}, 'shop.publish', action), actionType: 'shop.delete', action }, // 跨动作解锁
      { payload: bindPayload({}, 'shop.publish', action), actionType: 'shop.publish', action: { amount: 999 } }, // 执行时换载荷
    ];
    for (const c of cases) {
      let thrown: { code?: string; message?: string } | undefined;
      try {
        assertApprovalBinding(c);
      } catch (err) {
        thrown = err as { code?: string; message?: string };
      }
      expect(thrown).toBeTruthy();
      expect(thrown!.code).toBe('APPROVAL_BINDING_MISMATCH');
      expect(thrown!.message).toMatch(/审批未绑定具体动作|绑定的动作类型不一致|绑定的载荷摘要不一致/);
    }
  });

  it('requiresHumanApproval：external_action/financial/destructive 一律需人工审批（统一 predicate，不再只看单一权限）', () => {
    for (const permission of ['external_action', 'financial', 'destructive']) {
      expect(requiresHumanApproval({ permission })).toBe(true);
    }
    for (const permission of ['read', 'write', 'generate', undefined, null, 'unknown']) {
      expect(requiresHumanApproval({ permission })).toBe(false);
    }
    expect(requiresHumanApproval({ permission: 'read', requiresApproval: true })).toBe(true); // 工具自带标记仍然生效
  });
});
