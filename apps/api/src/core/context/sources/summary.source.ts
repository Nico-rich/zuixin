import { Inject } from '@nestjs/common';
import { SummaryRefinerService } from '../../memory/summary-refiner.service';
import { SimpleTokenEstimator } from '../token-estimator';
import { AssembleContext, CONTEXT_ORDER, DEGRADED_SUMMARY_PRIORITY, MemoryBlock, MemoryScope, MemorySource } from '../types';

const SUMMARY_PREFIX = '【对话摘要】';

/**
 * 对话摘要源（M9-P2 增量摘要 → 上下文）。
 *
 * - 只注入**最新非 stale 版本**（陈旧版本已被消息编辑/删除污染，绝不进上下文；更早的好版本自动兜底）；
 * - 版本段（最早→最新）随块下行（block.source.segments）：**本源不自行截断**（P6 原则），
 *   超预算时由 ContextBudgetService 裁掉最早版本段（见 context-budget.service 的 summary 分支）；
 * - 摘要来源是真实消息行的提炼，注入后仅作上下文背景；它绝不回流为记忆/摘要的提炼输入（防循环污染）；
 * - **D29 降级**：链上含【摘要降级】兜底段（LLM 不可用）→ 块显式标 `degraded`，order 置尾
 *   （CONTEXT_ORDER.degraded_summary=110，排在最近消息之后）+ 最低预算优先级（DEGRADED_SUMMARY_PRIORITY=6）
 *   ——降级文本绝不与正常摘要同权进入上下文排序。
 */
export class ConversationSummarySource implements MemorySource {
  readonly scope: MemoryScope = 'summary';
  private readonly estimator = new SimpleTokenEstimator();

  constructor(@Inject(SummaryRefinerService) private readonly summaries: SummaryRefinerService) {}

  async collect(ctx: AssembleContext): Promise<MemoryBlock[]> {
    const chain = await this.summaries.latestUsable(ctx.conversationId);
    if (!chain || !chain.text.trim()) return [];
    const content = `${SUMMARY_PREFIX}${chain.text}`;
    const degraded = chain.degraded === true;
    return [{
      scope: 'summary',
      role: 'user',
      content,
      order: degraded ? CONTEXT_ORDER.degraded_summary : CONTEXT_ORDER.summary,
      // 非降级块不设 degraded/priority（行为与既有“正常摘要”逐字一致，priority 走 scope 默认 3）
      ...(degraded ? { degraded: true, priority: DEGRADED_SUMMARY_PRIORITY } : {}),
      tokenCount: this.estimator.estimate(content),
      source: { summaryId: chain.summaryId, version: chain.version, segments: chain.segments },
    }];
  }
}
