import { describe, it, expect } from 'vitest';
import { RuleEvaluator } from './rule.evaluator';
import { CaseFacts } from './types';

function facts(over: Partial<CaseFacts> = {}): CaseFacts {
  return {
    input: 'q', expected: null, outputText: 'hello world', outputJson: { a: { b: 1 } },
    latencyMs: 100, promptTokens: 10, completionTokens: 20, cost: 0.001, toolCalls: [],
    ...over,
  };
}

const ev = new RuleEvaluator();

describe('RuleEvaluator（确定性规则集）', () => {
  it('全部规则通过 → passed，score=1，证据逐条列出', async () => {
    const v = await ev.evaluate(facts(), {
      rules: [{ type: 'contains', value: 'hello' }, { type: 'max_length', value: 100 }, { type: 'min_length', value: 3 }],
    });
    expect(v.passed).toBe(true);
    expect(v.score).toBe(1);
    expect(v.evidence.total).toBe(3);
    expect(v.evidence.passed).toBe(3);
  });

  it('部分通过 → score = 通过条数/总条数（覆盖率事实），passed=false', async () => {
    const v = await ev.evaluate(facts(), {
      rules: [{ type: 'contains', value: 'hello' }, { type: 'contains', value: '不存在' }, { type: 'contains', value: 'world' }, { type: 'contains', value: 'nope' }],
    });
    expect(v.passed).toBe(false);
    expect(v.score).toBe(0.5);
    expect(v.evidence.passed).toBe(2);
  });

  it('not_contains / equals / regex 判定', async () => {
    expect((await ev.evaluate(facts(), { rules: [{ type: 'not_contains', value: 'zzz' }] })).passed).toBe(true);
    expect((await ev.evaluate(facts(), { rules: [{ type: 'not_contains', value: 'hello' }] })).passed).toBe(false);
    expect((await ev.evaluate(facts(), { rules: [{ type: 'equals', value: 'hello world' }] })).passed).toBe(true);
    expect((await ev.evaluate(facts(), { rules: [{ type: 'equals', value: 'hello' }] })).passed).toBe(false);
    expect((await ev.evaluate(facts(), { rules: [{ type: 'regex', value: '^hello\\s+\\w+$' }] })).passed).toBe(true);
    expect((await ev.evaluate(facts(), { rules: [{ type: 'regex', value: '^nope$' }] })).passed).toBe(false);
  });

  it('max_latency_ms：事实缺失（latencyMs=null）判定为不通过——绝不视为通过', async () => {
    const v = await ev.evaluate(facts({ latencyMs: null }), { rules: [{ type: 'max_latency_ms', value: 9999 }] });
    expect(v.passed).toBe(false);
    expect(String((v.evidence.rules as Array<{ detail: string }>)[0].detail)).toContain('事实缺失');
  });

  it('max_cost / max_tokens 阈值判定（tokens 为 prompt+completion 合计）', async () => {
    expect((await ev.evaluate(facts(), { rules: [{ type: 'max_cost', value: 0.01 }] })).passed).toBe(true);
    expect((await ev.evaluate(facts(), { rules: [{ type: 'max_cost', value: 0.0001 }] })).passed).toBe(false);
    expect((await ev.evaluate(facts(), { rules: [{ type: 'max_tokens', value: 30 }] })).passed).toBe(true);
    expect((await ev.evaluate(facts(), { rules: [{ type: 'max_tokens', value: 29 }] })).passed).toBe(false);
  });

  it('json_path_equals：路径不存在 → 不通过（绝不静默通过）', async () => {
    expect((await ev.evaluate(facts(), { rules: [{ type: 'json_path_equals', path: 'a.b', value: 1 }] })).passed).toBe(true);
    expect((await ev.evaluate(facts(), { rules: [{ type: 'json_path_equals', path: 'a.z', value: 1 }] })).passed).toBe(false);
    // 值按值语义比对（数字 1 与字符串 "1" 不等价）
    expect((await ev.evaluate(facts(), { rules: [{ type: 'json_path_equals', path: 'a.b', value: '1' }] })).passed).toBe(false);
  });

  it('tool_called：评测 runner 不执行工具，只比对模型发出的调用名', async () => {
    const f = facts({ toolCalls: [{ name: 'search', arguments: '{}', output: null }] });
    expect((await ev.evaluate(f, { rules: [{ type: 'tool_called', value: 'search' }] })).passed).toBe(true);
    expect((await ev.evaluate(f, { rules: [{ type: 'tool_called', value: 'publish' }] })).passed).toBe(false);
    expect((await ev.evaluate(facts(), { rules: [{ type: 'tool_called', value: 'search' }] })).passed).toBe(false);
  });

  it('配置校验：空规则集/未知类型/字段缺失一律拒绝（绝不入库后静默跳过）', () => {
    expect(() => ev.validate({ rules: [] })).toThrow();
    expect(() => ev.validate({})).toThrow();
    expect(() => ev.validate({ rules: [{ type: 'nope' }] })).toThrow();
    expect(() => ev.validate({ rules: [{ type: 'contains' }] })).toThrow();
    expect(() => ev.validate({ rules: [{ type: 'contains', value: '' }] })).toThrow();
    expect(() => ev.validate({ rules: [{ type: 'regex', value: '(' }] })).toThrow();
    expect(() => ev.validate({ rules: [{ type: 'max_latency_ms', value: -1 }] })).toThrow();
    expect(() => ev.validate({ rules: [{ type: 'min_length', value: 1.5 }] })).toThrow();
    expect(() => ev.validate({ rules: [{ type: 'json_path_equals', value: 1 }] })).toThrow();
    expect(() => ev.validate({ rules: [{ type: 'tool_called', value: '' }] })).toThrow();
    expect(() => ev.validate({ rules: Array.from({ length: 101 }, () => ({ type: 'contains', value: 'x' })) })).toThrow();
    expect(() => ev.validate({ rules: [{ type: 'contains', value: 'x', label: 'y'.repeat(201) }] })).toThrow();
  });
});
