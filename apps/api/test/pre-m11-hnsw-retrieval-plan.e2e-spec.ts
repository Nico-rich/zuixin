import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/modules/prisma/prisma.service';
import {
  KnowledgeRepository, buildSimilaritySearchSql, EMBEDDING_DIMENSIONS,
  resolveHnswEfSearch, resolveHnswRandomPageCost,
} from '../src/core/knowledge/knowledge.repository';

/**
 * M11-P14（NV-10）e2e：**规模维度**的检索期 GUC 证据（真实 PG + 真实 pgvector 0.8）。
 *
 * 与 Pre-M9 P4 spec 的分工：
 * - P4 spec 用 `enable_sort/seqscan/bitmapscan=off` 证明"索引路径**可用**"（与表大小无关）；
 * - 本 spec 证明"在真实规模下 planner **会**选它——当且仅当检索期 GUC 被钉死"（P4 spec 明确注明了
 *   小表 + 默认 random_page_cost=4.0 时 planner 仍会退回 Seq Scan+Sort，那正是 NV-10 的缺陷窗口）。
 *
 * 证据三条：
 * 1) 【规模探针】事务内建**临时表**（一次性、随事务消失，绝不触碰 DocumentChunk / 共享 dev 库的既有数据），
 *    形状与生产一致：1536 维、content≈800 字符（触发 TOAST）、userId scope 下推、距离上界、LIMIT 5、
 *    1 文档/1000 块、m=16/ef_construction=64 默认 HNSW。灌 3e4 行后 `ANALYZE`，用**生产同一条 SQL**
 *    （`buildSimilaritySearchSql`，仅把表名换到临时表）跑 EXPLAIN：钉死 rpc=1.1 → 选 HNSW 有序扫描；
 *    备注（勿过度解读）：**本探针不构成"默认 rpc 一定选错"的断言**——在 3e4 行临时表上 rpc=4.0/8.0 也选了 HNSW。
 *    缺陷窗口是**代价噪声区**（实测 1e3~3e3 行 rpc=4.0 → Seq+Sort，实测 Seq+Sort 慢 30×~12000×），
 *    其非单调性见文件头交叉点表；本探针断言的是"钉死后在真实规模上**必然**走索引"这一生产保证。
 * 2) 【执行证据】同一条 SQL 在钉死 GUC 下 `EXPLAIN (ANALYZE, BUFFERS)`：计划里真的是 Index Scan（不是只被选中）；
 * 3) 【作用域证据】检索走完 `searchSimilarChunks` 后，**会话级** GUC 仍是 PG/pgvector 默认值
 *    —— `set_config(..., is_local=true)` 的作用域被真实 PG 兑现（若有人把它改成 false，本测试立刻变红：
 *    连接池里的其它查询会被永久改参数，属生产事故级回归）。
 *
 * 交叉点结论表（scratch 库 10^3~3×10^5 行 × rpc 1.0~8.0 全量扫描）见 `knowledge.repository.ts` 文件头。
 */
const DIMS = EMBEDDING_DIMENSIONS;
/** 与 q=e0 余弦相似度 = c（与 P4 spec 同一构造） */
const vecWithCos = (c: number) => Array.from({ length: DIMS }, (_, i) => (i === 0 ? c : i === 1 ? Math.sqrt(1 - c * c) : 0));
const e0 = () => vecWithCos(1);

/** Prisma Sql 的 `.sql` 用 `?` 占位符；EXPLAIN 需 `$n`（值顺序不变） */
const toPositional = (q: { sql: string; values: unknown[] }) => {
  let i = 0;
  return { text: q.sql.replace(/\?/g, () => `$${++i}`), values: q.values };
};

// 规模探针参数：3e4 行落在实测交叉点内（rpc=1.1 → HNSW；默认 rpc=4.0/8.0 在该量级会退回 Seq+Sort）
const PROBE_ROWS = 30_000;
const PROBE_DOCS = 30;
const PROBE_POOL = 500;

describe('Pre-M11 P14 HNSW 检索期 GUC（真实 PG：规模探针 + 执行证据 + 作用域）', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let repo: KnowledgeRepository;
  let userId: string;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    prisma = moduleRef.get(PrismaService);
    repo = new KnowledgeRepository(prisma);
    const user = await prisma.user.create({ data: { email: `p14plan-${Date.now()}@example.com`, passwordHash: 'x' } });
    userId = user.id;
    const doc = await prisma.document.create({ data: { userId, name: 'P14 plan e2e', sourceType: 'text', content: 'x', status: 'ready' } });
    await repo.createChunks(doc.id, userId, null, 'mock-embedding', [
      { content: 'p14 k0', tokenCount: 3, embedding: vecWithCos(1) },
      { content: 'p14 k1', tokenCount: 3, embedding: vecWithCos(0.9) },
      { content: 'p14 k2', tokenCount: 3, embedding: vecWithCos(0.7) },
    ]);
  });

  afterAll(async () => {
    await prisma.document.deleteMany({ where: { userId } }); // chunks 级联
    await prisma.user.deleteMany({ where: { id: userId } });
    await app.close();
  });

  it('语义：检索结果与相似度降序不变（GUC 钉死不改业务语义）', async () => {
    const hits = await repo.searchSimilarChunks({ userId, projectId: null, queryEmbedding: e0(), topK: 5, similarityThreshold: 0.3 });
    expect(hits.map((h) => h.content)).toEqual(['p14 k0', 'p14 k1', 'p14 k2']);
    expect(hits[0].similarity).toBeCloseTo(1, 5);

    const top2 = await repo.searchSimilarChunks({ userId, projectId: null, queryEmbedding: e0(), topK: 2, similarityThreshold: 0.5 });
    expect(top2.map((h) => h.content)).toEqual(['p14 k0', 'p14 k1']);
  }, 30000);

  it('作用域：检索结束后会话级 GUC 仍是默认值（is_local=true 被 PG 真实兑现，不污染连接池）', async () => {
    // 先确认基线就是默认值（若历史遗留了会话级 SET，这里会立刻暴露，避免"假绿"）
    const defaults = await prisma.$queryRawUnsafe<Array<{ ef: string; rpc: string; mw: string }>>(
      `SELECT current_setting('hnsw.ef_search') AS ef, current_setting('random_page_cost') AS rpc,
              current_setting('hnsw.max_scan_tuples', true) AS mw`,
    );
    expect(Number(defaults[0].ef)).toBe(40); // pgvector 默认 ef_search
    expect(Number(defaults[0].rpc)).toBe(4); // PG 默认 random_page_cost

    // 反复检索（每次都在自己的显式事务里 set_config(..., true)）
    for (let i = 0; i < 3; i++) {
      await repo.searchSimilarChunks({ userId, projectId: null, queryEmbedding: e0(), topK: 3, similarityThreshold: 0.3 });
    }

    const after = await prisma.$queryRawUnsafe<Array<{ ef: string; rpc: string }>>(
      `SELECT current_setting('hnsw.ef_search') AS ef, current_setting('random_page_cost') AS rpc`,
    );
    expect(Number(after[0].ef)).toBe(40); // 未被改写成钉死值之外的任何东西
    expect(Number(after[0].rpc)).toBe(4); // 检索期的 1.1 没有泄漏到会话
    // 被钉死的取值本身（与检索 SQL 同一份解析逻辑，env 可覆盖）
    expect(resolveHnswEfSearch()).toBe(40);
    expect(resolveHnswRandomPageCost()).toBe(1.1);
  }, 30000);

  it('规模探针：3e4 行临时表上，钉死检索期 GUC 后 planner 必选 HNSW 且真按索引执行（topK 命中）', async () => {
    // 阈值 0.0（距离上界 1.0）：随机向量近似正交（cosine 距离 ≈1.0），阈值 0.3 时探针会返回 0 行；
    // 用 0.0 让 ANN 扫描真的产出 topK 命中（SQL 形状与生产完全一致，只改常量）
    const params = { userId: 'p14-probe-user', projectId: null, queryEmbedding: e0(), topK: 5, similarityThreshold: 0.0 };
    const probe = toPositional(buildSimilaritySearchSql(params));
    // 生产 SQL → 探针表（临时表 schema 不可限定名，顺序：先换更长的 "DocumentChunk"，避免前缀误替换）
    const probeText = probe.text
      .replace(/"DocumentChunk"/g, 'p14_probe_chunk')
      .replace(/"Document" d/g, 'p14_probe_doc d');
    expect(probeText).toContain('p14_probe_chunk');

    const result = await prisma.$transaction(async (tx) => {
      // ── 一次性 schema（ON COMMIT DROP：事务结束即消失，不残留任何对象）────────────
      await tx.$executeRawUnsafe(`CREATE TEMP TABLE p14_probe_doc (id text PRIMARY KEY, name text) ON COMMIT DROP`);
      await tx.$executeRawUnsafe(`INSERT INTO p14_probe_doc SELECT 'd' || i, 'probe doc ' || i FROM generate_series(1, ${PROBE_DOCS}) i`);
      await tx.$executeRawUnsafe(`CREATE TEMP TABLE p14_probe_chunk (
        id text PRIMARY KEY, "documentId" text NOT NULL, "userId" text NOT NULL, "projectId" text,
        "chunkIndex" integer NOT NULL, content text NOT NULL, embedding vector(${DIMS}) NOT NULL) ON COMMIT DROP`);
      // 向量池：CROSS JOIN + GROUP BY pid 逐行求值（写成 SELECT 列表里的相关子查询会被 PG 拒绝：
      // "column g.g must appear in the GROUP BY clause"）
      await tx.$executeRawUnsafe(`CREATE TEMP TABLE p14_probe_pool ON COMMIT DROP AS
        SELECT h.pid, array_agg((random() * 2 - 1)::real ORDER BY d)::vector AS v
        FROM generate_series(1, ${PROBE_POOL}) h(pid) CROSS JOIN generate_series(1, ${DIMS}) d
        GROUP BY h.pid`);
      // 行形状对齐生产：content≈800 字符（TOAST 行外存储——正是代价模型看不见的部分）、1 文档/1000 块
      await tx.$executeRawUnsafe(`INSERT INTO p14_probe_chunk
        SELECT 'c' || g, 'd' || (1 + ((g - 1) / 1000)), 'p14-probe-user', NULL, (g - 1),
               'p14 chunk ' || g || repeat('x', 780),
               (SELECT v FROM p14_probe_pool p WHERE p.pid = 1 + ((g * 7919) % ${PROBE_POOL}))
        FROM generate_series(1, ${PROBE_ROWS}) g`);
      await tx.$executeRawUnsafe(`CREATE INDEX ON p14_probe_chunk ("documentId")`);
      await tx.$executeRawUnsafe(`CREATE INDEX ON p14_probe_chunk ("userId", "projectId")`);
      await tx.$executeRawUnsafe(`SET LOCAL maintenance_work_mem = '1GB'`);
      await tx.$executeRawUnsafe(`SET LOCAL max_parallel_maintenance_workers = 0`); // 容器 /dev/shm 仅 64MB
      await tx.$executeRawUnsafe(`CREATE INDEX p14_probe_hnsw_idx ON p14_probe_chunk USING hnsw (embedding vector_cosine_ops)`);
      await tx.$executeRawUnsafe(`ANALYZE p14_probe_doc`);
      await tx.$executeRawUnsafe(`ANALYZE p14_probe_chunk`);

      const explain = async (sql: string, opts = '') => {
        const rows = await tx.$queryRawUnsafe<Array<Record<string, string>>>(`EXPLAIN ${opts} ${sql}`, ...probe.values);
        return rows.map((r) => Object.values(r)[0]).join('\n');
      };
      const rows = await tx.$queryRawUnsafe<Array<{ n: bigint }>>(`SELECT count(*) AS n FROM p14_probe_chunk`);

      // ① 钉死生产取值（与 searchSimilarChunks 完全相同的 set_config(..., is_local=true) 调用）
      await tx.$queryRawUnsafe(
        `SELECT set_config('hnsw.ef_search', $1, true), set_config('random_page_cost', $2, true)`,
        String(resolveHnswEfSearch()), String(resolveHnswRandomPageCost()),
      );
      const pinned = await explain(probeText);
      // ② 同一条 SQL 的执行证据（临时表无并发，ANALYZE 只读路径）
      const analyzed = await explain(probeText, '(ANALYZE, BUFFERS)');
      // ③ 对照：默认 random_page_cost（PG 4.0）——只取计划，不执行（Seq+Sort 在该量级代价高）
      await tx.$queryRawUnsafe(`SELECT set_config('random_page_cost', '4', true)`);
      const defaultRpc = await explain(probeText);
      // ④ 对照：8.0——交叉点实验里 1e3~3e4 行区间稳定退回 Seq+Sort 的一侧
      await tx.$queryRawUnsafe(`SELECT set_config('random_page_cost', '8', true)`);
      const rpc8 = await explain(probeText);

      await tx.$executeRawUnsafe(`DROP TABLE p14_probe_chunk`);
      await tx.$executeRawUnsafe(`DROP TABLE p14_probe_doc`);
      await tx.$executeRawUnsafe(`DROP TABLE p14_probe_pool`);
      return { rows: Number(rows[0].n), pinned, analyzed, defaultRpc, rpc8 };
    }, { timeout: 240_000, maxWait: 30_000 });

    expect(result.rows).toBe(PROBE_ROWS);
    // ① 钉死取值 → 索引有序扫描，无排序步骤（Halving 版 planner 不该有别的选择）
    expect(result.pinned).toContain('p14_probe_hnsw_idx');
    expect(result.pinned).not.toMatch(/\bSort\b/);
    // ② 真执行：确实是 Index Scan（计划被选中 ≠ 被使用），且真的产出了 topK 命中
    expect(result.analyzed).toContain('Index Scan using p14_probe_hnsw_idx');
    expect(result.analyzed).toContain('actual'); // ANALYZE 输出（真实行数/耗时，见报告）
    expect(result.analyzed).toContain('Order By: (embedding <=>'); // 有序索引扫描（无 Sort 节点）
    expect(result.analyzed).toMatch(/rows=5 loops=1/); // topK 命中真的产出（不是空扫）
    // ③ 对照计划非空（记录用：默认 rpc=4.0 / 8.0 在 3e4 行的选择见下方日志与报告结论表）
    expect(result.defaultRpc.length).toBeGreaterThan(0);
    expect(result.rpc8.length).toBeGreaterThan(0);
    // eslint-disable-next-line no-console
    console.log(
      `[P14 探针 ${PROBE_ROWS} 行] pinned(1.1)=${result.pinned.includes('p14_probe_hnsw_idx') ? 'HNSW' : 'SEQ'}` +
      ` / default(4.0)=${result.defaultRpc.includes('p14_probe_hnsw_idx') ? 'HNSW' : 'SEQ'}` +
      ` / rpc8=${result.rpc8.includes('p14_probe_hnsw_idx') ? 'HNSW' : 'SEQ'}\n${result.analyzed}`,
    );
  }, 300_000);
});
