import { describe, expect, it } from 'vitest';
import { estimateCost, DEFAULT_ESTIMATED_TOKENS, DEFAULT_ESTIMATED_UNITS } from './cost-estimator';

const llm = { inputPrice: 10, outputPrice: 30, unitPrice: 0 }; // 每百万 token 单价
const image = { inputPrice: 0, outputPrice: 0, unitPrice: 0.2 }; // 每张单价

describe('M8-P7 成本估算（与 usage 计量同一约定）', () => {
  it('token 类：缺省按 1000 输入 + 1000 输出 tokens 估算', () => {
    const expected = (DEFAULT_ESTIMATED_TOKENS * 10 + DEFAULT_ESTIMATED_TOKENS * 30) / 1_000_000;
    expect(estimateCost('text_generation', llm)).toBeCloseTo(expected, 6);
  });

  it('token 类：budget 覆盖默认 token 数（function_calling/vision 同口径）', () => {
    expect(estimateCost('text_generation', llm, { inputTokens: 2000, outputTokens: 0 })).toBeCloseTo(0.02, 6);
    expect(estimateCost('function_calling', llm, { inputTokens: 0, outputTokens: 1000 })).toBeCloseTo(0.03, 6);
    expect(estimateCost('vision', llm, { inputTokens: 1000, outputTokens: 1000 })).toBeCloseTo(0.04, 6);
  });

  it('单位类：units × unitPrice（image/video/embedding）', () => {
    expect(estimateCost('image_generation', image, { units: 3 })).toBeCloseTo(0.6, 6);
    expect(estimateCost('image_generation', image)).toBeCloseTo(DEFAULT_ESTIMATED_UNITS * 0.2, 6);
    expect(estimateCost('video_generation', { inputPrice: 0, outputPrice: 0, unitPrice: 0.5 }, { units: 10 })).toBeCloseTo(5, 6);
    expect(estimateCost('embedding', { inputPrice: 0, outputPrice: 0, unitPrice: 0.0001 }, { units: 100 })).toBeCloseTo(0.01, 6);
  });

  it('脏预算（负数/NaN）退回默认值，绝不因输入崩溃', () => {
    expect(estimateCost('image_generation', image, { units: -5 })).toBeCloseTo(0.2, 6);
    expect(estimateCost('image_generation', image, { units: Number.NaN })).toBeCloseTo(0.2, 6);
  });

  it('结果保留 6 位小数（排序/断言确定性）', () => {
    expect(estimateCost('text_generation', { inputPrice: 0.1, outputPrice: 0.3, unitPrice: 0 }, { inputTokens: 3, outputTokens: 7 })).toBe(0.000002);
  });
});
