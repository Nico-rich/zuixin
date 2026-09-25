import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/modules/prisma/prisma.service';
import { KnowledgeRepository, buildSimilaritySearchSql, EMBEDDING_DIMENSIONS } from '../src/core/knowledge/knowledge.repository';

/**
 * Pre-M9 P4 e2e（真实 pgvector）：
 * - 检索语义：阈值（相似度 → 距离上界）、topK、按相似度降序、userId/projectId scope 隔离；
 * - 索引可用性：`EXPLAIN` 断言 ORDER BY 距离表达式走 DocumentChunk_embedding_hnsw_idx（杜绝退回全表排序）；
 * - 写入侧维度守卫：非 1536 维拒绝入库。
 * 注：HNSW 有序扫描路径是**代价敏感**的——小表 + 低选择性过滤时 planner 仍可能选 Seq Scan+Sort。
 * EXPLAIN 断言用 enable_sort/enable_seqscan/enable_bitmapscan=off（同一事务、同一连接）验证「路径可用」，
 * 与表大小无关；真实规模下的耗时对比见 P4 报告（10k 行 10x+）。
 */
const DIMS = EMBEDDING_DIMENSIONS;

/** 与 q=e0 的 cosine 相似度 = c */
const vecWithCos = (c: number) => Array.from({ length: DIMS }, (_, i) => (i === 0 ? c : i === 1 ? Math.sqrt(1 - c * c) : 0));
const e0 = () => vecWithCos(1);

describe('Pre-M9 P4 向量检索（pgvector HNSW）', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let repo: KnowledgeRepository;
  let userId: string;
  let otherUserId: string;
  let docId: string;
  let otherDocId: string;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    prisma = moduleRef.get(PrismaService);
    repo = new KnowledgeRepository(prisma);
    const stamp = Date.now();
    const user = await prisma.user.create({ data: { email: `p4e2e-${stamp}@example.com`, passwordHash: 'x' } });
    const other = await prisma.user.create({ data: { email: `p4e2e-other-${stamp}@example.com`, passwordHash: 'x' } });
    userId = user.id;
    otherUserId = other.id;
    const doc = await prisma.document.create({ data: { userId, name: 'P4 e2e', sourceType: 'text', content: 'x', status: 'ready' } });
    const otherDoc = await prisma.document.create({ data: { userId: otherUserId, name: 'P4 e2e other', sourceType: 'text', content: 'x', status: 'ready' } });
    docId = doc.id;
    otherDocId = otherDoc.id;

    await repo.createChunks(docId, userId, null, 'mock-embedding', [
      { content: 'k0 (cos 1.0)', tokenCount: 3, embedding: vecWithCos(1) },
      { content: 'k1 (cos 0.9)', tokenCount: 3, embedding: vecWithCos(0.9) },
      { content: 'k2 (cos 0.6)', tokenCount: 3, embedding: vecWithCos(0.6) },
      { content: 'k3 (cos 0.1)', tokenCount: 3, embedding: vecWithCos(0.1) },
    ]);
    await repo.createChunks(otherDocId, otherUserId, null, 'mock-embedding', [
      { content: '他人文档最相似块', tokenCount: 3, embedding: vecWithCos(1) },
    ]);
  });

  afterAll(async () => {
    await prisma.document.deleteMany({ where: { userId: { in: [userId, otherUserId] } } }); // chunks 级联
    await prisma.user.deleteMany({ where: { id: { in: [userId, otherUserId] } } });
    await app.close();
  });

  it('批量写入落库：4 块全部写入（单条多 VALUES，chunkIndex 0..3）', async () => {
    const rows = await prisma.documentChunk.findMany({ where: { documentId: docId }, orderBy: { chunkIndex: 'asc' } });
    expect(rows.map((r) => r.chunkIndex)).toEqual([0, 1, 2, 3]);
    expect(rows.map((r) => r.content)).toEqual(['k0 (cos 1.0)', 'k1 (cos 0.9)', 'k2 (cos 0.6)', 'k3 (cos 0.1)']);
  });

  it('检索语义：阈值过滤 + topK + 相似度降序（阈值以距离上界等价表达）', async () => {
    const hits = await repo.searchSimilarChunks({ userId, projectId: null, queryEmbedding: e0(), topK: 5, similarityThreshold: 0.5 });
    // 0.1 低于阈值 → 过滤；其余按相似度降序
    expect(hits.map((h) => h.content)).toEqual(['k0 (cos 1.0)', 'k1 (cos 0.9)', 'k2 (cos 0.6)']);
    expect(hits[0].similarity).toBeCloseTo(1, 5);
    expect(hits[1].similarity).toBeCloseTo(0.9, 4);
    expect(hits[2].similarity).toBeCloseTo(0.6, 4);
    expect(hits.every((h) => h.similarity >= 0.5)).toBe(true);

    const top2 = await repo.searchSimilarChunks({ userId, projectId: null, queryEmbedding: e0(), topK: 2, similarityThreshold: 0.5 });
    expect(top2.map((h) => h.content)).toEqual(['k0 (cos 1.0)', 'k1 (cos 0.9)']);

    const strict = await repo.searchSimilarChunks({ userId, projectId: null, queryEmbedding: e0(), topK: 5, similarityThreshold: 0.95 });
    expect(strict.map((h) => h.content)).toEqual(['k0 (cos 1.0)']);
  });

  it('scope 隔离：他人 userId 的块绝不进入候选集', async () => {
    const hits = await repo.searchSimilarChunks({ userId, projectId: null, queryEmbedding: e0(), topK: 10, similarityThreshold: 0.5 });
    expect(hits.some((h) => h.documentId === otherDocId)).toBe(false);
    expect(hits.every((h) => h.documentName === 'P4 e2e')).toBe(true);
  });

  it('scope 隔离：projectId 指定时只返回该项目块（同一 userId 下）', async () => {
    const doc3 = await prisma.document.create({ data: { userId, projectId: null, name: 'P4 e2e p1', sourceType: 'text', content: 'x', status: 'ready' } });
    const project = await prisma.project.create({ data: { userId, name: 'P4 proj' } });
    await prisma.document.update({ where: { id: doc3.id }, data: { projectId: project.id } });
    await repo.createChunks(doc3.id, userId, project.id, 'mock-embedding', [{ content: '项目内块', tokenCount: 3, embedding: e0() }]);

    const scoped = await repo.searchSimilarChunks({ userId, projectId: project.id, queryEmbedding: e0(), topK: 10, similarityThreshold: 0.5 });
    expect(scoped.map((h) => h.content)).toEqual(['项目内块']);
    const unscoped = await repo.searchSimilarChunks({ userId, projectId: null, queryEmbedding: e0(), topK: 10, similarityThreshold: 0.5 });
    expect(unscoped.some((h) => h.content === '项目内块')).toBe(true); // null = 不按项目过滤

    await prisma.document.delete({ where: { id: doc3.id } });
    await prisma.project.delete({ where: { id: project.id } });
  });

  it('维度守卫：768 维向量被拒绝入库（明确报错，绝不静默写坏数据）', async () => {
    const before = await prisma.documentChunk.count({ where: { documentId: docId } });
    await expect(repo.createChunks(docId, userId, null, 'mock-embedding', [
      { content: 'bad', tokenCount: 1, embedding: new Array(768).fill(0.1) },
    ])).rejects.toThrow(/期望 1536，实际 768/);
    expect(await prisma.documentChunk.count({ where: { documentId: docId } })).toBe(before); // 无部分写入
  });

  it('EXPLAIN：ORDER BY 距离表达式走 HNSW 索引（且无需 Sort）；旧形状（计算列排序）走不到索引', async () => {
    // Prisma Sql 的 .sql 使用 `?` 占位符；EXPLAIN 需 $n 形式（值顺序不变）
    const toPositional = (q: { sql: string; values: unknown[] }) => {
      let i = 0;
      return { text: q.sql.replace(/\?/g, () => `$${++i}`), values: q.values };
    };
    const params = { userId, projectId: null, queryEmbedding: e0(), topK: 5, similarityThreshold: 0.5 };
    const newQ = toPositional(buildSimilaritySearchSql(params));
    // Pre-P4 旧形状：ORDER BY 计算列（similarity DESC）+ 相似度阈值
    const oldQ = {
      text: `SELECT c.id, c."documentId", d.name AS "documentName", c."chunkIndex", c.content, (1 - (c.embedding <=> $2::vector)) AS similarity
FROM "DocumentChunk" c JOIN "Document" d ON d.id = c."documentId"
WHERE c."userId" = $1 AND ($3::text IS NULL OR c."projectId" = $3) AND (1 - (c.embedding <=> $2::vector)) >= $4
ORDER BY similarity DESC LIMIT $5`,
      values: [userId, `[${e0().join(',')}]`, null, 0.5, 5],
    };
    await prisma.$executeRawUnsafe(`ANALYZE "DocumentChunk"`);
    const explain = async (q: { text: string; values: unknown[] }) =>
      prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`SET LOCAL enable_sort = off`);
        await tx.$executeRawUnsafe(`SET LOCAL enable_seqscan = off`);
        await tx.$executeRawUnsafe(`SET LOCAL enable_bitmapscan = off`);
        const rows = await tx.$queryRawUnsafe<Array<Record<string, string>>>('EXPLAIN ' + q.text, ...q.values);
        return rows.map((r) => Object.values(r)[0]).join('\n');
      }, { timeout: 60000 });

    const newPlan = await explain(newQ);
    expect(newPlan).toContain('DocumentChunk_embedding_hnsw_idx'); // 索引排序表达式 → HNSW
    expect(newPlan).not.toMatch(/\bSort\b/); // 有序索引扫描，无排序步骤

    const oldPlan = await explain(oldQ);
    expect(oldPlan).not.toContain('DocumentChunk_embedding_hnsw_idx'); // 计算列排序：索引无能为力
    expect(oldPlan).toMatch(/\bSort\b/); // 只能排序（本测试已关闭 sort 仍被迫选择 → 证明无索引路径）
  }, 60000);

  it('等价性：距离上界阈值与相似度阈值返回同一集合（新旧语义一致）', async () => {
    const byDistance = await repo.searchSimilarChunks({ userId, projectId: null, queryEmbedding: e0(), topK: 10, similarityThreshold: 0.5 });
    const oldForm = await prisma.$queryRawUnsafe<Array<{ content: string }>>(
      `SELECT c.content, (1 - (c.embedding <=> $2::vector)) AS similarity FROM "DocumentChunk" c JOIN "Document" d ON d.id = c."documentId"
       WHERE c."userId" = $1 AND ($3::text IS NULL OR c."projectId" = $3) AND (1 - (c.embedding <=> $2::vector)) >= $4
       ORDER BY similarity DESC LIMIT $5`,
      userId, `[${e0().join(',')}]`, null, 0.5, 10,
    );
    expect(byDistance.map((h) => h.content)).toEqual(oldForm.map((r) => r.content));
  });
});
