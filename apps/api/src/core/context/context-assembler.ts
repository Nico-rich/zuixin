import { Inject, Injectable } from '@nestjs/common';
import { PrismaService } from '../../modules/prisma/prisma.service';
import { ChatMessage } from '../../providers/llm/llm.types';
import { AssembleContext, DEFAULT_RECENT_MESSAGES_LIMIT, MemoryBlock, MemorySource } from './types';
import { ContextBudgetService } from './context-budget.service';

const DEFAULT_CONTEXT_BUDGET_TOKENS = 8000;

/**
 * 上下文组装器——Agent 上下文的唯一入口：
 * Sources 提供候选块 → 本服务收集/排序 → ContextBudgetService 统一预算决策 → LLM 消息列表。
 * 任何 Source 不得自行截断（P6 原则）；预算来源：ctx.budgetTokens（AgentVersion 配置）→ limits.contextBudgetTokens → 8000。
 */
@Injectable()
export class ContextAssembler {
  private readonly sources: MemorySource[] = [];

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(ContextBudgetService) private readonly budgetService: ContextBudgetService,
  ) {
    // 内置源：最近会话消息（M1 唯一数据源）
    this.sources.push({ scope: 'conversation', collect: (ctx) => this.collectRecentMessages(ctx) });
  }

  /** 注册数据源（Memory/Knowledge/未来 Summary 等）；注册即参与组装 */
  register(source: MemorySource): void {
    this.sources.push(source);
  }

  /** 组装上下文：收集 → order 排序 → Budget 截断 → 映射为 LLM 消息列表 */
  async assemble(ctx: AssembleContext): Promise<{ messages: ChatMessage[]; blocks: MemoryBlock[]; truncated: boolean }> {
    const blocks: MemoryBlock[] = [];
    for (const source of this.sources) {
      blocks.push(...(await source.collect(ctx)));
    }
    blocks.sort((a, b) => (a.order ?? 100) - (b.order ?? 100));
    const budget = await this.resolveBudget(ctx);
    const budgeted = this.budgetService.apply(blocks, { maxTokens: budget });
    const messages = budgeted.blocks.map((b) => ({ role: b.role, content: b.content }) as ChatMessage);
    return { messages, blocks: budgeted.blocks, truncated: budgeted.truncated };
  }

  /** 预算解析：AgentVersion 配置 > limits.contextBudgetTokens > 8000（服务端配置，Tool/用户不可改） */
  private async resolveBudget(ctx: AssembleContext): Promise<number> {
    if (ctx.budgetTokens != null && Number.isInteger(ctx.budgetTokens) && ctx.budgetTokens > 0 && ctx.budgetTokens <= 32000) {
      return ctx.budgetTokens;
    }
    const limits = await this.prisma.systemSetting.findUnique({ where: { key: 'limits' } });
    const configured = (limits?.value as { contextBudgetTokens?: number } | null)?.contextBudgetTokens;
    if (configured != null && Number.isInteger(configured) && configured > 0 && configured <= 32000) return configured;
    return DEFAULT_CONTEXT_BUDGET_TOKENS;
  }

  /** 内置源：最近会话消息——倒序取 limit 条后反转为时间正序（与 M1 行为逐字一致） */
  private async collectRecentMessages(ctx: AssembleContext): Promise<MemoryBlock[]> {
    const limit = ctx.recentMessagesLimit ?? DEFAULT_RECENT_MESSAGES_LIMIT;
    const rows = await this.prisma.message.findMany({
      where: {
        conversationId: ctx.conversationId,
        ...(ctx.excludeMessageId ? { id: { not: ctx.excludeMessageId } } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: limit,
      select: { role: true, content: true, id: true },
    });
    return rows.reverse().map((m) => ({
      scope: 'conversation',
      role: m.role as ChatMessage['role'],
      content: m.content,
      tokenCount: Math.ceil(m.content.length / 2),
    }));
  }
}
