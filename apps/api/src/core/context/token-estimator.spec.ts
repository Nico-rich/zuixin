import { describe, it, expect } from 'vitest';
import { SimpleTokenEstimator } from './token-estimator';

describe('SimpleTokenEstimator（确定性启发式）', () => {
  const est = new SimpleTokenEstimator();

  it('empty → 0', () => {
    expect(est.estimate('')).toBe(0);
    expect(est.estimate('   ')).toBe(0);
  });

  it('短文本：中文按字、英文按词估算', () => {
    expect(est.estimate('你好')).toBe(2);       // ceil(2/1.5)=2
    expect(est.estimate('hello world')).toBe(3); // ceil(10/4)=3
  });

  it('长文本：随长度单调增长', () => {
    expect(est.estimate('x'.repeat(1000))).toBeGreaterThan(est.estimate('x'.repeat(100)));
  });

  it('确定性：同输入同输出', () => {
    const text = '同一段混合 content 内容'.repeat(20);
    expect(est.estimate(text)).toBe(est.estimate(text));
  });
});
