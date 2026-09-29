/**
 * M11-P15 PITR 演练（审计 NV-06）：在**一次性 PG 容器**里跑完整的时间点恢复链路并校验。
 *
 * 上游文档：
 * - `docs/operations/m8-disaster-recovery.md` §3.1/§4.2（WAL 归档 + `recovery_target_time`；
 *   "生产必须额外开 `wal_level=replica` + `archive_mode=on` + 归档目录，定时 `pg_basebackup`"）；
 * - `docs/operations/m10-runbook.md` §4（恢复演练的三步法与**四层校验 A/B/C/D** 口径）；
 * - `docs/operations/m11-pitr-drill.md`（本脚本的实测记录与诚实边界）。
 *
 * 为什么要有这个脚本：m8/m10 的备份都是**逻辑备份**（`pg_dump`），它们的 RPO = 上次备份时刻。
 * "误删表 5 分钟后发现"这种事故里，逻辑备份救不回中间的数据；只有 WAL 归档 + 基础备份能恢复到
 * 任意时刻。这条链路此前**从未演练过**（m8 §8 / m10 §9 都登记为未验证），本脚本把它变成可重复执行、
 * 有退出码、有数字的演练。
 *
 * 演练编排（每一步都有对应的真实失败模式，见 `m11-pitr-drill.md` §5）：
 *   1. 起一次性源实例：`archive_mode=on` + `archive_command='cp %p /archive/%f'`（独立端口 + 一次性卷）；
 *   2. 建 schema（重放 `prisma/migrations/**`，与生产同构）+ 播种 `Plan` + 建演练表；
 *   3. `pg_basebackup -Xs` 基准备份（物理基线）；
 *   4. 变更阶段：3 个事务写入演练账本 + 事件行（**这些都发生在基准备份之后** ⇒ 只能靠 WAL 重放找回来）；
 *   5. 静默窗口内记录**目标时刻** `recovery_target_time`（DB 时钟，非墙钟）；
 *   6. 制造"事故"：一个事务里 `DELETE FROM "Plan"` + `DROP TABLE "UsageRecord"`（模拟误删数据 + 误删表）；
 *   7. `pg_switch_wal()` 并**等归档追上**（否则目标时刻落在未归档 WAL 之后 ⇒ 恢复直接 FATAL）；
 *   8. 恢复：基线 + `restore_command` + `recovery_target_time` → `recovery_target_action=promote`；
 *   9. **四层校验**（同 m10 runbook §4.3）：A 指纹 / B 逐表行数 / C 关键表 / D 抽样内容逐行原样，
 *      外加 4 条 PITR 专属断言（目标时刻到达、WAL 真的重放了、事故事务未被重放、已提升为可写）；
 *  10. 销毁容器与卷（默认；`--keep` 保留取证）。
 *
 * 安全边界（**本脚本最重要的性质**）：
 * - **绝不触碰共享开发环境**：不读 `.env`、不连 `DATABASE_URL`、不碰 `docker-postgres-1`/`agent_platform`；
 *   全部动作发生在本次生成的 `pitr-drill-<stamp>-<rand>-*` 命名空间内（删除操作只按该名前缀匹配）；
 * - **默认 dry-run**：不加 `--confirm` 时只打印计划（含端口、卷名、阶段、校验项），不创建任何资源；
 * - **口令不进 argv**：容器口令随机生成并经 `docker run -e POSTGRES_PASSWORD`（无值形式）从客户端环境透传，
 *   命令行里看不到明文（`ps`/审计日志口径同 m10 §1.4）。
 *
 * 幂等：每次运行用**随机命名空间**（容器/卷/端口都不同），互不干扰；`--clean-stale` 可清理历史残留
 * （仅匹配严格命名模式，不会误删其他容器）。
 *
 * 用法：`cd apps/api && npx tsx scripts/pitr-drill.ts --help`
 */

import { createHash, randomBytes } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join, resolve } from 'node:path';

import {
  DEFAULT_EXIT_CODES,
  EXIT_FAIL,
  EXIT_OK,
  EXIT_PRECONDITION,
  EXIT_USAGE,
  EXIT_VERIFY,
  createLogger,
  formatBytes,
  formatDuration,
  redactSecrets,
  run,
  stamp,
  type Logger,
  type RunResult,
} from './lib/cli';
import { helpText, parseArgs, type FlagSpec } from './lib/args';
import { compareCopyRows, compareRowCounts, parseCopyRowsText, pickSampleTables } from './lib/dump';
import { KEY_TABLES, PgClient } from './lib/pg';
import type { DatabaseTarget } from './lib/env';

const SCRIPT = 'pitr-drill.ts';

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

/** 一次性实例内部使用的库/用户（与任何真实环境无关；口令每次运行随机生成）。 */
const DRILL_USER = 'drill';
const DRILL_DB = 'drilldb';

/** 本次运行的资源命名前缀（清理操作只认这个前缀 + 严格模式）。 */
const NAME_PREFIX = 'pitr-drill';
const NAME_PATTERN = /^pitr-drill-\d{8}-\d{6}-[0-9a-f]{6}-(src|dst)$/;
const VOLUME_PATTERN = /^pitr-drill-\d{8}-\d{6}-[0-9a-f]{6}-(archive|base|restore)$/;

/** 容器内挂载点（源实例与恢复实例共用同一套卷，靠挂载点区分用途）。 */
const ARCHIVE_MOUNT = '/archive';
const BASE_MOUNT = '/base';
const PGDATA_MOUNT = '/var/lib/postgresql/data';

const DEFAULT_PG_IMAGE = 'pgvector/pgvector:pg16';
const DEFAULT_TIMEOUT_MS = 60_000;

/** 演练自建表（业务表为空库基线，数据层校验靠它们 + `Plan` + `_prisma_migrations`）。 */
const DRILL_EVENT_TABLE = 'pitr_drill_event';
const DRILL_LEDGER_TABLE = 'pitr_drill_ledger';
/** 事故要删掉的业务表（m8 失败矩阵"误删表"那一行的对象；已确认无其他表引用它，DROP 不会级联失败）。 */
const ACCIDENT_DROPPED_TABLE = 'UsageRecord';

const SPECS: readonly FlagSpec[] = [
  { name: 'confirm', type: 'boolean', help: '真正执行演练（**默认 dry-run**：只打印计划，不创建容器/卷）' },
  { name: 'dry-run', type: 'boolean', help: '显式 dry-run（与默认行为一致，用于把"我没打算真跑"写清楚）' },
  { name: 'keep', type: 'boolean', help: '保留容器与卷（人工取证用；默认演练结束即删除）' },
  { name: 'clean-stale', type: 'boolean', help: '先清理历史残留的 pitr-drill 容器/卷（严格命名匹配；默认只告警不删）' },
  { name: 'pg-image', type: 'string', valueName: '<image>', default: DEFAULT_PG_IMAGE, help: 'PG 镜像（需自带 pg_basebackup）' },
  { name: 'port', type: 'number', valueName: '<n>', default: 0, help: '源实例宿主端口（0 = 自动挑空闲端口）' },
  { name: 'gap-ms', type: 'number', valueName: '<ms>', default: 2000, help: '最后一次变更提交后到"事故"之间的静默间隔（目标时刻必须落在这段窗口内）' },
  { name: 'target-offset-ms', type: 'number', valueName: '<ms>', default: 400, help: '目标时刻 = 最后一次变更提交时刻 + 偏移（必须显著小于 gap-ms）' },
  { name: 'ledger-rows', type: 'number', valueName: '<n>', default: 500, help: '变更阶段写入的账本行数（分 3 个事务）' },
  { name: 'verify-sample', type: 'number', valueName: '<n>', default: 5, help: 'D 层内容级抽样的表数（0 = 关闭；口径同 m10 runbook §4.3）' },
  { name: 'timeout-ms', type: 'number', valueName: '<ms>', default: DEFAULT_TIMEOUT_MS, help: '容器就绪 / 归档追上的等待上限' },
  { name: 'skip-schema-replay', type: 'boolean', help: '跳过 prisma 迁移重放（只建演练表；用于快速验证 PITR 通路本身）' },
  { name: 'report-json', type: 'string', valueName: '<path>', help: '把机器可读报告写到该路径（默认只打印到 stdout）' },
  { name: 'label', type: 'string', valueName: '<tag>', default: 'pitr-drill', help: '报告标签' },
];

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------

/** 带退出码的运行错误（顶层统一映射；`EXIT_VERIFY` 专指"校验不通过"）。 */
class DrillError extends Error {
  constructor(
    message: string,
    readonly code: number = EXIT_FAIL,
  ) {
    super(message);
    this.name = 'DrillError';
  }
}

interface Names {
  stamp: string;
  rand: string;
  src: string;
  dst: string;
  archiveVol: string;
  baseVol: string;
  restoreVol: string;
}

interface TableStat {
  table: string;
  exists: boolean;
  rows: number;
}

/** 某一时刻的库状态快照（A/B/C 层的输入）。 */
interface Snapshot {
  label: string;
  fingerprint: Record<string, string>;
  rowCounts: Record<string, number>;
  totalRows: number;
  keyTables: TableStat[];
}

interface Check {
  name: string;
  ok: boolean;
  detail: string;
}

interface DockerOpts {
  stdin?: string | Buffer;
  timeoutMs?: number;
  quiet?: boolean;
  env?: NodeJS.ProcessEnv;
}

interface Config {
  label: string;
  pgImage: string;
  port: number;
  portRestore: number;
  gapMs: number;
  targetOffsetMs: number;
  ledgerRows: number;
  verifySample: number;
  timeoutMs: number;
  skipSchemaReplay: boolean;
  reportJson?: string;
  keep: boolean;
  cleanStale: boolean;
  confirm: boolean;
}

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

function docker(args: readonly string[], opts: DockerOpts = {}): Promise<RunResult> {
  return run('docker', args, {
    stdin: opts.stdin,
    timeoutMs: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    quiet: opts.quiet,
    env: opts.env,
  });
}

/** docker 子命令必须成功，否则抛出带 stderr 摘要的 DrillError（错误信息统一过脱敏）。 */
async function dockerOk(args: readonly string[], what: string, opts: DockerOpts = {}): Promise<RunResult> {
  const res = await docker(args, opts);
  if (res.code !== 0) {
    const raw = (res.stderr || res.stdout || res.spawnError || '').trim();
    const detail = raw ? redactSecrets(raw).slice(0, 500) : '（无输出）';
    throw new DrillError(`${what} 失败（退出码 ${res.code}）：${detail}`);
  }
  return res;
}

async function sleep(ms: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

/** 轮询直到条件成立或超时；返回是否成立与已等待毫秒数。 */
async function waitFor(
  probe: () => Promise<boolean>,
  opts: { timeoutMs: number; intervalMs?: number },
): Promise<{ ok: boolean; waitedMs: number }> {
  const interval = opts.intervalMs ?? 500;
  const started = Date.now();
  for (;;) {
    // 探针自身抛错（容器刚起、socket 未就绪）不算失败，继续等
    let ok = false;
    try {
      ok = await probe();
    } catch {
      ok = false;
    }
    if (ok) return { ok: true, waitedMs: Date.now() - started };
    if (Date.now() - started > opts.timeoutMs) return { ok: false, waitedMs: Date.now() - started };
    await sleep(interval);
  }
}

/** 绑 127.0.0.1:0 拿一个空闲端口再释放（避免撞上共享环境里已占用的端口）。 */
function pickFreePort(): Promise<number> {
  return new Promise((resolvePort, rejectPort) => {
    const server = createServer();
    server.unref();
    server.on('error', rejectPort);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close(() => (port > 0 ? resolvePort(port) : rejectPort(new Error('无法挑选空闲端口'))));
    });
  });
}

/** 解析 PG 的时间戳文本（`2026-09-28 09:18:24.675945+00` / ISO）；失败返回 null。 */
export function parsePgTimestamp(text: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?\s*(?:([+-])(\d{2}):?(\d{2})?|Z)?$/.exec(text.trim());
  if (!m) return null;
  const [, y, mo, d, h, mi, s, frac, sign, offH, offM] = m;
  const ms = frac ? Number(frac.padEnd(3, '0').slice(0, 3)) : 0;
  let epoch = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s), ms);
  if (sign) {
    const offset = (Number(offH) * 60 + Number(offM ?? 0)) * 60_000;
    epoch -= sign === '+' ? offset : -offset;
  }
  return Number.isFinite(epoch) ? epoch : null;
}

/** 从容器日志里找第一条匹配的行（返回去掉时间戳前缀的原文）。 */
export function findLogLine(log: string, re: RegExp): string | null {
  for (const line of log.split(/\r?\n/)) {
    if (re.test(line)) return line.replace(/^\S+ \S+ UTC \[\d+\] /, '').trim();
  }
  return null;
}

/** 摘出恢复相关的日志行（用于报告与排障；FATAL 一定保留）。 */
export function summarizeRecoveryLog(log: string): string[] {
  return log
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => /recovery|redo|timeline|archive|FATAL|consistent state/i.test(l))
    .slice(-14);
}

function quoteLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function assertSafeTableName(table: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_$]*$/.test(table)) throw new DrillError(`表名不合法：${table}`);
  return table;
}

// ---------------------------------------------------------------------------
// docker 资源（只操作本次命名空间）
// ---------------------------------------------------------------------------

function makeNames(): Names {
  const s = stamp();
  const rand = randomBytes(3).toString('hex');
  return {
    stamp: s,
    rand,
    src: `${NAME_PREFIX}-${s}-${rand}-src`,
    dst: `${NAME_PREFIX}-${s}-${rand}-dst`,
    archiveVol: `${NAME_PREFIX}-${s}-${rand}-archive`,
    baseVol: `${NAME_PREFIX}-${s}-${rand}-base`,
    restoreVol: `${NAME_PREFIX}-${s}-${rand}-restore`,
  };
}

function assertOwnContainer(name: string): void {
  if (!NAME_PATTERN.test(name)) throw new DrillError(`拒绝操作非本次命名的容器：${name}`, EXIT_PRECONDITION);
}

function assertOwnVolume(name: string): void {
  if (!VOLUME_PATTERN.test(name)) throw new DrillError(`拒绝操作非本次命名的卷：${name}`, EXIT_PRECONDITION);
}

async function listOwnResources(): Promise<{ containers: string[]; volumes: string[] }> {
  const c = await docker(['ps', '-a', '--filter', `name=${NAME_PREFIX}`, '--format', '{{.Names}}'], { quiet: true });
  const v = await docker(['volume', 'ls', '--filter', `name=${NAME_PREFIX}`, '--format', '{{.Name}}'], { quiet: true });
  return {
    containers: c.stdout.split(/\r?\n/).map((s) => s.trim()).filter((s) => NAME_PATTERN.test(s)),
    volumes: v.stdout.split(/\r?\n/).map((s) => s.trim()).filter((s) => VOLUME_PATTERN.test(s)),
  };
}

async function dockerPreflight(logger: Logger, image: string): Promise<string> {
  const version = await docker(['version', '--format', '{{.Server.Version}}'], { quiet: true });
  if (version.code !== 0) {
    throw new DrillError(
      `docker 不可用（退出码 ${version.code}）：${redactSecrets((version.stderr || version.spawnError || '').trim()).slice(0, 200)}`,
      EXIT_PRECONDITION,
    );
  }
  const inspect = await docker(['image', 'inspect', image, '--format', '{{.Id}}'], { quiet: true });
  if (inspect.code !== 0) {
    logger.warn(`本地无镜像 ${image}，尝试 docker pull（首次会耗时数分钟）`);
    await dockerOk(['pull', image], `docker pull ${image}`, { quiet: false, timeoutMs: 600_000 });
  }
  return version.stdout.trim();
}

/** 用同一个 PG 镜像起一个一次性 helper 容器（root 身份跑 sh，用于改卷权限/拷卷/写配置）。 */
async function helperRun(image: string, mounts: readonly string[], shScript: string, opts: { stdin?: string; quiet?: boolean } = {}): Promise<RunResult> {
  const args = ['run', '--rm'];
  if (opts.stdin !== undefined) args.push('-i');
  args.push('--entrypoint', 'sh');
  for (const m of mounts) args.push('-v', m);
  args.push(image, '-c', shScript);
  return dockerOk(args, `helper 容器执行（${shScript.slice(0, 60)}）`, { stdin: opts.stdin, quiet: opts.quiet });
}

// ---------------------------------------------------------------------------
// PgClient 工厂（docker exec 进一次性容器；本地 socket 免口令）
// ---------------------------------------------------------------------------

function makeClient(container: string, port: number, password: string): PgClient {
  const target: DatabaseTarget = {
    scheme: 'postgresql',
    user: DRILL_USER,
    password,
    host: '127.0.0.1',
    port,
    database: DRILL_DB,
    query: '',
    redacted: `postgresql://${DRILL_USER}:***@127.0.0.1:${port}/${DRILL_DB}`,
  };
  return new PgClient({ target, mode: 'docker', container });
}

/** 容器日志（stdout + stderr 合并；失败也返回空串——日志只用于诊断）。 */
async function dockerLogs(container: string): Promise<string> {
  const res = await docker(['logs', container], { quiet: true, timeoutMs: 60_000 });
  return `${res.stdout}\n${res.stderr}`;
}

/**
 * 等实例**真正**可用；容器若中途退出则立刻返回 'exited'（恢复失败时不必等满超时）。
 *
 * 为什么不能只看 `pg_isready`（本脚本第 4 轮演练实测踩到）：
 * 官方 postgres 镜像的 entrypoint 在空数据目录时先起一个**临时服务器**跑 initdb/init 脚本，
 * 它同样会让 `pg_isready` 返回 0，随后立刻 `pg_ctl stop`——此时发查询会撞上
 * `FATAL: the database system is shutting down`（演练就是这么在第一轮失败过：
 * schema 重放 0ms、表 0 张，4.3s 就退出码 1）。
 * 因此判据是两段式的：①（仅空库初始化时）日志里出现 entrypoint 的 "ready for start up"，
 * ② 一次**真实查询**（`psql -c 'SELECT 1'`）成功——不是"端口能连"。
 */
async function waitReady(container: string, timeoutMs: number, opts: { requireInitComplete?: boolean } = {}): Promise<'ready' | 'exited' | 'timeout'> {
  const started = Date.now();
  for (;;) {
    const initDone = opts.requireInitComplete ? (await dockerLogs(container)).includes('ready for start up') : true;
    if (initDone) {
      const ping = await docker(['exec', container, 'pg_isready', '-U', DRILL_USER, '-d', DRILL_DB], { quiet: true, timeoutMs: 15_000 });
      if (ping.code === 0) {
        const probe = await docker(['exec', container, 'psql', '-U', DRILL_USER, '-d', DRILL_DB, '-At', '-c', 'SELECT 1'], { quiet: true, timeoutMs: 15_000 });
        if (probe.code === 0 && probe.stdout.trim() === '1') return 'ready';
      }
    }
    const running = await docker(['inspect', '-f', '{{.State.Running}}', container], { quiet: true, timeoutMs: 15_000 });
    if (running.code === 0 && running.stdout.trim() === 'false') return 'exited';
    if (Date.now() - started > timeoutMs) return 'timeout';
    await sleep(400);
  }
}

// ---------------------------------------------------------------------------
// 阶段实现
// ---------------------------------------------------------------------------

/** 迁移文件目录（tsx 直跑在 scripts/ 下；nest build 产物在 dist/scripts/ 下，两种都试）。 */
function findMigrationsDir(): string | null {
  const candidates = [
    resolve(__dirname, '..', 'prisma', 'migrations'),
    resolve(process.cwd(), 'prisma', 'migrations'),
    resolve(process.cwd(), 'apps', 'api', 'prisma', 'migrations'),
    resolve(__dirname, '..', '..', 'prisma', 'migrations'),
  ];
  for (const dir of candidates) if (existsSync(dir)) return dir;
  return null;
}

function migrationFiles(): { name: string; path: string }[] {
  const dir = findMigrationsDir();
  if (!dir) return [];
  return readdirSync(dir)
    .filter((name) => existsSync(join(dir, name, 'migration.sql')))
    .sort()
    .map((name) => ({ name, path: join(dir, name, 'migration.sql') }));
}

/**
 * 建 schema：`CREATE EXTENSION vector` → 逐个重放迁移文件（每个文件一个事务，与 Prisma 同口径）
 * → 合成 `_prisma_migrations` 行（checksum = 迁移文件的 sha256，与 Prisma 的算法一致）
 * → 播种 Plan → 建演练表。
 */
async function buildSchema(client: PgClient, logger: Logger, skipReplay: boolean): Promise<{ migrations: number; replayMs: number; tables: number }> {
  // pgvector 的扩展不在迁移文件里（生产由运维前置创建：迁移只含 pgcrypto）——这里显式补齐
  await client.query('CREATE EXTENSION IF NOT EXISTS vector');
  await client.query('CREATE EXTENSION IF NOT EXISTS pgcrypto');

  const files = skipReplay ? [] : migrationFiles(); // M11 Final Audit M4：skipReplay 时 Plan 播种也必须跳过（见 buildSchema）
  const started = Date.now();
  for (const file of files) {
    const sql = readFileSync(file.path, 'utf8');
    const res = await client.loadScript(DRILL_DB, sql, 300_000);
    if (res.code !== 0) {
      throw new DrillError(
        `迁移重放失败（${file.name}，退出码 ${res.code}）：${redactSecrets(res.stderr.trim()).slice(0, 400)}`,
      );
    }
  }
  const replayMs = Date.now() - started;

  // _prisma_migrations：Prisma CLI 自己维护的表；本脚本直接重放 SQL 而不经 Prisma CLI，
  // 因此按 Prisma 的 DDL 合成（checksum 用**真实的**迁移文件 sha256），使 C 层"迁移基线"仍然可信。
  await client.query(`
    CREATE TABLE IF NOT EXISTS "_prisma_migrations" (
      "id" VARCHAR(36) NOT NULL,
      "checksum" VARCHAR(64) NOT NULL,
      "finished_at" TIMESTAMPTZ,
      "migration_name" VARCHAR(255) NOT NULL,
      "logs" TEXT,
      "rolled_back_at" TIMESTAMPTZ,
      "started_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
      "applied_steps_count" INTEGER NOT NULL DEFAULT 0,
      CONSTRAINT "_prisma_migrations_pkey" PRIMARY KEY ("id")
    )`);
  for (const file of files) {
    const checksum = sha256Text(readFileSync(file.path, 'utf8'));
    await client.query(
      `INSERT INTO "_prisma_migrations" ("id", "checksum", "finished_at", "migration_name", "started_at", "applied_steps_count")
       VALUES (gen_random_uuid()::text, ${quoteLiteral(checksum)}, now(), ${quoteLiteral(file.name)}, now(), 1)
       ON CONFLICT ("id") DO NOTHING`,
    );
  }

  // 真实业务表的播种（Plan 是 m10 §4.4 D 层抽样命中的同一张表，便于沿时间轴对比数字）。
  // M11 Final Audit M4：--skip-schema-replay 时不重放迁移 ⇒ Plan 表不存在——播种必须一并跳过
  //（原实现无条件播种，跳过迁移后必在 INSERT 处 psql 报错，"快速验证 PITR 通路"的文档承诺落空）
  if (!skipReplay) {
    await client.query(`
      INSERT INTO "Plan" ("id", "code", "name", "monthlyPrice", "yearlyPrice", "entitlements", "active", "createdAt", "updatedAt")
      VALUES
        (gen_random_uuid()::text, 'free', 'Free', 0, 0, '{"llmTokensMonthly":100000,"seats":1}'::jsonb, true, now(), now()),
        (gen_random_uuid()::text, 'pro',  'Pro',  19, 190, '{"llmTokensMonthly":2000000,"seats":5}'::jsonb, true, now(), now()),
        (gen_random_uuid()::text, 'team', 'Team', 49, 490, '{"llmTokensMonthly":10000000,"seats":20}'::jsonb, true, now(), now())
      ON CONFLICT ("code") DO NOTHING`);
  }

  // 演练自建表（数据层：没有业务数据也不让 B/D 层变成"全 0 空转"）
  await client.query(`
    CREATE TABLE IF NOT EXISTS "${DRILL_EVENT_TABLE}" (
      id BIGSERIAL PRIMARY KEY,
      phase TEXT NOT NULL,
      note TEXT,
      at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
    )`);
  await client.query(`
    CREATE TABLE IF NOT EXISTS "${DRILL_LEDGER_TABLE}" (
      id BIGSERIAL PRIMARY KEY,
      org TEXT NOT NULL,
      amount NUMERIC(12,2) NOT NULL,
      note TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      CONSTRAINT "pitr_drill_ledger_amount_check" CHECK (amount >= 0)
    )`);

  const tables = Number((await client.scalar(DRILL_DB, `SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE c.relkind='r' AND n.nspname='public'`)).trim());
  logger.info(`schema：重放迁移 ${files.length} 个文件（${formatDuration(replayMs)}），public schema 现有 ${tables} 张表`);
  return { migrations: files.length, replayMs, tables };
}

function sha256Text(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

async function takeBaseBackup(names: Names, client: PgClient, password: string, logger: Logger): Promise<{ ms: number; bytes: number }> {
  const started = Date.now();
  const res = await docker(
    ['exec', '-e', 'PGPASSWORD', names.src, 'pg_basebackup', '-h', '127.0.0.1', '-p', '5432', '-U', DRILL_USER, '-D', BASE_MOUNT, '-Xs', '-c', 'fast'],
    { env: { ...process.env, PGPASSWORD: password }, timeoutMs: 600_000 },
  );
  const ms = Date.now() - started;
  if (res.code !== 0) {
    throw new DrillError(`pg_basebackup 失败（退出码 ${res.code}）：${redactSecrets(res.stderr.trim()).slice(0, 400)}`);
  }
  const sizeOut = await dockerOk(['exec', names.src, 'du', '-sb', BASE_MOUNT], '统计基准备份体积', { quiet: true });
  const bytes = Number(sizeOut.stdout.trim().split(/\s+/)[0] ?? 0);
  logger.info(`基准备份：pg_basebackup -Xs -c fast → ${formatBytes(bytes)}，耗时 ${formatDuration(ms)}`);
  await client.query(`INSERT INTO "${DRILL_EVENT_TABLE}" (phase, note) VALUES ('base-backup', ${quoteLiteral(`pg_basebackup ${bytes} bytes`)})`);
  return { ms, bytes };
}

/** 变更阶段：3 个事务写入（每次都记事件行，便于事后核对"哪些事务被重放了"）。 */
async function applyChanges(client: PgClient, ledgerRows: number): Promise<{ transactions: { phase: string; rows: number; ms: number }[] }> {
  const batches = [Math.max(1, Math.round(ledgerRows * 0.4)), Math.max(1, Math.round(ledgerRows * 0.3)), Math.max(1, ledgerRows - Math.round(ledgerRows * 0.4) - Math.round(ledgerRows * 0.3))];
  const transactions: { phase: string; rows: number; ms: number }[] = [];
  let inserted = 0;

  for (let i = 0; i < batches.length; i += 1) {
    const rows = batches[i];
    const phase = `change-${i + 1}`;
    const from = inserted + 1;
    const to = inserted + rows;
    const started = Date.now();
    // 显式事务：一个 phase = **一个事务**，其提交时刻才是 WAL 里可比较的时间点
    // （否则每条语句各自 autocommit，"最后一次变更的时刻"就没有确定含义）
    const sql =
      `BEGIN;\n` +
      `INSERT INTO "${DRILL_LEDGER_TABLE}" (org, amount, note) ` +
      `SELECT 'org-' || lpad(((g % 10) + 1)::text, 2, '0'), (g % 97)::numeric + 0.5, ${quoteLiteral(`${phase}-row`)} || g FROM generate_series(${from}, ${to}) AS g;\n` +
      (i === 1 ? `UPDATE "${DRILL_LEDGER_TABLE}" SET amount = amount + 1.5 WHERE id % 5 = 0;\n` : '') +
      (i === 2 ? `UPDATE "Plan" SET "monthlyPrice" = "monthlyPrice" + 1, "updatedAt" = now() WHERE "code" IN ('free','pro');\n` : '') +
      `INSERT INTO "${DRILL_EVENT_TABLE}" (phase, note) VALUES (${quoteLiteral(phase)}, ${quoteLiteral(`ledger +${rows} 行（id ${from}..${to}）`)});\n` +
      `COMMIT;`;
    const res = await client.loadScript(DRILL_DB, sql, 300_000);
    if (res.code !== 0) throw new DrillError(`变更事务 ${phase} 失败（退出码 ${res.code}）：${redactSecrets(res.stderr.trim()).slice(0, 400)}`);
    inserted = to;
    transactions.push({ phase, rows, ms: Date.now() - started });
  }
  return { transactions };
}

/** 目标时刻：变更阶段结束后的 DB 时钟 + 偏移（**DB 时钟**才是 `recovery_target_time` 的权威）。 */
async function readDbClock(client: PgClient): Promise<string> {
  const out = await client.scalar(DRILL_DB, `SELECT to_char(clock_timestamp() at time zone 'UTC','YYYY-MM-DD HH24:MI:SS.US') || '+00'`);
  return out.trim();
}

async function readEventCount(client: PgClient, phase: string): Promise<number> {
  return Number((await client.scalar(DRILL_DB, `SELECT count(*) FROM "${DRILL_EVENT_TABLE}" WHERE phase = ${quoteLiteral(phase)}`)).trim());
}

/** A/B/C 层的快照（指纹 + 逐表行数 + 关键表点名）。 */
async function takeSnapshot(client: PgClient, label: string): Promise<Snapshot> {
  const fingerprint = await client.fingerprint(DRILL_DB);
  const rowCounts = await client.tableRowCounts(DRILL_DB);
  const totalRows = Object.values(rowCounts).reduce((a, b) => a + b, 0);
  const keyTables: TableStat[] = [];
  const targets = [...KEY_TABLES.map((k) => k.table), 'Plan', DRILL_EVENT_TABLE, DRILL_LEDGER_TABLE];
  for (const table of [...new Set(targets)]) {
    assertSafeTableName(table);
    const exists = (await client.scalar(DRILL_DB, `SELECT CASE WHEN to_regclass('public."${table}"') IS NULL THEN 'no' ELSE 'yes' END`)).trim() === 'yes';
    const rows = exists ? Number((await client.scalar(DRILL_DB, `SELECT count(*) FROM "${table}"`)).trim()) : -1;
    keyTables.push({ table, exists, rows });
  }
  return { label, fingerprint, rowCounts, totalRows, keyTables };
}

/** D 层：对抽中的表再做一次单表 `pg_dump --data-only`，转成 COPY 数据行（原样文本）。 */
async function dumpSampleRows(client: PgClient, tables: readonly string[]): Promise<Record<string, string[]>> {
  const out: Record<string, string[]> = {};
  for (const table of tables) {
    const text = await client.dumpTableData(DRILL_DB, table);
    out[table] = parseCopyRowsText(text, [table]).rows[table] ?? [];
  }
  return out;
}

/** 事故：一个事务里"误删数据 + 误删表"，并留下事故事务自己的事件行（事后用它证明未被重放）。 */
async function makeAccident(client: PgClient): Promise<{ droppedTableExists: boolean }> {
  // 一个事务里的"误删数据 + 误删表"：事务性 DDL 让整个事故只有一个提交时刻，
  // 于是"恢复到目标时刻"要么整件事都没发生，要么整件都发生——没有中间态可以狡辩。
  const sql =
    `BEGIN;\n` +
    `DELETE FROM "Plan";\n` +
    `DROP TABLE "${ACCIDENT_DROPPED_TABLE}";\n` +
    `INSERT INTO "${DRILL_EVENT_TABLE}" (phase, note) VALUES ('accident', 'DELETE FROM "Plan" + DROP TABLE "${ACCIDENT_DROPPED_TABLE}"');\n` +
    `COMMIT;`;
  const res = await client.loadScript(DRILL_DB, sql, 300_000);
  if (res.code !== 0) throw new DrillError(`事故模拟失败（退出码 ${res.code}）：${redactSecrets(res.stderr.trim()).slice(0, 400)}`);
  const exists = (await client.scalar(DRILL_DB, `SELECT CASE WHEN to_regclass('public."${ACCIDENT_DROPPED_TABLE}"') IS NULL THEN 'no' ELSE 'yes' END`)).trim() === 'yes';
  return { droppedTableExists: exists };
}

interface ArchiveState {
  lastArchived: string;
  archivedCount: number;
  failedCount: number;
}

async function readArchiveState(client: PgClient): Promise<ArchiveState> {
  const out = await client.query(
    `SELECT COALESCE((SELECT last_archived_wal FROM pg_stat_archiver), '') || '|' ||
            (SELECT archived_count FROM pg_stat_archiver) || '|' ||
            (SELECT failed_count FROM pg_stat_archiver)`,
  );
  const [lastArchived = '', archivedCount = '0', failedCount = '0'] = out.trim().split('|');
  return { lastArchived, archivedCount: Number(archivedCount), failedCount: Number(failedCount) };
}

/** 让当前 WAL 段归档（否则恢复拿不到目标时刻之后的记录 ⇒ "recovery ended before ... target"）。 */
async function switchAndAwaitArchive(client: PgClient, logger: Logger, timeoutMs: number): Promise<{ needSegment: string; archiveLagMs: number; state: ArchiveState }> {
  const needSegment = (await client.scalar(DRILL_DB, 'SELECT pg_walfile_name(pg_current_wal_insert_lsn())')).trim();
  await client.query('SELECT pg_switch_wal()');
  const started = Date.now();
  const waited = await waitFor(
    async () => {
      const state = await readArchiveState(client);
      return state.lastArchived >= needSegment && state.failedCount === 0;
    },
    { timeoutMs, intervalMs: 300 },
  );
  const state = await readArchiveState(client);
  if (!waited.ok) {
    throw new DrillError(
      `WAL 归档未在 ${formatDuration(timeoutMs)} 内追上（需要 ${needSegment}，当前 ${state.lastArchived || '（空）'}，failed=${state.failedCount}）：` +
        `归档滞后会让 recovery_target_time 不可达（恢复会以 "recovery ended before configured recovery target was reached" 直接失败）`,
      EXIT_VERIFY,
    );
  }
  const archiveLagMs = Date.now() - started;
  logger.info(`WAL 归档：段 ${needSegment} 已在 ${formatDuration(archiveLagMs)} 内落盘（归档累计 ${state.archivedCount} 段，failed=${state.failedCount}）`);
  return { needSegment, archiveLagMs, state };
}

// ---------------------------------------------------------------------------
// 校验
// ---------------------------------------------------------------------------

interface VerificationInput {
  golden: Snapshot;
  afterAccident: Snapshot;
  recovered: Snapshot;
  goldenRows: Record<string, string[]>;
  recoveredRows: Record<string, string[]>;
  sampleTables: string[];
  accidentEventRowsInRecovered: number;
  changeEventRowsInRecovered: number;
  ledgerRowsInRecovered: number;
  expectedLedgerRows: number;
  recoveryLog: string;
  targetTime: string;
  writableAfterPromote: boolean;
  timelineId: string;
}

const FINGERPRINT_LABELS: readonly string[] = ['tables', 'columns', 'indexes', 'enums', 'fks', 'prisma_migrations', 'extensions'];

function formatFingerprint(fp: Record<string, string>): string {
  return FINGERPRINT_LABELS.map((k) => `${k}=${fp[k] ?? '-'}`).join(' / ');
}

function formatKeyTable(stat: TableStat): string {
  return stat.exists ? `${stat.table}=${stat.rows}` : `${stat.table}=（不存在）`;
}

function verify(input: VerificationInput, sampleCount: number): { checks: Check[]; sampleDetail: string; rowCountDiffs: { table: string; expected: number; actual: number }[] } {
  const checks: Check[] = [];

  // A 层：schema 指纹（七项）——恢复实例必须等于**目标时刻**的源实例（而不是事故后的源实例）
  const fpDiff = FINGERPRINT_LABELS.filter((k) => input.golden.fingerprint[k] !== input.recovered.fingerprint[k]);
  const fpAccidentDiff = FINGERPRINT_LABELS.filter((k) => input.golden.fingerprint[k] !== input.afterAccident.fingerprint[k]);
  checks.push({
    name: 'A-fingerprint',
    ok: fpDiff.length === 0,
    detail:
      fpDiff.length === 0
        ? `七项全等于目标时刻：${formatFingerprint(input.recovered.fingerprint)}`
        : `与目标时刻不一致的项：${fpDiff.map((k) => `${k}(目标 ${input.golden.fingerprint[k]} → 恢复 ${input.recovered.fingerprint[k]})`).join('、')}`,
  });
  // 事故**确实**在源实例的 schema 上留下了痕迹（否则 P4 的"恢复回来了"就没有对照物）
  checks.push({
    name: 'A-accident-visible',
    ok: fpAccidentDiff.length > 0,
    detail:
      fpAccidentDiff.length > 0
        ? `事故后源实例偏离目标时刻的项：${fpAccidentDiff.map((k) => `${k}(${input.golden.fingerprint[k]} → ${input.afterAccident.fingerprint[k]})`).join('、')}`
        : '事故没有在 schema 指纹上留下任何痕迹（DROP 没生效？）——恢复也就无从证明',
  });

  // B 层：逐表行数（与目标时刻比，**不与事故后的源实例比**——m8 §6.2 的教训）
  const rowCountDiffs = compareRowCounts(input.golden.rowCounts, input.recovered.rowCounts);
  checks.push({
    name: 'B-rowcounts',
    ok: rowCountDiffs.length === 0,
    detail:
      rowCountDiffs.length === 0
        ? `${Object.keys(input.golden.rowCounts).length}/${Object.keys(input.golden.rowCounts).length} 张表一致，合计 ${input.golden.totalRows} 行`
        : `${rowCountDiffs.length} 张表不一致：${rowCountDiffs.slice(0, 6).map((d) => `${d.table}(目标 ${d.expected} → 恢复 ${d.actual})`).join('、')}`,
  });

  // C 层：关键表点名（含"表存在性"——事故删掉的表在恢复实例里必须还在）
  const keyMismatch: string[] = [];
  for (const goldenStat of input.golden.keyTables) {
    const recoveredStat = input.recovered.keyTables.find((s) => s.table === goldenStat.table);
    if (!recoveredStat || !recoveredStat.exists || recoveredStat.rows !== goldenStat.rows) {
      keyMismatch.push(`${goldenStat.table}(目标 ${goldenStat.exists ? goldenStat.rows : '不存在'} → 恢复 ${recoveredStat?.exists ? recoveredStat.rows : '不存在'})`);
    }
  }
  checks.push({
    name: 'C-key-tables',
    ok: keyMismatch.length === 0,
    detail:
      keyMismatch.length === 0
        ? input.recovered.keyTables.map(formatKeyTable).join(' / ')
        : `点名不符：${keyMismatch.join('、')}`,
  });

  // D 层：抽样内容逐行原样（两侧都来自 pg_dump 的 COPY 文本，不解码转义）
  const sampleDetails: string[] = [];
  let sampleOk = sampleCount > 0;
  if (sampleCount <= 0) {
    sampleDetails.push('未抽样（--verify-sample 0）：B/C 层回到"行数对了不代表内容对"的强度');
  } else if (input.sampleTables.length === 0) {
    sampleDetails.push('没有符合条件的表可抽样（需要 0 < 行数 ≤ 2000）');
  } else {
    for (const table of input.sampleTables) {
      const expected = input.goldenRows[table] ?? [];
      const actual = input.recoveredRows[table] ?? [];
      const cmp = compareCopyRows(expected, actual);
      sampleOk = sampleOk && cmp.ok;
      sampleDetails.push(`${table}（${expected.length} 行）：${cmp.ok ? '逐行一致' : cmp.detail}`);
    }
  }
  checks.push({ name: 'D-sampled-content', ok: sampleOk, detail: sampleDetails.join('；') });

  // PITR 专属断言
  const prematureEnd = /recovery ended before configured recovery target was reached/.test(input.recoveryLog);
  const complete = /archive recovery complete/.test(input.recoveryLog);
  const stopping = findLogLine(input.recoveryLog, /recovery stopping (before|after)/);
  checks.push({
    name: 'P1-target-reached',
    ok: complete && !prematureEnd,
    detail:
      (complete && !prematureEnd ? '归档恢复完整走完（archive recovery complete）' : '恢复未到达目标（日志见下）') +
      (stopping ? `；停止点：${stopping.replace(/^.*(recovery stopping)/, 'recovery stopping')}` : ''),
  });
  const replayEvidence = input.changeEventRowsInRecovered > 0 && input.ledgerRowsInRecovered === input.expectedLedgerRows;
  checks.push({
    name: 'P2-wal-replayed',
    ok: replayEvidence,
    detail: `基准备份之后写入的数据只能来自 WAL 重放：事件行 ${input.changeEventRowsInRecovered} 条、账本 ${input.ledgerRowsInRecovered}/${input.expectedLedgerRows} 行`,
  });
  checks.push({
    name: 'P3-post-target-excluded',
    ok: input.accidentEventRowsInRecovered === 0,
    detail: `目标时刻之后的事故事务事件行在恢复实例中为 ${input.accidentEventRowsInRecovered} 条（期望 0 ⇒ 恢复停在了目标时刻）`,
  });
  const accidentUndone = input.recovered.keyTables.some((s) => s.table === ACCIDENT_DROPPED_TABLE && s.exists) && !input.afterAccident.keyTables.some((s) => s.table === ACCIDENT_DROPPED_TABLE && s.exists);
  checks.push({
    name: 'P4-accident-rolled-back',
    ok: accidentUndone,
    detail: `事故删掉的 ${ACCIDENT_DROPPED_TABLE} 在恢复实例中${accidentUndone ? '已回来' : '仍然缺失'}（事故后源实例中${
      input.afterAccident.keyTables.some((s) => s.table === ACCIDENT_DROPPED_TABLE && s.exists) ? '仍存在（事故未生效？）' : '已不存在'
    }）`,
  });
  const newTimeline = Number(input.timelineId) > 1;
  const promoted = newTimeline && input.writableAfterPromote;
  checks.push({
    name: 'P5-promoted-writable',
    ok: promoted,
    detail: `时间线 ${input.timelineId}${newTimeline ? '（恢复后分叉，> 1 说明确实做过 promote）' : '（未分叉：promote 可能没发生）'}；恢复实例${input.writableAfterPromote ? '可写（已实际写入一行验证）' : '不可写'}`,
  });

  return { checks, sampleDetail: sampleDetails.join('；'), rowCountDiffs };
}

// ---------------------------------------------------------------------------
// 报告
// ---------------------------------------------------------------------------

interface Report {
  label: string;
  script: string;
  startedAt: string;
  finishedAt?: string;
  totalMs?: number;
  verdict: 'PASS' | 'FAIL' | 'DRY-RUN';
  environment: {
    dockerVersion: string;
    pgImage: string;
    containers: { src: string; dst: string };
    volumes: { archive: string; base: string; restore: string };
    ports: { src: number; dst: number };
  };
  timeline: { baseBackupAt?: string; lastChangeAt?: string; targetTime?: string; accidentAt?: string; gapMs: number };
  backup: { ms?: number; bytes?: number; bytesText?: string };
  wal: { needSegment?: string; archiveLagMs?: number; archivedCount?: number; failedCount?: number };
  recovery: {
    /** 基线物化 + 落恢复配置（恢复卷准备）耗时 */
    baseCopyMs?: number;
    /** 容器启动 → `pg_isready` 通过（服务器已能接受连接） */
    startupMs?: number;
    /** 容器启动 → `pg_is_in_recovery()=false`（promote 完成，可写）——本报告口径的 RTO */
    rtoMs?: number;
    /** 恢复后的时间线号（> 1 表示 promote 后分叉） */
    timelineId?: string;
    /** `pg_last_xact_replay_timestamp()`：最后被重放的事务时刻 */
    recoveredToTime?: string;
    logLines: string[];
    /** 目标时刻 → 事故事务提交（PITR 有意丢弃的窗口） */
    dataLossWindowMs?: number;
  };
  schema: { migrations: number; replayMs: number; tables: number; skippedReplay: boolean };
  checks: Check[];
  numbers: {
    goldenTotalRows?: number;
    recoveredTotalRows?: number;
    afterAccidentTotalRows?: number;
    sampleTables?: string[];
    ledgerRows?: number;
    /** 变更阶段写入的账本行数（期望值） */
    expectedLedgerRows?: number;
    accidentEventRowsInRecovered?: number;
    changeEventRowsInRecovered?: number;
  };
  cleanup: { performed: boolean; keptResources?: boolean; sharedContainersStillRunning?: string[] };
  notes: string[];
}

function printReport(logger: Logger, report: Report): void {
  logger.raw('');
  logger.raw(`=== PITR 演练报告（${report.script} · ${report.label}）===`);
  logger.raw(`环境      ：docker ${report.environment.dockerVersion} / 镜像 ${report.environment.pgImage}`);
  logger.raw(`一次性资源：容器 ${report.environment.containers.src} + ${report.environment.containers.dst}（端口 ${report.environment.ports.src} / ${report.environment.ports.dst}）`);
  logger.raw(`卷        ：${report.environment.volumes.archive} / ${report.environment.volumes.base} / ${report.environment.volumes.restore}`);
  logger.raw(`schema    ：重放迁移 ${report.schema.migrations} 个（${formatDuration(report.schema.replayMs)}），表 ${report.schema.tables} 张${report.schema.skippedReplay ? '（--skip-schema-replay）' : ''}`);
  logger.raw(`时间线    ：基准备份 ${report.timeline.baseBackupAt ?? '-'} → 最后变更 ${report.timeline.lastChangeAt ?? '-'} → 目标 ${report.timeline.targetTime ?? '-'} → 事故 ${report.timeline.accidentAt ?? '-'}`);
  logger.raw(`基准备份  ：${report.backup.bytesText ?? '-'}（${formatDuration(report.backup.ms ?? 0)}）`);
  logger.raw(`WAL 归档  ：段 ${report.wal.needSegment ?? '-'} 归档耗时 ${formatDuration(report.wal.archiveLagMs ?? 0)}（累计 ${report.wal.archivedCount ?? '-'} 段 / failed=${report.wal.failedCount ?? '-'}）`);
  logger.raw(`恢复准备  ：基线物化 + 恢复配置 ${formatDuration(report.recovery.baseCopyMs ?? 0)}`);
  logger.raw(
    `恢复      ：启动 ${formatDuration(report.recovery.startupMs ?? 0)}（→ pg_isready）/ RTO ${formatDuration(report.recovery.rtoMs ?? 0)}（→ promote 完成，可写）`,
  );
  logger.raw(
    `端到端 RTO：${formatDuration((report.recovery.baseCopyMs ?? 0) + (report.recovery.rtoMs ?? 0))}（基线物化 → 可写；不含"人发现事故 + 决定恢复到哪个时刻"的决策时间）`,
  );
  logger.raw(`恢复结果  ：timeline ${report.recovery.timelineId ?? '-'}；最后重放事务时刻 ${report.recovery.recoveredToTime ?? '-'}`);
  logger.raw(`丢弃窗口  ：${formatDuration(report.recovery.dataLossWindowMs ?? 0)}（目标时刻 → 事故事务提交，PITR 有意丢弃）`);
  logger.raw('');
  logger.raw('四层校验 + PITR 断言：');
  for (const check of report.checks) logger.raw(`  [${check.ok ? 'PASS' : 'FAIL'}] ${check.name}：${check.detail}`);
  if (report.recovery.logLines.length > 0) {
    logger.raw('');
    logger.raw('恢复实例关键日志：');
    for (const line of report.recovery.logLines) logger.raw(`  ${line}`);
    if (report.recovery.logLines.some((l) => /cannot stat/.test(l))) {
      logger.raw('  （注：`cp: cannot stat ... No such file or directory` 是 restore_command 在找"下一段 WAL / 时间线历史文件"时的正常失败——PG 正是靠它判断"归档到此为止"，不是错误。）');
    }
  }
  if (report.notes.length > 0) {
    logger.raw('');
    logger.raw('诚实边界（本机一次性容器 ≠ 生产拓扑）：');
    for (const note of report.notes) logger.raw(`  - ${note}`);
  }
  logger.raw('');
  const failed = report.checks.filter((c) => !c.ok);
  logger.raw(
    `结论：${report.verdict}${report.totalMs !== undefined ? `（总耗时 ${formatDuration(report.totalMs)}）` : ''}` +
      (failed.length > 0 ? ` —— 未通过：${failed.map((c) => c.name).join('、')}` : ''),
  );
  logger.raw(
    `清理：${report.cleanup.performed ? (report.cleanup.keptResources ? '按要求保留（--keep）' : '容器与卷已删除') : '未执行'}` +
      (report.cleanup.sharedContainersStillRunning?.length ? `；共享容器未被触碰：${report.cleanup.sharedContainersStillRunning.join(', ')}` : ''),
  );
}

// ---------------------------------------------------------------------------
// dry-run 计划
// ---------------------------------------------------------------------------

function printPlan(logger: Logger, config: Config, names: Names, dockerVersion: string, migrations: number): void {
  logger.raw('');
  logger.raw('=== PITR 演练计划（dry-run；未创建任何资源）===');
  logger.raw(`镜像      ：${config.pgImage}（本机 docker ${dockerVersion}）`);
  logger.raw(`一次性资源：容器 ${names.src} / ${names.dst}`);
  logger.raw(`一次性卷  ：${names.archiveVol}（WAL 归档） / ${names.baseVol}（基准备份） / ${names.restoreVol}（恢复数据目录）`);
  logger.raw(`端口      ：源实例 127.0.0.1:${config.port} / 恢复实例 127.0.0.1:${config.portRestore}（仅绑本机回环）`);
  logger.raw(`源实例配置：archive_mode=on + archive_command='cp %p ${ARCHIVE_MOUNT}/%f' + wal_level=replica`);
  logger.raw(`schema    ：${config.skipSchemaReplay ? '跳过迁移重放（只建演练表）' : `重放 prisma/migrations/** 共 ${migrations} 个文件 + 合成 _prisma_migrations + 播种 Plan`}`);
  logger.raw(`阶段      ：① 基准备份 → ② 3 个事务写入 ${config.ledgerRows} 行账本 → ③ 目标时刻（DB 时钟 + ${config.targetOffsetMs}ms）`);
  logger.raw(`            ④ 静默 ${config.gapMs}ms → ⑤ 事故（DELETE "Plan" + DROP TABLE "${ACCIDENT_DROPPED_TABLE}"）→ ⑥ pg_switch_wal + 等归档`);
  logger.raw(`            ⑦ 基线 + restore_command 恢复到目标时刻（promote）→ ⑧ 四层校验 → ⑨ 销毁`);
  logger.raw(`校验      ：A 指纹七项 / B 逐表行数 / C 关键表（${KEY_TABLES.length} 张 + 演练表）/ D 内容级抽样 ${config.verifySample} 张（逐行原样）`);
  logger.raw(`            + PITR 断言：目标时刻到达 / WAL 已重放 / 事故事务未重放 / 已提升且可写`);
  logger.raw('');
  logger.raw('诚实边界（不会因为"本机跑通"就变成生产结论）：');
  logger.raw('  - 本机归档是本地 cp（同盘），没有对象存储/异地网络延迟，也没有归档失败的运维路径；');
  logger.raw('  - 数据量级 = 空库 schema + 数百行演练数据（实际字节数见报告"基准备份"行），TB 级库的 RTO 不可外推；');
  logger.raw('  - 无主从切换/无多可用区：promote 的是"恢复实例"本身，不是真实集群的故障转移；');
  logger.raw('  - 容器共享宿主时钟与磁盘，宿主级故障（m8 §7 最后一行）不在本演练范围内。');
  logger.raw('');
  logger.raw(`加上 --confirm 才会真正执行（预计 1~3 分钟）；退出码契约见 --help。`);
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

async function main(): Promise<number> {
  const parsed = parseArgs(process.argv.slice(2), SPECS);
  const logger = createLogger('pitr-drill');
  if (!parsed.ok) {
    process.stderr.write(`${parsed.error}\n`);
    return EXIT_USAGE;
  }
  if (parsed.help) {
    process.stdout.write(
      helpText({
        script: SCRIPT,
        summary: 'M11-P15 PITR 演练：一次性 PG 容器 + WAL 归档 → recovery_target_time 时间点恢复 → 四层校验（NV-06）',
        usage: 'npx tsx scripts/pitr-drill.ts [--confirm] [选项]',
        specs: SPECS,
        exitCodes: DEFAULT_EXIT_CODES,
        notes: [
          '默认 dry-run：不加 --confirm 只打印计划；执行时需要 docker。',
          '绝不触碰共享开发环境：全部资源在一次性命名空间（pitr-drill-<stamp>-<rand>-*）内，用完即删。',
          '口令随机生成、经 docker 的环境变量透传（不进命令行/日志）；不读 .env、不连 DATABASE_URL（见文档 §1）。',
          '本机一次性容器 ≠ 生产 WAL 归档拓扑——RTO/RPO 数字不可外推（见 docs/operations/m11-pitr-drill.md §7）。',
        ],
        examples: [
          'npx tsx scripts/pitr-drill.ts                      # 看计划（dry-run）',
          'npx tsx scripts/pitr-drill.ts --confirm            # 真跑一轮（含四层校验）',
          'npx tsx scripts/pitr-drill.ts --confirm --keep     # 跑完保留容器/卷做人工取证',
          'npx tsx scripts/pitr-drill.ts --confirm --verify-sample 8 --ledger-rows 2000',
        ],
      }) + '\n',
    );
    return EXIT_OK;
  }

  const v = parsed.parsed.values;
  // 两个实例各占一个本机回环端口（--port 0 = 自动挑空闲；两者必须不同）
  const portSrc = Number(v.port ?? 0) || (await pickFreePort());
  let portRestore = await pickFreePort();
  while (portRestore === portSrc) portRestore = await pickFreePort();

  const config: Config = {
    label: String(v.label ?? 'pitr-drill'),
    pgImage: String(v['pg-image'] ?? DEFAULT_PG_IMAGE),
    port: portSrc,
    portRestore,
    gapMs: Number(v['gap-ms'] ?? 2000),
    targetOffsetMs: Number(v['target-offset-ms'] ?? 400),
    ledgerRows: Number(v['ledger-rows'] ?? 500),
    verifySample: Number(v['verify-sample'] ?? 5),
    timeoutMs: Number(v['timeout-ms'] ?? DEFAULT_TIMEOUT_MS),
    skipSchemaReplay: v['skip-schema-replay'] === true,
    reportJson: v['report-json'] ? String(v['report-json']) : undefined,
    keep: v.keep === true,
    cleanStale: v['clean-stale'] === true,
    confirm: v.confirm === true && v['dry-run'] !== true,
  };
  if (config.targetOffsetMs >= config.gapMs) {
    logger.error(`参数不自洽：--target-offset-ms(${config.targetOffsetMs}) 必须显著小于 --gap-ms(${config.gapMs})，否则目标时刻可能落到事故事务之后`);
    return EXIT_USAGE;
  }

  const startedAt = new Date();
  const dockerVersion = await dockerPreflight(logger, config.pgImage);
  const names = makeNames();
  const migrations = migrationFiles();

  if (!config.confirm) {
    printPlan(logger, config, names, dockerVersion, migrations.length);
    return EXIT_OK;
  }

  const started = Date.now();
  const report: Report = {
    label: config.label,
    script: SCRIPT,
    startedAt: startedAt.toISOString(),
    verdict: 'FAIL',
    environment: {
      dockerVersion,
      pgImage: config.pgImage,
      containers: { src: names.src, dst: names.dst },
      volumes: { archive: names.archiveVol, base: names.baseVol, restore: names.restoreVol },
      ports: { src: config.port, dst: config.portRestore },
    },
    timeline: { gapMs: config.gapMs },
    backup: {},
    wal: {},
    recovery: { logLines: [] },
    schema: { migrations: migrations.length, replayMs: 0, tables: 0, skippedReplay: config.skipSchemaReplay || migrations.length === 0 },
    checks: [],
    numbers: {},
    cleanup: { performed: false },
    notes: [
      '本机归档 = 本地 cp（同盘），无对象存储/异地网络延迟，也没有"归档失败告警与重试"的运维路径；',
      '数据量级 = 空库 schema + 数百行演练数据（本次基线字节数见报告"基准备份"行），TB 级库的 RTO/RPO 不可外推；',
      'promote 的是恢复实例本身，不是真实集群的主从切换/多可用区故障转移；',
      '宿主级故障、备份介质损坏、密钥（ENCRYPTION_KEY）丢失均不在本演练范围（见 m8 §7 失败矩阵）。',
    ],
  };

  const password = randomBytes(12).toString('hex');
  const src = makeClient(names.src, config.port, password);
  const dst = makeClient(names.dst, config.portRestore, password);
  let exitCode = EXIT_OK;

  try {
    // ---- 0) 残留告警 / 清理 ----
    const stale = await listOwnResources();
    if (stale.containers.length > 0 || stale.volumes.length > 0) {
      if (config.cleanStale) {
        logger.warn(`--clean-stale：清理残留 ${stale.containers.length} 个容器 / ${stale.volumes.length} 个卷`);
        for (const c of stale.containers) await docker(['rm', '-f', c], { quiet: true });
        for (const vol of stale.volumes) await docker(['volume', 'rm', vol], { quiet: true });
      } else {
        logger.warn(`发现历史残留（不影响本次，本次使用全新命名空间）：容器 ${stale.containers.join(', ') || '无'}；卷 ${stale.volumes.join(', ') || '无'}（清理加 --clean-stale）`);
      }
    }

    // ---- 1) 一次性卷 + 源实例 ----
    logger.step(`创建一次性卷并启动源实例 ${names.src}（端口 127.0.0.1:${config.port}）`);
    for (const [vol, what] of [
      [names.archiveVol, 'WAL 归档'],
      [names.baseVol, '基准备份'],
      [names.restoreVol, '恢复数据目录'],
    ] as const) {
      assertOwnVolume(vol);
      await dockerOk(['volume', 'create', vol], `创建卷 ${what}`);
    }
    await helperRun(
      config.pgImage,
      [`${names.archiveVol}:${ARCHIVE_MOUNT}`, `${names.baseVol}:${BASE_MOUNT}`, `${names.restoreVol}:${PGDATA_MOUNT}`],
      `chmod 777 ${ARCHIVE_MOUNT} ${BASE_MOUNT} ${PGDATA_MOUNT} && echo volumes-ready`,
      { quiet: true },
    );

    await dockerOk(
      [
        'run', '-d', '--name', names.src,
        '-e', 'POSTGRES_PASSWORD',
        '-e', `POSTGRES_USER=${DRILL_USER}`,
        '-e', `POSTGRES_DB=${DRILL_DB}`,
        '-v', `${names.archiveVol}:${ARCHIVE_MOUNT}`,
        '-v', `${names.baseVol}:${BASE_MOUNT}`,
        '-p', `127.0.0.1:${config.port}:5432`,
        config.pgImage,
        '-c', 'archive_mode=on',
        '-c', `archive_command=cp %p ${ARCHIVE_MOUNT}/%f`,
        '-c', 'wal_level=replica',
        '-c', 'max_wal_senders=4',
        '-c', 'listen_addresses=*',
      ],
      '启动源实例',
      { env: { ...process.env, POSTGRES_PASSWORD: password }, timeoutMs: 120_000 },
    );
    const ready = await waitReady(names.src, config.timeoutMs, { requireInitComplete: true });
    if (ready !== 'ready') {
      const logs = await dockerLogs(names.src);
      throw new DrillError(`源实例未就绪（${ready}）：${redactSecrets(logs).slice(-600)}`);
    }
    logger.info(`源实例就绪（PostgreSQL ${(await src.scalar(DRILL_DB, 'SHOW server_version')).trim()}）`);

    // ---- 2) schema ----
    logger.step('建 schema（迁移重放 + 演练表）');
    report.schema = { ...(await buildSchema(src, logger, config.skipSchemaReplay)), skippedReplay: config.skipSchemaReplay };

    // ---- 3) 基准备份 ----
    logger.step('pg_basebackup 基准备份');
    const backup = await takeBaseBackup(names, src, password, logger);
    report.backup = { ms: backup.ms, bytes: backup.bytes, bytesText: formatBytes(backup.bytes) };
    report.timeline.baseBackupAt = await readDbClock(src);

    // ---- 4) 变更（全部发生在基准备份之后 ⇒ 只能靠 WAL 找回） ----
    logger.step(`变更阶段：3 个事务写入 ${config.ledgerRows} 行账本`);
    const changes = await applyChanges(src, config.ledgerRows);
    for (const t of changes.transactions) logger.info(`  ${t.phase}：${t.rows} 行，${formatDuration(t.ms)}`);
    const lastChangeAt = await readDbClock(src);
    const targetTime = new Date((parsePgTimestamp(lastChangeAt) ?? Date.now()) + config.targetOffsetMs).toISOString().replace('T', ' ').replace('Z', '+00');
    report.timeline.lastChangeAt = lastChangeAt;
    report.timeline.targetTime = targetTime;

    // ---- 5) 目标时刻的状态（golden）：指纹 / 行数 / 抽样内容 ----
    logger.step('采集目标时刻基线（A/B/C/D 层的"期望值"）');
    const golden = await takeSnapshot(src, 'golden');
    const sampleTables = pickSampleTables(golden.rowCounts, config.verifySample, {
      preferred: [...KEY_TABLES.map((k) => k.table), 'Plan', DRILL_EVENT_TABLE, DRILL_LEDGER_TABLE],
    });
    logger.info(
      `抽样表：${sampleTables.length > 0 ? `${sampleTables.join(', ')}（内容级逐行比对）` : '无（没有 0 < 行数 ≤ 2000 的表）'}`,
    );
    const goldenRows = await dumpSampleRows(src, sampleTables);

    // ---- 6) 静默窗口（保证目标时刻落在"无写入"区间内）+ 事故 ----
    const elapsedSinceChange = Date.now() - (parsePgTimestamp(lastChangeAt) ?? Date.now());
    const remainingGap = config.gapMs - elapsedSinceChange;
    if (remainingGap > 0) {
      logger.info(`静默等待 ${formatDuration(remainingGap)}（目标时刻 ${targetTime} 必须落在无写入窗口内）`);
      await sleep(remainingGap);
    }
    logger.step(`制造事故：DELETE "Plan" + DROP TABLE "${ACCIDENT_DROPPED_TABLE}"`);
    const accident = await makeAccident(src);
    if (accident.droppedTableExists) throw new DrillError(`事故未生效：${ACCIDENT_DROPPED_TABLE} 仍存在`, EXIT_VERIFY);
    report.timeline.accidentAt = await readDbClock(src);
    report.numbers.expectedLedgerRows = config.ledgerRows;

    // ---- 7) 让归档追上（否则目标时刻不可达） ----
    logger.step('pg_switch_wal + 等归档追上');
    const archive = await switchAndAwaitArchive(src, logger, Math.max(config.timeoutMs, 30_000));
    report.wal = { needSegment: archive.needSegment, archiveLagMs: archive.archiveLagMs, archivedCount: archive.state.archivedCount, failedCount: archive.state.failedCount };

    // 事故后的源实例状态（用于"恢复到事故前"的对照证据）
    const afterAccident = await takeSnapshot(src, 'after-accident');

    // ---- 8) 恢复实例 ----
    logger.step('准备恢复实例（基线副本 + recovery.signal + recovery_target_time）');
    const baseCopyStarted = Date.now();
    await helperRun(
      config.pgImage,
      [`${names.baseVol}:/src`, `${names.restoreVol}:/dst`],
      'cp -a /src/. /dst/ && touch /dst/recovery.signal && chown -R postgres:postgres /dst && chmod 700 /dst && echo restore-dir-ready',
      { quiet: true },
    );
    const recoveryConfig = [
      '',
      `# --- ${SCRIPT} 生成的恢复参数（演练后随卷删除；生产应放进专门的配置 include）---`,
      `restore_command = 'cp ${ARCHIVE_MOUNT}/%f %p'`,
      `recovery_target_time = '${targetTime}'`,
      `recovery_target_action = 'promote'`,
      `recovery_target_inclusive = on`,
      '',
    ].join('\n');
    await helperRun(config.pgImage, [`${names.restoreVol}:/dst`], `cat >> /dst/postgresql.auto.conf && grep -q recovery_target_time /dst/postgresql.auto.conf`, {
      stdin: recoveryConfig,
      quiet: true,
    });
    // 基线物化（把 st_size 版图字节搬到恢复卷）也是真实 RTO 的一部分，不能只从"容器启动"开始计时
    report.recovery.baseCopyMs = Date.now() - baseCopyStarted;

    logger.step(`启动恢复实例 ${names.dst}（端口 127.0.0.1:${config.portRestore}）`);
    const restoreStarted = Date.now();
    await dockerOk(
      [
        'run', '-d', '--name', names.dst,
        '-v', `${names.archiveVol}:${ARCHIVE_MOUNT}`,
        '-v', `${names.restoreVol}:${PGDATA_MOUNT}`,
        '-p', `127.0.0.1:${config.portRestore}:5432`,
        config.pgImage,
      ],
      '启动恢复实例',
      { timeoutMs: 120_000 },
    );
    const restoreReady = await waitReady(names.dst, config.timeoutMs);
    // M11 Final Audit M5：promote 完成后再抓恢复日志（此处抓取可能早于 "archive recovery complete"
    // 落盘 → P1 伪 FAIL）。declaration 移到 promote 之后，这里先空调用不保留结果。
    report.recovery.logLines = []; // 占位——promote 后以重抓日志填充
    if (restoreReady !== 'ready') {
      throw new DrillError(
        `恢复实例未就绪（${restoreReady}）——这通常意味着归档恢复没能到达目标时刻（见日志）：\n${report.recovery.logLines.join('\n')}`,
        EXIT_VERIFY,
      );
    }
    report.recovery.startupMs = Date.now() - restoreStarted;

    // RTO 的终点取"promote 完成"（`pg_is_in_recovery()` 转 false），而不是仅仅"端口能连"：
    // 恢复中的实例也会接受连接，只按 pg_isready 计时会把 RTO 报小。
    const promoted = await waitFor(
      async () => (await dst.scalar(DRILL_DB, 'SELECT pg_is_in_recovery()')).trim() === 'f',
      { timeoutMs: config.timeoutMs, intervalMs: 300 },
    );
    report.recovery.rtoMs = Date.now() - restoreStarted;
    if (!promoted.ok) {
      throw new DrillError(
        `恢复实例在 ${formatDuration(config.timeoutMs)} 内未提升为可写（pg_is_in_recovery() 仍为 true）：\n${report.recovery.logLines.join('\n')}`,
        EXIT_VERIFY,
      );
    }
    // M11 Final Audit M5：promote 完成后重抓日志——P1 的 "archive recovery complete" 判定以此时为准
    const recoveryLog = await dockerLogs(names.dst);
    report.recovery.logLines = summarizeRecoveryLog(recoveryLog);
    report.recovery.timelineId = (await dst.scalar(DRILL_DB, `SELECT timeline_id FROM pg_control_checkpoint()`)).trim();
    report.recovery.recoveredToTime = (await dst.scalar(DRILL_DB, `SELECT to_char(pg_last_xact_replay_timestamp() at time zone 'UTC','YYYY-MM-DD HH24:MI:SS.US') || '+00'`)).trim();
    logger.info(
      `恢复实例就绪并已 promote：启动 ${formatDuration(report.recovery.startupMs)}（到 pg_isready）/ ` +
        `RTO ${formatDuration(report.recovery.rtoMs)}（到 promote 完成，timeline ${report.recovery.timelineId}，最后重放事务时刻 ${report.recovery.recoveredToTime}）`,
    );

    // ---- 9) 四层校验 + PITR 断言 ----
    logger.step('四层校验（A 指纹 / B 行数 / C 关键表 / D 抽样内容）+ PITR 断言');
    const recovered = await takeSnapshot(dst, 'recovered');
    const recoveredRows = await dumpSampleRows(dst, sampleTables);
    const accidentEventRowsInRecovered = await readEventCount(dst, 'accident');
    const changeEventRowsInRecovered = Number((await dst.scalar(DRILL_DB, `SELECT count(*) FROM "${DRILL_EVENT_TABLE}" WHERE phase LIKE 'change-%'`)).trim());
    const ledgerRowsInRecovered = Number((await dst.scalar(DRILL_DB, `SELECT count(*) FROM "${DRILL_LEDGER_TABLE}"`)).trim());

    // 提升后可写（在内容比对**之后**做，避免写入污染 D 层比对）
    const writeRes = await dst.loadScript(DRILL_DB, `INSERT INTO "${DRILL_EVENT_TABLE}" (phase, note) VALUES ('after-recovery-write', 'promote 后可写性验证')`);
    const writableAfterPromote = writeRes.code === 0;
    if (!writableAfterPromote) logger.warn(`promote 后写入失败（退出码 ${writeRes.code}）：${redactSecrets(writeRes.stderr.trim()).slice(0, 200)}`);

    const accidentMs = parsePgTimestamp(report.timeline.accidentAt ?? '');
    const targetMs = parsePgTimestamp(targetTime);
    if (accidentMs !== null && targetMs !== null) report.recovery.dataLossWindowMs = accidentMs - targetMs;

    const verification = verify(
      {
        golden,
        afterAccident,
        recovered,
        goldenRows,
        recoveredRows,
        sampleTables,
        accidentEventRowsInRecovered,
        changeEventRowsInRecovered,
        ledgerRowsInRecovered,
        expectedLedgerRows: config.ledgerRows,
        recoveryLog,
        targetTime,
        writableAfterPromote,
        timelineId: report.recovery.timelineId ?? '0',
      },
      config.verifySample,
    );
    report.checks = verification.checks;
    report.numbers = {
      ...report.numbers,
      goldenTotalRows: golden.totalRows,
      recoveredTotalRows: recovered.totalRows,
      afterAccidentTotalRows: afterAccident.totalRows,
      sampleTables,
      ledgerRows: ledgerRowsInRecovered,
      accidentEventRowsInRecovered,
      changeEventRowsInRecovered,
    };

    report.verdict = report.checks.every((c) => c.ok) ? 'PASS' : 'FAIL';
    exitCode = report.verdict === 'PASS' ? EXIT_OK : EXIT_VERIFY;
  } catch (err) {
    const e = err instanceof DrillError ? err : new DrillError(err instanceof Error ? err.message : String(err));
    logger.error(e.message);
    exitCode = e.code;
  } finally {
    // ---- 10) 清理（只动本次命名空间）----
    try {
      if (!config.keep) {
        for (const container of [names.dst, names.src]) {
          assertOwnContainer(container);
          await docker(['rm', '-f', container], { quiet: true });
        }
        for (const volume of [names.archiveVol, names.baseVol, names.restoreVol]) {
          assertOwnVolume(volume);
          await docker(['volume', 'rm', volume], { quiet: true });
        }
        report.cleanup = { performed: true, keptResources: false };
      } else {
        report.cleanup = { performed: true, keptResources: true };
      }
      const shared = await docker(['ps', '--format', '{{.Names}}'], { quiet: true });
      const stillRunning = shared.stdout
        .split(/\r?\n/)
        .map((s) => s.trim())
        .filter((s) => s.startsWith('docker-') || s === 'b2c-postgres' || s === 'b2c-redis');
      report.cleanup.sharedContainersStillRunning = stillRunning;
    } catch (cleanupErr) {
      logger.warn(`清理阶段出错（人工核对 docker ps -a --filter name=${NAME_PREFIX}）：${cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr)}`);
    }
  }

  report.finishedAt = new Date().toISOString();
  report.totalMs = Date.now() - started;
  printReport(logger, report);
  if (config.reportJson) {
    const path = resolve(config.reportJson);
    writeFileSync(path, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    logger.info(`报告已写入 ${path}`);
  }
  return exitCode;
}

void main()
  .then((code) => process.exit(code))
  .catch((err) => {
    process.stderr.write(`${SCRIPT} 未捕获异常：${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
    process.exit(EXIT_FAIL);
  });
