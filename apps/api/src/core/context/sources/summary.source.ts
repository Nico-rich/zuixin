import { Inject } from '@nestjs/common';
import { SummaryRefinerService } from '../../memory/summary-refiner.service';
import { SimpleTokenEstimator } from '../token-estimator';
import { AssembleContext, CONTEXT_ORDER, MemoryBlock, MemoryScope, MemorySource } from '../types';

const SUMMARY_PREFIX = '【对话摘要】';

/**
 * 对话摘要源（M9-P2 增量摘要 → 上下文）。
 *
 * - 只注入**最新非 stale 版本**（陈旧版本已被消息编辑/删除污染，绝不进上下文；更早的好版本自动兜底）；
 * - 版本段（最早→最新）随块下行（block.source.segments）：**本源不自行截断**（P6 原则），
 *   超预算时由 ContextBudgetService 裁掉最早版本段（见 context-budget.service 的 summary 分支）；
 * - 摘要来源是真实消息行的提炼，注入后仅作上下文背景；它绝不回流为记忆/摘要的提炼输入（防循环污染）。
 */
export class ConversationSummarySource implements MemorySource {
  readonly scope: MemoryScope = 'summary';
  private readonly estimator = new SimpleTokenEstimator();

  constructor(@Inject(SummaryRefinerService) private readonly summaries: SummaryRefinerService) {}

  async collect(ctx: AssembleContext): Promise<MemoryBlock[]> {
    const chain = await this.summaries.latestUsable(ctx.conversationId);
    if (!chain || !chain.text.trim()) return [];
    const content = `${SUMMARY_PREFIX}${chain.text}`;
    return [{
      scope: 'summary',
      role: 'user',
      content,
      order: CONTEXT_ORDER.summary,
      tokenCount: this.estimator.estimate(content),
      source: { summaryId: chain.summaryId, version: chain.version, segments: chain.segments },
    }];
  }
}
