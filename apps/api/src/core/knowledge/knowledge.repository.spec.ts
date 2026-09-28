import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  KnowledgeRepository, EMBEDDING_DIMENSIONS, buildSimilaritySearchSql,
  HNSW_EF_SEARCH_ENV, HNSW_RANDOM_PAGE_COST_ENV, parseHnswSetting, resolveHnswEfSearch, resolveHnswRandomPageCost,
} from './knowledge.repository';
import { AppError, ErrorCode } from '../../common/errors/app-error';

interface Captured {
  sql: string;
  values: unknown[];
  tagged: boolean;
}

/**
 * 捕获 raw SQL 调用的假 Prisma（同时支持 `$queryRaw(sql对象)` 与 tagged template 两种调用形态）。
 * P14：检索走**显式事务**（事务内 SET LOCAL 检索期 GUC）——假 `$transaction` 把回调直接跑在同一个
 * 假客户端上，并记录事务开启次数（用于断言"GUC 限定在事务内、不泄漏到连接池"）。
 */
function makePrisma(rows: unknown[] = []) {
  const executeRaw: Captured[] = [];
  const queryRaw: Captured[] = [];
  const capture = (list: Captured[]) =>
    (...args: unknown[]) => {
      if (Array.isArray(args[0])) {
        // tagged template：strings 为模板数组，其余为插值
        list.push({ sql: (args[0] as string[]).join('$'), values: args.slice(1), tagged: true });
      } else {
        const q = args[0] as { sql: string; values: unknown[] };
        list.push({ sql: q.sql, values: q.values, tagged: false });
      }
      return Promise.resolve(rows);
    };
  const client = { $executeRaw: vi.fn(capture(executeRaw)), $queryRaw: vi.fn(capture(queryRaw)) };
  const transaction = vi.fn(async (fn: (tx: typeof client) => Promise<unknown>) => fn(client));
  const prisma = { ...client, $transaction: transaction };
  return { prisma: prisma as never, executeRaw, queryRaw, transaction };
}

/** 检索语句（剔除事务内的 GUC 设置语句）；GUC 语句单独由 gucsOf 断言 */
const searchCalls = (calls: Captured[]) => calls.filter((c) => c.sql.includes('ORDER BY c.embedding'));
const gucCall = (calls: Captured[]) => calls.find((c) => c.sql.includes('set_config'))!;

const vector = (dims: number, fill = 0.1) => new Array(dims).fill(fill);
const chunks = (n: number) =>
  Array.from({ length: n }, (_, i) => ({ content: `c${i}`, tokenCount: 5, embedding: vector(EMBEDDING_DIMENSIONS, i / 1000) }));

/** 从扁平绑定参数取每行 chunkIndex（列序：id,documentId,userId,projectId,chunkIndex,content,tokenCount,embedding,model；createdAt 为 now() 字面量，不占绑定位） */
const chunkIndexes = (values: unknown[]) => values.filter((_, i) => i % 9 === 4) as number[];

describe('KnowledgeRepository（P4：批量写入 + 维度守卫 + 索引化检索 SQL）', () => {
  it('维度守卫：非 1536 维**在任何写入前**被拒绝（明确报错，绝不静默插坏数据）', async () => {
    const { prisma, executeRaw } = makePrisma();
    const repo = new KnowledgeRepository(prisma);
    const bad = [{ content: 'x', tokenCount: 1, embedding: vector(768) }];
    await expect(repo.createChunks('doc-1', 'u1', null, 'm', bad)).rejects.toBeInstanceOf(AppError);
    await expect(repo.createChunks('doc-1', 'u1', null, 'm', bad)).rejects.toMatchObject({ code: ErrorCode.VALIDATION_ERROR });
    expect(executeRaw).toHaveLength(0);
  });

  it('维度守卫：批量中任一行非法 → 整批拒绝（无部分写入）', async () => {
    const { prisma, executeRaw } = makePrisma();
    const repo = new KnowledgeRepository(prisma);
    const batch = [...chunks(3), { content: 'bad', tokenCount: 1, embedding: vector(1024) }];
    await expect(repo.createChunks('doc-1', 'u1', null, 'm', batch)).rejects.toThrow(/期望 1536，实际 1024/);
    expect(executeRaw).toHaveLength(0);
  });

  it('批量写入：1200 行 = ⌈1200/500⌉ = 3 条多 VALUES INSERT（替代 1200 次往返）', async () => {
    const { prisma, executeRaw } = makePrisma();
    await new KnowledgeRepository(prisma).createChunks('doc-1', 'u1', 'p1', 'm', chunks(1200));

    expect(executeRaw).toHaveLength(3);
    expect(executeRaw.map((c) => (c.sql.match(/\?::vector/g) ?? []).length)).toEqual([500, 500, 200]); // 每行一个值组（vector 绑定）
    expect(executeRaw.map((c) => c.values.length)).toEqual([4500, 4500, 1800]); // 9 列/行全参数化绑定（createdAt 为 now() 字面量）
    for (const call of executeRaw) {
      expect(call.sql).toContain('INSERT INTO "DocumentChunk"');
      expect(call.sql.match(/VALUES/g)).toHaveLength(1); // 单条语句，而非逐行拼接
    }
    // chunkIndex 跨分片连续 0..1199（分片不改变写入语义与顺序）
    expect(chunkIndexes(executeRaw.flatMap((c) => c.values))).toEqual(Array.from({ length: 1200 }, (_, i) => i));
    expect(executeRaw[0].values.filter((v) => v === 'doc-1')).toHaveLength(500);
    expect(executeRaw[0].values.filter((v) => v === 'p1')).toHaveLength(500);
  });

  it('空数组：不产生任何 SQL 往返', async () => {
    const { prisma, executeRaw } = makePrisma();
    await new KnowledgeRepository(prisma).createChunks('doc-1', 'u1', null, 'm', []);
    expect(executeRaw).toHaveLength(0);
  });

  it('检索 SQL 形状：ORDER BY 距离表达式（非计算列）+ 距离上界阈值 + scope 下推 + LIMIT 参数化', async () => {
    const { prisma, queryRaw } = makePrisma([{ id: 'k1', documentId: 'd1', documentName: 'D', chunkIndex: 0, content: 'x', similarity: '0.8123' }]);
    const rows = await new KnowledgeRepository(prisma).searchSimilarChunks({
      userId: 'u1', projectId: null, queryEmbedding: vector(EMBEDDING_DIMENSIONS, 0.2), topK: 5, similarityThreshold: 0.3,
    });

    expect(searchCalls(queryRaw)).toHaveLength(1); // 检索只发一条语句（另一条是事务内 GUC 设置）
    const { sql, values } = searchCalls(queryRaw)[0];
    expect(sql).toContain('ORDER BY c.embedding <=> '); // 索引排序表达式（HNSW 可用前提）
    expect(sql).not.toContain('ORDER BY similarity'); // 旧形状：计算列排序 → 必然 Sort
    expect(values).toContain(0.7); // 距离上界 = 1 - threshold(0.3)，落在同一条索引表达式上
    expect(values).toContain('u1'); // scope 下推 WHERE
    expect(values).toContain(5); // topK 绑定
    expect(values.filter((v) => v === null)).toHaveLength(2); // projectId 未指定 → 绑定 null（IS NULL OR ...）
    expect(sql).toContain('"userId"');
    expect(sql).toContain('"projectId"');
    expect(sql).toContain('::vector');
    expect(rows[0].similarity).toBe(0.8123); // pgvector 返回字符串 → 归一为 number
  });

  it('检索 SQL 形状：projectId 指定时绑定同一值（scope 过滤仍下推）', async () => {
    const { prisma, queryRaw } = makePrisma([]);
    await new KnowledgeRepository(prisma).searchSimilarChunks({
      userId: 'u1', projectId: 'p9', queryEmbedding: vector(EMBEDDING_DIMENSIONS), topK: 3, similarityThreshold: 0.9,
    });
    const { values } = searchCalls(queryRaw)[0];
    expect(values).toContain(1 - 0.9); // 距离上界（浮点结果与实现一致）
    expect(values.filter((v) => v === 'p9')).toHaveLength(2); // IS NULL 判定 + 等值判定（同一绑定值）
  });

  it('buildSimilaritySearchSql：运行时就调用它（导出给 EXPLAIN 验证复用，杜绝第二份 SQL 副本漂移）', async () => {
    const { prisma, queryRaw } = makePrisma([]);
    const params = { userId: 'u1', projectId: null, queryEmbedding: vector(EMBEDDING_DIMENSIONS), topK: 4, similarityThreshold: 0.5 };
    await new KnowledgeRepository(prisma).searchSimilarChunks(params);
    const built = buildSimilaritySearchSql(params);
    expect(searchCalls(queryRaw)[0].values).toEqual(built.values);
    expect(searchCalls(queryRaw)[0].sql).toContain('ORDER BY c.embedding <=> ');
  });

  // ── M11-P14：检索期 GUC（显式事务 + SET LOCAL）─────────────────────────────
  describe('M11-P14 检索期 GUC（HNSW 交叉点结论落地）', () => {
    afterEach(() => {
      delete process.env[HNSW_EF_SEARCH_ENV];
      delete process.env[HNSW_RANDOM_PAGE_COST_ENV];
    });

    it('检索在显式事务内先钉死 GUC（is_local=true）再执行同一份 SQL——作用域=事务，绝不泄漏到连接池', async () => {
      const { prisma, queryRaw, transaction } = makePrisma([]);
      await new KnowledgeRepository(prisma).searchSimilarChunks({
        userId: 'u1', projectId: null, queryEmbedding: vector(EMBEDDING_DIMENSIONS), topK: 5, similarityThreshold: 0.3,
      });

      expect(transaction).toHaveBeenCalledTimes(1); // 只有一个显式事务（不会出现"SET 泄漏到会话"的路径）
      const guc = gucCall(queryRaw);
      expect(guc.sql).toContain('set_config'); // set_config(...) 而非 SET LOCAL 字面量——支持参数绑定
      expect(guc.sql).toContain("'hnsw.ef_search'");
      expect(guc.sql).toContain("'random_page_cost'");
      expect(guc.values).toEqual(['40', '1.1']); // 默认：pgvector 默认 ef_search + SSD 口径 rpc
      expect((guc.sql.match(/true/g) ?? []).length).toBe(2); // is_local=true ×2 → 事务级
      // GUC 语句在检索语句之前（同一事务内、同一连接）
      expect(queryRaw.findIndex((c) => c.sql.includes('set_config'))).toBeLessThan(
        queryRaw.findIndex((c) => c.sql.includes('ORDER BY c.embedding')),
      );
    });

    it('env 可配：两个 GUC 都随 env 覆盖（不同磁盘/不同召回要求）', async () => {
      process.env[HNSW_EF_SEARCH_ENV] = '100';
      process.env[HNSW_RANDOM_PAGE_COST_ENV] = '2.5';
      const { prisma, queryRaw } = makePrisma([]);
      await new KnowledgeRepository(prisma).searchSimilarChunks({
        userId: 'u1', projectId: null, queryEmbedding: vector(EMBEDDING_DIMENSIONS), topK: 5, similarityThreshold: 0.3,
      });
      expect(gucCall(queryRaw).values).toEqual(['100', '2.5']);
    });

    it('env 非法 → 回退默认并仍能检索（绝不因一次调参把检索打挂）', async () => {
      process.env[HNSW_EF_SEARCH_ENV] = 'abc';
      process.env[HNSW_RANDOM_PAGE_COST_ENV] = '-3';
      const { prisma, queryRaw } = makePrisma([]);
      await new KnowledgeRepository(prisma).searchSimilarChunks({
        userId: 'u1', projectId: null, queryEmbedding: vector(EMBEDDING_DIMENSIONS), topK: 5, similarityThreshold: 0.3,
      });
      expect(gucCall(queryRaw).values).toEqual(['40', '1.1']);
      expect(parseHnswSetting('99999', 40, 1, 1000, 'X')).toBe(40); // 越界同样回退
      expect(parseHnswSetting('', 40, 1, 1000, 'X')).toBe(40); // 空串 = 未设置
      expect(parseHnswSetting(undefined, 1.1, 0, 100, 'X')).toBe(1.1);
      expect(resolveHnswEfSearch({})).toBe(40);
      expect(resolveHnswRandomPageCost({})).toBe(1.1);
      expect(resolveHnswEfSearch({ [HNSW_EF_SEARCH_ENV]: '200' })).toBe(200);
    });
  });
});
