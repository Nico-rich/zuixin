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
 * scope → 默认优先级（导出：调用方构造 MemoryBlock 时复用同一映射，绝不各自硬编码优先级数字）。
 * conversation=5 即「最近消息」组：组内从最新向前保留、预算不足整块丢弃。
 */
export function scopePriority(scope: MemoryBlock['scope']): number {
  switch (scope) {
    case 'system': return 0;
    case 'project': return 1;
    case 'user': return 2;
    case 'conversation': return 5; // recent messages
    case 'knowledge': return 4;
    case 'summary': return 3; // M9-P2：摘要版本段（高优先于 knowledge、低于 memory）
  }
  return 3; // 未知源默认中位
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
 * - summary 组（M9-P2）：块携带版本段（block.source.segments，最早→最新）时，超预算**裁掉最早版本段**
 *   ——保留最新段（最近的对话信息），仍然超预算的那一段才走通用比例截断；
 * - 单块超过剩余预算 → 按比例确定性截断 content 并重估 tokenCount（不丢消息、不破坏配对）；
 * - 同输入同预算 → 同输出。
 */
@Injectable()
export class ContextBudgetService {
  constructor(@Inject('TOKEN_ESTIMATOR') private readonly estimator: TokenEstimator) {}

  private defaultPriority(scope: MemoryBlock['scope']): number {
    return scopePriority(scope);
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
        } else if (block.scope === 'summary' && Array.isArray(block.source?.segments)) {
          // summary 组：裁掉最早版本段（保留最新段——最近的对话上下文更相关）
          const trimmed = this.trimSummarySegments(block, remaining);
          kept.push(trimmed);
          remaining = Math.max(0, remaining - this.tokensOf(trimmed));
          truncated = true;
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

  /**
   * 摘要块超预算 → 裁掉最早版本段（确定性：同输入同输出）。
   * 仍不放下最后一段时，对该段走通用比例截断（保留头部），绝不删除整块（摘要比旧消息更值钱）。
   */
  private trimSummarySegments(block: MemoryBlock, remaining: number): MemoryBlock {
    const segments = (block.source?.segments as string[]).filter((s) => typeof s === 'string');
    const full = segments.join('\n');
    // 块前缀（如【对话摘要】）不在版本段里：按"内容以全文结尾"还原，保持注入标记不变
    const prefix = block.content.endsWith(full) ? block.content.slice(0, block.content.length - full.length) : '';
    const kept = [...segments];
    while (kept.length > 1 && this.estimator.estimate(prefix + kept.join('\n')) > remaining) kept.shift();
    let content = prefix + kept.join('\n');
    if (this.estimator.estimate(content) > remaining) {
      const ratio = Math.max(0.05, remaining / Math.max(1, this.estimator.estimate(content)));
      content = content.slice(0, Math.max(1, Math.floor(content.length * ratio)));
    }
    return {
      ...block,
      content,
      tokenCount: this.estimator.estimate(content),
      source: { ...(block.source ?? {}), segments: kept, trimmedSegments: segments.length - kept.length },
    };
  }
}
