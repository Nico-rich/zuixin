/**
 * M10-P9 运维脚本：PostgreSQL 备份回灌与校验（**默认 dry-run；只恢复进新建的临时库**）。
 *
 * 来源：`docs/operations/m8-disaster-recovery.md` §4.1（临时库恢复 + 指纹 + 逐表行数）脚本化（审计 DR-6/DR-13）。
 *
 * 安全设计（这是本仓库里最容易造成不可逆事故的脚本，故三条硬闸门）：
 *   1. **默认 --dry-run**：不给 `--confirm` 就什么都不做（只打印计划与前置检查）；
 *   2. **拒绝恢复到源库**：目标库 ≠ `DATABASE_URL` 指向的库（`assertSafeTargetDatabase`，单测覆盖）；
 *      "就地恢复生产库"必须由人工按 runbook §4.2 执行，脚本不提供这条捷径；
 *   3. **拒绝复用已存在的库**（除显式 `--reuse-existing`），默认每次都是全新库 ⇒ 演练可重复、无脏状态。
 *
 * 校验口径（**与 m8 手册踩过的坑一致**）：逐表行数必须与 **dump 文件自身的 COPY 段**比较，
 * 绝不与"源库当前行数"比较——源库在备份之后仍在写入，那样比会得到假失败。
 *
 * 用法：`cd apps/api && npx tsx scripts/restore.ts --help`
 */

import { createReadStream, existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { resolve } from 'node:path';
import { createGunzip } from 'node:zlib';

import {
  DEFAULT_EXIT_CODES, EXIT_FAIL, EXIT_OK, EXIT_PRECONDITION, EXIT_USAGE, EXIT_VERIFY,
  createLogger, fail, formatBytes, formatDuration, stamp,
} from './lib/cli';
import { loadEnv, parseDatabaseUrl } from './lib/env';
import { compareRowCounts, createDumpStatsCollector, type DumpStats } from './lib/dump';
import { KEY_TABLES, PgClient, assertSafeTargetDatabase, type PgMode } from './lib/pg';
import { helpText, parseArgs, type FlagSpec } from './lib/args';

const SCRIPT = 'restore.ts';
const SPECS: readonly FlagSpec[] = [
  { name: 'dump', alias: 'f', type: 'string', valueName: '<file.sql|file.sql.gz>', help: '备份文件（必填；.gz 自动解压）' },
  { name: 'target-db', alias: 't', type: 'string', valueName: '<name>', help: '恢复目标库名（必填；必须是**新建**的临时库）' },
  { name: 'confirm', type: 'boolean', help: '真正执行恢复（不传则等同 --dry-run：只打印计划）' },
  { name: 'reuse-existing', type: 'boolean', help: '允许目标库已存在（默认拒绝；dump 自带 --clean 会先 DROP 再 CREATE）' },
  { name: 'keep', type: 'boolean', help: '恢复后保留临时库（默认校验完即 DROP）' },
  { name: 'out-dir', alias: 'o', type: 'string', valueName: '<dir>', help: '恢复报告输出目录（默认 <仓库根>/backup）' },
  { name: 'env-file', type: 'string', valueName: '<path>', help: 'env 文件路径（解析 DATABASE_URL / PG 连接）' },
  { name: 'pg-mode', type: 'string', valueName: '<auto|docker|direct>', default: 'auto', help: 'pg 客户端来源（同 backup.ts）' },
  { name: 'pg-container', type: 'string', valueName: '<name>', default: 'docker-postgres-1', help: 'docker 模式容器名' },
  { name: 'pg-client-dir', type: 'string', valueName: '<dir>', help: 'direct 模式客户端目录' },
  { name: 'skip-rowcount-all', type: 'boolean', help: '跳过"全表行数"比对（只做关键表 + 指纹；超大库演练用）' },
  { name: 'timeout-ms', type: 'number', valueName: '<ms>', default: 3_600_000, help: '回灌超时（默认 1h）' },
];

const TARGET_PREFIX_HINT = 'm10p9_';

async function collectStats(file: string): Promise<DumpStats> {
  const collector = createDumpStatsCollector();
  const input = file.endsWith('.gz') ? createReadStream(file).pipe(createGunzip()) : createReadStream(file);
  const rl = createInterface({ input, crlfDelay: Infinity });
  for await (const line of rl) collector.pushLine(line);
  return collector.finish();
}

async function main(): Promise<void> {
  const parsed = parseArgs(process.argv.slice(2), SPECS);
  if (!parsed.ok) {
    process.stderr.write(`${parsed.error}\n`);
    process.exit(EXIT_USAGE);
  }
  if (parsed.help) {
    process.stdout.write(
      helpText({
        script: SCRIPT,
        summary: '把备份回灌到**新建临时库**并做完整性校验（默认 dry-run；需 --confirm 才执行）',
        specs: SPECS,
        notes: [
          '默认行为是 dry-run：不给 --confirm 时只做前置检查与计划打印，不创建/写入任何库。',
          '硬闸门：目标库名 ≠ DATABASE_URL 的库名；目标库不存在（除非 --reuse-existing）；目标库名必须是合法标识符。',
          '行数校验与 **dump 文件自身的 COPY 段**比对（不与源库当前行数比——那会因源库持续写入而假失败）。',
          '恢复完成后打印"凭证解密抽查"步骤；ENCRYPTION_KEY 不正确时凭证全部作废（无需回灌即可发现）。',
        ],
        examples: [
          'npx tsx scripts/restore.ts --dump backup/agent_platform-20260928-120000.sql.gz --target-db m10p9_drill',
          'npx tsx scripts/restore.ts -f backup/x.sql.gz -t m10p9_drill --confirm',
          'npx tsx scripts/restore.ts -f backup/x.sql.gz -t m10p9_drill --confirm --keep',
          'npx tsx scripts/restore.ts -f backup/x.sql.gz -t m10p9_drill --confirm --skip-rowcount-all',
        ],
        exitCodes: DEFAULT_EXIT_CODES,
      }),
    );
    process.exit(EXIT_OK);
  }
  const v = parsed.parsed.values;
  const logger = createLogger('restore');
  const startedAll = Date.now();

  // ---- 参数与 env ----
  const dumpArg = v.dump as string | undefined;
  const targetArg = v['target-db'] as string | undefined;
  if (!dumpArg) fail(logger, '缺少 --dump <备份文件>（见 --help）', EXIT_USAGE);
  if (!targetArg) fail(logger, `缺少 --target-db <临时库名>（建议以 ${TARGET_PREFIX_HINT} 开头）`, EXIT_USAGE);
  let envReport;
  try {
    envReport = loadEnv({ explicit: v['env-file'] as string | undefined });
  } catch (err) {
    fail(logger, (err as Error).message, EXIT_USAGE);
  }
  let target;
  try {
    target = parseDatabaseUrl(process.env.DATABASE_URL);
  } catch (err) {
    fail(logger, `${(err as Error).message}（用 --env-file 指定）`, EXIT_PRECONDITION);
  }
  const dumpPath = resolve(process.cwd(), dumpArg);
  if (!existsSync(dumpPath)) fail(logger, `备份文件不存在：${dumpPath}`, EXIT_PRECONDITION);
  const dumpBytes = statSync(dumpPath).size;
  if (dumpBytes === 0) fail(logger, `备份文件为 0 字节：${dumpPath}`, EXIT_PRECONDITION);

  const outDir = resolve((v['out-dir'] as string | undefined) ?? process.env.BACKUP_DIR ?? resolve(__dirname, '../../../backup'));
  const confirm = v.confirm === true;
  const keep = v.keep === true;
  const reuseExisting = v['reuse-existing'] === true;

  // ---- 安全闸门（先于任何"看起来像动作"的输出）----
  const safety = assertSafeTargetDatabase({ target: targetArg, sourceDatabase: target.database });
  const effectiveDryRun = !confirm;

  logger.raw('');
  logger.raw('=== M10-P9 恢复计划 ===');
  logger.raw(`模式        ：${effectiveDryRun ? 'DRY-RUN（未执行任何写入；加 --confirm 才真正恢复）' : 'EXECUTE（--confirm 已给出）'}`);
  logger.raw(`备份文件    ：${dumpPath}（${formatBytes(dumpBytes)}）`);
  logger.raw(`源库（只读）：${target.redacted}`);
  logger.raw(`目标临时库  ：${targetArg}`);
  logger.raw(`恢复后处理  ：${keep ? '保留临时库' : '校验通过后 DROP 临时库'}；目标已存在：${reuseExisting ? '允许复用' : '拒绝（默认）'}`);
  logger.raw(`env 文件    ：${envReport.file ?? '（未找到，仅用进程环境）'}`);
  logger.raw(`安全闸门    ：${safety.ok ? '通过' : `拒绝 — ${safety.reason}`}`);

  // ---- 解析 dump 内容（期望值来源；dry-run 也做，等于"先证明这个备份文件是可解析的"）----
  logger.step('解析备份文件内容（表 / COPY 段 / 逐表行数）');
  const statsStarted = Date.now();
  const stats = await collectStats(dumpPath);
  const statsMs = Date.now() - statsStarted;
  logger.raw(`  表 ${stats.tables} / COPY 段 ${stats.copySegments} / 数据行 ${stats.totalRows} / 扩展 [${stats.extensions.join(',')}] / 迁移行 ${String(stats.migrationsRows)}`);
  if (stats.tables === 0) fail(logger, '备份文件里没有任何 CREATE TABLE——不是有效的 pg_dump 产物', EXIT_PRECONDITION);
  if (stats.copySegments !== stats.tables) {
    fail(
      logger,
      `备份内部不一致：COPY 段 ${stats.copySegments} ≠ 表 ${stats.tables}（可能被截断）——拒绝用它恢复`,
      EXIT_VERIFY,
    );
  }

  const resolved = await resolveClient(String(v['pg-mode']), String(v['pg-container']), v['pg-client-dir'] as string | undefined, target, logger, fail);
  logger.raw(`pg 客户端   ：${resolved.mode} — ${resolved.client.description}`);

  if (!safety.ok) fail(logger, `安全闸门拒绝：${safety.reason}`, EXIT_PRECONDITION);

  const ping = await resolved.client.ping();
  logger.raw(`连通性      ：${ping.ok ? 'OK' : `FAIL（${ping.detail}）`} ${formatDuration(ping.durationMs)}`);
  if (!ping.ok) fail(logger, `无法连接 PostgreSQL：${ping.detail}`, EXIT_PRECONDITION);

  const exists = await resolved.client.databaseExists(targetArg);
  logger.raw(`目标库状态  ：${exists ? '已存在' : '不存在（将新建）'}`);
  if (exists && !reuseExisting && !effectiveDryRun) {
    fail(logger, `目标库 "${targetArg}" 已存在：默认拒绝复用（--reuse-existing 可覆盖，或换一个库名）`, EXIT_PRECONDITION);
  }

  if (effectiveDryRun) {
    printCredentialCheckInstructions(logger, targetArg, stats);
    logger.raw('');
    logger.raw('dry-run 结论：前置检查通过（未创建/未写入任何库）。加 --confirm 执行真实恢复。');
    process.exit(EXIT_OK);
  }

  // ================= 真实恢复 =================
  mkdirSync(outDir, { recursive: true });
  const createdByUs = !exists;
  let restored = false;
  const report: Record<string, unknown> = {
    tool: 'm10-restore',
    startedAt: new Date().toISOString(),
    mode: resolved.mode,
    source: target.redacted,
    dump: { path: dumpPath, bytes: dumpBytes, stats },
    target: targetArg,
    createdByUs,
    steps: [] as { name: string; ok: boolean; detail: string; ms?: number }[],
  };
  const steps = report.steps as { name: string; ok: boolean; detail: string; ms?: number }[];

  try {
    if (createdByUs) {
      logger.step(`新建临时库 ${targetArg}（TEMPLATE template0）`);
      await resolved.client.createDatabase(targetArg);
      steps.push({ name: 'create-database', ok: true, detail: `CREATE DATABASE ${targetArg} TEMPLATE template0` });
    } else {
      logger.warn(`复用已存在的库 ${targetArg}：备份里的 DROP/CREATE 会重建其中的对象（--reuse-existing 已给出）`);
      steps.push({ name: 'create-database', ok: true, detail: '目标库已存在且 --reuse-existing 已给出，跳过建库' });
    }

    // ---- 回灌（psql -v ON_ERROR_STOP=1；任何 SQL 失败立即非 0）----
    logger.step('回灌 SQL（ON_ERROR_STOP=1：任一语句失败立即中断）');
    const input = dumpPath.endsWith('.gz') ? createReadStream(dumpPath).pipe(createGunzip()) : createReadStream(dumpPath);
    // 读流错误（截断的 .gz 等）必须有监听者：否则 Node 会把 'error' 抛成未捕获异常（进程直接崩）
    input.on('error', (err: Error) => logger.error(`读取备份流失败（psql 会因输入截断而失败）：${err.message}`));
    const load = await resolved.client.loadScript(targetArg, input, Number(v['timeout-ms']));
    if (load.code !== 0) {
      steps.push({ name: 'load', ok: false, detail: `psql 退出码 ${load.code}：${load.stderr.trim().slice(0, 400)}` });
      throw new Error(`回灌失败（psql 退出码 ${load.code}）：${load.stderr.trim().slice(0, 400)}`);
    }
    steps.push({ name: 'load', ok: true, detail: `psql ON_ERROR_STOP=1 退出码 0，stderr ${load.stderr.length} 字节`, ms: load.durationMs });
    logger.info(`回灌完成：${formatDuration(load.durationMs)}，stderr ${load.stderr.length} 字节`);
    restored = true;

    // ---- 校验 A：指纹 ----
    logger.step('校验 A：schema 指纹（表/列/索引/枚举/外键/迁移/扩展）');
    const fp = await resolved.client.fingerprint(targetArg);
    logger.raw(`  指纹：${Object.entries(fp).map(([k, val]) => `${k}=${val}`).join('  ')}`);
    const fpTables = Number(fp.tables);
    const fpOk = fpTables === stats.tables && Number(fp.prisma_migrations) === (stats.migrationsRows ?? 0);
    steps.push({
      name: 'fingerprint',
      ok: fpOk,
      detail: `表 ${fp.tables}（dump ${stats.tables}）/ 迁移行 ${fp.prisma_migrations}（dump ${String(stats.migrationsRows)}）/ 列 ${fp.columns} / 索引 ${fp.indexes} / 枚举 ${fp.enums} / 外键 ${fp.fks} / 扩展 ${fp.extensions}`,
    });

    // ---- 校验 B：逐表行数（与 dump 的 COPY 段比）----
    const actual = await resolved.client.tableRowCounts(targetArg);
    const expected: Record<string, number> = {};
    for (const [table, rows] of Object.entries(stats.rowCounts)) {
      if (table === 'public') continue; // 个别版本会多出一个空 key，忽略
      expected[table] = rows;
    }
    let rowDiffs: { table: string; expected: number; actual: number }[] = [];
    if (v['skip-rowcount-all'] === true) {
      for (const { table } of KEY_TABLES) {
        if (expected[table] !== undefined) rowDiffs.push({ table, expected: expected[table], actual: actual[table] ?? -1 });
      }
      logger.raw('  全表比对已跳过（--skip-rowcount-all）：仅比对关键表');
    } else {
      rowDiffs = compareRowCounts(expected, actual);
    }
    const rowDiffsReal = rowDiffs.filter((d) => d.actual !== d.expected);
    steps.push({
      name: 'row-counts',
      ok: rowDiffsReal.length === 0,
      detail:
        rowDiffsReal.length === 0
          ? `比对 ${v['skip-rowcount-all'] === true ? KEY_TABLES.length : Object.keys(expected).length} 张表全部一致；恢复库合计 ${Object.values(actual).reduce((a, b) => a + b, 0)} 行 == dump ${stats.totalRows} 行`
          : `${rowDiffsReal.length} 张表行数不一致：${rowDiffsReal.slice(0, 10).map((d) => `${d.table}(${d.expected}→${d.actual})`).join(', ')}`,
    });

    // ---- 校验 C：关键表点名 + 业务冒烟 ----
    const keyTableReport: Record<string, { dump: number; restored: number }> = {};
    for (const { table } of KEY_TABLES) {
      keyTableReport[table] = { dump: expected[table] ?? -1, restored: actual[table] ?? -1 };
    }
    const keyMismatch = Object.entries(keyTableReport).filter(([, r]) => r.dump !== r.restored);
    steps.push({
      name: 'key-tables',
      ok: keyMismatch.length === 0,
      detail: Object.entries(keyTableReport).map(([t, r]) => `${t}: dump=${r.dump} restored=${r.restored}`).join('  '),
    });

    const verdict = steps.every((s) => s.ok);
    report.finishedAt = new Date().toISOString();
    report.verdict = verdict ? 'PASS' : 'FAIL';
    report.rowCounts = { dumpTotal: stats.totalRows, restoredTotal: Object.values(actual).reduce((a, b) => a + b, 0) };
    report.keyTables = keyTableReport;
    report.totalMs = Date.now() - startedAll;

    const reportPath = resolve(outDir, `restore-${targetArg}-${stamp()}.report.json`);
    writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    logger.raw('');
    logger.raw(`=== 恢复校验结果：${verdict ? 'PASS' : 'FAIL'} ===`);
    for (const s of steps) logger.raw(`  [${s.ok ? 'ok' : 'FAIL'}] ${s.name} — ${s.detail}`);
    logger.raw(`恢复报告：${reportPath}`);

    printCredentialCheckInstructions(logger, targetArg, stats);

    if (!keep) {
      logger.step(`清理：DROP DATABASE ${targetArg}`);
      await resolved.client.dropDatabase(targetArg);
      restored = false;
      logger.info('临时库已销毁（--keep 可保留）');
    } else {
      logger.warn(`临时库 ${targetArg} 已保留——请人工销毁，避免占用磁盘/连接数`);
    }

    if (!verdict) {
      logger.error('恢复校验未通过：该备份不可信，请换更早的备份并记录失败项');
      process.exit(EXIT_VERIFY);
    }
    logger.info(`恢复演练成功（总耗时 ${formatDuration(Date.now() - startedAll)}）`);
    process.exit(EXIT_OK);
  } catch (err) {
    report.finishedAt = new Date().toISOString();
    report.verdict = 'ERROR';
    report.error = err instanceof Error ? err.message : String(err);
    const reportPath = resolve(outDir, `restore-${targetArg}-${stamp()}.report.json`);
    try {
      writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
      logger.raw(`恢复报告：${reportPath}`);
    } catch {
      /* 报告写不进去不掩盖原始错误 */
    }
    if (restored && !keep) {
      logger.warn(`保留失败的临时库 ${targetArg} 供人工排查（避免"删证据"）；确认后用 psql 手工 DROP`);
    }
    fail(logger, `恢复失败：${err instanceof Error ? err.message : String(err)}`, EXIT_FAIL);
  }
}

/** 恢复后凭证解密抽查：**只给步骤与只读计数**，不自动解密（需 ENCRYPTION_KEY 与应用上下文）。 */
function printCredentialCheckInstructions(
  logger: ReturnType<typeof createLogger>,
  targetDb: string,
  stats: DumpStats,
): void {
  const credentialRows = stats.rowCounts.Credential ?? 0;
  const connectionRows = stats.rowCounts.Connection ?? 0;
  logger.raw('');
  logger.raw('=== 恢复后必做：凭证解密抽查（ENCRYPTION_KEY 正确性的唯一证明） ===');
  logger.raw(`备份里的密文行数：Connection=${connectionRows}  Credential=${credentialRows}`);
  logger.raw('步骤（在**恢复出来的库**上做，不要在源库上做）：');
  logger.raw(`  1) 临时把 DATABASE_URL 指向目标库：DATABASE_URL=.../${targetDb}（或只读连过去）`);
  logger.raw('  2) 用与生产一致的 ENCRYPTION_KEY 起一个 Node 进程，调用 CryptoService.decrypt 解一条 Credential.encryptedValue');
  logger.raw('     —— 参考实现：apps/api/src/core/crypto/crypto.service.ts（AES-256-GCM，keyVersion 见 M10-P1）');
  logger.raw('  3) 解密成功 ⇒ ENCRYPTION_KEY 正确；抛错（auth tag 校验失败）⇒ 密钥不对，凭证全部作废，必须立刻停下来取回正确密钥');
  logger.raw('  4) 核对解密出的 token 能通过 provider 的健康检查（可选，涉及外部网络）');
  logger.raw('注意：这一步**不能**用"能不能登录"替代——登录只证明 JWT_SECRET 正确。');
}

async function resolveClient(
  requested: string,
  container: string,
  clientDir: string | undefined,
  target: ReturnType<typeof parseDatabaseUrl>,
  logger: ReturnType<typeof createLogger>,
  failFn: typeof fail,
): Promise<{ mode: PgMode; client: PgClient }> {
  const mode = requested.toLowerCase();
  if (!['auto', 'docker', 'direct'].includes(mode)) failFn(logger, `--pg-mode 只能是 auto|docker|direct，收到 "${requested}"`, EXIT_USAGE);
  const mk = (m: PgMode) => new PgClient({ target, mode: m, container, clientBinDir: clientDir });
  if (mode !== 'auto') return { mode: mode as PgMode, client: mk(mode as PgMode) };
  try {
    const direct = mk('direct');
    await direct.version();
    return { mode: 'direct', client: direct };
  } catch {
    const docker = mk('docker');
    try {
      await docker.version();
      return { mode: 'docker', client: docker };
    } catch (err) {
      failFn(
        logger,
        `找不到可用的 psql/pg_dump（直连与 docker exec ${container} 均失败）：${(err as Error).message}\n` +
          '  提示：本机开发用 --pg-container <name>（docker ps 查名）；生产用 --pg-mode direct。',
        EXIT_PRECONDITION,
      );
    }
  }
}

void main().catch((err) => {
  process.stderr.write(`restore.ts 未捕获异常：${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
  process.exit(EXIT_FAIL);
});
