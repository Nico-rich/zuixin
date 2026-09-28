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

  it('summary 块在预算内：原样保留（含版本段元数据）', () => {
    const b = makeBlock({
      scope: 'summary', content: '【对话摘要】段1\n段2', order: 30, tokenCount: 10,
      source: { summaryId: 's1', version: 2, segments: ['段1', '段2'] },
    });
    const r = svc.apply([b], { maxTokens: 100 });
    expect(r.blocks[0].content).toBe('【对话摘要】段1\n段2');
    expect(r.truncated).toBe(false);
  });

  it('summary 块超预算 → 裁掉最早版本段（保留最新段），裁剪事实回写元数据', () => {
    const seg1 = '早'.repeat(30);
    const seg2 = '晚'.repeat(30);
    const b = makeBlock({
      scope: 'summary',
      content: `【对话摘要】${seg1}\n${seg2}`,
      order: 30,
      tokenCount: new SimpleTokenEstimator().estimate(`【对话摘要】${seg1}\n${seg2}`),
      source: { summaryId: 's1', version: 2, segments: [seg1, seg2] },
    });
    const r = svc.apply([b], { maxTokens: 30 }); // 只放得下最新段
    expect(r.truncated).toBe(true);
    expect(r.blocks[0].content).toContain('【对话摘要】');
    expect(r.blocks[0].content).toContain(seg2); // 最新段保留
    expect(r.blocks[0].content).not.toContain(seg1); // 最早版本段被裁掉
    expect((r.blocks[0].source as { trimmedSegments: number }).trimmedSegments).toBe(1);
  });

  it('summary 段数多于预算：多段连续裁撤（只留放得下的最新若干段）', () => {
    const segs = ['一'.repeat(20), '二'.repeat(20), '三'.repeat(20)];
    const content = `【对话摘要】${segs.join('\n')}`;
    const b = makeBlock({
      scope: 'summary', content, order: 30,
      tokenCount: new SimpleTokenEstimator().estimate(content),
      source: { summaryId: 's1', version: 3, segments: segs },
    });
    const loose = svc.apply([b], { maxTokens: 40 }); // 放得下最新两段
    expect(loose.blocks[0].content).not.toContain(segs[0]);
    expect(loose.blocks[0].content).toContain(segs[1]);
    expect(loose.blocks[0].content).toContain(segs[2]);
    const tight = svc.apply([b], { maxTokens: 20 }); // 只放得下最新一段
    expect(tight.blocks[0].content).toContain(segs[2]);
    expect(tight.blocks[0].content).not.toContain(segs[1]);
    expect(tight.blocks[0].content).not.toContain(segs[0]);
  });

  it('summary 单段仍超预算 → 该段按比例截断（整块不删除；摘要比旧消息值钱）', () => {
    const b = makeBlock({
      scope: 'summary', content: '【对话摘要】' + '内'.repeat(100), order: 30,
      tokenCount: 100, source: { summaryId: 's1', version: 1, segments: ['内'.repeat(100)] },
    });
    const r = svc.apply([b], { maxTokens: 20 });
    expect(r.blocks).toHaveLength(1);
    expect(r.blocks[0].content.length).toBeLessThan(110);
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

  // ===== D29 降级块（【摘要降级】兜底段）：降权 + 置尾，绝不与正常来源同权 =====

  const degradedBlock = (over: Partial<MemoryBlock> = {}) =>
    makeBlock({
      scope: 'summary', degraded: true, order: 110, priority: 6,
      content: '【对话摘要】【摘要降级：模型不可用，按消息原文压缩】\n用户：内容1',
      source: { summaryId: 's1', version: 1, segments: ['【摘要降级：模型不可用，按消息原文压缩】\n用户：内容1'] },
      ...over,
    });

  it('降级块预算不足 → 整块丢弃（不裁段/不截断），正常摘要与记忆照常保留', () => {
    const normal = makeBlock({
      scope: 'summary', content: '【对话摘要】正常摘要文本', order: 30, tokenCount: 12,
      source: { summaryId: 's2', version: 2, segments: ['正常摘要文本'] },
    });
    const memory = makeBlock({ scope: 'user', content: '记忆', order: 20, tokenCount: 10 });
    const r = svc.apply([normal, memory, degradedBlock({ tokenCount: 40 })], { maxTokens: 22 });
    expect(r.truncated).toBe(true);
    expect(r.blocks.map((b) => b.content)).toEqual(['记忆', '【对话摘要】正常摘要文本']);
    expect(r.blocks.some((b) => b.degraded === true)).toBe(false);
  });

  it('降级块即使被调用方漏标 priority → 仍按最低优先级分配（预算只够正常块时被丢弃）', () => {
    const normal = makeBlock({
      scope: 'summary', content: '【对话摘要】正常摘要文本', order: 30, tokenCount: 12,
      source: { summaryId: 's2', version: 2, segments: ['正常摘要文本'] },
    });
    const r = svc.apply([normal, degradedBlock({ priority: undefined, tokenCount: 40 })], { maxTokens: 12 });
    expect(r.blocks.map((b) => b.content)).toEqual(['【对话摘要】正常摘要文本']);
  });

  it('降级块预算足够 → 保留但置尾（输出顺序排在最近消息之后），不挤占正常内容', () => {
    const recent = makeBlock({ scope: 'conversation', content: '最近消息', order: 100, tokenCount: 5 });
    const r = svc.apply([degradedBlock({ tokenCount: 8 }), recent], { maxTokens: 50 });
    expect(r.blocks).toHaveLength(2);
    expect(r.blocks.map((b) => b.content)).toEqual(['最近消息', degradedBlock().content]); // 置尾：降级块在最后
    expect(r.truncated).toBe(false);
  });

  it('降级块与正常来源同权重不会互相顶掉：预算恰够两者 → 都保留（只是降级块排在尾部）', () => {
    const normal = makeBlock({ scope: 'summary', content: '【对话摘要】正常摘要', order: 30, tokenCount: 6 });
    const r = svc.apply([degradedBlock({ tokenCount: 6 }), normal], { maxTokens: 12 });
    expect(r.blocks.map((b) => b.content)).toEqual(['【对话摘要】正常摘要', degradedBlock().content]);
  });
});
