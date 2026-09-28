import { describe, expect, it } from 'vitest';
import { buildPgDumpArgs, compareRowCounts, createDumpStatsCollector, parseDumpStatsText, unqualifyIdentifier, verifyDumpStats } from './dump';

/** 取一段真实形态的 pg_dump plain 输出（结构照抄，内容简化）。 */
const SAMPLE = `--
-- PostgreSQL database dump
--

SET statement_timeout = 0;

CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA public;

--
-- Name: User; Type: TABLE; Schema: public; Owner: agent
--

CREATE TABLE public."User" (
    id text NOT NULL,
    email text NOT NULL
);

ALTER TABLE ONLY public."User" ADD CONSTRAINT "User_pkey" PRIMARY KEY (id);

--
-- Data for Name: User; Type: TABLE DATA; Schema: public; Owner: agent
--

COPY public."User" (id, email) FROM stdin;
u1\ta@example.com
u2\tb@example.com
\\.

--
-- Name: AgentRun; Type: TABLE; Schema: public; Owner: agent
--

CREATE TABLE public."AgentRun" (
    id text NOT NULL,
    status text NOT NULL
);

CREATE INDEX "AgentRun_status_idx" ON public."AgentRun" USING btree (status);
CREATE UNIQUE INDEX "AgentRun_pkey" ON public."AgentRun" USING btree (id);

COPY public."AgentRun" (id, status) FROM stdin;
r1\tcompleted
\\.

--
-- Name: _prisma_migrations; Type: TABLE; Schema: public; Owner: agent
--

CREATE TABLE public."_prisma_migrations" (
    id text NOT NULL
);

COPY public."_prisma_migrations" (id) FROM stdin;
m1
m2
m3
\\.

--
-- PostgreSQL database dump complete
--
`;

describe('dump 内容统计（"非空文件"不等于"可用备份"）', () => {
  it('统计表数 / COPY 段 / 逐表行数 / 扩展 / 索引语句', () => {
    const stats = parseDumpStatsText(SAMPLE);
    expect(stats.tables).toBe(3);
    expect(stats.copySegments).toBe(3);
    expect(stats.totalRows).toBe(6);
    expect(stats.rowCounts).toEqual({ User: 2, AgentRun: 1, _prisma_migrations: 3 });
    expect(stats.extensions).toEqual(['vector']);
    expect(stats.indexStatements).toBe(2);
    expect(stats.migrationsRows).toBe(3);
  });

  it('0 行表也被记录（COPY 段立刻以 \\. 结束）', () => {
    const stats = parseDumpStatsText('CREATE TABLE public."Empty" (\n id text\n);\nCOPY public."Empty" (id) FROM stdin;\n\\.\n');
    expect(stats.tables).toBe(1);
    expect(stats.copySegments).toBe(1);
    expect(stats.totalRows).toBe(0);
    expect(stats.rowCounts).toEqual({ Empty: 0 });
  });

  it('截断的 dump：COPY 段未闭合 ⇒ 行数仍被统计（差异交给校验环节判失败）', () => {
    const truncated = 'CREATE TABLE public."User" (\n id text\n);\nCOPY public."User" (id) FROM stdin;\nu1\nu2\n';
    const stats = parseDumpStatsText(truncated);
    expect(stats.tables).toBe(1);
    expect(stats.rowCounts).toEqual({ User: 2 });
  });

  it('COPY 数据里的转义换行不会多算行（text 格式一行 = 一行数据）', () => {
    const withEscapes = 'CREATE TABLE public."T" (\n v text\n);\nCOPY public."T" (v) FROM stdin;\na\\nb\n\\.\n';
    const stats = parseDumpStatsText(withEscapes);
    expect(stats.rowCounts).toEqual({ T: 1 });
  });

  it('流式 collector 与一次性解析结果一致（backup.ts 走流式；readline 不产出结尾空行）', () => {
    const collector = createDumpStatsCollector();
    const lines = SAMPLE.split('\n');
    if (lines[lines.length - 1] === '') lines.pop(); // 复刻 readline 语义
    for (const line of lines) collector.pushLine(line);
    expect(collector.finish()).toEqual(parseDumpStatsText(SAMPLE));
  });

  it('unqualifyIdentifier 处理带 schema / 带引号 / 带列列表的写法', () => {
    expect(unqualifyIdentifier('public."AgentRun"')).toBe('AgentRun');
    expect(unqualifyIdentifier('"User"')).toBe('User');
    expect(unqualifyIdentifier('public."User" (id, email)')).toBe('User');
    expect(unqualifyIdentifier('plain_table')).toBe('plain_table');
  });
});

describe('备份校验（失败必须体现在退出码上）', () => {
  const stats = parseDumpStatsText(SAMPLE);

  it('全绿场景通过', () => {
    const checks = verifyDumpStats(stats, { sizeBytes: 1024, expectTables: 3, expectMigrationsRows: 3, minRows: 6 });
    expect(checks.every((c) => c.ok)).toBe(true);
  });

  it('空文件 / 无表 / COPY 段与表数不符 全部判失败', () => {
    const empty = verifyDumpStats(parseDumpStatsText(''), { sizeBytes: 0 });
    expect(empty.find((c) => c.name === 'file-non-empty')?.ok).toBe(false);
    expect(empty.find((c) => c.name === 'has-tables')?.ok).toBe(false);

    const mismatchStats = { ...stats, copySegments: stats.tables - 1 };
    const mismatch = verifyDumpStats(mismatchStats, { sizeBytes: 10 });
    expect(mismatch.find((c) => c.name === 'copy-segments-match-tables')?.ok).toBe(false);
  });

  it('期望表数/迁移行数不符判失败（表数缩水是"备份到空库"的典型形态）', () => {
    const checks = verifyDumpStats(stats, { sizeBytes: 1, expectTables: 73, expectMigrationsRows: 24, minRows: 100 });
    const failed = checks.filter((c) => !c.ok).map((c) => c.name);
    expect(failed).toContain('expected-table-count');
    expect(failed).toContain('expected-migrations-rows');
    expect(failed).toContain('row-count-floor');
  });
});

describe('恢复侧逐表比对（口径：与 dump 的 COPY 段比，不与源库当前行数比）', () => {
  it('一致时无差异', () => {
    expect(compareRowCounts({ A: 1, B: 2 }, { A: 1, B: 2 })).toEqual([]);
  });

  it('行数不同 / 表缺失（-1）/ 恢复库多出的表 都算差异', () => {
    const diffs = compareRowCounts({ A: 1, B: 2, C: 3 }, { A: 5, B: 2, D: 9 });
    expect(diffs).toContainEqual({ table: 'A', expected: 1, actual: 5 });
    expect(diffs).toContainEqual({ table: 'C', expected: 3, actual: -1 });
    expect(diffs).toContainEqual({ table: 'D', expected: -1, actual: 9 });
    expect(diffs.find((d) => d.table === 'B')).toBeUndefined();
  });
});

describe('pg_dump 参数（一致性/可恢复性开关不许漂移）', () => {
  it('包含一致性快照与可回灌所需参数', () => {
    const args = buildPgDumpArgs({ user: 'agent', database: 'agent_platform' });
    expect(args.slice(0, 5)).toEqual(['pg_dump', '-U', 'agent', '-d', 'agent_platform']);
    for (const flag of ['--format=plain', '--no-owner', '--no-privileges', '--clean', '--if-exists', '--lock-wait-timeout=15s']) {
      expect(args).toContain(flag);
    }
    expect(args).not.toContain('--column-inserts'); // 体积/耗时灾难
  });
});
