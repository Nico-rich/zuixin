import { Inject, Injectable } from '@nestjs/common';
import { PrismaService } from '../../modules/prisma/prisma.service';
import { ChatMessage } from '../../providers/llm/llm.types';
import { AssembleContext, DEFAULT_RECENT_MESSAGES_LIMIT, MemoryBlock, MemorySource } from './types';

/**
 * 上下文组装器——Agent 上下文的唯一入口。
 * M1 仅内置"最近会话消息"源（行为与原先 ChatService.buildHistory 完全一致）；
 * 未来 System Prompt / Conversation Summary / User Memory / Project Memory / KB 检索
 * 均以 MemorySource 注册接入（M6+），本文件之外的组装逻辑不应再出现。
 */
@Injectable()
export class ContextAssembler {
  private readonly sources: MemorySource[] = [];

  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {
    // 内置源：最近会话消息（M1 唯一数据源）
    this.sources.push({ scope: 'conversation', collect: (ctx) => this.collectRecentMessages(ctx) });
  }

  /** 注册未来数据源（M6+：摘要/Memory/KB）；注册即参与组装 */
  register(source: MemorySource): void {
    this.sources.push(source);
  }

  /** 组装上下文：执行全部已注册源 → 按 order 排序 → 映射为 LLM 消息列表 */
  async assemble(ctx: AssembleContext): Promise<{ messages: ChatMessage[]; blocks: MemoryBlock[] }> {
    const blocks: MemoryBlock[] = [];
    for (const source of this.sources) {
      blocks.push(...(await source.collect(ctx)));
    }
    blocks.sort((a, b) => (a.order ?? 100) - (b.order ?? 100));
    const messages = blocks.map((b) => ({ role: b.role, content: b.content }) as ChatMessage);
    return { messages, blocks };
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
    }));
  }
}
