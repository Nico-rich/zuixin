import { describe, it, expect, vi } from 'vitest';
import { ConversationSummarySource } from './summary.source';

function makeSource(chain: unknown) {
  const summaries = { latestUsable: vi.fn().mockResolvedValue(chain) };
  return { source: new ConversationSummarySource(summaries as never), summaries };
}

const chain = {
  summaryId: 's2',
  version: 2,
  text: '首批摘要\n第二批摘要',
  segments: ['首批摘要', '第二批摘要'],
  tokenCount: 12,
  degraded: false,
};

describe('ConversationSummarySource（增量摘要 → 上下文）', () => {
  it('注入最新非 stale 版本：【对话摘要】前缀 + order=30 + 版本段随块下行（供预算裁剪）', async () => {
    const { source, summaries } = makeSource(chain);
    const blocks = await source.collect({ userId: 'u1', conversationId: 'c1' });
    expect(summaries.latestUsable).toHaveBeenCalledWith('c1');
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({
      scope: 'summary',
      role: 'user',
      order: 30, // CONTEXT_ORDER.summary：user memory(20) 之后、knowledge(40) 之前
      content: '【对话摘要】首批摘要\n第二批摘要',
    });
    expect(blocks[0].source).toEqual({ summaryId: 's2', version: 2, segments: ['首批摘要', '第二批摘要'] });
    expect(blocks[0].tokenCount).toBeGreaterThan(0);
    // 本源不自行截断（P6 原则）：整段原文注入，裁剪交给 ContextBudgetService
    expect(blocks[0].content).toContain('首批摘要');
  });

  it('无可用摘要（无版本/全部陈旧）→ 空数组（不产生任何数据）', async () => {
    const { source } = makeSource(null);
    expect(await source.collect({ userId: 'u1', conversationId: 'c1' })).toEqual([]);
  });

  it('摘要文本为空 → 空数组（不注入空块）', async () => {
    const { source } = makeSource({ ...chain, text: '   ' });
    expect(await source.collect({ userId: 'u1', conversationId: 'c1' })).toEqual([]);
  });

  it('D29 降级链：块显式标 degraded + 置尾（order=110）+ 最低预算优先级（6）', async () => {
    const degradedText = '【摘要降级：模型不可用，按消息原文压缩】\n用户：内容1';
    const { source } = makeSource({ ...chain, text: degradedText, segments: [degradedText], version: 1, degraded: true });
    const blocks = await source.collect({ userId: 'u1', conversationId: 'c1' });
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({
      scope: 'summary',
      degraded: true,
      order: 110, // CONTEXT_ORDER.degraded_summary：排在最近消息(100)之后 → 置尾
      priority: 6, // DEGRADED_SUMMARY_PRIORITY：低于 summary(3)/knowledge(4)/recent(5)
      content: '【对话摘要】' + degradedText,
    });
    // 仍携带版本段（不因降级而破坏预算裁剪的元数据契约）
    expect(blocks[0].source).toMatchObject({ version: 1, segments: [degradedText] });
  });

  it('D29 非降级链：不设 degraded/priority（正常摘要行为逐字不变，priority 走 scope 默认 3）', async () => {
    const { source } = makeSource(chain);
    const [block] = await source.collect({ userId: 'u1', conversationId: 'c1' });
    expect(block.degraded).toBeUndefined();
    expect(block.priority).toBeUndefined();
    expect(block.order).toBe(30);
  });
});
