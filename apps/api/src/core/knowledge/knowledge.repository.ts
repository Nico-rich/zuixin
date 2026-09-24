import { Inject, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { PrismaService } from '../../modules/prisma/prisma.service';
import { AppError, ErrorCode } from '../../common/errors/app-error';

export interface SearchResultChunk {
  id: string;
  documentId: string;
  documentName: string;
  chunkIndex: number;
  content: string;
  similarity: number;
}

/**
 * Knowledge 数据访问层——唯一允许出现 pgvector raw SQL 的位置（$executeRaw/$queryRaw 全部封装于此）。
 * 业务层（KnowledgeService/KnowledgeSource/Tool）不得直接写 raw SQL。
 * 权限过滤（userId / projectId）全部下推到 SQL WHERE。
 */
@Injectable()
export class KnowledgeRepository {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  async createDocument(input: {
    userId: string; projectId?: string; kbId?: string;
    name: string; sourceType: 'text' | 'file';
    content?: string; storageKey?: string; mimeType?: string; sizeBytes?: number; contentHash?: string;
  }) {
    if (input.projectId) {
      const p = await this.prisma.project.findFirst({ where: { id: input.projectId, userId: input.userId, deletedAt: null } });
      if (!p) throw new AppError(ErrorCode.NOT_FOUND, '项目不存在');
    }
    return this.prisma.document.create({
      data: {
        userId: input.userId, projectId: input.projectId, kbId: input.kbId,
        name: input.name, sourceType: input.sourceType,
        content: input.content, storageKey: input.storageKey,
        mimeType: input.mimeType, sizeBytes: input.sizeBytes, contentHash: input.contentHash,
        status: 'pending',
      },
    });
  }

  async getDocument(userId: string, id: string) {
    const doc = await this.prisma.document.findFirst({ where: { id, userId }, include: { chunks: false } });
    if (!doc) throw new AppError(ErrorCode.NOT_FOUND, '文档不存在');
    return doc;
  }

  async listDocuments(userId: string, projectId?: string) {
    return this.prisma.document.findMany({
      where: { userId, ...(projectId ? { projectId } : {}) },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
  }

  async updateDocumentStatus(userId: string, id: string, data: { status: 'processing' | 'ready' | 'failed'; errorCode?: string; chunkCount?: number; version?: { increment: number } }) {
    const done = await this.prisma.document.updateMany({ where: { id, userId }, data });
    if (done.count === 0) throw new AppError(ErrorCode.NOT_FOUND, '文档不存在');
  }

  async deleteDocument(userId: string, id: string) {
    const done = await this.prisma.document.deleteMany({ where: { id, userId } });
    if (done.count === 0) throw new AppError(ErrorCode.NOT_FOUND, '文档不存在');
    // chunks 级联删除（FK ON DELETE CASCADE），无孤儿数据
  }

  async deleteChunks(documentId: string): Promise<void> {
    await this.prisma.$executeRaw`DELETE FROM "DocumentChunk" WHERE "documentId" = ${documentId}`;
  }

  /** 批量插入 chunks（vector 列必须 raw SQL；参数化绑定，无注入风险） */
  async createChunks(
    documentId: string, userId: string, projectId: string | null, embeddingModel: string,
    chunks: Array<{ content: string; tokenCount: number; embedding: number[] }>,
  ): Promise<void> {
    for (let i = 0; i < chunks.length; i++) {
      const c = chunks[i];
      const vector = `[${c.embedding.join(',')}]`;
      await this.prisma.$executeRaw`
        INSERT INTO "DocumentChunk" ("id", "documentId", "userId", "projectId", "chunkIndex", "content", "tokenCount", "embedding", "embeddingModel", "createdAt")
        VALUES (${randomUUID()}, ${documentId}, ${userId}, ${projectId}, ${i}, ${c.content}, ${c.tokenCount}, ${vector}::vector, ${embeddingModel}, now())
      `;
    }
  }

  /** 相似度搜索（cosine = 1 - <=> 距离）；权限过滤在 SQL 层完成 */
  async searchSimilarChunks(params: {
    userId: string; projectId?: string | null;
    queryEmbedding: number[]; topK: number; similarityThreshold: number;
  }): Promise<SearchResultChunk[]> {
    const vector = `[${params.queryEmbedding.join(',')}]`;
    const rows = await this.prisma.$queryRaw<Array<{
      id: string; documentId: string; documentName: string; chunkIndex: number; content: string; similarity: number;
    }>>`
      SELECT c.id, c."documentId", d.name AS "documentName", c."chunkIndex", c.content,
             (1 - (c.embedding <=> ${vector}::vector)) AS similarity
      FROM "DocumentChunk" c
      JOIN "Document" d ON d.id = c."documentId"
      WHERE c."userId" = ${params.userId}
        AND (${params.projectId ?? null}::text IS NULL OR c."projectId" = ${params.projectId ?? null})
        AND (1 - (c.embedding <=> ${vector}::vector)) >= ${params.similarityThreshold}
      ORDER BY similarity DESC
      LIMIT ${params.topK}
    `;
    return rows.map((r) => ({ ...r, similarity: Number(r.similarity) }));
  }
}
