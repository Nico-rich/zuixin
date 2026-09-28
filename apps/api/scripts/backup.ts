/**
 * M10-P9 运维脚本：PostgreSQL 全库逻辑备份（一致性快照 + 内容校验 + manifest + 可选远端归档）。
 *
 * 来源：`docs/operations/m8-disaster-recovery.md` §3.1/§3.3/§3.4 的手工命令脚本化（审计 DR-13/PR-6）。
 *
 * 设计要点（与手册逐条对应）：
 * - **只读**：`pg_dump` 不修改源库（本脚本对生产/开发库绝对安全）；
 * - **一致性**：pg_dump 单事务 repeatable-read 快照（参数见 lib/dump.ts 的 PG_DUMP_CONSISTENCY_ARGS）；
 * - **不信"非空文件"**：必须解析产物内容（表数/COPY 段/行数）并与期望比对，失败即非 0 退出；
 * - **manifest**：把"备份是否可信"变成机器可读事实（编排/告警读 checks）；
 * - **幂等**：同名备份（同 label + 同秒）默认拒绝覆盖；`--force` 才允许；
 * - **不碰密钥**：连接串只回显脱敏形式；`.env` 只报存在性（RPO=0 清单）。
 *
 * 用法：`cd apps/api && npx tsx scripts/backup.ts --help`
 */

import { createGzip } from 'node:zlib';
import { createReadStream, createWriteStream, existsSync, mkdirSync, readdirSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { createInterface } from 'node:readline';
import { hostname } from 'node:os';
import { resolve } from 'node:path';

import {
  DEFAULT_EXIT_CODES, EXIT_FAIL, EXIT_OK, EXIT_PRECONDITION, EXIT_USAGE, EXIT_VERIFY,
  commandExists, createLogger, fail, formatBytes, formatDuration, run, sha256File, stamp,
} from './lib/cli';
import { RPO_ZERO_SECRET_KEYS, envFileMeta, findEnvBackupCopies, loadEnv, parseDatabaseUrl, secretPresence, storageConfigFromEnv } from './lib/env';
import { buildPgDumpArgs, createDumpStatsCollector, verifyDumpStats, type DumpStats } from './lib/dump';
import { KEY_TABLES, PgClient, type PgMode } from './lib/pg';
import { MANIFEST_TOOL, MANIFEST_VERSION, backupFileName, buildBackupManifest, manifestSummaryLines, manifestVerdict } from './lib/manifest';
import { McClient, parseMcListJson, safeMcError } from './lib/mc';
import { helpText, parseArgs, type FlagSpec } from './lib/args';

const SCRIPT = 'backup.ts';
const SPECS: readonly FlagSpec[] = [
  { name: 'out-dir', alias: 'o', type: 'string', valueName: '<dir>', help: '备份输出目录（默认 $BACKUP_DIR 或 <仓库根>/backup）' },
  { name: 'label', type: 'string', valueName: '<tag>', help: '备份标签（写进文件名，如 pre-migration / drill）' },
  { name: 'env-file', type: 'string', valueName: '<path>', help: 'env 文件路径（默认按 cwd/.env → <仓库根>/.env 搜索）' },
  { name: 'pg-mode', type: 'string', valueName: '<auto|docker|direct>', default: 'auto', help: 'pg 客户端来源：docker exec 容器 / 直连 / 自动探测' },
  { name: 'pg-container', type: 'string', valueName: '<name>', default: 'docker-postgres-1', help: 'docker 模式下的 PostgreSQL 容器名' },
  { name: 'pg-client-dir', type: 'string', valueName: '<dir>', help: 'direct 模式下 pg_dump/psql 所在目录（默认走 PATH）' },
  { name: 'expect-tables', type: 'number', valueName: '<n>', help: '期望表数（校验用；不传则只做内部一致性校验）' },
  { name: 'min-rows', type: 'number', valueName: '<n>', default: 0, help: '数据行下限（默认 0；演练可传实际值的 90%）' },
  { name: 'keep-plain', type: 'boolean', help: '保留未压缩的 .sql（默认压缩后删除明文，节省磁盘）' },
  { name: 'no-compress', type: 'boolean', help: '不压缩（只留 .sql；大库慎用）' },
  { name: 'gzip-level', type: 'number', valueName: '<0-9>', default: 6, help: 'gzip 级别（默认 6：体积/耗时平衡）' },
  { name: 'force', type: 'boolean', help: '允许覆盖同名备份（默认拒绝，防手滑覆盖当日备份）' },
  { name: 'prune', type: 'boolean', help: '执行保留策略清理（默认只提示不删除）' },
  { name: 'prune-keep', type: 'number', valueName: '<n>', default: 30, help: '保留最近 N 份备份（默认 30，与 DR 手册 §3.4 一致）' },
  { name: 'upload', type: 'boolean', help: '把备份上传到 MinIO（mc 一次性容器；默认关闭）' },
  { name: 'bucket', type: 'string', valueName: '<name>', default: 'db-backups', help: '远端归档桶（默认 db-backups，**不要**与对象存储业务桶混用）' },
  { name: 'prefix', type: 'string', valueName: '<path>', default: 'postgres/', help: '远端归档前缀（默认 postgres/）' },
  { name: 'mc-mode', type: 'string', valueName: '<docker|native>', default: 'docker', help: 'mc 运行形态（默认 docker）' },
  { name: 'mc-network', type: 'string', valueName: '<net>', default: 'container:docker-minio-1', help: 'mc 容器的 network（默认复用 minio 容器网络）' },
  { name: 'mc-image', type: 'string', valueName: '<image>', default: 'quay.io/minio/mc:latest', help: 'mc 镜像' },
  { name: 'env-backup-dir', type: 'string', valueName: '<dir>', help: '人工存放 .env 副本的目录（默认 <out-dir>/env；只做存在性提醒）' },
  { name: 'dry-run', type: 'boolean', help: '只打印计划与前置检查，不执行 pg_dump' },
];

interface Resolved {
  mode: PgMode;
  client: PgClient;
}

async function resolvePgClient(opts: {
  requested: string;
  container: string;
  clientDir?: string;
  target: ReturnType<typeof parseDatabaseUrl>;
  logger: ReturnType<typeof createLogger>;
}): Promise<Resolved> {
  const requested = opts.requested.toLowerCase();
  if (!['auto', 'docker', 'direct'].includes(requested)) {
    fail(opts.logger, `--pg-mode 只能是 auto|docker|direct，收到 "${opts.requested}"`, EXIT_USAGE);
  }
  const mkClient = (mode: PgMode) =>
    new PgClient({ target: opts.target, mode, container: opts.container, clientBinDir: opts.clientDir });

  if (requested === 'docker') return { mode: 'docker', client: mkClient('docker') };
  if (requested === 'direct') return { mode: 'direct', client: mkClient('direct') };

  // auto：宿主机有 pg_dump 就直连，否则退到 docker exec 容器内客户端
  if (await commandExists(opts.clientDir ? `${opts.clientDir}/pg_dump` : 'pg_dump')) {
    return { mode: 'direct', client: mkClient('direct') };
  }
  const dockerProbe = await run('docker', ['exec', opts.container, 'pg_dump', '--version'], { quiet: true, timeoutMs: 20_000 });
  if (!dockerProbe.spawnError && dockerProbe.code === 0) return { mode: 'docker', client: mkClient('docker') };

  fail(
    opts.logger,
    `找不到可用的 pg 客户端：宿主机无 pg_dump，且 docker exec ${opts.container} 不可用` +
      `（docker 输出：${(dockerProbe.spawnError ?? dockerProbe.stderr).trim().slice(0, 200)}）\n` +
      '  提示：本机开发环境请确认容器名（docker ps），或用 --pg-mode docker --pg-container <name>；生产请用 --pg-mode direct。',
    EXIT_PRECONDITION,
  );
}

/** 流式统计 dump 内容（GB 级文件也不吃内存）。 */
async function collectStats(file: string): Promise<DumpStats> {
  const collector = createDumpStatsCollector();
  const rl = createInterface({ input: createReadStream(file), crlfDelay: Infinity });
  for await (const line of rl) collector.pushLine(line);
  return collector.finish();
}

async function gzipFile(src: string, dst: string, level: number): Promise<void> {
  await pipeline(createReadStream(src), createGzip({ level }), createWriteStream(dst));
}

/** 保留策略：只删本脚本自己产出的、且超出保留份数的文件（默认 dry-run，需 --prune 才真删）。 */
function pruneBackups(
  outDir: string,
  database: string,
  keep: number,
  logger: ReturnType<typeof createLogger>,
  apply: boolean,
): { scanned: number; removed: string[] } {
  const names = readdirSync(outDir).filter((n) => n.startsWith(`${database}-`) || n.startsWith(`${database}.-`));
  const sets = new Map<string, string[]>();
  for (const name of names) {
    const m = /^(.*)-(\d{8}-\d{6})\.(?:sql|sql\.gz|manifest\.json)$/.exec(name);
    if (!m) continue;
    const key = `${m[1]}-${m[2]}`;
    sets.set(key, [...(sets.get(key) ?? []), name]);
  }
  const ordered = [...sets.keys()].sort().reverse(); // 时间戳字典序 == 时间序
  const victims = ordered.slice(keep);
  const removed: string[] = [];
  for (const key of victims) {
    for (const name of sets.get(key) ?? []) {
      if (apply) {
        try {
          unlinkSync(resolve(outDir, name));
        } catch (err) {
          logger.warn(`删除失败（跳过）：${name} — ${(err as Error).message}`);
          continue;
        }
      }
      removed.push(name);
    }
  }
  return { scanned: sets.size, removed };
}

function printEnvReminder(
  logger: ReturnType<typeof createLogger>,
  report: { file?: string; sources: Record<string, 'process' | 'file'> },
  envBackupDir: string,
): void {
  logger.raw('');
  logger.raw('=== RPO=0 密钥清单（.env **不在**任何自动备份里） ===');
  if (report.file) {
    const meta = envFileMeta(report.file);
    logger.raw(`env 文件：${meta.path}（大小 ${meta.sizeBytes} 字节，mtime=${meta.mtime}，约 ${meta.ageDays} 天前）`);
  } else {
    logger.raw('env 文件：未找到（只使用了进程环境变量——生产/容器里这是正常形态）');
  }
  const presence = secretPresence(RPO_ZERO_SECRET_KEYS.map((k) => k.key), report.sources);
  for (const { key, why } of RPO_ZERO_SECRET_KEYS) {
    const p = presence[key];
    const mark = !p.present ? '缺失' : p.source === 'default-placeholder' ? '占位符(!)' : '已配置';
    logger.raw(`  [${mark}] ${key.padEnd(26)} 长度=${p.length.toString().padStart(3)}  ${why}`);
  }
  const copies = findEnvBackupCopies(envBackupDir);
  logger.raw(`env 副本目录：${envBackupDir} — 找到 ${copies.length} 份${copies.length ? `（最新：${copies.sort((a, b) => b.mtime.localeCompare(a.mtime))[0].path}）` : '（建议立刻放一份**加密**副本）'}`);
  logger.raw('提醒：本脚本只备份数据库；ENCRYPTION_KEY/JWT_SECRET 必须另有可用副本（Vault/KMS/K8s Secret），');
  logger.raw('      丢失 ENCRYPTION_KEY ⇒ 已加密凭证永久不可解（见 runbook §2「密钥备份/取回」）。');
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
        summary: 'PostgreSQL 全库一致性逻辑备份（pg_dump → 内容校验 → gzip → manifest → 可选远端归档）',
        specs: SPECS,
        notes: [
          'pg_dump 只读，不对源库做任何写入；一致性由 pg_dump 单事务快照保证。',
          '校验口径：解析 dump 自身的 CREATE TABLE / COPY 段与行数——"非空文件"不等于"可用备份"。',
          '本脚本不做 PITR（需 WAL 归档）；RPO = 备份时刻（DR 手册 §1）。',
          '默认不执行保留策略清理（--prune 才删），且只删本脚本命名规则的产物。',
        ],
        examples: [
          'npx tsx scripts/backup.ts --dry-run',
          'npx tsx scripts/backup.ts --label daily',
          'npx tsx scripts/backup.ts --label pre-migration --expect-tables 73',
          'npx tsx scripts/backup.ts --label offsite --upload --bucket db-backups',
          'BACKUP_DIR=D:/backups npx tsx scripts/backup.ts --prune --prune-keep 14',
        ],
        exitCodes: DEFAULT_EXIT_CODES,
      }),
    );
    process.exit(EXIT_OK);
  }
  const args = parsed.parsed;
  const v = args.values;
  const logger = createLogger('backup');
  const startedAll = Date.now();

  // ---- env / 目标 ----
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
    fail(logger, `${(err as Error).message}（用 --env-file 指定 env 文件）`, EXIT_PRECONDITION);
  }
  const outDir = resolve(
    (v['out-dir'] as string | undefined) ?? process.env.BACKUP_DIR ?? resolve(__dirname, '../../../backup'),
  );
  const envBackupDir = resolve((v['env-backup-dir'] as string | undefined) ?? resolve(outDir, 'env'));
  const label = v.label as string | undefined;
  const ts = stamp();
  const plainName = backupFileName({ database: target.database, stamp: ts, label });
  const plainPath = resolve(outDir, plainName);
  const gzPath = `${plainPath}.gz`;
  const manifestPath = resolve(outDir, `${plainName.replace(/\.sql$/, '')}.manifest.json`);
  const compress = v['no-compress'] !== true;
  const keepPlain = v['keep-plain'] === true || !compress;
  const expectTables = v['expect-tables'] as number | undefined;
  const minRows = v['min-rows'] as number;

  logger.raw('');
  logger.raw('=== M10-P9 备份计划 ===');
  logger.raw(`源库        ：${target.redacted}`);
  logger.raw(`输出目录    ：${outDir}`);
  logger.raw(`备份文件    ：${plainName}${compress ? ' → 追加 .gz' : '（不压缩）'}`);
  logger.raw(`manifest    ：${manifestPath}`);
  logger.raw(`env 文件    ：${envReport.file ?? '（未找到，仅用进程环境）'}`);
  logger.raw(`压缩        ：${compress ? `gzip -${v['gzip-level']}` : '关闭'}；明文保留：${keepPlain ? '是' : '否'}`);
  logger.raw(`校验期望    ：表数 ${expectTables ?? '（自动/内部一致性）'}，数据行下限 ${minRows}`);

  const resolved = await resolvePgClient({
    requested: String(v['pg-mode']),
    container: String(v['pg-container']),
    clientDir: v['pg-client-dir'] as string | undefined,
    target,
    logger,
  });
  logger.raw(`pg 客户端   ：${resolved.mode} — ${resolved.client.description}`);

  if (v['dry-run'] === true) {
    logger.step('dry-run：只做前置检查（连通性 + 客户端版本 + 输出目录可写），不执行 pg_dump');
    const ping = await resolved.client.ping();
    logger.raw(`连通性      ：${ping.ok ? 'OK' : `FAIL（${ping.detail}）`} ${formatDuration(ping.durationMs)}`);
    let version = 'unknown';
    try {
      version = await resolved.client.version();
    } catch (err) {
      logger.warn(`读取 pg_dump 版本失败：${(err as Error).message}`);
    }
    logger.raw(`pg_dump     ：${version}`);
    if (existsSync(plainPath) && v.force !== true) {
      fail(logger, `目标文件已存在（--force 可覆盖）：${plainPath}`, EXIT_PRECONDITION);
    }
    if (!existsSync(outDir)) logger.raw(`输出目录    ：不存在，将在正式执行时创建`);
    printEnvReminder(logger, envReport, envBackupDir);
    logger.raw('');
    logger.raw('dry-run 结论：前置检查通过（未做任何备份）。去掉 --dry-run 执行真实备份。');
    process.exit(ping.ok ? EXIT_OK : EXIT_PRECONDITION);
  }

  // ---- 前置：目标文件冲突（幂等保护）----
  if (existsSync(plainPath) && v.force !== true) {
    fail(logger, `目标文件已存在，拒绝覆盖（--force 可覆盖）：${plainPath}`, EXIT_PRECONDITION);
  }
  mkdirSync(outDir, { recursive: true });
  mkdirSync(envBackupDir, { recursive: true });

  // ---- 1) dump（流式落盘：不把大库读进内存）----
  logger.step(`执行 pg_dump（只读，单事务一致性快照）→ ${plainName}`);
  const dumpArgs = buildPgDumpArgs({ user: target.user, database: target.database });
  const dumpRes = await resolved.client.exec(dumpArgs, { quiet: false, timeoutMs: 3_600_000, stdoutToFile: plainPath });
  const dumpMs = dumpRes.durationMs;
  if (dumpRes.code !== 0 || dumpRes.spawnError) {
    if (existsSync(plainPath)) rmSync(plainPath); // 不留半截产物（半截文件最容易被误当成备份）
    fail(
      logger,
      `pg_dump 失败（退出码 ${dumpRes.code}）：${(dumpRes.spawnError ?? dumpRes.stderr).trim().slice(0, 500)}`,
      EXIT_FAIL,
    );
  }
  if (!existsSync(plainPath) || statSync(plainPath).size === 0) {
    fail(logger, 'pg_dump 输出为空（0 字节）——备份失败，拒绝继续', EXIT_FAIL);
  }
  const plainBytes = statSync(plainPath).size;
  if (dumpRes.stderr.trim()) logger.warn(`pg_dump stderr（非致命，需人工确认）：${dumpRes.stderr.trim().slice(0, 400)}`);
  logger.info(`pg_dump 完成：${formatBytes(plainBytes)} / ${formatDuration(dumpMs)}`);

  // ---- 2) 内容统计 ----
  logger.step('解析 dump 内容（表 / COPY 段 / 逐表行数 / 扩展）');
  const statsStarted = Date.now();
  const stats = await collectStats(plainPath);
  const statsMs = Date.now() - statsStarted;
  const keyTableRows: Record<string, number> = {};
  for (const { table } of KEY_TABLES) keyTableRows[table] = stats.rowCounts[table] ?? -1; // -1 = 备份里没有该表

  // ---- 3) 校验 ----
  const checks = verifyDumpStats(stats, { sizeBytes: plainBytes, expectTables, minRows });
  const failedChecks = checks.filter((c) => !c.ok);
  logger.info(`内容统计：表 ${stats.tables} / COPY 段 ${stats.copySegments} / 行 ${stats.totalRows} / 扩展 [${stats.extensions.join(',')}]`);
  for (const c of checks) logger.raw(`  [${c.ok ? 'ok' : 'FAIL'}] ${c.name} — ${c.detail}`);

  // ---- 4) 压缩 ----
  let gzBytes = 0;
  let gzSha256 = '';
  let compressMs = 0;
  if (compress) {
    logger.step(`gzip -${v['gzip-level']} 压缩`);
    const t0 = Date.now();
    await gzipFile(plainPath, gzPath, Number(v['gzip-level']));
    compressMs = Date.now() - t0;
    gzBytes = statSync(gzPath).size;
    gzSha256 = await sha256File(gzPath);
    logger.info(`压缩完成：${formatBytes(gzBytes)}（压缩比 ${(plainBytes / Math.max(gzBytes, 1)).toFixed(2)}x）/ ${formatDuration(compressMs)}`);
    if (!keepPlain) {
      rmSync(plainPath);
      logger.info('已删除明文 .sql（用 --keep-plain 保留）');
    }
  } else {
    gzBytes = plainBytes;
    gzSha256 = await sha256File(plainPath);
  }

  // ---- 5) 远端归档（可选；先传数据文件，manifest 生成后单独传）----
  const backupFileNameOnDisk = compress ? `${plainName}.gz` : plainName;
  let mc: McClient | null = null;
  let mcMounts: { hostPath: string; containerPath: string }[] = [];
  let mcDirRef = outDir;
  let remoteTarget = '';
  const uploaded: string[] = [];
  if (v.upload === true) {
    const storage = storageConfigFromEnv();
    if (!storage.accessKeyId || !storage.secretAccessKey) {
      fail(logger, '--upload 需要 STORAGE_ACCESS_KEY_ID / STORAGE_SECRET_ACCESS_KEY（见 .env）', EXIT_PRECONDITION);
    }
    const bucket = String(v.bucket);
    const prefix = String(v.prefix).replace(/\/?$/, '/');
    const mcMode = String(v['mc-mode']) === 'native' ? 'native' : 'docker';
    mc = new McClient({
      mode: mcMode,
      origin: storage.endpoint || 'http://localhost:9000',
      accessKey: storage.accessKeyId,
      secretKey: storage.secretAccessKey,
      image: String(v['mc-image']),
      network: String(v['mc-network']),
    });
    mcMounts = mc.mountFor(outDir, '/backup', mcMode);
    mcDirRef = mcMode === 'native' ? outDir : '/backup';
    remoteTarget = `${bucket}/${prefix}`;
    logger.step(`远端归档到 ${remoteTarget}（${mc.description}）`);
    const mk = await mc.makeBucket(bucket);
    if (mk.code !== 0) logger.warn(`建桶返回非 0（可能已存在）：${safeMcError(mk)}（未阻断）`);
    const cp = await mc.exec(['cp', `${mcDirRef}/${backupFileNameOnDisk}`, `${mc.ref(bucket)}/${prefix}${backupFileNameOnDisk}`], {
      mounts: mcMounts,
      timeoutMs: 3_600_000,
    });
    if (cp.code !== 0) fail(logger, `上传失败 ${backupFileNameOnDisk}：${safeMcError(cp)}`, EXIT_FAIL);
    // 远端体积核对（截断上传是静默事故的常见形态；哈希留给 minio-mirror.ts 的抽样校验）
    const ls = await mc.list(`${mc.ref(bucket)}/${prefix}${backupFileNameOnDisk}`, { mounts: mcMounts });
    const remoteSummary = parseMcListJson(ls.stdout);
    const expected = compress ? gzBytes : plainBytes;
    if (remoteSummary.totalBytes !== expected) {
      fail(
        logger,
        `远端对象体积不符：期望 ${expected} 字节，实际 ${remoteSummary.totalBytes} 字节（${mc.ref(bucket)}/${prefix}${backupFileNameOnDisk}）`,
        EXIT_VERIFY,
      );
    }
    uploaded.push(`${prefix}${backupFileNameOnDisk}`);
    logger.info(`远端已确认：${prefix}${backupFileNameOnDisk}（${formatBytes(remoteSummary.totalBytes)}）`);
  }

  // ---- 6) manifest ----
  const totalMs = Date.now() - startedAll;
  const manifest = buildBackupManifest({
    host: hostname(),
    database: target.database,
    source: target.redacted,
    pgVersion: await resolved.client.version().catch(() => 'unknown'),
    mode: resolved.mode,
    files: {
      plain: keepPlain ? plainPath : null,
      plainBytes,
      gz: compress ? gzPath : plainPath,
      gzBytes,
      gzSha256,
    },
    stats,
    checks,
    keyTableRows,
    secrets: secretPresence(),
    durations: { dumpMs, statsMs, compressMs, totalMs },
    remote: mc ? { kind: 'minio', target: remoteTarget, uploaded } : null,
    retentionHint: `建议保留 ${v['prune-keep']} 份（${v.prune === true ? '本次已执行清理' : '本次未清理，--prune 生效'}），异地留存见 runbook`,
  });
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

  // 数据文件已传完后，manifest 才定稿 ⇒ 单独补传（远端与本地内容一致）
  if (mc) {
    const manifestName = `${plainName.replace(/\.sql$/, '')}.manifest.json`;
    const cp = await mc.exec(['cp', `${mcDirRef}/${manifestName}`, `${mc.ref(String(v.bucket))}/${String(v.prefix).replace(/\/?$/, '/')}${manifestName}`], {
      mounts: mcMounts,
      timeoutMs: 600_000,
    });
    if (cp.code !== 0) fail(logger, `上传 manifest 失败：${safeMcError(cp)}`, EXIT_FAIL);
    uploaded.push(`${String(v.prefix).replace(/\/?$/, '/')}${manifestName}`);
    logger.info(`远端已确认：${uploaded[uploaded.length - 1]}`);
  }

  // ---- 7) 保留策略 ----
  if (v.prune === true) {
    const { scanned, removed } = pruneBackups(outDir, target.database, Number(v['prune-keep']), logger, true);
    logger.info(`保留策略：扫描 ${scanned} 份备份，删除 ${removed.length} 份（保留最近 ${v['prune-keep']} 份）`);
  } else {
    const { removed } = pruneBackups(outDir, target.database, Number(v['prune-keep']), logger, false);
    if (removed.length) logger.warn(`保留策略：有 ${removed.length} 份超出保留数（未删除；加 --prune 执行）：${removed.slice(0, 5).join(', ')}`);
  }

  // ---- 8) 摘要 + RPO=0 清单 ----
  logger.raw('');
  logger.raw(`=== ${MANIFEST_TOOL} v${MANIFEST_VERSION} 备份结果 ===`);
  for (const line of manifestSummaryLines(manifest)) logger.raw(line);
  printEnvReminder(logger, envReport, envBackupDir);
  logger.raw(`manifest：${manifestPath}`);

  const verdict = manifestVerdict(manifest);
  if (!verdict.ok || failedChecks.length > 0) {
    logger.error(`备份校验未通过（${verdict.failed.join(', ')}）——请勿把该文件当作可用备份`);
    process.exit(EXIT_VERIFY);
  }
  logger.info(`备份成功且校验通过（总耗时 ${formatDuration(totalMs)}）`);
  process.exit(EXIT_OK);
}

void main().catch((err) => {
  process.stderr.write(`backup.ts 未捕获异常：${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
  process.exit(EXIT_FAIL);
});
