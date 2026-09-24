import { EmbeddingProvider } from '../embedding.types';

/**
 * dev/e2e 替身：确定性字符频率投影向量（L2 归一化）。
 * 同文本永远产生相同向量；语义近似通过字符重叠近似（仅测试用，无真实语义）。
 */
export class MockEmbeddingProvider implements EmbeddingProvider {
  readonly kind = 'embedding' as const;
  constructor(private readonly dimensions = 64) {}

  getDimensions(): number { return this.dimensions; }

  async embed(inputs: string[]): Promise<number[][]> {
    return inputs.map((t) => this.embedOne(t));
  }

  private embedOne(text: string): number[] {
    const v = new Array(this.dimensions).fill(0);
    for (const ch of text.toLowerCase()) {
      v[ch.charCodeAt(0) % this.dimensions] += 1;
    }
    const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
    return v.map((x) => x / norm);
  }
}
