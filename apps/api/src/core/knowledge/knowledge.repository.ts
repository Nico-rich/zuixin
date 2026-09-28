import { Inject, Injectable, Logger } from '@nestjs/common';
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

// ─────────────────────────────────────────────────────────────────────────────
// M11-P14（NV-10）HNSW 规模交叉点实验结论 —— 检索期 GUC 的取值依据
//
// 实验（scratch 库，一次性、用完即删；形状与生产一致：1536 维向量、content 800 字符/行=chunking 默认、
// userId scope 下推、距离上界=1-0.3、LIMIT 5；二维扫描 = 行数(1e3~3e5) × random_page_cost(1.0~8.0)，
// `EXPLAIN (ANALYZE, BUFFERS)` 实测，索引参数 = 生产默认 m=16/ef_construction=64）：
//
//   行数    rpc=1.0   rpc=1.1   rpc=2.0   rpc=4.0(PG 默认)   rpc=8.0
//   1e3     HNSW      HNSW      HNSW      **Seq+Sort**       Seq+Sort
//   3e3     HNSW      HNSW      Seq+Sort  Seq+Sort           Seq+Sort
//   1e4     HNSW      HNSW      HNSW      HNSW               Seq+Sort
//   3e4     HNSW      HNSW      HNSW      HNSW               Seq+Sort
//   1e5     HNSW      HNSW      HNSW      HNSW               HNSW
//   3e5     HNSW      HNSW      HNSW      HNSW               HNSW
//
// 同一查询的实测耗时（同一数据、同一 SQL，只换 planner 的选择）：
//   Seq+Sort 命中时：3e3 行 21.9ms / 1e4 行 3175ms / 3e4 行 7609ms / 1e5 行 >60s（statement_timeout 截断）
//   HNSW 命中时：    1e3~3e5 行全部 0.4~0.8ms（ef_search=40；ef_search 40→400 仍为 0.4~3ms 量级）
//   → 规划器选错时代价 30×~12000×，且**不随规模单调**（3e3~3e5 段都可能退回 Seq+Sort）。
//
// 为什么默认 rpc=4.0 会选错：宽向量列被 TOAST 存到行外，顺序扫描每行都要额外取一次 TOAST 页，
// 而 planner 的代价模型只看**堆页**（看不到 TOAST 取列成本），于是把 Seq+Sort 估得远比实际便宜。
// 因此"到多大数据量才自动生效"这个问题没有安全答案——**必须把检索期 GUC 显式钉死**。
//
// 结论（本模块据此固定，作用域=本次检索的显式事务，不污染连接池里的其它查询）：
//   1) random_page_cost 取 SSD 口径 1.1：实测在 1e3~3e5 行**全部**选择 HNSW 有序扫描；
//   2) hnsw.ef_search 默认保持 pgvector 默认值 40（时延最优区间；更大值只买到合成语料上分辨不出的召回，
//      真实 embedding 分布的召回率 NOT VERIFIED，故不做无依据的上调）；
//   3) 两个值都可用 env 覆盖（不同磁盘/不同召回要求），非法值 → 回退默认并 warn（检索绝不因调参挂掉）。
// ─────────────────────────────────────────────────────────────────────────────

/** HNSW 检索期 hnsw.ef_search（env 覆盖；默认 40 = pgvector 默认） */
export const HNSW_EF_SEARCH_ENV = 'KNOWLEDGE_HNSW_EF_SEARCH';
/** HNSW 检索期 random_page_cost（env 覆盖；默认 1.1 = SSD 口径） */
export const HNSW_RANDOM_PAGE_COST_ENV = 'KNOWLEDGE_HNSW_RANDOM_PAGE_COST';
const DEFAULT_HNSW_EF_SEARCH = 40;
const DEFAULT_HNSW_RANDOM_PAGE_COST = 1.1;
const hnswLogger = new Logger('KnowledgeRepository');

/** 解析并校验 env（非法 → 回退默认 + warn，绝不让一次调参把检索打挂） */
export function parseHnswSetting(raw: string | undefined, fallback: number, min: number, max: number, name: string): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < min || value > max) {
    hnswLogger.warn(`${name}="${raw}" 非法（允许 ${min}~${max}）→ 回退默认 ${fallback}`);
    return fallback;
  }
  return value;
}

export const resolveHnswEfSearch = (env: NodeJS.ProcessEnv = process.env): number =>
  parseHnswSetting(env[HNSW_EF_SEARCH_ENV], DEFAULT_HNSW_EF_SEARCH, 1, 1000, HNSW_EF_SEARCH_ENV);

export const resolveHnswRandomPageCost = (env: NodeJS.ProcessEnv = process.env): number =>
  parseHnswSetting(env[HNSW_RANDOM_PAGE_COST_ENV], DEFAULT_HNSW_RANDOM_PAGE_COST, 0, 100, HNSW_RANDOM_PAGE_COST_ENV);

/**
 * P4 检索 SQL 构造器（导出：与运行时同一份 SQL，供 EXPLAIN 验证测试直接复用——绝不复制粘贴第二份）。
 * 形状约束（HNSW 索引可用性的充要条件）：
 * - `ORDER BY c.embedding <=> $vector`（**索引排序表达式**，非计算列排序）；
 * - 阈值以距离上界表达（`<=> <= 1 - threshold`），与相似度阈值数学等价；
 * - userId/projectId scope 下推 WHERE（HNSW 候选集后过滤，越权行绝不进入候选集）。
 * 注：形状正确只是**必要**条件——pgvector 的 HNSW 有序扫描路径是**代价敏感**的，默认 random_page_cost=4.0
 * 下 1e3~3e5 行区间 planner 会随机性地退回 Seq Scan+Sort（宽向量 TOAST 取列成本不在代价模型里）。
 * P14（M11）起检索在显式事务内钉死检索期 GUC（见 `searchSimilarChunks` 与文件头的实测交叉点表），
 * 使该形状在本模块的调用路径上**必定**走索引；EXPLAIN 断言（enable_sort=off）只用于验证"路径可用"。
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
   *
   * M11-P14：形状正确**不足以**让 planner 选 HNSW——代价模型看不到 TOAST 取列成本，默认
   * random_page_cost=4.0 下 1e3~3e5 行区间会随机性地退回 Seq+Sort（实测慢 30×~12000×，
   * 见文件头实验表）。故检索在**显式事务**内先钉死检索期 GUC（`set_config(..., is_local=true)`
   * 等价 `SET LOCAL`，事务结束即失效，绝不泄漏到连接池里的其它查询），再执行同一份 SQL。
   */
  async searchSimilarChunks(params: {
    userId: string; projectId?: string | null;
    queryEmbedding: number[]; topK: number; similarityThreshold: number;
  }): Promise<SearchResultChunk[]> {
    const efSearch = resolveHnswEfSearch();
    const randomPageCost = resolveHnswRandomPageCost();
    const rows = await this.prisma.$transaction(
      async (tx) => {
        // 单次往返同时落两个 GUC（值经 env 校验后以 text 绑定，无拼接注入面）
        await tx.$queryRaw`SELECT set_config('hnsw.ef_search', ${String(efSearch)}, true) AS ef_search,
                                  set_config('random_page_cost', ${String(randomPageCost)}, true) AS random_page_cost`;
        return tx.$queryRaw<Array<{
          id: string; documentId: string; documentName: string; chunkIndex: number; content: string; similarity: number;
        }>>(buildSimilaritySearchSql(params));
      },
      { timeout: 15_000, maxWait: 10_000 },
    );
    return rows.map((r) => ({ ...r, similarity: Number(r.similarity) }));
  }
}
