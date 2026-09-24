import { describe, it, expect } from 'vitest';
import { MockEmbeddingProvider } from './mock-embedding.adapter';

describe('MockEmbeddingProvider', () => {
  it('dimensions 正确', () => {
    expect(new MockEmbeddingProvider(64).getDimensions()).toBe(64);
  });

  it('空输入返回空数组', async () => {
    expect(await new MockEmbeddingProvider().embed([])).toEqual([]);
  });

  it('多输入返回等长向量数组，每个向量维度一致', async () => {
    const r = await new MockEmbeddingProvider(32).embed(['a', 'b', 'c']);
    expect(r).toHaveLength(3);
    expect(r.every((v) => v.length === 32)).toBe(true);
  });

  it('同输入确定性：两次调用结果相同', async () => {
    const p = new MockEmbeddingProvider();
    const r1 = await p.embed(['产品规格说明书']);
    const r2 = await p.embed(['产品规格说明书']);
    expect(r1).toEqual(r2);
  });

  it('向量 L2 归一化（模长≈1）', async () => {
    const [v] = await new MockEmbeddingProvider().embed(['hello world']);
    const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
    expect(norm).toBeCloseTo(1, 5);
  });
});
