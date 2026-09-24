import { describe, it, expect } from 'vitest';
import { ChunkingService } from './chunking.service';

describe('ChunkingService（确定性基础分块）', () => {
  const svc = new ChunkingService();

  it('空文本 → 空数组（不产生空 chunk）', () => {
    expect(svc.chunk('')).toEqual([]);
    expect(svc.chunk('   \n  ')).toEqual([]);
  });

  it('短文本（≤ chunkSize）→ 单块', () => {
    const chunks = svc.chunk('短文本', { chunkSize: 100, overlap: 10 });
    expect(chunks).toEqual(['短文本']);
  });

  it('恰好边界（== chunkSize）→ 单块', () => {
    const text = 'a'.repeat(100);
    expect(svc.chunk(text, { chunkSize: 100, overlap: 10 })).toEqual([text]);
  });

  it('长文本按 size-overlap 步长切分且无空块', () => {
    const text = 'x'.repeat(1000);
    const chunks = svc.chunk(text, { chunkSize: 100, overlap: 20 });
    expect(chunks.every((c) => c.length > 0)).toBe(true);
    expect(chunks.every((c) => c.length <= 100)).toBe(true);
    expect(chunks.length).toBe(Math.ceil((1000 - 20) / 80));
  });

  it('overlap 生效：相邻块存在重叠片段', () => {
    const text = '0123456789'.repeat(20); // 200 字符
    const chunks = svc.chunk(text, { chunkSize: 100, overlap: 40 });
    expect(chunks.length).toBeGreaterThan(1);
    // 前一块结尾与后一块开头重叠
    expect(chunks[0].slice(-20)).toBe(chunks[1].slice(0, 20));
  });

  it('确定性：同输入两次结果相同', () => {
    const text = '同一段文本内容'.repeat(50);
    expect(svc.chunk(text)).toEqual(svc.chunk(text));
  });

  it('非法参数：overlap ≥ chunkSize 抛错', () => {
    expect(() => svc.chunk('x'.repeat(200), { chunkSize: 100, overlap: 100 })).toThrow();
  });
});
