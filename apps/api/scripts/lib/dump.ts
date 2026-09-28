/**
 * M10-P9 运维脚本：pg_dump 的调用参数 + **dump 文件的真实内容统计**（纯函数，可单测）。
 *
 * 为什么要有"内容统计"：`pg_dump` 失败最阴的形态是**部分成功**（网络中断/磁盘满 ⇒ 截断的 .sql
 * 依然是个非空文件，`test -s` 判为通过）。所以备份脚本必须解析产物本身：
 * 表数 / COPY 段数 / 逐表行数 / 扩展，并与文件大小一起写进 manifest。
 *
 * 解析口径（与 `docs/operations/m8-disaster-recovery.md` §4.1 的"与 dump 自身 COPY 段比对"一致）：
 * - `CREATE TABLE public."X" (...)` ⇒ 表数；
 * - `COPY public."X" (...) FROM stdin;` ⇒ 一个数据段，其后到 `\.` 之间的行数 = 该表行数
 *   （text 格式把换行转义为 `\n`，故"一行 = 一行数据"成立）；
 * - `CREATE EXTENSION ... name ...` ⇒ 扩展名。
 */

export interface DumpStats {
  /** `CREATE TABLE` 语句数（= dump 里的表数） */
  tables: number;
  /** `COPY ... FROM stdin;` 段数（正常 == tables，二者不等说明 dump 异常） */
  copySegments: number;
  /** 全部 COPY 段的数据行合计 */
  totalRows: number;
  /** 逐表数据行数（表名 → 行数；含 0 行表） */
  rowCounts: Record<string, number>;
  /** `CREATE EXTENSION` 涉及的扩展名 */
  extensions: string[];
  /** `CREATE INDEX` / `CREATE UNIQUE INDEX` 语句数（仅参考，不作断言） */
  indexStatements: number;
  /** `_prisma_migrations` 的 COPY 行数（无该表 ⇒ null） */
  migrationsRows: number | null;
  /** 解析器看到的总行数（诊断用） */
  lines: number;
}

export interface DumpStatsCollector {
  pushLine(line: string): void;
  finish(): DumpStats;
}

/** 去掉可能的 schema 前缀与标识符引号：`public."AgentRun"` → `AgentRun`。 */
export function unqualifyIdentifier(raw: string): string {
  const trimmed = raw.trim().replace(/\(.*$/, '').trim();
  const noSchema = trimmed.includes('.') ? trimmed.slice(trimmed.indexOf('.') + 1) : trimmed;
  return noSchema.replace(/^"|"$/g, '');
}

const RE_CREATE_TABLE = /^CREATE TABLE\s+(?:"?[\w$]+"?\.)?"?([\w$]+)"?\s*\(/i;
const RE_COPY_FROM_STDIN = /^COPY\s+(?:"?[\w$]+"?\.)?"?([\w$]+)"?\s*\(.*\)\s*FROM stdin;\s*$/i;
const RE_CREATE_EXTENSION = /^CREATE EXTENSION (?:IF NOT EXISTS )?"?([\w$]+)"?/i;
const RE_CREATE_INDEX = /^CREATE (?:UNIQUE )?INDEX /i;

export function createDumpStatsCollector(): DumpStatsCollector {
  const rowCounts: Record<string, number> = {};
  const extensions: string[] = [];
  let tables = 0;
  let copySegments = 0;
  let totalRows = 0;
  let indexStatements = 0;
  let lines = 0;
  let migrationsRows: number | null = null;

  /** 当前正在统计 COPY 段的表名；null = 不在 COPY 段内 */
  let currentTable: string | null = null;
  let currentRows = 0;

  const closeCopy = () => {
    if (currentTable === null) return;
    rowCounts[currentTable] = currentRows;
    if (currentTable === '_prisma_migrations') migrationsRows = currentRows;
    currentTable = null;
    currentRows = 0;
  };

  return {
    pushLine(line: string): void {
      lines += 1;
      if (currentTable !== null) {
        if (line === '\\' + '.') {
          closeCopy();
          return;
        }
        currentRows += 1;
        totalRows += 1;
        return;
      }
      const createTable = RE_CREATE_TABLE.exec(line);
      if (createTable) {
        tables += 1;
        if (!(createTable[1] in rowCounts)) rowCounts[createTable[1]] = 0;
        return;
      }
      const copy = RE_COPY_FROM_STDIN.exec(line);
      if (copy) {
        copySegments += 1;
        currentTable = copy[1];
        currentRows = 0;
        return;
      }
      const ext = RE_CREATE_EXTENSION.exec(line);
      if (ext) {
        if (!extensions.includes(ext[1])) extensions.push(ext[1]);
        return;
      }
      if (RE_CREATE_INDEX.test(line)) indexStatements += 1;
    },
    finish(): DumpStats {
      // 截断的 dump 会在 COPY 段中途结束：这里保留已统计到的行数，由校验环节判失败
      closeCopy();
      return { tables, copySegments, totalRows, rowCounts, extensions, indexStatements, migrationsRows, lines };
    },
  };
}

/**
 * 小文件/单测用：一次性解析文本。大文件请用流式 collector（backup.ts 的做法）。
 *
 * 与 readline 语义对齐：结尾的换行**不**产生一条空行（否则截断的 COPY 段会被多算一行，
 * 恰好掩盖"少一行"的差异，见 lib/dump.spec.ts 的截断用例）。
 */
export function parseDumpStatsText(text: string): DumpStats {
  const lines = text.split(/\r?\n/);
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  const collector = createDumpStatsCollector();
  for (const line of lines) collector.pushLine(line);
  return collector.finish();
}

/**
 * 备份可用性判定（**失败必须体现在退出码上**）。
 * 纯函数：输入数字，输出结论，便于单测与"演练前先跑一遍断言"。
 */
export interface BackupCheck {
  name: string;
  ok: boolean;
  detail: string;
}

export function verifyDumpStats(
  stats: DumpStats,
  opts: { sizeBytes: number; expectTables?: number; expectMigrationsRows?: number; minRows?: number } = { sizeBytes: 0 },
): BackupCheck[] {
  const checks: BackupCheck[] = [];
  checks.push({ name: 'file-non-empty', ok: opts.sizeBytes > 0, detail: `dump 大小 ${opts.sizeBytes} 字节` });
  checks.push({ name: 'has-tables', ok: stats.tables > 0, detail: `CREATE TABLE 语句 ${stats.tables} 条` });
  checks.push({
    name: 'copy-segments-match-tables',
    ok: stats.copySegments === stats.tables,
    detail: `COPY 段 ${stats.copySegments} / 表 ${stats.tables}（不等 ⇒ dump 可能被截断或表无权限导出）`,
  });
  if (opts.expectTables !== undefined) {
    checks.push({
      name: 'expected-table-count',
      ok: stats.tables === opts.expectTables,
      detail: `期望 ${opts.expectTables} 张表，实际 ${stats.tables} 张`,
    });
  }
  if (opts.expectMigrationsRows !== undefined) {
    checks.push({
      name: 'expected-migrations-rows',
      ok: stats.migrationsRows === opts.expectMigrationsRows,
      detail: `_prisma_migrations 期望 ${opts.expectMigrationsRows} 行，实际 ${String(stats.migrationsRows)} 行`,
    });
  }
  const minRows = opts.minRows ?? 0;
  checks.push({ name: 'row-count-floor', ok: stats.totalRows >= minRows, detail: `数据行合计 ${stats.totalRows}（下限 ${minRows}）` });
  return checks;
}

export interface RowCountDiff {
  table: string;
  expected: number;
  actual: number;
}

/**
 * 逐表比对（**dump 期望** vs **恢复库实际**）。
 * 口径纪律（m8 手册 §6.2 的教训）：期望值只能来自 dump 文件自身的 COPY 段，
 * 绝不能来自"源库当前行数"——源库在备份之后仍在写入，那样比会永远失败。
 * `actual === -1` 表示恢复库里根本没有这张表（比"行数不同"更严重）。
 */
export function compareRowCounts(expected: Record<string, number>, actual: Record<string, number>): RowCountDiff[] {
  const diffs: RowCountDiff[] = [];
  for (const [table, exp] of Object.entries(expected)) {
    const act = actual[table];
    if (act === undefined || act !== exp) diffs.push({ table, expected: exp, actual: act ?? -1 });
  }
  // 恢复库里多出来的表（dump 里没有）同样算差异——它说明"恢复前这个库不是空的"
  for (const table of Object.keys(actual)) {
    if (!(table in expected)) diffs.push({ table, expected: -1, actual: actual[table] });
  }
  return diffs;
}

// ===== pg_dump 参数 =====

/**
 * 一致性参数（每一项都有运维理由，别随手删）：
 * - `--format=plain`：人类可读 + 可直接 psql 回灌（DR 手册实测路径）；压缩交给脚本（gzip 级别可控、可流式）；
 * - `--no-owner --no-privileges`：恢复到不同角色/临时库必须（否则会遇到 role 不存在而中断）；
 * - `--clean --if-exists`：备份文件可直接回灌到**已有**库（先 DROP 再 CREATE，幂等重放）；
 * - `--lock-wait-timeout=15s`：拿不到锁就失败退出，而不是把备份任务挂在生产库上排队等待（运维看得见失败）；
 * - 不加 `--serializable-deferrable`：它只在"无并发写"时快，有写入时会长时间阻塞；pg_dump 默认的
 *   单事务 repeatable-read 快照已保证**一致性**（同一时点）；
 * - 不加 `--column-inserts`：行数级放大体积且慢 10 倍以上（COPY 格式才是运维口径）。
 *
 * 注意（诚实边界）：这是**逻辑备份**，RPO = 备份时刻。想做 PITR 必须另行开 WAL 归档（见 DR 手册 §3.1）。
 */
export const PG_DUMP_CONSISTENCY_ARGS: readonly string[] = [
  '--format=plain',
  '--no-owner',
  '--no-privileges',
  '--clean',
  '--if-exists',
  '--lock-wait-timeout=15s',
];

export function buildPgDumpArgs(opts: { user: string; database: string; extra?: readonly string[] }): string[] {
  return ['pg_dump', '-U', opts.user, '-d', opts.database, ...PG_DUMP_CONSISTENCY_ARGS, ...(opts.extra ?? [])];
}
