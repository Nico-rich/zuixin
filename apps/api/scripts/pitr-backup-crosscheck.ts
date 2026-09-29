/**
 * M12-P5：**PITR × 逻辑备份交叉验证**（审计项："两条恢复路径从未互相印证"）。
 *
 * 为什么需要它（两条独立路径各自的"自证"都不够）：
 * - `pitr-drill.ts`（M11-P15）证明的是"**WAL 归档 + 恢复**能把库带回事故前一刻"，它的对照物是
 *   **事故前从源库抓的快照**（同一台机器、同一份数据目录）；
 * - `backup.ts` / `restore.ts`（M11-P9/P13）证明的是"**pg_dump 产物**能回灌"，它的对照物是
 *   **dump 文件自身的 COPY 段**（口径纪律：绝不拿"源库当前行数"当期望）。
 * 两条链路的对照物**都不是对方**，于是下面这类事故无法被任何一方发现：
 * ① 恢复出来的实例"看着对"，但它的**逻辑备份能力**已经坏了（例如恢复到的时间线缺少
 *    extension / 序列 / 迁移历史，pg_dump 出来的东西回灌后与它不一致）；
 * ② 逻辑备份路径**丢了事故的痕迹**（回灌出来的库既不像事故前、也不像事故后）。
 *
 * 本脚本的做法（一次运行把两条链路**钉在同一个物理实例上**）：
 * ```
 *  [pitr-drill --keep]                       ← 上游：一次真实 PITR 演练，保留容器
 *        │
 *        ├─ dst（PITR 恢复到目标时刻，事故被撤销）──┐
 *        │                                          ├─ pg_dump（生产参数）→ 回灌到新实例 DB-A
 *        └─ src（源库，事故**已发生**）────────────┘── pg_dump（生产参数）→ 回灌到新实例 DB-B
 * ```
 * 四路交叉断言（全部是硬断言，任何一条不成立即退出码 3）：
 * - **等价 A**：DB-A ≡ dst（四层：A 指纹 / B 全表行数 / C 关键表 / D 抽样内容逐行）；
 * - **等价 B**：DB-B ≡ src（同上四层）——逻辑备份路径在**两个方向**上都保真；
 * - **分歧 C**：dst 与 src 的差异**恰好等于事故足迹**（多出来的表/行数必须逐项对上，
 *   任何未声明的差异都算 FAIL）——两个恢复语义在同一份数据上"分歧得很精确"；
 * - **语义 D**：事故行只出现在 src、promote 后写入行只出现在 dst（点位断言，行数相等时也骗不过去）。
 *
 * 安全边界（与 `pitr-drill.ts` 同源，**绝不继承其风险**）：
 * - 只**读** drill 的资源（`docker exec` 查询 / pg_dump），**绝不删除** drill 的容器与卷；
 * - 自建资源命名严格受限 `pitr-xcheck-<stamp>-<rand>-*`，删除前逐一断言名字；
 * - 不读 `.env`、不连 `DATABASE_URL`、不碰共享容器（`docker-postgres-1` 等）；新实例**不暴露宿主端口**；
 * - 口令随机生成，经 `-e POSTGRES_PASSWORD`（无值形式）透传，绝不进 argv；
 * - 默认 dry-run：不加 `--confirm` 只打印计划。
 *
 * 退出码（契约同 m10 runbook §1.3）：0 成功 / 1 执行失败 / 2 参数错误 / 3 校验失败 / 4 前置条件不满足
 */
import { createReadStream, existsSync, mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { createDumpStatsCollector, buildPgDumpArgs, compareCopyRows, compareRowCounts, parseCopyRowsText, pickSampleTables, verifyDumpStats, type BackupCheck, type DumpStats } from './lib/dump';
import { KEY_TABLES, PgClient } from './lib/pg';
import { helpText, parseArgs, type FlagSpec } from './lib/args';
import {
  EXIT_FAIL, EXIT_OK, EXIT_PRECONDITION, EXIT_USAGE, EXIT_VERIFY,
  DEFAULT_EXIT_CODES, createLogger, fail, formatBytes, formatDuration, run, sha256File, stamp,
  type Logger, type RunResult,
} from './lib/cli';

const SCRIPT = 'pitr-backup-crosscheck.ts';

// ---------------------------------------------------------------------------
// 常量（与 pitr-drill.ts 对齐；drill 侧若不改，这里也不需要改）
// ---------------------------------------------------------------------------

/** 本次运行自建资源的命名（删除前逐一断言；**绝不**匹配 drill 的前缀） */
const NAME_PREFIX = 'pitr-xcheck';
const NAME_PATTERN = /^pitr-xcheck-\d{8}-\d{6}-[0-9a-f]{6}-xr$/;
const VOLUME_PATTERN = /^pitr-xcheck-\d{8}-\d{6}-[0-9a-f]{6}-data$/;
/** 上游 drill 的资源名（只读；跨脚本契约） */
const DRILL_NAME_PATTERN = /^pitr-drill-\d{8}-\d{6}-[0-9a-f]{6}-(src|dst)$/;

/** pitr-drill.ts 内部的库/用户常量（跨脚本契约：drill 侧改名则本脚本在连接处大声失败） */
const DRILL_USER = 'drill';
const DRILL_DB = 'drilldb';
/** 新实例的管理员（官方镜像入口脚本创建；容器内 socket 为 trust，无需口令） */
const ADMIN_USER = 'postgres';
const ADMIN_DB = 'postgres';

const XCHECK_DB_PITR = 'xcheck_from_pitr';
const XCHECK_DB_SRC = 'xcheck_from_src';

/** 事故对象（与 pitr-drill.ts 的 ACCIDENT_DROPPED_TABLE / 默认 Plan 播种行数一致） */
const ACCIDENT_DROPPED_TABLE = 'UsageRecord';
const PLAN_TABLE = 'Plan';
const DEFAULT_PLAN_ROWS = 3;
/** drill 自建表：事故行 / promote 后写入行都写在这里（语义 D 的点位断言靠它） */
const DRILL_EVENT_TABLE = 'pitr_drill_event';

const DEFAULT_PG_IMAGE = 'pgvector/pgvector:pg16';
const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_VERIFY_SAMPLE = 5;

const SPECS: readonly FlagSpec[] = [
  { name: 'confirm', type: 'boolean', help: '真正执行交叉验证（**默认 dry-run**：只打印计划）' },
  { name: 'dry-run', type: 'boolean', help: '显式 dry-run（与默认行为一致）' },
  { name: 'drill-report', type: 'string', valueName: '<path>', help: '复用既有 `pitr-drill --confirm --keep --report-json` 的报告（不给则本脚本自己跑一轮 drill）' },
  { name: 'keep', type: 'boolean', help: '保留本次自建的实例与卷（人工取证；默认结束即删）' },
  { name: 'clean-stale', type: 'boolean', help: '先清理历史残留的 pitr-xcheck 容器/卷（严格命名匹配）' },
  { name: 'pg-image', type: 'string', valueName: '<image>', default: DEFAULT_PG_IMAGE, help: '自跑 drill 时使用的 PG 镜像' },
  { name: 'verify-sample', type: 'number', valueName: '<n>', default: DEFAULT_VERIFY_SAMPLE, help: 'D 层内容级抽样的表数（0 = 关闭）' },
  { name: 'plan-rows', type: 'number', valueName: '<n>', default: DEFAULT_PLAN_ROWS, help: 'drill 播种的 Plan 行数（事故 DELETE 的行数基准；用于精确核对分歧）' },
  { name: 'timeout-ms', type: 'number', valueName: '<ms>', default: DEFAULT_TIMEOUT_MS, help: '实例就绪等待上限' },
  { name: 'work-dir', type: 'string', valueName: '<dir>', help: '逻辑备份产物的落盘目录（默认系统临时目录下的 pitr-xcheck-<stamp>）' },
  { name: 'report-json', type: 'string', valueName: '<path>', help: '机器可读报告落盘路径' },
  { name: 'label', type: 'string', valueName: '<tag>', default: 'pitr-xcheck', help: '报告标签' },
];

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------

class XcheckError extends Error {
  constructor(message: string, readonly code: number = EXIT_FAIL) {
    super(message);
    this.name = 'XcheckError';
  }
}

interface Check {
  name: string;
  ok: boolean;
  detail: string;
}

interface Names {
  stamp: string;
  rand: string;
  container: string;
  volume: string;
}

interface DrillFacts {
  reportPath: string;
  ranByScript: boolean;
  verdict: string;
  image: string;
  containers: { src: string; dst: string };
  timeline: Record<string, unknown>;
  recoveredToTime?: string;
}

interface DumpArtifact {
  database: string;
  path: string;
  bytes: number;
  sha256: string;
  ms: number;
  stats: DumpStats;
}

interface Config {
  label: string;
  pgImage: string;
  drillReport?: string;
  verifySample: number;
  planRows: number;
  timeoutMs: number;
  keep: boolean;
  cleanStale: boolean;
  confirm: boolean;
  workDir?: string;
  reportJson?: string;
}

// ---------------------------------------------------------------------------
// 纯函数（单测覆盖；不含任何 docker/IO）
// ---------------------------------------------------------------------------

/** 事故足迹期望：哪些表在"对照侧"应当**不存在**，以及各表行数的精确差值（**参考侧 − 对照侧**） */
export interface FootprintExpectation {
  missingTables: readonly string[];
  expectedDeltas: Readonly<Record<string, number>>;
}

export interface FootprintEntry {
  table: string;
  /** 参考侧（PITR 恢复实例）行数；null = 该表不存在 */
  reference: number | null;
  /** 对照侧（事故后的源库）行数；null = 该表不存在 */
  other: number | null;
  /** 行数差（参考侧 − 对照侧）；任一侧表不存在时为 null */
  delta: number | null;
  note: string;
  ok: boolean;
}

export interface FootprintVerdict {
  ok: boolean;
  entries: FootprintEntry[];
  /** 未被期望覆盖的差异（表名） */
  unexpected: string[];
}

/**
 * 核对"两个恢复语义在同一份数据上的差异**恰好**是事故足迹"。
 *
 * 口径纪律：**任何未声明的差异都算失败**——包括"对照侧多出来一张表"（事故不会创建表）、
 * 行数差值与期望不符、以及"声明为缺失的表其实还在"。绝不写成"大致相等"。
 */
export function verifyIncidentFootprint(input: {
  reference: Record<string, number>;
  other: Record<string, number>;
  expectation: FootprintExpectation;
}): FootprintVerdict {
  const { reference, other, expectation } = input;
  const tables = [...new Set([...Object.keys(reference), ...Object.keys(other)])].sort();
  const entries: FootprintEntry[] = [];
  const unexpected: string[] = [];
  for (const table of tables) {
    const ref = table in reference ? reference[table] : null;
    const oth = table in other ? other[table] : null;
    if (oth === null) {
      const declared = expectation.missingTables.includes(table);
      entries.push({
        table, reference: ref, other: null, delta: null, ok: declared,
        note: declared ? `对照侧不存在（已声明的事故足迹）` : `对照侧不存在，但**未在 missingTables 里声明**`,
      });
      if (!declared) unexpected.push(table);
      continue;
    }
    if (ref === null) {
      entries.push({ table, reference: null, other: oth, delta: null, ok: false, note: '对照侧多出该表（事故不会创建表）' });
      unexpected.push(table);
      continue;
    }
    // 差值方向 = 参考侧 − 对照侧：事故是"删数据"，所以恢复侧（参考侧）应当**更多**（正差值）
    const delta = ref - oth;
    const want = expectation.expectedDeltas[table] ?? 0;
    const ok = delta === want;
    entries.push({
      table, reference: ref, other: oth, delta, ok,
      note: ok ? `差值 ${delta}（= 期望）` : `差值 ${delta}，期望 ${want}`,
    });
    if (!ok) unexpected.push(table);
  }
  return { ok: unexpected.length === 0, entries, unexpected };
}

/** 汇总一组行数（表数 + 行合计）——报告与断言都用它，避免各处自己 reduce。 */
export function summarizeCounts(rowCounts: Record<string, number>): { tables: number; rows: number } {
  const values = Object.values(rowCounts);
  return { tables: values.length, rows: values.reduce((a, b) => a + b, 0) };
}

/** 断言容器名属于本次命名空间（删除前调用；不匹配直接抛，绝不"尽力而为地删"） */
export function assertOwnContainer(name: string): void {
  if (!NAME_PATTERN.test(name)) throw new XcheckError(`拒绝操作非本次命名空间的容器：${name}`, EXIT_PRECONDITION);
}

/** 断言卷名属于本次命名空间 */
export function assertOwnVolume(name: string): void {
  if (!VOLUME_PATTERN.test(name)) throw new XcheckError(`拒绝操作非本次命名空间的卷：${name}`, EXIT_PRECONDITION);
}

/** 断言是上游 drill 的资源（只读操作前的最小校验：名字不对就不碰） */
export function assertDrillContainer(name: string): void {
  if (!DRILL_NAME_PATTERN.test(name)) throw new XcheckError(`不是 pitr-drill 的容器名，拒绝连接：${name}`, EXIT_PRECONDITION);
}

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------

function docker(args: readonly string[], opts: { env?: NodeJS.ProcessEnv; timeoutMs?: number; quiet?: boolean } = {}): Promise<RunResult> {
  return run('docker', args, { env: opts.env, timeoutMs: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS, quiet: opts.quiet ?? true });
}

async function dockerOk(args: readonly string[], what: string): Promise<RunResult> {
  const res = await docker(args);
  if (res.code !== 0 || res.spawnError) {
    throw new XcheckError(`${what} 失败（退出码 ${res.code}${res.spawnError ? `，${res.spawnError}` : ''}）：${(res.stderr || '').trim().slice(0, 400)}`);
  }
  return res;
}

async function sleep(ms: number): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

function makeNames(): Names {
  const s = stamp();
  const rand = randomBytes(3).toString('hex');
  return { stamp: s, rand, container: `${NAME_PREFIX}-${s}-${rand}-xr`, volume: `${NAME_PREFIX}-${s}-${rand}-data` };
}

/** 一次性管理员客户端（docker 模式：容器内 `psql -U postgres`，socket trust，无需口令） */
function adminClient(container: string, database: string = ADMIN_DB): PgClient {
  return new PgClient({
    mode: 'docker',
    container,
    target: { scheme: 'postgresql', user: ADMIN_USER, password: '', host: container, port: 5432, database, query: '', redacted: `docker://${ADMIN_USER}@${container}/${database}` },
  });
}

/** drill 内部用户的客户端（socket trust；口令从不进 argv，也从不被本脚本读取） */
function drillClient(container: string, database: string = DRILL_DB): PgClient {
  return new PgClient({
    mode: 'docker',
    container,
    target: { scheme: 'postgresql', user: DRILL_USER, password: '', host: container, port: 5432, database, query: '', redacted: `docker://${DRILL_USER}@${container}/${database}` },
  });
}

/** 等待实例就绪（`pg_isready` 通过；容器退出/超时都是硬失败） */
async function waitReady(container: string, timeoutMs: number, logger: Logger): Promise<number> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const state = await docker(['inspect', '-f', '{{.State.Running}}', container]);
    if (state.code !== 0) throw new XcheckError(`实例 ${container} 不存在或无法 inspect`, EXIT_PRECONDITION);
    if (state.stdout.trim() !== 'true') throw new XcheckError(`实例 ${container} 已退出（无法就绪）`, EXIT_FAIL);
    const ready = await docker(['exec', container, 'pg_isready', '-U', ADMIN_USER, '-q']);
    if (ready.code === 0) {
      logger.info(`实例就绪：${container}（${formatDuration(Date.now() - started)}）`);
      return Date.now() - started;
    }
    await sleep(500);
  }
  throw new XcheckError(`实例 ${container} 在 ${formatDuration(timeoutMs)} 内未就绪`, EXIT_PRECONDITION);
}

/** 读取 drill 报告（跨脚本契约：只认字段存在，缺字段直接失败而不是猜） */
function readDrillReport(path: string): DrillFacts {
  const abs = resolve(path);
  if (!existsSync(abs)) throw new XcheckError(`drill 报告不存在：${abs}`, EXIT_PRECONDITION);
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(require('node:fs').readFileSync(abs, 'utf8')) as Record<string, unknown>;
  } catch (err) {
    throw new XcheckError(`drill 报告不是合法 JSON：${(err as Error).message}`, EXIT_PRECONDITION);
  }
  const env = raw.environment as { pgImage?: string; containers?: { src?: string; dst?: string } } | undefined;
  const src = env?.containers?.src;
  const dst = env?.containers?.dst;
  const image = env?.pgImage;
  if (!src || !dst || !image) {
    throw new XcheckError(`drill 报告缺少 environment.{pgImage,containers.{src,dst}}：${abs}`, EXIT_PRECONDITION);
  }
  assertDrillContainer(src);
  assertDrillContainer(dst);
  return {
    reportPath: abs,
    ranByScript: false,
    verdict: String(raw.verdict ?? 'UNKNOWN'),
    image,
    containers: { src, dst },
    timeline: (raw.timeline ?? {}) as Record<string, unknown>,
    recoveredToTime: (raw.recovery as { recoveredToTime?: string } | undefined)?.recoveredToTime,
  };
}

/** 解析 tsx CLI（自跑 drill 用）：优先 `tsx` 包声明的 bin，找不到就明确失败（不猜） */
function tsxCliPath(): string | null {
  try {
    const require_ = createRequire(__filename);
    const pkgPath = require_.resolve('tsx/package.json');
    const pkg = JSON.parse(require('node:fs').readFileSync(pkgPath, 'utf8')) as { bin?: string | Record<string, string> };
    const bins = typeof pkg.bin === 'string' ? { tsx: pkg.bin } : (pkg.bin ?? {});
    const rel = bins.tsx ?? Object.values(bins)[0];
    if (!rel) return null;
    const cli = resolve(dirname(pkgPath), rel);
    return existsSync(cli) ? cli : null;
  } catch {
    return null;
  }
}

/** 跑一轮 drill（`--confirm --keep --report-json`）并解析其报告 */
async function runDrill(config: Config, logger: Logger, workDir: string): Promise<DrillFacts> {
  const reportPath = join(workDir, 'pitr-drill-report.json');
  const cli = tsxCliPath();
  if (!cli) {
    throw new XcheckError(
      '找不到 tsx CLI（用于自跑 pitr-drill）。请手工执行 ' +
        '`npx tsx scripts/pitr-drill.ts --confirm --keep --report-json <path>` 后用 --drill-report <path> 复用其结果。',
      EXIT_PRECONDITION,
    );
  }
  logger.step(`运行上游 PITR 演练（${SCRIPT} 不重复实现 PITR 编排，只消费它的产物）`);
  const res = await run(process.execPath, [cli, resolve(__dirname, 'pitr-drill.ts'), '--confirm', '--keep', '--pg-image', config.pgImage, '--report-json', reportPath], {
    timeoutMs: 15 * 60_000,
    quiet: false,
  });
  if (res.code !== 0) {
    throw new XcheckError(`pitr-drill 失败（退出码 ${res.code}）：交叉验证要求一条健康的 PITR 基线`, res.code === EXIT_VERIFY ? EXIT_PRECONDITION : EXIT_FAIL);
  }
  const facts = readDrillReport(reportPath);
  return { ...facts, ranByScript: true };
}

/** 解析明文 dump 的表/COPY/行数统计（与 backup.ts 同口径：直接读产物，不再连库） */
async function collectStats(file: string): Promise<DumpStats> {
  const collector = createDumpStatsCollector();
  const rl = createInterface({ input: createReadStream(file), crlfDelay: Infinity });
  for await (const line of rl) collector.pushLine(line);
  return collector.finish();
}

/** 逻辑备份（**生产参数**：lib/dump.ts 的一致性参数，只读源库） */
async function logicalBackup(client: PgClient, user: string, database: string, path: string, logger: Logger): Promise<DumpArtifact> {
  const dumpArgs = buildPgDumpArgs({ user, database });
  const res = await client.exec(dumpArgs, { quiet: true, timeoutMs: 3_600_000, stdoutToFile: path });
  if (res.code !== 0 || res.spawnError) {
    if (existsSync(path)) rmSync(path);
    throw new XcheckError(`pg_dump 失败（${database}，退出码 ${res.code}）：${(res.spawnError ?? res.stderr).trim().slice(0, 300)}`);
  }
  if (!existsSync(path) || statSync(path).size === 0) {
    throw new XcheckError(`pg_dump 产物为空（${database}）：拒绝拿空产物做交叉验证`);
  }
  const bytes = statSync(path).size;
  const sha256 = await sha256File(path);
  const stats = await collectStats(path);
  logger.info(`逻辑备份（${database}）：${formatBytes(bytes)} / ${formatDuration(res.durationMs)} / 表 ${stats.tables} / 行 ${stats.totalRows}（sha256 ${sha256.slice(0, 16)}…）`);
  return { database, path, bytes, sha256, ms: res.durationMs, stats };
}

/** 四层核对（A 指纹 / B 行数 / C 关键表 / D 抽样）——两侧都按同一口径取数 */
async function fourLayerCompare(input: {
  label: string;
  reference: PgClient;
  referenceDb: string;
  actual: PgClient;
  actualDb: string;
  sampleCount: number;
  logger: Logger;
}): Promise<{ checks: Check[]; referenceCounts: Record<string, number>; actualCounts: Record<string, number> }> {
  const { label, reference, referenceDb, actual, actualDb, sampleCount } = input;
  const checks: Check[] = [];

  // A：七项 schema 指纹
  const refFp = await reference.fingerprint(referenceDb);
  const actFp = await actual.fingerprint(actualDb);
  const fpDiffs = Object.keys(refFp).filter((k) => refFp[k] !== actFp[k]);
  checks.push({
    name: `${label}-A-指纹`,
    ok: fpDiffs.length === 0,
    detail: fpDiffs.length === 0
      ? `7 项一致（表 ${refFp.tables} / 列 ${refFp.columns} / 索引 ${refFp.indexes} / 枚举 ${refFp.enums} / 外键 ${refFp.fks} / 迁移 ${refFp.prisma_migrations} / 扩展 [${refFp.extensions}]）`
      : `不一致项：${fpDiffs.map((k) => `${k}(${refFp[k]} vs ${actFp[k]})`).join('、')}`,
  });

  // B：全表行数
  const refCounts = await reference.tableRowCounts(referenceDb);
  const actCounts = await actual.tableRowCounts(actualDb);
  const rowDiffs = compareRowCounts(refCounts, actCounts);
  const refSum = summarizeCounts(refCounts);
  checks.push({
    name: `${label}-B-行数`,
    ok: rowDiffs.length === 0,
    detail: rowDiffs.length === 0
      ? `${refSum.tables} 张表 / ${refSum.rows} 行逐表一致`
      : `${rowDiffs.length} 张表不一致：${rowDiffs.slice(0, 5).map((d) => `${d.table}(${d.expected} vs ${d.actual})`).join('、')}`,
  });

  // C：关键表点名（两侧都查，避免"两边一样地缺"被放过）
  const keyDetails: string[] = [];
  let keyOk = true;
  let keyChecked = 0;
  for (const { table } of KEY_TABLES) {
    const inRef = refCounts[table];
    const inAct = actCounts[table];
    if (inRef === undefined && inAct === undefined) continue; // 该表在两侧都不存在（如被事故删掉的那张）
    keyChecked += 1;
    const ok = inRef === inAct;
    if (!ok) keyOk = false;
    keyDetails.push(`${table}=${inRef ?? '-'}/${inAct ?? '-'}`);
  }
  checks.push({
    name: `${label}-C-关键表`,
    ok: keyOk,
    detail: keyChecked === 0 ? '两侧都没有关键表（空库？）' : keyDetails.join(' '),
  });

  // D：内容级抽样（逐行原样比较；跳过超限表）
  const sampleTables = pickSampleTables(refCounts, sampleCount, { preferred: ['_prisma_migrations', PLAN_TABLE, DRILL_EVENT_TABLE] });
  const sampleDetails: string[] = [];
  let sampleOk = true;
  for (const table of sampleTables) {
    const refText = await reference.dumpTableData(referenceDb, table);
    const actText = await actual.dumpTableData(actualDb, table);
    const refRows = parseCopyRowsText(refText, [table]).rows[table] ?? [];
    const actRows = parseCopyRowsText(actText, [table]).rows[table] ?? [];
    const cmp = compareCopyRows(refRows, actRows);
    if (!cmp.ok) sampleOk = false;
    sampleDetails.push(`${table}: ${cmp.ok ? 'ok' : cmp.detail}`);
  }
  checks.push({
    name: `${label}-D-抽样内容`,
    ok: sampleOk,
    detail: sampleTables.length === 0 ? '抽样关闭/无可抽样表' : sampleDetails.join('；'),
  });

  return { checks, referenceCounts: refCounts, actualCounts: actCounts };
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

async function cleanupStale(logger: Logger): Promise<void> {
  const containers = await docker(['ps', '-a', '--format', '{{.Names}}']);
  const volumes = await docker(['volume', 'ls', '--format', '{{.Name}}']);
  const staleContainers = containers.stdout.split(/\r?\n/).map((s) => s.trim()).filter((n) => NAME_PATTERN.test(n));
  const staleVolumes = volumes.stdout.split(/\r?\n/).map((s) => s.trim()).filter((n) => VOLUME_PATTERN.test(n));
  if (staleContainers.length + staleVolumes.length === 0) {
    logger.info('无 pitr-xcheck 残留');
    return;
  }
  for (const name of staleContainers) {
    assertOwnContainer(name);
    await docker(['rm', '-f', name], { quiet: true });
    logger.info(`已删除残留容器 ${name}`);
  }
  for (const name of staleVolumes) {
    assertOwnVolume(name);
    await docker(['volume', 'rm', name], { quiet: true });
    logger.info(`已删除残留卷 ${name}`);
  }
}

function printPlan(logger: Logger, config: Config, names: Names, workDir: string, drillFacts?: DrillFacts): void {
  logger.raw('');
  logger.raw(`=== 计划（${SCRIPT} · ${config.label}）===`);
  logger.raw('模式        ：dry-run（未创建任何资源；加 --confirm 才执行）');
  logger.raw(`上游 PITR   ：${config.drillReport ? `复用 ${resolve(config.drillReport)}（--drill-report）` : '本脚本自己跑一轮 pitr-drill --confirm --keep（约 40~55s）'}`);
  if (drillFacts) {
    logger.raw(`             容器 ${drillFacts.containers.src}（事故后源库）/ ${drillFacts.containers.dst}（PITR 恢复到 ${drillFacts.recoveredToTime ?? '目标时刻'}）`);
  }
  logger.raw(`自建实例    ：容器 ${names.container} + 卷 ${names.volume}（镜像 ${config.pgImage}；**不暴露宿主端口**）`);
  logger.raw(`产物目录    ：${workDir}（pg_dump 明文产物；不加密——仅本机一次性目录）`);
  logger.raw(`交叉断言    ：等价 A/B（四层）× 2 + 分歧 C（恰好事故足迹：${ACCIDENT_DROPPED_TABLE} 缺失、${PLAN_TABLE} 差 ${config.planRows} 行）+ 语义 D（事故行 / promote 后写入行的点位）`);
  logger.raw(`抽样        ：${config.verifySample} 张表逐行比较`);
  logger.raw(`清理        ：${config.keep ? '保留自建实例与卷（--keep）' : '结束即删自建实例与卷'}；**绝不删除 drill 的容器/卷**`);
  logger.raw('');
}

async function main(): Promise<number> {
  const parsed = parseArgs(process.argv.slice(2), SPECS);
  const logger = createLogger(SCRIPT);
  if (!parsed.ok) {
    process.stderr.write(`${SCRIPT}：${parsed.error}\n`);
    return EXIT_USAGE;
  }
  if (!parsed.parsed) {
    process.stdout.write(
      helpText({
        script: SCRIPT,
        summary: 'PITR × 逻辑备份交叉验证（消费 pitr-drill --keep 的实例；把两条恢复链路钉在同一份数据上）',
        specs: SPECS,
        exitCodes: DEFAULT_EXIT_CODES,
        examples: [
          'npx tsx scripts/pitr-backup-crosscheck.ts                                  # dry-run（默认，只打印计划）',
          'npx tsx scripts/pitr-backup-crosscheck.ts --confirm                        # 自跑 drill + 交叉验证（约 2 分钟）',
          'npx tsx scripts/pitr-backup-crosscheck.ts --confirm --drill-report /tmp/pitr.json   # 复用既有 drill --keep 结果',
          'npx tsx scripts/pitr-backup-crosscheck.ts --confirm --keep --report-json /tmp/xcheck.json',
        ],
        notes: [
          '本脚本只读 drill 的容器（docker exec 查询 + pg_dump），绝不删除它们；drill 资源的清理用 `npx tsx scripts/pitr-drill.ts --confirm --clean-stale`。',
          '逻辑备份用**生产参数**（lib/dump.ts 的一致性参数），回灌走**生产路径**（psql -v ON_ERROR_STOP=1）。',
          '任一交叉断言不成立 ⇒ 退出码 3（校验失败），并在报告里列出每一处差异。',
        ],
      }),
    );
    return EXIT_OK;
  }
  const v = parsed.parsed.values;
  const config: Config = {
    label: String(v.label ?? 'pitr-xcheck'),
    pgImage: String(v['pg-image'] ?? DEFAULT_PG_IMAGE),
    drillReport: v['drill-report'] === undefined ? undefined : String(v['drill-report']),
    verifySample: Math.max(0, Math.trunc(Number(v['verify-sample'] ?? DEFAULT_VERIFY_SAMPLE))),
    planRows: Math.max(0, Math.trunc(Number(v['plan-rows'] ?? DEFAULT_PLAN_ROWS))),
    timeoutMs: Math.max(10_000, Math.trunc(Number(v['timeout-ms'] ?? DEFAULT_TIMEOUT_MS))),
    keep: v.keep === true,
    cleanStale: v['clean-stale'] === true,
    confirm: v.confirm === true && v['dry-run'] !== true,
    workDir: v['work-dir'] === undefined ? undefined : String(v['work-dir']),
    reportJson: v['report-json'] === undefined ? undefined : String(v['report-json']),
  };
  const names = makeNames();
  const workDir = resolve(config.workDir ?? join(tmpdir(), `${NAME_PREFIX}-${names.stamp}-${names.rand}`));

  if (!config.confirm) {
    printPlan(logger, config, names, workDir);
    logger.raw('（dry-run 到此为止：未创建容器/卷，也未调用 docker；加 --confirm 才真跑）');
    return EXIT_OK;
  }

  const started = Date.now();
  const checks: Check[] = [];
  let exitCode = EXIT_OK;
  let drillFacts: DrillFacts | undefined;
  let restoreStartedAt = 0;
  const report: Record<string, unknown> = {
    label: config.label,
    script: SCRIPT,
    startedAt: new Date().toISOString(),
    verdict: 'FAIL',
    plan: { selfContainedDrill: config.drillReport === undefined, keep: config.keep, verifySample: config.verifySample, planRows: config.planRows },
    environment: { container: names.container, volume: names.volume, workDir },
    checks,
    numbers: {},
    notes: [] as string[],
  };
  const notes = report.notes as string[];

  try {
    const dockerVersion = (await docker(['version', '--format', '{{.Server.Version}}'])).stdout.trim();
    (report.environment as Record<string, unknown>).dockerVersion = dockerVersion;
    if (config.cleanStale) await cleanupStale(logger);

    // ---- 0) 前置：不得与既有 xcheck 命名空间冲突 ----
    const existing = await docker(['ps', '-a', '--format', '{{.Names}}']);
    if (existing.stdout.split(/\r?\n/).map((s) => s.trim()).includes(names.container)) {
      throw new XcheckError(`容器名冲突（重名残留？）：${names.container}`, EXIT_PRECONDITION);
    }

    // ---- 1) 上游 PITR 基线 ----
    logger.step('上游 PITR 基线');
    mkdirSync(workDir, { recursive: true });
    drillFacts = config.drillReport ? readDrillReport(config.drillReport) : await runDrill(config, logger, workDir);
    report.drill = drillFacts;
    checks.push({
      name: 'drill-verdict',
      ok: drillFacts.verdict === 'PASS',
      detail: `上游演练结论 ${drillFacts.verdict}（${drillFacts.ranByScript ? '本脚本执行' : '复用报告'}：${drillFacts.reportPath}）`,
    });
    if (drillFacts.verdict !== 'PASS') {
      throw new XcheckError(`上游 PITR 演练结论不是 PASS（${drillFacts.verdict}）：交叉验证拒绝在不可信的基线上做结论`, EXIT_PRECONDITION);
    }
    logger.info(`上游实例：src=${drillFacts.containers.src}（事故后源库）/ dst=${drillFacts.containers.dst}（恢复到 ${drillFacts.recoveredToTime ?? '-'}）`);

    const dstClient = drillClient(drillFacts.containers.dst);
    const srcClient = drillClient(drillFacts.containers.src);
    for (const [label, client] of [['dst', dstClient], ['src', srcClient]] as const) {
      const ping = await client.ping(DRILL_DB);
      checks.push({ name: `connect-${label}`, ok: ping.ok, detail: `${label} 连通性：${ping.ok ? 'ok' : ping.detail}` });
      if (!ping.ok) throw new XcheckError(`无法连接 drill 实例 ${label}（${client.description}）：${ping.detail}`, EXIT_PRECONDITION);
    }

    // ---- 2) 两侧的逻辑备份（生产参数）----
    logger.step('对 dst（PITR 恢复态）与 src（事故后）各做一次逻辑备份');
    const backupPitr = await logicalBackup(dstClient, DRILL_USER, DRILL_DB, join(workDir, 'from-pitr.sql'), logger);
    const backupSrc = await logicalBackup(srcClient, DRILL_USER, DRILL_DB, join(workDir, 'from-src.sql'), logger);
    const dstTableCount = Object.keys(await dstClient.tableRowCounts(DRILL_DB)).length;
    const srcTableCount = Object.keys(await srcClient.tableRowCounts(DRILL_DB)).length;
    for (const [name, artifact, expectTables] of [['from-pitr', backupPitr, dstTableCount], ['from-src', backupSrc, srcTableCount]] as const) {
      const dumpChecks: BackupCheck[] = verifyDumpStats(artifact.stats, { sizeBytes: artifact.bytes, expectTables, minRows: 1 });
      checks.push({
        name: `dump-${name}-stats`,
        ok: dumpChecks.every((c) => c.ok),
        detail: `表 ${artifact.stats.tables} / COPY 段 ${artifact.stats.copySegments} / 行 ${artifact.stats.totalRows} / 扩展 [${artifact.stats.extensions.join(',')}]`,
      });
    }

    // ---- 3) 自建一次性实例（无宿主端口；口令随机且不进 argv）----
    logger.step(`创建一次性实例 ${names.container}（不暴露宿主端口）`);
    await dockerOk(['volume', 'create', names.volume], '创建卷');
    const password = randomBytes(12).toString('base64url');
    const runRes = await docker(
      ['run', '-d', '--name', names.container, '-e', 'POSTGRES_PASSWORD', '--mount', `type=volume,source=${names.volume},target=/var/lib/postgresql/data`, drillFacts.image],
      { env: { ...process.env, POSTGRES_PASSWORD: password } },
    );
    if (runRes.code !== 0) throw new XcheckError(`创建实例失败：${(runRes.stderr || '').trim().slice(0, 300)}`);
    restoreStartedAt = Date.now();
    const startupMs = await waitReady(names.container, config.timeoutMs, logger);
    const xrClient = adminClient(names.container);
    (report.numbers as Record<string, unknown>).instanceStartupMs = startupMs;

    // ---- 4) 回灌（生产路径：psql -v ON_ERROR_STOP=1）----
    logger.step('把两份逻辑备份回灌到新实例（两个独立库）');
    const loadResults: { name: string; database: string; ok: boolean; detail: string }[] = [];
    for (const [name, artifact, database] of [
      ['from-pitr', backupPitr, XCHECK_DB_PITR],
      ['from-src', backupSrc, XCHECK_DB_SRC],
    ] as const) {
      await xrClient.createDatabase(database);
      const t0 = Date.now();
      const res = await xrClient.loadScript(database, createReadStream(artifact.path));
      const ok = res.code === 0 && !res.spawnError;
      loadResults.push({ name, database, ok, detail: ok ? formatDuration(Date.now() - t0) : (res.stderr || '').trim().slice(0, 300) });
      checks.push({
        name: `restore-${name}`,
        ok,
        detail: ok ? `回灌到 ${database} 成功（${formatDuration(Date.now() - t0)}）` : `回灌失败（退出码 ${res.code}）：${(res.stderr || '').trim().slice(0, 300)}`,
      });
    }
    (report.numbers as Record<string, unknown>).restoreMs = Date.now() - restoreStartedAt;
    if (!loadResults.every((r) => r.ok)) throw new XcheckError('逻辑备份回灌失败：后续比较无意义', EXIT_FAIL);

    // ---- 5) 交叉断言 ----
    logger.step('交叉断言：等价 A/B（四层）+ 分歧 C（事故足迹）+ 语义 D（点位）');
    const pairPitr = await fourLayerCompare({
      label: '等价A(dst↔逻辑还原)', reference: dstClient, referenceDb: DRILL_DB, actual: xrClient, actualDb: XCHECK_DB_PITR,
      sampleCount: config.verifySample, logger,
    });
    const pairSrc = await fourLayerCompare({
      label: '等价B(src↔逻辑还原)', reference: srcClient, referenceDb: DRILL_DB, actual: xrClient, actualDb: XCHECK_DB_SRC,
      sampleCount: config.verifySample, logger,
    });
    checks.push(...pairPitr.checks, ...pairSrc.checks);

    // 分歧 C：dst（参考侧，事故被撤销） vs src（对照侧，事故已发生）
    const footprint = verifyIncidentFootprint({
      reference: pairPitr.referenceCounts,
      other: pairSrc.referenceCounts,
      expectation: { missingTables: [ACCIDENT_DROPPED_TABLE], expectedDeltas: { [PLAN_TABLE]: config.planRows } },
    });
    checks.push({
      name: '分歧C-事故足迹精确匹配',
      ok: footprint.ok,
      detail: footprint.ok
        ? `两侧差异恰好是事故足迹（${ACCIDENT_DROPPED_TABLE} 在 src 不存在；${PLAN_TABLE} 差 ${config.planRows} 行；其余 ${footprint.entries.length - 2} 张表逐表一致）`
        : `未声明的差异：${footprint.unexpected.join('、')}；明细 ${footprint.entries.filter((e) => !e.ok).map((e) => `${e.table}(${e.note})`).join('；')}`,
    });

    // 语义 D：点位断言（行数相等也骗不过去：事故行 vs promote 后写入行）
    const accidentInSrc = Number((await srcClient.scalar(DRILL_DB, `SELECT count(*) FROM "${DRILL_EVENT_TABLE}" WHERE phase = 'accident'`)).trim());
    const accidentInDst = Number((await dstClient.scalar(DRILL_DB, `SELECT count(*) FROM "${DRILL_EVENT_TABLE}" WHERE phase = 'accident'`)).trim());
    const postWriteInDst = Number((await dstClient.scalar(DRILL_DB, `SELECT count(*) FROM "${DRILL_EVENT_TABLE}" WHERE phase = 'after-recovery-write'`)).trim());
    const postWriteInSrc = Number((await srcClient.scalar(DRILL_DB, `SELECT count(*) FROM "${DRILL_EVENT_TABLE}" WHERE phase = 'after-recovery-write'`)).trim());
    checks.push({
      name: '语义D-事故行只在源库',
      ok: accidentInSrc >= 1 && accidentInDst === 0,
      detail: `事故行 src=${accidentInSrc} / dst=${accidentInDst}（PITR 有意丢弃事故窗口）`,
    });
    checks.push({
      name: '语义D-恢复后可写行只在恢复实例',
      ok: postWriteInDst >= 1 && postWriteInSrc === 0,
      detail: `promote 后写入行 dst=${postWriteInDst} / src=${postWriteInSrc}`,
    });

    (report.numbers as Record<string, unknown>) = {
      ...(report.numbers as Record<string, unknown>),
      dump: {
        pitr: { bytes: backupPitr.bytes, bytesText: formatBytes(backupPitr.bytes), sha256: backupPitr.sha256, ms: backupPitr.ms, tables: backupPitr.stats.tables, rows: backupPitr.stats.totalRows },
        src: { bytes: backupSrc.bytes, bytesText: formatBytes(backupSrc.bytes), sha256: backupSrc.sha256, ms: backupSrc.ms, tables: backupSrc.stats.tables, rows: backupSrc.stats.totalRows },
      },
      counts: {
        dst: summarizeCounts(pairPitr.referenceCounts),
        restoreFromPitr: summarizeCounts(pairPitr.actualCounts),
        src: summarizeCounts(pairSrc.referenceCounts),
        restoreFromSrc: summarizeCounts(pairSrc.actualCounts),
      },
      incident: {
        droppedTable: ACCIDENT_DROPPED_TABLE,
        planInPitr: pairPitr.referenceCounts[PLAN_TABLE] ?? null,
        planInSrc: pairSrc.referenceCounts[PLAN_TABLE] ?? null,
        usageRecordInPitr: pairPitr.referenceCounts[ACCIDENT_DROPPED_TABLE] ?? null,
        usageRecordInSrc: pairSrc.referenceCounts[ACCIDENT_DROPPED_TABLE] ?? null,
        accidentEventRows: { src: accidentInSrc, dst: accidentInDst },
        postRecoveryWriteRows: { src: postWriteInSrc, dst: postWriteInDst },
      },
      footprint: footprint.entries.filter((e) => e.reference !== e.other || e.other === null),
    };

    const failed = checks.filter((c) => !c.ok);
    (report as { verdict: string }).verdict = failed.length === 0 ? 'PASS' : 'FAIL';
    exitCode = failed.length === 0 ? EXIT_OK : EXIT_VERIFY;
  } catch (err) {
    const e = err instanceof XcheckError ? err : new XcheckError(err instanceof Error ? err.message : String(err));
    logger.error(e.message);
    exitCode = e.code;
    (report as { verdict: string }).verdict = 'FAIL';
  } finally {
    try {
      if (!config.keep) {
        assertOwnContainer(names.container);
        await docker(['rm', '-f', names.container], { quiet: true });
        assertOwnVolume(names.volume);
        await docker(['volume', 'rm', names.volume], { quiet: true });
        (report as Record<string, unknown>).cleanup = { performed: true, kept: false };
      } else {
        (report as Record<string, unknown>).cleanup = { performed: true, kept: true };
      }
      const shared = await docker(['ps', '--format', '{{.Names}}']);
      callsite: {
        (report as Record<string, unknown>).sharedContainersStillRunning = shared.stdout
          .split(/\r?\n/)
          .map((s) => s.trim())
          .filter((s) => s.startsWith('docker-') || s === 'b2c-postgres' || s === 'b2c-redis');
      }
    } catch (cleanupErr) {
      logger.warn(`清理阶段出错（人工核对 docker ps -a --filter name=${NAME_PREFIX}）：${cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr)}`);
    }
  }

  (report as Record<string, unknown>).finishedAt = new Date().toISOString();
  (report as Record<string, unknown>).totalMs = Date.now() - started;
  notes.push('逻辑备份产物在临时目录中为**明文**（仅本机一次性目录，不加密、不上传）；生产备份必须加密（见 m11-backup-encryption.md）。');
  notes.push(`drill 的容器/卷未被本脚本触碰；如需清理：npx tsx scripts/pitr-drill.ts --confirm --clean-stale`);
  if (drillFacts) notes.push(`上游 drill 报告：${drillFacts.reportPath}`);

  printReport(logger, report);
  if (config.reportJson) {
    const path = resolve(config.reportJson);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    logger.info(`报告已写入 ${path}`);
  }
  return exitCode;
}

function printReport(logger: Logger, report: Record<string, unknown>): void {
  const checks = (report.checks ?? []) as Check[];
  const failed = checks.filter((c) => !c.ok);
  logger.raw('');
  logger.raw(`=== 交叉验证报告（${report.script as string} · ${report.label as string}）===`);
  const drill = report.drill as DrillFacts | undefined;
  if (drill) logger.raw(`上游 PITR ：${drill.containers.src} / ${drill.containers.dst}（结论 ${drill.verdict}，最后重放 ${drill.recoveredToTime ?? '-'}）`);
  logger.raw(`结论      ：${report.verdict as string}（${checks.length - failed.length}/${checks.length} 项通过，耗时 ${formatDuration(Number(report.totalMs ?? 0))}）`);
  for (const c of checks) logger.raw(`  [${c.ok ? 'ok' : 'FAIL'}] ${c.name} — ${c.detail}`);
  const numbers = report.numbers as Record<string, unknown>;
  const counts = numbers?.counts as Record<string, { tables: number; rows: number }> | undefined;
  if (counts) {
    logger.raw(
      `行数      ：dst ${counts.dst.tables}表/${counts.dst.rows}行 · 逻辑还原 ${counts.restoreFromPitr.tables}表/${counts.restoreFromPitr.rows}行 · ` +
        `src ${counts.src.tables}表/${counts.src.rows}行 · 逻辑还原 ${counts.restoreFromSrc.tables}表/${counts.restoreFromSrc.rows}行`,
    );
  }
  const dump = numbers?.dump as { pitr: { bytesText: string; ms: number; sha256: string }; src: { bytesText: string; ms: number; sha256: string } } | undefined;
  if (dump) {
    logger.raw(`逻辑备份  ：from-pitr ${dump.pitr.bytesText}/${dump.pitr.ms}ms（sha256 ${dump.pitr.sha256.slice(0, 12)}…） · from-src ${dump.src.bytesText}/${dump.src.ms}ms（sha256 ${dump.src.sha256.slice(0, 12)}…）`);
  }
  const incident = numbers?.incident as Record<string, unknown> | undefined;
  if (incident) {
    logger.raw(
      `事故足迹  ：${incident.droppedTable as string} 在 PITR=${String(incident.usageRecordInPitr)}/src=${String(incident.usageRecordInSrc)} · ` +
        `Plan PITR=${String(incident.planInPitr)}/src=${String(incident.planInSrc)}`,
    );
  }
  for (const n of (report.notes ?? []) as string[]) logger.raw(`注        ：${n}`);
  logger.raw('');
}

const isMain = typeof require !== 'undefined' && require.main === module;
if (isMain) {
  void main()
    .then((code) => process.exit(code))
    .catch((err) => {
      process.stderr.write(`${SCRIPT} 未捕获异常：${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
      process.exit(EXIT_FAIL);
    });
}

export { main, SPECS, NAME_PATTERN, VOLUME_PATTERN, DRILL_NAME_PATTERN, ACCIDENT_DROPPED_TABLE, PLAN_TABLE };
