import { describe, it, expect } from 'vitest';
import { ContextBudgetService } from './context-budget.service';
import { SimpleTokenEstimator } from './token-estimator';
import { MemoryBlock } from './types';

function makeBlock(over: Partial<MemoryBlock> & { content: string; scope: MemoryBlock['scope'] }): MemoryBlock {
  return {
    role: 'user',
    tokenCount: Math.ceil(over.content.length / 2),
    ...over,
  };
}

describe('ContextBudgetService（统一预算决策，deterministic）', () => {
  const svc = new ContextBudgetService(new SimpleTokenEstimator());

  it('预算内：全部保留，truncated=false', () => {
    const blocks = [
      makeBlock({ scope: 'system', content: 'sys', required: true, order: 0 }),
      makeBlock({ scope: 'user', content: '记忆A', order: 20 }),
      makeBlock({ scope: 'conversation', content: '最近消息', order: 100 }),
    ];
    const r = svc.apply(blocks, { maxTokens: 100 });
    expect(r.blocks).toHaveLength(3);
    expect(r.truncated).toBe(false);
  });

  it('恰好边界：全部保留', () => {
    const b = makeBlock({ scope: 'conversation', content: 'x'.repeat(20) }); // 10 tokens
    const r = svc.apply([b], { maxTokens: 10 });
    expect(r.blocks).toHaveLength(1);
    expect(r.truncated).toBe(false);
  });

  it('超预算：低优先级（recent）先被丢弃，高优先级（memory）保留', () => {
    const blocks = [
      makeBlock({ scope: 'user', content: '重要记忆', order: 20, tokenCount: 30 }),
      makeBlock({ scope: 'conversation', content: '旧消息', order: 100, tokenCount: 30 }),
      makeBlock({ scope: 'conversation', content: '新消息', order: 100, tokenCount: 20 }),
    ];
    const r = svc.apply(blocks, { maxTokens: 50 }); // memory(30) 优先；recent 组剩 20 → 保留最新一条，旧消息被丢
    expect(r.truncated).toBe(true);
    expect(r.blocks.map((b) => b.scope)).toEqual(['user', 'conversation']);
    expect(r.blocks.find((b) => b.scope === 'conversation')!.content).toBe('新消息'); // 最新优先
  });

  it('recent 组：最新消息优先保留，输出保持时间正序', () => {
    const blocks = [
      makeBlock({ scope: 'conversation', content: 'msg1-最旧', order: 100, tokenCount: 10 }),
      makeBlock({ scope: 'conversation', content: 'msg2', order: 100, tokenCount: 10 }),
      makeBlock({ scope: 'conversation', content: 'msg3-最新', order: 100, tokenCount: 10 }),
    ];
    const r = svc.apply(blocks, { maxTokens: 25 });
    expect(r.blocks.map((b) => b.content)).toEqual(['msg2', 'msg3-最新']); // 丢最旧，顺序正序
  });

  it('knowledge 组：保持输入顺序（similarity 降序）→ 高相似度优先保留', () => {
    const blocks = [
      makeBlock({ scope: 'knowledge', content: '高分块0.91', order: 40, tokenCount: 10 }),
      makeBlock({ scope: 'knowledge', content: '中分块0.85', order: 40, tokenCount: 10 }),
      makeBlock({ scope: 'knowledge', content: '低分块0.72', order: 40, tokenCount: 10 }),
    ];
    const r = svc.apply(blocks, { maxTokens: 20 });
    expect(r.blocks.map((b) => b.content)).toEqual(['高分块0.91', '中分块0.85']); // 低分被丢
  });

  it('system required：不可截断；system 超预算 → CONTEXT_BUDGET_EXCEEDED', () => {
    const sys = makeBlock({ scope: 'system', content: 'y'.repeat(200), required: true, tokenCount: 100, order: 0 });
    expect(() => svc.apply([sys, makeBlock({ scope: 'user', content: 'x', order: 20 })], { maxTokens: 50 }))
      .toThrowError(/CONTEXT_BUDGET_EXCEEDED|上下文预算不足/);
  });

  it('单块超剩余预算 → 按比例确定性截断（不删块）', () => {
    const b = makeBlock({ scope: 'knowledge', content: 'k'.repeat(100), order: 40, tokenCount: 50 });
    const r = svc.apply([b], { maxTokens: 25 });
    expect(r.blocks).toHaveLength(1);
    expect(r.blocks[0].content.length).toBeLessThan(100);
    expect(r.truncated).toBe(true);
  });

  it('确定性：同输入同预算两次结果一致', () => {
    const blocks = [
      makeBlock({ scope: 'user', content: '记忆', order: 20, tokenCount: 30 }),
      makeBlock({ scope: 'conversation', content: '消息A', order: 100, tokenCount: 20 }),
      makeBlock({ scope: 'conversation', content: '消息B', order: 100, tokenCount: 20 }),
    ];
    const r1 = svc.apply(blocks, { maxTokens: 40 });
    const r2 = svc.apply(blocks, { maxTokens: 40 });
    expect(r1.blocks.map((b) => b.content)).toEqual(r2.blocks.map((b) => b.content));
  });
});
