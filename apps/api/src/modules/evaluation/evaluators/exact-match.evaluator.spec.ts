import { describe, it, expect } from 'vitest';
import { ExactMatchEvaluator } from './exact-match.evaluator';
import { CaseFacts } from './types';

function facts(over: Partial<CaseFacts> = {}): CaseFacts {
  return {
    input: 'q', expected: 'hello', outputText: 'hello', outputJson: null,
    latencyMs: 10, promptTokens: 1, completionTokens: 2, cost: 0, toolCalls: [],
    ...over,
  };
}

const ev = new ExactMatchEvaluator();

describe('ExactMatchEvaluator（确定性比对；零 LLM）', () => {
  it('完全相等 → passed，score=1；证据含期望与实际', async () => {
    const v = await ev.evaluate(facts(), {});
    expect(v.passed).toBe(true);
    expect(v.score).toBe(1);
    expect(v.evidence).toMatchObject({ matchMode: 'equals', expected: 'hello', actual: 'hello' });
  });

  it('不等 → passed=false，score=0（绝不"部分通过"）', async () => {
    const v = await ev.evaluate(facts({ outputText: 'hello!' }), {});
    expect(v.passed).toBe(false);
    expect(v.score).toBe(0);
  });

  it('trim 默认开启；显式关闭后空白差异导致不通过', async () => {
    expect((await ev.evaluate(facts({ outputText: '  hello  ' }), {})).passed).toBe(true);
    expect((await ev.evaluate(facts({ outputText: '  hello  ' }), { trim: false })).passed).toBe(false);
  });

  it('caseSensitive 默认区分大小写；关闭后忽略', async () => {
    expect((await ev.evaluate(facts({ outputText: 'HELLO' }), {})).passed).toBe(false);
    expect((await ev.evaluate(facts({ outputText: 'HELLO' }), { caseSensitive: false })).passed).toBe(true);
  });

  it('contains 模式：expected 为 actual 子串即通过', async () => {
    const v = await ev.evaluate(facts({ outputText: '[mock] 收到："hello" 世界' }), { matchMode: 'contains' });
    expect(v.passed).toBe(true);
  });

  it('path 模式：从输出 JSON 取值比对（JSON 之外的事实不参与）', async () => {
    const f = facts({ outputText: '{"answer":"hello"}', outputJson: { answer: 'hello' } });
    expect((await ev.evaluate(f, { path: 'answer' })).passed).toBe(true);
    expect((await ev.evaluate(f, { path: 'missing' })).passed).toBe(false);
  });

  it('非字符串 expected：按规范化 JSON 值比对（空白/键序等无关差异不误判为不等）', async () => {
    const f = facts({ expected: { a: 1, b: [1, 2] }, outputText: '{ "b": [1,2],\n  "a": 1 }', outputJson: { b: [1, 2], a: 1 } });
    const v = await ev.evaluate(f, {});
    expect(v.passed).toBe(true);
    expect(v.evidence.comparedAs).toBe('json');
  });

  it('非字符串 expected 而输出不可解析为 JSON → 按文本比对并判不等（绝不猜测）', async () => {
    const f = facts({ expected: { a: 1 }, outputText: '抱歉，我无法回答', outputJson: null });
    const v = await ev.evaluate(f, {});
    expect(v.passed).toBe(false);
    expect(v.evidence.comparedAs).toBe('text');
  });

  it('case 未定义 expected → 不通过并给出理由（绝不猜测期望值）', async () => {
    const v = await ev.evaluate(facts({ expected: null }), {});
    expect(v.passed).toBe(false);
    expect(v.score).toBe(0);
    expect(String(v.evidence.reason)).toContain('expected');
  });

  it('配置校验：非法 matchMode/类型/path 长度一律拒绝', () => {
    expect(() => ev.validate({ matchMode: 'fuzzy' })).toThrow();
    expect(() => ev.validate({ trim: 'yes' })).toThrow();
    expect(() => ev.validate({ caseSensitive: 1 })).toThrow();
    expect(() => ev.validate({ path: 'x'.repeat(201) })).toThrow();
    expect(() => ev.validate({})).not.toThrow();
  });
});
