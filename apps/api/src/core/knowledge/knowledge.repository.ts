import { Inject, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { Prisma } from '@prisma/client';
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
 * P4：平台固定嵌入维度——与 `DocumentChunk.embedding vector(1536)` 及 HNSW 索引（vector_cosine_ops）一致。
 * 写入侧守卫：非该维度的向量一律拒绝（混合维度无法构成 ANN 索引，静默写入=坏数据）。
 */
export const EMBEDDING_DIMENSIONS = 1536;

/** 单条 INSERT 的最大行数（Postgres 绑定参数上限 65535；10 参数/行 → 保守取 500，超出分片仍为批量） */
const CHUNK_INSERT_BATCH = 500;

/**
 * P4 检索 SQL 构造器（导出：与运行时同一份 SQL，供 EXPLAIN 验证测试直接复用——绝不复制粘贴第二份）。
 * 形状约束（HNSW 索引可用性的充要条件）：
 * - `ORDER BY c.embedding <=> $vector`（**索引排序表达式**，非计算列排序）；
 * - 阈值以距离上界表达（`<=> <= 1 - threshold`），与相似度阈值数学等价；
 * - userId/projectId scope 下推 WHERE（HNSW 候选集后过滤，越权行绝不进入候选集）。
 * 注：pgvector 的 HNSW 有序扫描路径是**代价敏感**的——小表 + 低选择性过滤时 planner 仍可能选 Seq Scan+Sort
 * （10k 行量级实测稳定走索引；见 docs 与本模块测试的 EXPLAIN 断言：以 enable_sort=off 验证路径可用性）。
 */
export function buildSimilaritySearchSql(params: {
  userId: string; projectId?: string | null;
  queryEmbedding: number[]; topK: number; similarityThreshold: number;
}): Prisma.Sql {
  const vector = `[${params.queryEmbedding.join(',')}]`;
  const maxDistance = 1 - params.similarityThreshold; // 相似度阈值 → cosine 距离上界
  return Prisma.sql`
      SELECT c.id, c."documentId", d.name AS "documentName", c."chunkIndex", c.content,
             (1 - (c.embedding <=> ${vector}::vector)) AS similarity
      FROM "DocumentChunk" c
      JOIN "Document" d ON d.id = c."documentId"
      WHERE c."userId" = ${params.userId}
        AND (${params.projectId ?? null}::text IS NULL OR c."projectId" = ${params.projectId ?? null})
        AND c.embedding <=> ${vector}::vector <= ${maxDistance}
      ORDER BY c.embedding <=> ${vector}::vector
      LIMIT ${params.topK}
    `;
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

  /**
   * 批量插入 chunks（vector 列必须 raw SQL；参数化绑定，无注入风险）。
   * P4：
   * - **单条多 VALUES**（Prisma.join 拼参数化行）替代逐条 INSERT——N 次往返 → ⌈N/500⌉ 次；
   * - 写入侧维度守卫：非 EMBEDDING_DIMENSIONS 维向量 → 明确拒绝（绝不静默写坏数据/静默截断）；
   * - 超 500 行分片仍为批量（Postgres 绑定参数上限保护），语义与顺序（chunkIndex）不变。
   */
  async createChunks(
    documentId: string, userId: string, projectId: string | null, embeddingModel: string,
    chunks: Array<{ content: string; tokenCount: number; embedding: number[] }>,
  ): Promise<void> {
    if (!chunks.length) return;
    chunks.forEach((chunk, index) => {
      const actual = Array.isArray(chunk.embedding) ? chunk.embedding.length : 0;
      if (actual !== EMBEDDING_DIMENSIONS) {
        throw new AppError(
          ErrorCode.VALIDATION_ERROR,
          `embedding 维度非法（chunk #${index}）：期望 ${EMBEDDING_DIMENSIONS}，实际 ${actual}`,
        );
      }
    });
    for (let offset = 0; offset < chunks.length; offset += CHUNK_INSERT_BATCH) {
      const slice = chunks.slice(offset, offset + CHUNK_INSERT_BATCH);
      const rows = slice.map((chunk, index) => Prisma.sql`(
        ${randomUUID()}, ${documentId}, ${userId}, ${projectId}, ${offset + index},
        ${chunk.content}, ${chunk.tokenCount}, ${`[${chunk.embedding.join(',')}]`}::vector, ${embeddingModel}, now()
      )`);
      await this.prisma.$executeRaw(Prisma.sql`
        INSERT INTO "DocumentChunk" ("id", "documentId", "userId", "projectId", "chunkIndex", "content", "tokenCount", "embedding", "embeddingModel", "createdAt")
        VALUES ${Prisma.join(rows)}
      `);
    }
  }

  /**
   * 相似度搜索（cosine similarity = 1 - cosine distance）；权限过滤在 SQL 层完成。
   * P4：
   * - `ORDER BY c.embedding <=> $vector`（距离升序，**索引排序表达式**）替代 `ORDER BY (1 - (embedding <=> q)) DESC`
   *   ——后者是计算列排序，planner 无法走 `DocumentChunk_embedding_hnsw_idx`（全表扫描 + 排序）；
   * - 阈值以**距离上界**表达（`<=> 距离 <= 1 - threshold`，与相似度阈值数学等价），条件同样落在索引表达式上；
   * - userId/projectId scope 仍下推 WHERE（HNSW 索引扫描的候选集后过滤）——越权行绝不进入候选集。
   * 返回集合语义不变（topK 内、相似度 ≥ threshold、按相似度降序）。
   */
  async searchSimilarChunks(params: {
    userId: string; projectId?: string | null;
    queryEmbedding: number[]; topK: number; similarityThreshold: number;
  }): Promise<SearchResultChunk[]> {
    const rows = await this.prisma.$queryRaw<Array<{
      id: string; documentId: string; documentName: string; chunkIndex: number; content: string; similarity: number;
    }>>(buildSimilaritySearchSql(params));
    return rows.map((r) => ({ ...r, similarity: Number(r.similarity) }));
  }
}
