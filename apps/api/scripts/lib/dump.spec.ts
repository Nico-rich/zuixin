import { describe, expect, it } from 'vitest';
import {
  buildPgDumpArgs,
  buildTableDataDumpArgs,
  compareCopyRows,
  compareRowCounts,
  createCopyRowCollector,
  createDumpStatsCollector,
  parseCopyRowsText,
  parseDumpStatsText,
  pickSampleTables,
  unqualifyIdentifier,
  verifyDumpStats,
} from './dump';

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

describe('内容级抽样（恢复后逐行比对：比"行数相同"更硬的一层）', () => {
  it('buildTableDataDumpArgs：只取数据 + 引号表名（大小写敏感表名必须引号）+ 不带 DROP/CREATE', () => {
    const args = buildTableDataDumpArgs({ user: 'agent', database: 'agent_platform', table: 'User' });
    expect(args.slice(0, 5)).toEqual(['pg_dump', '-U', 'agent', '-d', 'agent_platform']);
    expect(args).toContain('--data-only');
    expect(args).toContain('public."User"');
    expect(args).not.toContain('--clean'); // 单表采样产物只用来比对，绝不能带 --clean/--if-exists
    expect(args).not.toContain('--if-exists');
  });

  it('只收集目标表的 COPY 行，未列入的表完全不进内存', () => {
    const sample = parseCopyRowsText(SAMPLE, ['User']);
    expect(Object.keys(sample.rows)).toEqual(['User']);
    expect(sample.rows.User).toEqual(['u1\ta@example.com', 'u2\tb@example.com']);
    expect(sample.skipped).toEqual([]);

    const none = parseCopyRowsText(SAMPLE, []);
    expect(none.rows).toEqual({});
    expect(none.skipped).toEqual([]);
  });

  it('空表与超限表一律标 skipped —— 否则两侧同样被截断会得出"相等"的假通过', () => {
    const text = [
      'COPY public."Empty" (id) FROM stdin;',
      '\\.',
      'COPY public."Tiny" (id) FROM stdin;',
      'r1',
      'r2',
      '\\.',
      'COPY public."Big" (id) FROM stdin;',
      'r1',
      'r2',
      'r3',
      '\\.',
    ].join('\n');
    const sample = parseCopyRowsText(text, ['Empty', 'Tiny', 'Big'], 3);
    expect(sample.rows.Tiny).toEqual(['r1', 'r2']);
    expect(sample.rows.Empty).toEqual([]);
    expect(sample.skipped.sort()).toEqual(['Big', 'Empty']); // 空表：无可比内容；超限表：内容被截断，不可作证
    expect(sample.rows.Big).toHaveLength(3); // 超限表的内容仍在，但调用方必须按 skipped 排除它
  });

  it('流式 collector 与一次性解析结果一致（readline 不产出结尾空行）', () => {
    const lines = SAMPLE.split('\n');
    if (lines[lines.length - 1] === '') lines.pop();
    const collector = createCopyRowCollector(['User', 'AgentRun']);
    for (const line of lines) collector.pushLine(line);
    const streamed = collector.finish();
    expect(streamed).toEqual(parseCopyRowsText(SAMPLE, ['User', 'AgentRun']));
    expect(Object.keys(streamed.rows).sort()).toEqual(['AgentRun', 'User']);
  });

  it('截断的 COPY 段照收（差异由比对环节判定，不在收集环节丢数据）', () => {
    const sample = parseCopyRowsText('COPY public."User" (id) FROM stdin;\nu1\nu2\n', ['User']);
    expect(sample.rows.User).toEqual(['u1', 'u2']);
    expect(sample.skipped).toEqual([]);
  });

  it('compareCopyRows：一致 / 行数不同 / 内容不同（只报位置，不回显数据）', () => {
    expect(compareCopyRows(['a', 'b'], ['a', 'b'])).toEqual({ ok: true, detail: '2 行逐行一致' });

    const fewer = compareCopyRows(['a', 'b'], ['a']);
    expect(fewer.ok).toBe(false);
    expect(fewer.detail).toContain('行数不同');

    const content = compareCopyRows(['a', 'b', 'c'], ['a', 'SECRET-VALUE', 'c']);
    expect(content.ok).toBe(false);
    expect(content.detail).toContain('第 2 行');
    expect(content.detail).not.toContain('SECRET'); // 数据行可能含用户数据/密文：只报位置
  });

  it('内容差异最多报 5 处（再多会淹没有效信息）', () => {
    const expected = ['a', 'b', 'c', 'd', 'e', 'f', 'g'];
    const actual = ['x', 'x', 'x', 'x', 'x', 'x', 'x'];
    const result = compareCopyRows(expected, actual);
    expect(result.ok).toBe(false);
    expect(result.detail).toContain('1、2、3、4、5');
    expect(result.detail).not.toContain('6');
  });
});

describe('抽样选表（确定性：同一份 dump 永远抽同一批，演练结果可比）', () => {
  const rowCounts: Record<string, number> = { User: 5, AgentRun: 0, Credential: 3, Big: 99_999 };
  for (let i = 1; i <= 10; i += 1) rowCounts[`A${String(i).padStart(2, '0')}`] = i;

  it('一半名额给关键表（有数据且不过大），其余等距抽且首尾都取到', () => {
    const picked = pickSampleTables(rowCounts, 5, { preferred: ['User', 'AgentRun', 'Credential', 'Missing'] });
    expect(picked.slice(0, 2)).toEqual(['User', 'Credential']); // 优先关键表；AgentRun=0 行、Missing 不存在 ⇒ 跳过
    expect(picked).toHaveLength(5);
    expect(picked).toContain('A01'); // 首
    expect(picked).toContain('A10'); // 尾
    expect(picked).not.toContain('Big'); // 超限表不采样（大表全量比对会把秒级演练拖成分钟级）
    expect(picked).not.toContain('AgentRun');
  });

  it('同一输入两次抽表结果完全相同（演练报告可比）', () => {
    const a = pickSampleTables(rowCounts, 4, { preferred: ['User'] });
    const b = pickSampleTables({ ...rowCounts }, 4, { preferred: ['User'] });
    expect(a).toEqual(b);
  });

  it('n<=0 / 全部表超限 / 全部表为空 ⇒ 空数组（不采样，也绝不误报"通过"）', () => {
    expect(pickSampleTables(rowCounts, 0)).toEqual([]);
    expect(pickSampleTables(rowCounts, -1)).toEqual([]);
    expect(pickSampleTables({ Big: 99_999 }, 3)).toEqual([]);
    expect(pickSampleTables({ Empty: 0 }, 3)).toEqual([]);
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
