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

/** 单表数据 dump（恢复后内容级抽样用）：只取数据、不做 owner/权限语句。 */
export function buildTableDataDumpArgs(opts: { user: string; database: string; table: string }): string[] {
  // -t 的模式里带引号才能正确匹配大小写敏感的表名（User / _prisma_migrations）
  return ['pg_dump', '-U', opts.user, '-d', opts.database, '--data-only', '--no-owner', '--no-privileges', '-t', `public."${opts.table}"`];
}

/** COPY 段内被判定为"表数据行"的数量上限；超过则放弃采样该表（大表全量比对不是抽样的目的）。 */
export const DEFAULT_MAX_SAMPLED_ROWS = 2_000;

export interface CopyRowSample {
  /** 表名 → COPY 数据行（**原样文本**，不解码转义） */
  rows: Record<string, string[]>;
  /** 因超过行数上限或未出现在 dump 里而放弃采样的表 */
  skipped: string[];
}

export interface CopyRowCollector {
  pushLine(line: string): void;
  finish(): CopyRowSample;
}

/**
 * 按表收集 COPY 数据行（流式；两侧都来自 pg_dump ⇒ 逐行**原样文本**比较即可）。
 *
 * 为什么不做转义解码：两侧都是 pg_dump 的 COPY text 输出，同一个值必然渲染成同一行文本；
 * 原样比较比"解码后比较"更严格——连转义写法不一致都能发现，且没有自己实现 COPY 转义的出错空间
 * （`\N` / `\t` / `\\` 的处理错一处就会把真实损坏掩盖掉）。
 */
export function createCopyRowCollector(targets: Iterable<string>, maxRowsPerTable = DEFAULT_MAX_SAMPLED_ROWS): CopyRowCollector {
  const wanted = new Set(targets);
  const rows: Record<string, string[]> = {};
  const skipped = new Set<string>();
  /** 当前正在收集的表；null = 不在目标表的 COPY 段内 */
  let current: string | null = null;

  const close = () => {
    if (current === null) return;
    const bucket = rows[current];
    // 空表：一致性无从谈起；超限表：**必须标跳过**——否则两侧同样被截断会得出"相等"的假通过
    if (bucket.length === 0 || bucket.length >= maxRowsPerTable) skipped.add(current);
    current = null;
  };

  return {
    pushLine(line: string): void {
      if (current !== null) {
        if (line === '\\' + '.') {
          close();
          return;
        }
        const bucket = rows[current];
        if (bucket.length < maxRowsPerTable) bucket.push(line);
        return;
      }
      if (wanted.size === 0) return;
      const copy = RE_COPY_FROM_STDIN.exec(line);
      if (!copy) return;
      const table = copy[1];
      if (!wanted.has(table)) return;
      current = table;
      rows[table] = rows[table] ?? [];
    },
    finish(): CopyRowSample {
      close();
      return { rows, skipped: [...skipped] };
    },
  };
}

/** 小输出用（"回灌后再 dump 单表"的产物很小，直接整段解析）：同 collector 语义。 */
export function parseCopyRowsText(text: string, targets: Iterable<string>, maxRowsPerTable = DEFAULT_MAX_SAMPLED_ROWS): CopyRowSample {
  const lines = text.split(/\r?\n/);
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  const collector = createCopyRowCollector(targets, maxRowsPerTable);
  for (const line of lines) collector.pushLine(line);
  return collector.finish();
}

/**
 * 确定性抽取用于内容核对的表（同一份 dump 永远抽同一批，演练结果可比）。
 *
 * 选表规则（两条互补，缺一不可）：
 *  1. **优先关键业务表**（KEY_TABLES 里的），一半名额——它们是"这份备份是不是业务库"的证据；
 *  2. 其余名额从**有数据且不过大**的表里等距抽（首尾都取到）——小表更容易暴露"少一行"，
 *     而大表全量比对会把秒级演练拖成分钟级。
 */
export function pickSampleTables(
  rowCounts: Record<string, number>,
  n: number,
  opts: { preferred?: readonly string[]; maxRows?: number } = {},
): string[] {
  if (n <= 0) return [];
  const preferred = opts.preferred ?? [];
  const maxRows = opts.maxRows ?? DEFAULT_MAX_SAMPLED_ROWS;
  const eligible = (t: string) => (rowCounts[t] ?? 0) > 0 && (rowCounts[t] ?? 0) <= maxRows;
  const picked: string[] = [];
  const preferredSlots = Math.ceil(n / 2);
  for (const t of preferred) {
    if (picked.length >= preferredSlots) break;
    if (eligible(t) && !picked.includes(t)) picked.push(t);
  }
  const rest = Object.keys(rowCounts)
    .filter((t) => eligible(t) && !picked.includes(t))
    .sort();
  const need = n - picked.length;
  if (need > 0 && rest.length > 0) {
    if (rest.length <= need) picked.push(...rest);
    else {
      const step = (rest.length - 1) / (need - 1 || 1);
      for (let i = 0; i < need; i += 1) {
        const idx = need === 1 ? Math.floor(rest.length / 2) : Math.min(rest.length - 1, Math.round(i * step));
        if (!picked.includes(rest[idx])) picked.push(rest[idx]);
      }
    }
  }
  return picked;
}

export interface SampleComparison {
  ok: boolean;
  detail: string;
}

/**
 * 逐行比较两侧的 COPY 数据行。
 * **先比长度再比内容**：少一行时逐行比对会从第一个差异点开始雪崩式误报，
 * 而"行数不同"这一条信息本身就已经足够定位问题。
 * 内容差异最多报 5 处（再多会淹没有效信息）；**只报位置不报值**——数据行可能含用户数据/密文。
 */
export function compareCopyRows(expected: string[], actual: string[]): SampleComparison {
  if (expected.length !== actual.length) {
    return { ok: false, detail: `行数不同：dump ${expected.length} 行 / 恢复库 ${actual.length} 行` };
  }
  const bad: number[] = [];
  for (let i = 0; i < expected.length && bad.length < 5; i += 1) {
    if (expected[i] !== actual[i]) bad.push(i + 1);
  }
  if (bad.length === 0) return { ok: true, detail: `${expected.length} 行逐行一致` };
  return { ok: false, detail: `共 ${expected.length} 行，其中第 ${bad.join('、')} 行内容不一致（只报位置，不回显数据）` };
}
