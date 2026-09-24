import { z } from 'zod';
import { Tool } from '../tool.types';
import { KnowledgeService } from '../../knowledge/knowledge.service';

/**
 * knowledge.search：Agent 主动检索知识库（Path B）。
 * 输入 schema 禁止身份字段——userId/projectId 一律来自 ToolContext。
 * Agent → Tool → KnowledgeService → KnowledgeRepository → pgvector（不直查 Prisma）。
 */
export function createKnowledgeSearchTool(knowledge: KnowledgeService): Tool {
  return {
    name: 'knowledge.search',
    description: '在用户知识库中检索相关内容（产品资料/品牌规范/操作手册等）。返回相关片段与来源文档。',
    permission: 'read',
    inputSchema: z.strictObject({
      query: z.string().min(1).max(2000),
      topK: z.number().int().min(1).max(10).optional(),
      similarityThreshold: z.number().min(0).max(1).optional(),
    }),
    execute: async (raw, ctx) => {
      const input = raw as { query: string; topK?: number; similarityThreshold?: number };
      const results = await knowledge.search(ctx.userId, ctx.projectId, input.query, {
        topK: input.topK,
        similarityThreshold: input.similarityThreshold,
      });
      return {
        count: results.length,
        results: results.map((r) => ({
          documentId: r.documentId,
          documentName: r.documentName,
          chunkIndex: r.chunkIndex,
          content: r.content.slice(0, 2000),
          similarity: Math.round(r.similarity * 1000) / 1000,
        })),
      };
    },
  };
}
