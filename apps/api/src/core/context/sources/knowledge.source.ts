import { Inject } from '@nestjs/common';
import { KnowledgeService } from '../../knowledge/knowledge.service';
import { AssembleContext, CONTEXT_ORDER, MemoryBlock, MemoryScope, MemorySource } from '../types';

const KNOWLEDGE_TOP_K = 3;
const KNOWLEDGE_SCORE_THRESHOLD = 0.3;
const KNOWLEDGE_MAX_CHUNK_CHARS = 2000;

/**
 * KnowledgeSource（Path A）：Agent 配置 knowledge.enabled 时才自动检索——
 * 普通聊天不触发 embedding/search。检索结果以引用块注入上下文（order=knowledge）。
 */
export class KnowledgeSource implements MemorySource {
  readonly scope: MemoryScope = 'knowledge';
  constructor(@Inject(KnowledgeService) private readonly knowledge: KnowledgeService) {}

  async collect(ctx: AssembleContext): Promise<MemoryBlock[]> {
    if (!ctx.knowledge?.enabled) return [];
    if (!ctx.userMessage?.trim()) return [];
    const results = await this.knowledge.search(ctx.userId, ctx.projectId, ctx.userMessage, {
      topK: KNOWLEDGE_TOP_K,
      similarityThreshold: KNOWLEDGE_SCORE_THRESHOLD,
    });
    return results.map((r) => ({
      scope: 'knowledge' as const,
      role: 'user' as const,
      content: `[Knowledge]\nSource: ${r.documentName}\n${r.content.slice(0, KNOWLEDGE_MAX_CHUNK_CHARS)}`,
      order: CONTEXT_ORDER.knowledge,
      tokenCount: Math.ceil(r.content.length / 2),
      source: { kind: 'knowledge', documentId: r.documentId, documentName: r.documentName, chunkIndex: r.chunkIndex, similarity: r.similarity },
    }));
  }
}
