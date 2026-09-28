import { describe, it, expect } from 'vitest';
import {
  WorkflowContext, compensationTargetIds, effectiveMaxRetries, evaluateCondition, getPath,
  isCompensationTarget, isRetryableStepError, lockedDefinition, renderTemplate, validateDefinition,
} from './workflow-types';

const ctx: WorkflowContext = {
  input: { product: '主图', budget: 100 },
  steps: {
    analyze: { status: 'completed', output: { facts: { orders: 200, revenue: 25800 } } },
  },
};

describe('Workflow 求值原语（M7-P6 确定性、无 eval）', () => {
  it('getPath：安全路径取值；非法路径/越界返回 undefined（绝不抛错）', () => {
    expect(getPath(ctx, 'input.product')).toBe('主图');
    expect(getPath(ctx, 'steps.analyze.output.facts.orders')).toBe(200);
    expect(getPath(ctx, 'steps.missing.output.x')).toBeUndefined();
    expect(getPath(ctx, 'input.product.__proto__')).toBeUndefined();
  });

  it('evaluateCondition：eq/gt/contains/exists + then/else 跳转', () => {
    expect(evaluateCondition(
      { field: 'steps.analyze.output.facts.orders', op: 'gt', value: 100, then: 'brief' }, ctx, 'next',
    )).toMatchObject({ target: 'brief', hit: true, actual: 200 });
    expect(evaluateCondition(
      { field: 'steps.analyze.output.facts.orders', op: 'lt', value: 100, then: 'a', else: 'notify' }, ctx, 'next',
    )).toMatchObject({ target: 'notify', hit: false });
    expect(evaluateCondition(
      { field: 'input.product', op: 'contains', value: '主图', then: 'x' }, ctx, null,
    )).toMatchObject({ target: 'x', hit: true });
    expect(evaluateCondition(
      { field: 'input.missing', op: 'exists', then: 'x', else: 'y' }, ctx, null,
    )).toMatchObject({ target: 'y', hit: false });
    // 缺省 else → 顺序下一步
    expect(evaluateCondition(
      { field: 'input.missing', op: 'exists', then: 'x' }, ctx, 'next-id',
    )).toMatchObject({ target: 'next-id' });
  });

  it('renderTemplate：{{input.x}} / {{steps.<id>.output.y}} 替换；缺值空串；对象值 JSON 化', () => {
    expect(renderTemplate('给 {{input.product}} 做 {{steps.analyze.output.facts.orders}} 单', ctx)).toBe('给 主图 做 200 单');
    expect(renderTemplate('缺值 [{{input.nope}}]', ctx)).toBe('缺值 []');
    expect(renderTemplate('{{steps.analyze.output.facts}}', ctx)).toBe('{"orders":200,"revenue":25800}');
  });

  it('validateDefinition：跳转目标不存在/重复 id/缺步骤 → 明确错误', () => {
    expect(validateDefinition({ triggers: [], steps: [] })).toContain('至少一个步骤');
    expect(validateDefinition({
      triggers: [], steps: [
        { id: 'a', type: 'condition', condition: { field: 'input.x', op: 'eq', value: 1, then: 'ghost' } },
      ],
    })).toContain('跳转目标不存在');
    expect(validateDefinition({
      triggers: [], steps: [{ id: 'a', type: 'output' }, { id: 'a', type: 'output' }],
    })).toContain('重复');
    expect(validateDefinition({
      triggers: [], steps: [{ id: 'a', type: 'external_action' }],
    })).toContain('actionType');
    expect(validateDefinition({
      triggers: [], steps: [
        { id: 'a', type: 'condition', condition: { field: 'input.x', op: 'eq', then: 'b' } },
        { id: 'b', type: 'output' },
      ],
    })).toBeNull();
  });
});

/** M9-P4 定义校验增量：wait / timeoutMs / retryPolicy / compensate */
describe('Workflow 定义校验（M9-P4 增量）', () => {
  it('wait：三选一 + 类型存在 + 取值范围（缺条件/多条件/越界/非法 ISO 一律拒绝）', () => {
    const withWait = (wait: unknown) => validateDefinition({
      triggers: [], steps: [{ id: 'w', type: 'wait', wait: wait as never }],
    });
    expect(withWait({ untilMs: 1000 })).toBeNull();
    expect(withWait({ untilIso: new Date(Date.now() + 60_000).toISOString() })).toBeNull();
    expect(withWait({ childRunId: '{{input.childRunId}}' })).toBeNull();
    expect(withWait(undefined)).toContain('缺少 wait 条件定义');
    expect(withWait({})).toContain('缺少等待条件');
    expect(withWait({ untilMs: 1, untilIso: '2030-01-01T00:00:00Z' })).toContain('三选一');
    expect(withWait({ untilMs: -1 })).toContain('untilMs 非法');
    expect(withWait({ untilMs: 8 * 86400_000 })).toContain('untilMs 非法');
    expect(withWait({ untilIso: 'tomorrow' })).toContain('untilIso 非法');
  });

  it('compensate：目标必须存在且类型收敛为 tool/external_action，且不可自补偿', () => {
    expect(validateDefinition({
      triggers: [], steps: [
        { id: 'a', type: 'tool', tool: { name: 'read.a', arguments: {} }, compensate: 'undo' },
        { id: 'undo', type: 'tool', tool: { name: 'undo.a', arguments: {} } },
      ],
    })).toBeNull();
    expect(validateDefinition({
      triggers: [], steps: [
        { id: 'a', type: 'tool', tool: { name: 'read.a', arguments: {} }, compensate: 'ghost' },
      ],
    })).toContain('补偿目标不存在');
    expect(validateDefinition({
      triggers: [], steps: [{ id: 'a', type: 'tool', tool: { name: 'read.a', arguments: {} }, compensate: 'a' }],
    })).toContain('不可补偿自身');
    expect(validateDefinition({
      triggers: [], steps: [
        { id: 'a', type: 'tool', tool: { name: 'read.a', arguments: {} }, compensate: 'out' },
        { id: 'out', type: 'output', output: {} },
      ],
    })).toContain('类型不支持');
  });

  it('timeoutMs / retryPolicy：范围校验 + retryableCodes 只能是平台瞬态码', () => {
    const one = (over: Record<string, unknown>) => validateDefinition({
      triggers: [], steps: [{ id: 'a', type: 'tool', tool: { name: 'read.a', arguments: {} }, ...over }],
    });
    expect(one({ timeoutMs: 500 })).toBeNull();
    expect(one({ timeoutMs: 50 })).toContain('timeoutMs 非法');
    expect(one({ retryPolicy: { maxRetries: 2 } })).toBeNull();
    expect(one({ retryPolicy: { maxRetries: 2, retryableCodes: ['PROVIDER_TIMEOUT'] } })).toBeNull();
    expect(one({ retryPolicy: { maxRetries: -1 } })).toContain('maxRetries 非法');
    expect(one({ retryPolicy: { maxRetries: 1, retryableCodes: ['VALIDATION_ERROR'] } })).toContain('非瞬态码');
  });

  it('isCompensationTarget/compensationTargetIds：只认被引用的补偿步骤', () => {
    const steps = [
      { id: 'a', type: 'tool' as const, compensate: 'undo_a' },
      { id: 'undo_a', type: 'tool' as const },
      { id: 'x', type: 'output' as const },
    ];
    expect(isCompensationTarget(steps, 'undo_a')).toBe(true);
    expect(isCompensationTarget(steps, 'x')).toBe(false);
    expect([...compensationTargetIds(steps)]).toEqual(['undo_a']);
  });

  it('effectiveMaxRetries/isRetryableStepError：maxAttempts 与 retryPolicy 取并集（既有语义绝不收窄）', () => {
    expect(effectiveMaxRetries({ id: 'a', type: 'tool', maxAttempts: 3 })).toBe(3);
    expect(effectiveMaxRetries({ id: 'a', type: 'tool', retryPolicy: { maxRetries: 2 } })).toBe(2);
    expect(effectiveMaxRetries({ id: 'a', type: 'tool', maxAttempts: 1, retryPolicy: { maxRetries: 4 } })).toBe(4);
    expect(effectiveMaxRetries({ id: 'a', type: 'tool' })).toBe(0);
    // 缺省 = 平台瞬态码全集；声明后按声明收窄
    expect(isRetryableStepError({ id: 'a', type: 'tool' }, 'PROVIDER_TIMEOUT')).toBe(true);
    expect(isRetryableStepError({ id: 'a', type: 'tool' }, 'VALIDATION_ERROR')).toBe(false);
    expect(isRetryableStepError({ id: 'a', type: 'tool', retryPolicy: { maxRetries: 1, retryableCodes: ['PROVIDER_RATE_LIMITED'] } }, 'PROVIDER_TIMEOUT')).toBe(false);
  });

  it('lockedDefinition：版本行/定义为空 → 拒绝执行（版本锁定不变量被破坏时不静默降级）', () => {
    expect(lockedDefinition({ definition: { triggers: [], steps: [{ id: 'a', type: 'output' }] } }).steps).toHaveLength(1);
    expect(() => lockedDefinition(null)).toThrowError(/版本锁定/);
    expect(() => lockedDefinition({ definition: null })).toThrowError(/版本锁定/);
  });

  /**
   * M10-P5 D4/M9-01：run 级 `definitionSnapshot` —— 执行期**快照优先**。
   * 语义边界：快照存在且合法 → 一律按快照（版本行被改写/修复/迁移都不影响在跑 run）；
   * 快照缺失（历史 run）→ 回退锁定版本行；快照非法 → **拒绝执行**（绝不在锁定可疑时静默换一份定义）。
   */
  it('lockedDefinition（M10-P5）：快照优先于版本行；null 回退版本行；非法快照 → 拒绝执行', () => {
    const version = { definition: { triggers: [], steps: [{ id: 'version-step', type: 'output' }] } };
    const snapshot = { triggers: [], steps: [{ id: 'snapshot-step', type: 'output' }] };
    // ① 快照与版本行不一致时，以快照为准（= 定义变更后仍按创建时的定义执行）
    expect(lockedDefinition(version, snapshot).steps[0].id).toBe('snapshot-step');
    // ② 历史 run（快照列上线前）→ 回退版本行（published 行不可变，语义等价）
    expect(lockedDefinition(version, null).steps[0].id).toBe('version-step');
    expect(lockedDefinition(version, undefined).steps[0].id).toBe('version-step');
    // ③ 快照存在但结构非法 → 拒绝执行（而非改用版本行）
    expect(() => lockedDefinition(version, { steps: 'not-an-array' })).toThrowError(/快照非法/);
    expect(() => lockedDefinition(version, [1, 2, 3])).toThrowError(/快照非法/);
    expect(() => lockedDefinition(version, 'oops')).toThrowError(/快照非法/);
    // ④ 合法的空 triggers 快照仍按快照执行（空数组是合法定义形状，不是"缺失"）
    expect(lockedDefinition(version, { triggers: [], steps: [] }).steps).toHaveLength(0);
  });
});
