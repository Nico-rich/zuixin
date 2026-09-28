/**
 * M10-P9 运维脚本：PostgreSQL 客户端封装（docker exec 与直连两种模式）。
 *
 * 为什么两种模式：
 * - **本机开发环境**（`docker/docker-compose.yml`）里 DB 在容器 `docker-postgres-1`，宿主机没有
 *   pg_dump/psql 客户端 ⇒ 用 `docker exec` 复用容器内的客户端二进制（m8 手册实测路径）；
 * - **生产**（托管 PG / K8s）里应当在 DB 主机或带客户端的 Job 里**直连**（PGHOST/PGPORT/PGUSER/PGPASSWORD），
 *   不去依赖"能 docker exec 到数据库容器"这种特权。
 *
 * 安全：口令只经环境变量传给子进程，**绝不进命令行参数**（命令行在 `ps` 里对同机用户可见）。
 */

import type { DatabaseTarget } from './env';
import { redactSecrets, run, type RunResult } from './cli';

export type PgMode = 'docker' | 'direct';

export interface PgClientOptions {
  target: DatabaseTarget;
  mode: PgMode;
  /** docker 模式：容器名（默认 docker-postgres-1） */
  container?: string;
  /** 覆盖 docker 二进制路径（默认 `docker`） */
  dockerBin?: string;
  /** 直连模式：客户端二进制路径（默认 `pg_dump` / `psql` 走 PATH） */
  clientBinDir?: string;
}

/** 受保护的库名：任何"恢复到目标库"的动作都绝不允许指向这些名字。 */
export const PROTECTED_DATABASES: readonly string[] = ['postgres', 'template0', 'template1'];

export interface TargetSafetyResult {
  ok: boolean;
  reason: string;
}

/**
 * 目标库安全闸门（**恢复脚本的第一道门**，纯函数、单测覆盖）：
 *  1. 必须符合 PG 标识符规则（防注入；恢复脚本里会有 CREATE DATABASE 拼接）；
 *  2. 不允许等于**当前 DATABASE_URL 指向的库**（即"就地覆盖源库"）——演练/恢复都用新库，
 *     就地恢复必须由人工用 psql 执行（见 runbook §4.2），脚本不提供这条捷径；
 *  3. 不允许是 postgres/template0/template1 这类系统库；
 *  4. 不允许以 `-` 开头或含空格/引号/分号/反斜杠。
 */
export function assertSafeTargetDatabase(input: {
  target: string;
  sourceDatabase: string;
  protectedNames?: readonly string[];
}): TargetSafetyResult {
  const { target, sourceDatabase } = input;
  const protectedNames = input.protectedNames ?? PROTECTED_DATABASES;
  if (!target) return { ok: false, reason: '目标库名为空' };
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(target)) {
    return { ok: false, reason: `目标库名 "${target}" 非法：只允许小写字母/数字/下划线，且以字母或下划线开头（≤63 字符）` };
  }
  if (target === sourceDatabase) {
    return {
      ok: false,
      reason: `拒绝恢复到源库 "${sourceDatabase}"：恢复脚本只在**新建的临时库**上工作（就地恢复见 runbook §4.2，需人工执行）`,
    };
  }
  if (protectedNames.includes(target)) {
    return { ok: false, reason: `拒绝以系统库 "${target}" 作为恢复目标` };
  }
  return { ok: true, reason: 'ok' };
}

/** 拼接带引号的标识符（`"x"`），并断言不含引号——与 assertSafeTargetDatabase 双保险。 */
export function quoteIdent(name: string): string {
  if (name.includes('"') || name.includes('\0')) throw new Error(`标识符含非法字符：${name}`);
  return `"${name}"`;
}

/** 解析 `psql -At -F'|'` 的 `key|value` 输出。多列时只取前两列。 */
export function parsePipeRows(stdout: string): [string, string][] {
  return stdout
    .split(/\r?\n/)
    .map((l) => l.trimEnd())
    .filter((l) => l.length > 0)
    .map((l) => {
      const idx = l.indexOf('|');
      return idx < 0 ? ([l, ''] as [string, string]) : ([l.slice(0, idx), l.slice(idx + 1)] as [string, string]);
    });
}

/**
 * 逐表行数查询输出（`表名|行数`）→ Record。
 * 表名两侧可能带双引号（不同查询写法/`-A` 之外的输出），这里统一剥掉；
 * 数值保持原样（`-1` 由调用方解释为"表不存在"）。
 */
export function parseRowCountOutput(stdout: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [rawTable, value] of parsePipeRows(stdout)) {
    const table = rawTable.replace(/^"|"$/g, '');
    if (table === '') continue;
    out[table] = Number(value);
  }
  return out;
}

export interface QueryTarget {
  /** 要连接的库（默认 = target.database） */
  database?: string;
  /** 是否把 stdout 收集进内存（默认 true） */
  collect?: boolean;
}

/**
 * 一次性可用的 psql 单条查询：
 * `SELECT '<key>' AS k, count(*) AS v FROM "X"` 之类，输出按 `-At -F'|'` 管道分隔。
 */
export class PgClient {
  private readonly target: DatabaseTarget;
  private readonly mode: PgMode;
  private readonly container: string;
  private readonly dockerBin: string;
  private readonly clientBinDir: string;

  constructor(options: PgClientOptions) {
    this.target = options.target;
    this.mode = options.mode;
    this.container = options.container ?? 'docker-postgres-1';
    this.dockerBin = options.dockerBin ?? 'docker';
    this.clientBinDir = options.clientBinDir ?? '';
  }

  get description(): string {
    return this.mode === 'docker'
      ? `docker exec ${this.container}（容器内客户端，库 ${this.target.database}）`
      : `直连 ${this.target.redacted}`;
  }

  /** 直连模式需要的 PG* 环境（docker 模式不传口令：容器内 local trust）。 */
  private env(): NodeJS.ProcessEnv {
    if (this.mode === 'docker') return process.env;
    return {
      ...process.env,
      PGHOST: this.target.host,
      PGPORT: String(this.target.port),
      PGUSER: this.target.user,
      PGPASSWORD: this.target.password,
      PGCONNECT_TIMEOUT: process.env.PGCONNECT_TIMEOUT ?? '10',
    };
  }

  private clientBin(name: 'psql' | 'pg_dump' | 'pg_isready'): string {
    return this.clientBinDir ? `${this.clientBinDir}/${name}` : name;
  }

  /** 把"客户端命令 + 参数"包成实际要执行的命令（docker 模式加 `docker exec -i <container>`）。 */
  wrap(clientArgs: readonly string[], opts: { interactive?: boolean } = {}): { command: string; args: string[] } {
    if (this.mode === 'docker') {
      return { command: this.dockerBin, args: ['exec', ...(opts.interactive ? ['-i'] : []), this.container, ...clientArgs] };
    }
    return { command: clientArgs[0], args: clientArgs.slice(1) };
  }

  async exec(
    clientArgs: readonly string[],
    opts: {
      stdin?: NodeJS.ReadableStream | Buffer | string;
      timeoutMs?: number;
      quiet?: boolean;
      interactive?: boolean;
      /** 大产物（pg_dump）直接落盘：不把 GB 级内容读进内存 */
      stdoutToFile?: string;
    } = {},
  ): Promise<RunResult> {
    const { command, args } = this.wrap(clientArgs, { interactive: opts.interactive ?? opts.stdin !== undefined });
    return run(command, args, {
      env: this.env(),
      stdin: opts.stdin,
      timeoutMs: opts.timeoutMs,
      quiet: opts.quiet,
      stdoutToFile: opts.stdoutToFile,
    });
  }

  async version(): Promise<string> {
    const res = await this.exec([this.clientBin('pg_dump'), '--version'], { quiet: true, timeoutMs: 20_000 });
    if (res.spawnError) throw new Error(`无法执行 pg_dump（${this.description}）：${res.spawnError}`);
    if (res.code !== 0) throw new Error(`pg_dump --version 退出码 ${res.code}：${redactSecrets(res.stderr.trim())}`);
    return res.stdout.trim();
  }

  /** `SELECT 1` 连通性（不打印口令）。 */
  async ping(database?: string): Promise<{ ok: boolean; detail: string; durationMs: number }> {
    const res = await this.exec(
      [this.clientBin('psql'), '-U', this.target.user, '-d', database ?? this.target.database, '-At', '-c', 'SELECT 1'],
      { quiet: true, timeoutMs: 20_000 },
    );
    return {
      ok: res.code === 0 && res.stdout.trim() === '1',
      detail: res.spawnError ?? redactSecrets(res.stderr.trim()).slice(0, 300),
      durationMs: res.durationMs,
    };
  }

  async query(sql: string, target: QueryTarget = {}): Promise<string> {
    const res = await this.exec(
      [this.clientBin('psql'), '-U', this.target.user, '-d', target.database ?? this.target.database, '-At', '-F', '|', '-c', sql],
      { quiet: true, timeoutMs: 120_000 },
    );
    if (res.code !== 0) throw new Error(`psql 查询失败（退出码 ${res.code}）：${redactSecrets(res.stderr.trim()).slice(0, 500)}`);
    return res.stdout;
  }

  /** 用 `psql -v ON_ERROR_STOP=1 -f -` 回灌 SQL 流：任何一条 SQL 失败立即非 0 退出（绝不"带错恢复"）。 */
  async loadScript(database: string, stdin: NodeJS.ReadableStream | Buffer | string, timeoutMs = 3_600_000): Promise<RunResult> {
    return this.exec([this.clientBin('psql'), '-U', this.target.user, '-d', database, '-v', 'ON_ERROR_STOP=1', '-f', '-'], {
      stdin,
      timeoutMs,
      quiet: false,
    });
  }

  async databaseExists(name: string): Promise<boolean> {
    const out = await this.query(`SELECT 1 FROM pg_database WHERE datname = ${sqlLiteral(name)}`);
    return out.trim() === '1';
  }

  async createDatabase(name: string): Promise<void> {
    // TEMPLATE template0：不带任何模板库里的对象/编码差异，且允许指定编码（生产模板库常被改过）
    await this.query(`CREATE DATABASE ${quoteIdent(name)} TEMPLATE template0`);
  }

  /** 断开其他会话后删库（DROP DATABASE 要求无活动连接；演练机器上只有本脚本会连临时库）。 */
  async dropDatabase(name: string): Promise<void> {
    await this.query(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = ${sqlLiteral(name)} AND pid <> pg_backend_pid()`,
    );
    await this.query(`DROP DATABASE IF EXISTS ${quoteIdent(name)}`);
  }

  /** 逐表行数（public schema，relkind='r'，与 m8 手册指纹口径一致）。 */
  async tableRowCounts(database: string): Promise<Record<string, number>> {
    const out = await this.query(ROW_COUNT_SQL, { database });
    return parseRowCountOutput(out);
  }

  /** schema 指纹（七项：表/列/索引/枚举/外键/迁移数/扩展）——与 m8 手册 §4.1 ④ 同口径。 */
  async fingerprint(database: string): Promise<Record<string, string>> {
    const out = await this.query(FINGERPRINT_SQL, { database });
    const map: Record<string, string> = {};
    for (const [k, v] of parsePipeRows(out)) map[k] = v;
    return map;
  }

  /** 读一行标量（`SELECT count(*) FROM "X"`），供关键表点名核对。 */
  async scalar(database: string, sql: string): Promise<string> {
    return (await this.query(sql, { database })).trim();
  }
}

/** 单条 SQL 字面量（只用于脚本内部常量表名；用户输入一律走 assertSafeTargetDatabase/quoteIdent）。 */
export function sqlLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/**
 * 逐表行数：一次查询拿到全部表的 count（避免 73 张表 × 一次 docker exec 往返）。
 * `query_to_xml` 让 PG 自己为每张表生成 `SELECT count(*)` 并抽回文本。
 */
export const ROW_COUNT_SQL = `
SELECT c.relname,
       COALESCE((xpath('/row/c/text()', query_to_xml(format('SELECT count(*) AS c FROM %I.%I', n.nspname, c.relname), false, true, '')))[1]::text, '0')
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE c.relkind = 'r' AND n.nspname = 'public'
ORDER BY c.relname`;

/** 七项指纹（与 m8 手册一致，便于沿时间轴对比数字）。 */
export const FINGERPRINT_SQL = `
SELECT 'tables', count(*)::text FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE c.relkind = 'r' AND n.nspname = 'public'
UNION ALL SELECT 'columns', count(*)::text FROM information_schema.columns WHERE table_schema = 'public'
UNION ALL SELECT 'indexes', count(*)::text FROM pg_indexes WHERE schemaname = 'public'
UNION ALL SELECT 'enums', count(distinct t.oid)::text FROM pg_type t JOIN pg_enum e ON e.enumtypid = t.oid
UNION ALL SELECT 'fks', count(*)::text FROM pg_constraint WHERE contype = 'f'
UNION ALL SELECT 'prisma_migrations', count(*)::text FROM _prisma_migrations
UNION ALL SELECT 'extensions', string_agg(extname, ',' order by extname) FROM pg_extension`;

/** 恢复后必须点名的关键表（业务冒烟的最小集合；缺失/为 0 会显著提高"恢复到的不是业务库"的概率）。 */
export const KEY_TABLES: readonly { table: string; why: string }[] = [
  { table: 'User', why: '账号（登录可用性的前提）' },
  { table: 'Organization', why: '组织归属（全部数据隔离的根）' },
  { table: 'AgentRun', why: 'run 状态机（recoverStale 兜底的对象）' },
  { table: 'UsageRecord', why: '计量事实（billing 对账的事实源）' },
  { table: 'Credential', why: '加密凭证（ENCRYPTION_KEY 正确性的抽查对象）' },
  { table: '_prisma_migrations', why: '迁移基线（与代码侧 migrate status 必须一致）' },
];
