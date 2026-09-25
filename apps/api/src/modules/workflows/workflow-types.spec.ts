import { describe, it, expect } from 'vitest';
import {
  WorkflowContext, evaluateCondition, getPath, renderTemplate, validateDefinition,
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
