import { describe, it, expect } from 'vitest';
import { JsonSchemaEvaluator } from './json-schema.evaluator';
import { CaseFacts } from './types';

function facts(outputText: string, outputJson: unknown): CaseFacts {
  return {
    input: 'q', expected: null, outputText, outputJson,
    latencyMs: 1, promptTokens: 1, completionTokens: 1, cost: 0, toolCalls: [],
  };
}

const ev = new JsonSchemaEvaluator();
const schema = {
  type: 'object',
  required: ['summary', 'confidence'],
  properties: {
    summary: { type: 'string', minLength: 2 },
    confidence: { type: 'number', minimum: 0, maximum: 1 },
    tags: { type: 'array', items: { type: 'string' }, maxItems: 2 },
  },
};

describe('JsonSchemaEvaluator（确定性 schema 校验）', () => {
  it('符合 schema → passed，零违规', async () => {
    const v = await ev.evaluate(facts('{"summary":"ok","confidence":0.8}', { summary: 'ok', confidence: 0.8 }), { schema });
    expect(v.passed).toBe(true);
    expect(v.score).toBe(1);
    expect(v.evidence.failureCount).toBe(0);
  });

  it('缺字段/越界/类型不符 → 不通过，证据逐条列出（含路径）', async () => {
    const v = await ev.evaluate(facts('{"confidence":2}', { confidence: 2 }), { schema });
    expect(v.passed).toBe(false);
    expect(v.score).toBe(0);
    const failures = v.evidence.failures as Array<{ path: string; rule: string }>;
    expect(failures.some((f) => f.rule === 'required' && f.path === '$')).toBe(true);
    expect(failures.some((f) => f.rule === 'maximum' && f.path === '$.confidence')).toBe(true);
  });

  it('数组 items 递归校验（含下标路径）', async () => {
    const v = await ev.evaluate(facts('{"tags":["a",1]}', { tags: ['a', 1] }), { schema });
    expect(v.passed).toBe(false);
    expect((v.evidence.failures as Array<{ path: string }>).some((f) => f.path === '$.tags[1]')).toBe(true);
  });

  it('输出不是合法 JSON → 不通过（绝不尝试修复输出）', async () => {
    const v = await ev.evaluate(facts('[mock] 你好', null), { schema });
    expect(v.passed).toBe(false);
    expect((v.evidence.failures as Array<{ rule: string }>)[0].rule).toBe('json.parse');
  });

  it('enum 比对按值语义（字符串/数字均可）', async () => {
    const s = { type: 'object', properties: { kind: { enum: ['a', 1] } } };
    expect((await ev.evaluate(facts('{"kind":"a"}', { kind: 'a' }), { schema: s })).passed).toBe(true);
    expect((await ev.evaluate(facts('{"kind":1}', { kind: 1 }), { schema: s })).passed).toBe(true);
    expect((await ev.evaluate(facts('{"kind":"b"}', { kind: 'b' }), { schema: s })).passed).toBe(false);
  });

  it('配置校验：未知关键字/非法正则/非法 type 一律拒绝（绝不静默忽略）', () => {
    expect(() => ev.validate({ schema: { type: 'object', pattern: '(' } })).toThrow();
    expect(() => ev.validate({ schema: { type: 'object', oneOf: [] } })).toThrow();
    expect(() => ev.validate({ schema: { type: 'objectt' } })).toThrow();
    expect(() => ev.validate({ schema: [] })).toThrow();
    expect(() => ev.validate({})).toThrow();
    expect(() => ev.validate({ schema: { type: 'object', properties: { a: { type: 'string' } } } })).not.toThrow();
  });
});
