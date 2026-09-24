import { Inject, Injectable } from '@nestjs/common';
import { AppError, ErrorCode } from '../../common/errors/app-error';
import { MemoryBlock } from './types';
import { TokenEstimator } from './token-estimator';

export interface ContextBudget {
  maxTokens: number;
}

export interface BudgetedContext {
  blocks: MemoryBlock[];
  estimatedTokens: number;
  truncated: boolean;
}

/**
 * Context Budget 统一决策点——任何 Source 不得自行截断（P6 原则）。
 *
 * 截断策略（deterministic + explainable + stable）：
 * - 分配顺序 = priority 升序（高优先级先拿到预算）；scope 默认优先级：
 *   system=0（required，不可截断）、project_memory=1、user_memory=2、summary=3、knowledge=4、recent_messages=5；
 * - system 块本身超过预算 → 抛 CONTEXT_BUDGET_EXCEEDED（绝不静默删除 System Prompt）；
 * - recent_messages 组内：**从最新向前保留**（blocks 为时间正序 → 从末尾取），输出保持时间正序；
 * - knowledge 组内：保持输入顺序（KnowledgeSource 已按 similarity 降序）→ 高相似度优先；
 * - 单块超过剩余预算 → 按比例确定性截断 content 并重估 tokenCount（不丢消息、不破坏配对）；
 * - 同输入同预算 → 同输出。
 */
@Injectable()
export class ContextBudgetService {
  constructor(@Inject('TOKEN_ESTIMATOR') private readonly estimator: TokenEstimator) {}

  private defaultPriority(scope: MemoryBlock['scope']): number {
    switch (scope) {
      case 'system': return 0;
      case 'project': return 1;
      case 'user': return 2;
      case 'conversation': return 5; // recent messages
      case 'knowledge': return 4;
    }
    return 3; // summary 等未知源默认中位
  }

  apply(blocks: MemoryBlock[], budget: ContextBudget): BudgetedContext {
    // 记录源索引：最终排序时同 order 块恢复源顺序（recent 组反序遍历后必须回到时间正序）
    const sourceIndex = new Map<MemoryBlock, number>();
    blocks.forEach((b, i) => sourceIndex.set(b, i));
    const required = blocks.filter((b) => b.required || b.scope === 'system');
    const requiredTokens = required.reduce((s, b) => s + this.tokensOf(b), 0);
    if (requiredTokens > budget.maxTokens) {
      // System Prompt 不可被普通截断删除——明确报错而非静默
      throw new AppError(ErrorCode.CONTEXT_BUDGET_EXCEEDED, `上下文预算不足：System 内容已占用 ${requiredTokens} tokens（预算 ${budget.maxTokens}）`);
    }

    let remaining = budget.maxTokens - requiredTokens;
    let truncated = false;
    const kept: MemoryBlock[] = [...required];

    const optional = blocks.filter((b) => !(b.required || b.scope === 'system'));
    // 按 priority 分组并保持组内原顺序（order 排序后已保证时间/相似度语义）
    const groups = new Map<number, MemoryBlock[]>();
    for (const b of optional) {
      const p = b.priority ?? this.defaultPriority(b.scope);
      if (!groups.has(p)) groups.set(p, []);
      groups.get(p)!.push(b);
    }
    const sortedGroups = [...groups.entries()].sort((a, b) => a[0] - b[0]);

    for (const [priority, group] of sortedGroups) {
      // recent_messages 特例：组内从最新向前保留；超剩余的直接丢弃旧消息（§八：删除旧消息而非截断旧消息）
      const ordered = priority === 5 ? [...group].reverse() : group;
      for (const block of ordered) {
        if (remaining <= 0) { truncated = true; continue; }
        const tokens = this.tokensOf(block);
        if (tokens <= remaining) {
          kept.push(block);
          remaining -= tokens;
        } else if (priority === 5) {
          truncated = true; // recent 组：预算不足 → 丢弃（更旧的更不可能保留）
          continue;
        } else {
          // 非 recent 组（memory/knowledge/summary）：单块超剩余 → 按比例确定性截断内容（保留头部）
          const ratio = Math.max(0.05, remaining / tokens);
          const newContent = block.content.slice(0, Math.max(1, Math.floor(block.content.length * ratio)));
          kept.push({ ...block, content: newContent, tokenCount: this.estimator.estimate(newContent) });
          remaining = 0;
          truncated = true;
        }
      }
    }

    // 输出保持原组装顺序（order 优先，同 order 按源索引恢复）
    kept.sort((a, b) => ((a.order ?? 100) - (b.order ?? 100)) || ((sourceIndex.get(a) ?? 0) - (sourceIndex.get(b) ?? 0)));
    return {
      blocks: kept,
      estimatedTokens: kept.reduce((s, b) => s + this.tokensOf(b), 0),
      truncated,
    };
  }

  private tokensOf(b: MemoryBlock): number {
    return b.tokenCount ?? this.estimator.estimate(b.content);
  }
}
