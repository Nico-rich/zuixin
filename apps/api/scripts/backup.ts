/**
 * M10-P9 运维脚本：PostgreSQL 全库逻辑备份（一致性快照 + 内容校验 + 可选静态加密 + manifest + 可选远端归档）。
 *
 * 来源：`docs/operations/m8-disaster-recovery.md` §3.1/§3.3/§3.4 的手工命令脚本化（审计 DR-13/PR-6）。
 *
 * 设计要点（与手册逐条对应）：
 * - **只读**：`pg_dump` 不修改源库（本脚本对生产/开发库绝对安全）；
 * - **一致性**：pg_dump 单事务 repeatable-read 快照（参数见 lib/dump.ts 的 PG_DUMP_CONSISTENCY_ARGS）；
 * - **不信"非空文件"**：必须解析产物内容（表数/COPY 段/行数）并与期望比对，失败即非 0 退出；
 * - **静态加密（M11-P9/D1-13）**：`--encrypt gpg` 在 gzip 之后再加一层 gpg（对称或公钥）。
 *   压缩不是加密：备份常要出仓库（异地桶/离线介质/工单附件），明文 dump 含用户数据与凭证密文。
 *   口令只经环境变量 → **stdin** 交给 gpg，绝不进 argv/日志；加密后**立刻解密回读比对 sha256**——
 *   "加完解不开"的备份等于没有备份，这一条是自检而不是可选项（失败即退出码 3 且不删明文产物）；
 * - **远端核对**：上传后用 `mc stat` 比对体积与 ETag（单段对象 ETag == 内容 md5）——零传输的内容级核对；
 * - **manifest**：把"备份是否可信/是否加密"变成机器可读事实（编排/告警读 checks 与 encryption）；
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
  commandExists, createLogger, fail, formatBytes, formatDuration, md5File, run, sha256File, sha256Stream, stamp,
} from './lib/cli';
import { RPO_ZERO_SECRET_KEYS, envFileMeta, findEnvBackupCopies, loadEnv, parseDatabaseUrl, secretPresence, storageConfigFromEnv } from './lib/env';
import { buildPgDumpArgs, createDumpStatsCollector, verifyDumpStats, type BackupCheck, type DumpStats } from './lib/dump';
import { KEY_TABLES, PgClient, type PgMode } from './lib/pg';
import { MANIFEST_TOOL, MANIFEST_VERSION, backupFileName, buildBackupManifest, manifestSummaryLines, manifestVerdict } from './lib/manifest';
import { McClient, parseMcListJson, parseMcStatJson, etagAsMd5, safeMcError } from './lib/mc';
import { assessPlaintextUpload } from './lib/upload-gate';
import { openArtifactStream, planRetention, type Compression, type Encryption } from './lib/artifact';
import { GPG_CIPHER_ALGO, GPG_PASSPHRASE_ENV, describeGpgMode, encryptFile, gpgPreflight, type GpgMode } from './lib/gpg';
import { helpText, parseArgs, type FlagSpec } from './lib/args';

const SCRIPT = 'backup.ts';
const SPECS: readonly FlagSpec[] = [
  { name: 'out-dir', alias: 'o', type: 'string', valueName: '<dir>', help: '备份输出目录（默认 $BACKUP_DIR 或 <仓库根>/backup）' },
  { name: 'label', type: 'string', valueName: '<tag>', help: '备份标签（写进文件名，如 pre-migration / drill）' },
  { name: 'env-file', type: 'string', valueName: '<path>', help: 'env 文件路径（默认按 cwd/.env → <仓库根>/.env 搜索）' },
  { name: 'pg-mode', type: 'string', valueName: '<auto|docker|direct>', default: 'auto', help: 'pg 客户端来源：docker exec 容器 / 直连 / 自动探测' },
  { name: 'pg-container', type: 'string', valueName: '<name>', default: 'docker-postgres-1', help: 'docker 模式下的 PostgreSQL 容器名' },
  { name: 'pg-client-dir', type: 'string', valueName: '<dir>', help: 'direct 模式下 pg_dump/psql 所在目录（默认走 PATH）' },
  { name: 'expect-tables', type: 'number', valueName: '<n>', help: '期望表数（校验用；不传则只做内部一致性校验）。**随迁移递增，务必用当前真实表数**（M11 为 88）' },
  { name: 'min-rows', type: 'number', valueName: '<n>', default: 0, help: '数据行下限（默认 0；演练可传实际值的 90%）' },
  { name: 'keep-plain', type: 'boolean', help: '保留未压缩的 .sql（默认压缩后删除明文，节省磁盘）' },
  { name: 'no-compress', type: 'boolean', help: '不压缩（只留 .sql；大库慎用）' },
  { name: 'gzip-level', type: 'number', valueName: '<0-9>', default: 6, help: 'gzip 级别（默认 6：体积/耗时平衡）' },
  { name: 'encrypt', type: 'string', valueName: '<none|gpg>', default: 'none', help: '静态加密（默认 none；gpg = gpg 对称/公钥加密；口令只经环境变量 BACKUP_GPG_PASSPHRASE → stdin）' },
  { name: 'encrypt-recipient', type: 'string', valueName: '<keyid|email>', help: '改用**公钥**加密（需 --encrypt gpg；公钥须已在 keyring 里，运维机不需要口令）' },
  { name: 'force', type: 'boolean', help: '允许覆盖同名备份（默认拒绝，防手滑覆盖当日备份）' },
  { name: 'prune', type: 'boolean', help: '执行保留策略清理（默认只提示不删除）' },
  { name: 'prune-keep', type: 'number', valueName: '<n>', default: 30, help: '保留最近 N 份备份（默认 30，与 DR 手册 §3.4 一致）' },
  { name: 'upload', type: 'boolean', help: '把备份上传到 MinIO（mc 一次性容器；默认关闭）' },
  { name: 'allow-plaintext-upload', type: 'boolean', help: '**显式承认风险**：允许把未加密备份上传到非本机端点（不加则直接拒绝，退出码 4；本机端点如 localhost 自动放行）' },
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

/**
 * 幂等保护：同名产物（明文 / 归档产物 / manifest）已存在则拒绝（`--force` 才允许覆盖）。
 * dry-run 与真实执行走**同一个**函数——否则会出现"dry-run 说没事、真跑却覆盖了当日备份"。
 */
function assertNoExistingArtifact(
  logger: ReturnType<typeof createLogger>,
  paths: readonly string[],
  force: boolean,
  dryRun: boolean,
): void {
  const hit = paths.filter((p) => existsSync(p));
  if (hit.length === 0 || force) return;
  fail(logger, `目标文件已存在${dryRun ? '（--force 可覆盖）' : '，拒绝覆盖（--force 可覆盖）'}：${hit.join(', ')}`, EXIT_PRECONDITION);
}

/**
 * 保留策略：只删本脚本自己产出的、且超出保留份数的文件（默认 dry-run，需 --prune 才真删）。
 *
 * 分组键走 lib/artifact.ts 的 `backupSetKey()`（扩展名链解析），不再用"白名单正则"——
 * M11 加加密时正是白名单正则漏掉了新形态 `.sql.gz.gpg`，会让加密备份**永远不被回收**（磁盘悄悄涨满）。
 * 挑选逻辑（哪几套超期、每套删哪些文件）在 `planRetention()`，本函数只负责 unlink。
 */
function pruneBackups(
  outDir: string,
  database: string,
  keep: number,
  logger: ReturnType<typeof createLogger>,
  apply: boolean,
): { scanned: number; removed: string[]; setsRemoved: number; setNames: string[]; untouched: string[] } {
  // 归组/排序/挑选都是纯逻辑，放在 lib/artifact.ts 的 planRetention()（有单测）；
  // 这里只做 IO：读目录 + 按计划 unlink。
  const plan = planRetention(readdirSync(outDir), { database, keep });
  const removed: string[] = [];
  for (const name of plan.victimFiles) {
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
  if (plan.untouched.length) {
    logger.info(`保留策略：${plan.untouched.length} 个文件不匹配本脚本命名规则，未参与清理（原样保留）`);
  }
  return { scanned: plan.scannedSets, removed, setsRemoved: plan.victims.length, setNames: plan.victims, untouched: plan.untouched };
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
  logger.raw('      丢失 ENCRYPTION_KEY ⇒ 已加密凭证永久不可解（见 runbook §3「密钥备份/取回」）。');
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
        summary: 'PostgreSQL 全库一致性逻辑备份（pg_dump → 内容校验 → gzip → 可选 gpg 加密 → manifest → 可选远端归档）',
        specs: SPECS,
        notes: [
          'pg_dump 只读，不对源库做任何写入；一致性由 pg_dump 单事务快照保证。',
          '校验口径：解析 dump 自身的 CREATE TABLE / COPY 段与行数——"非空文件"不等于"可用备份"。',
          '静态加密（--encrypt gpg）：压缩不是加密。口令只经环境变量 BACKUP_GPG_PASSPHRASE 走 stdin，'
            + '绝不进 argv/日志；加密后立刻解密回读比对 sha256（失败 ⇒ 退出码 3 且**不删**明文产物，避免删掉唯一可用副本）。',
          '公钥模式（--encrypt-recipient）：加密只需公钥、解密只需私钥在 keyring，运维机不需要放口令（生产推荐）。',
          '--upload 在传完后用 mc stat 比对**体积 + ETag**（单段对象 ETag == 内容 md5，零传输的内容级核对）。',
          '明文外发闸门（M12-P5）：--upload + --encrypt none 且端点为非本机时，必须显式 --allow-plaintext-upload，'
            + '否则前置条件失败（退出码 4）；本机端点（localhost/127.0.0.1/::1）自动放行。--dry-run 也会做这项检查。',
          '本脚本不做 PITR（需 WAL 归档）；RPO = 备份时刻（DR 手册 §1）。',
          '默认不执行保留策略清理（--prune 才删），且只删本脚本命名规则的产物（含 .gpg 形态）。',
        ],
        examples: [
          'npx tsx scripts/backup.ts --dry-run',
          'npx tsx scripts/backup.ts --label daily',
          'npx tsx scripts/backup.ts --label pre-migration --expect-tables 88   # 88 = 当前真实表数，随迁移递增',
          'BACKUP_GPG_PASSPHRASE=$(pass show db-backup) npx tsx scripts/backup.ts --label daily --encrypt gpg',
          'npx tsx scripts/backup.ts --label offsite --encrypt gpg --encrypt-recipient ops@example.com --upload --bucket db-backups',
          'npx tsx scripts/backup.ts --label dev --upload   # 本机 MinIO（localhost）自动放行；非本机端点需 --allow-plaintext-upload',
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
  const compress = v['no-compress'] !== true;
  const keepPlain = v['keep-plain'] === true || !compress;
  const expectTables = v['expect-tables'] as number | undefined;
  const minRows = v['min-rows'] as number;

  // ---- 加密模式解析（**绝不静默降级为明文**：--encrypt gpg 给不出密钥就直接退出码 4）----
  const encryptArg = String(v.encrypt).toLowerCase();
  if (!['none', 'gpg'].includes(encryptArg)) {
    fail(logger, `--encrypt 只支持 none|gpg，收到 "${String(v.encrypt)}"`, EXIT_USAGE);
  }
  const recipient = (v['encrypt-recipient'] as string | undefined) ?? null;
  if (recipient && encryptArg !== 'gpg') fail(logger, '--encrypt-recipient 需要同时给出 --encrypt gpg', EXIT_USAGE);
  const encryption: Encryption = encryptArg === 'gpg' ? 'gpg' : 'none';
  const compression: Compression = compress ? 'gzip' : 'none';
  const gpgMode: { kind: GpgMode; recipient?: string | null } = recipient ? { kind: 'public-key', recipient } : { kind: 'symmetric' };
  const passphrase = encryption === 'gpg' && gpgMode.kind === 'symmetric' ? (process.env[GPG_PASSPHRASE_ENV] ?? null) : null;

  const plainName = backupFileName({ database: target.database, stamp: ts, label });
  const plainPath = resolve(outDir, plainName);
  const preEncryptionPath = resolve(outDir, backupFileName({ database: target.database, stamp: ts, label, compression }));
  const artifactName = backupFileName({ database: target.database, stamp: ts, label, compression, encryption });
  const artifactPath = resolve(outDir, artifactName);
  const manifestPath = resolve(outDir, `${plainName.replace(/\.sql$/, '')}.manifest.json`);

  logger.raw('');
  logger.raw('=== M10-P9 备份计划 ===');
  logger.raw(`源库        ：${target.redacted}`);
  logger.raw(`输出目录    ：${outDir}`);
  logger.raw(`产物（唯一）：${artifactName}`);
  logger.raw(`manifest    ：${manifestPath}`);
  logger.raw(`env 文件    ：${envReport.file ?? '（未找到，仅用进程环境）'}`);
  logger.raw(`压缩        ：${compress ? `gzip -${v['gzip-level']}` : '关闭'}；明文保留：${keepPlain ? '是' : '否'}`);
  logger.raw(
    `加密        ：${encryption === 'gpg' ? describeGpgMode(gpgMode) : '关闭（明文备份——出仓库前必须自行加密）'}` +
      (encryption === 'gpg' && gpgMode.kind === 'symmetric'
        ? `；${GPG_PASSPHRASE_ENV}：${passphrase ? `已设置（长度 ${passphrase.length}，不回显）` : '缺失'}`
        : ''),
  );
  logger.raw(`校验期望    ：表数 ${expectTables ?? '（自动/内部一致性）'}，数据行下限 ${minRows}`);

  // 加密前置检查：即使 --dry-run 也要做（dry-run 的价值就是"先证明密钥/工具齐备"）
  if (encryption === 'gpg') {
    const preflight = await gpgPreflight({ mode: gpgMode });
    logger.raw(`gpg 前置    ：${preflight.ok ? '通过' : 'FAIL'} — ${preflight.detail}`);
    if (!preflight.ok) fail(logger, `加密备份无法执行：${preflight.detail}`, EXIT_PRECONDITION);
  }

  // ---- 明文外发闸门（M12-P5）：**即使 --dry-run 也要做** ——
  // dry-run 的价值正是"在没有任何副作用前暴露问题"；若只在真实上传前拦截，dry-run 就会给出假绿灯。
  const uploadGate = assessPlaintextUpload({
    upload: v.upload === true,
    encryption,
    endpoint: process.env.STORAGE_ENDPOINT ?? '',
    allowPlaintextUpload: v['allow-plaintext-upload'] === true,
  });
  if (v.upload === true) {
    // 拒绝时**不要**打"无需确认"（那会让人以为已经放行）；直接把"被拒"写在计划里，原因紧跟在下方错误行
    logger.raw(
      `上传闸门    ：${
        uploadGate.ok ? (uploadGate.notice ?? '无需确认（已加密或未上传）') : '**未加密外发被拒绝**（原因见下）'
      }`,
    );
  }
  if (!uploadGate.ok) fail(logger, uploadGate.reason ?? '明文外发被拒绝', EXIT_PRECONDITION);

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
    assertNoExistingArtifact(logger, [plainPath, artifactPath], v.force === true, true);
    if (!existsSync(outDir)) logger.raw(`输出目录    ：不存在，将在正式执行时创建`);
    printEnvReminder(logger, envReport, envBackupDir);
    logger.raw('');
    logger.raw('dry-run 结论：前置检查通过（未做任何备份）。去掉 --dry-run 执行真实备份。');
    process.exit(ping.ok ? EXIT_OK : EXIT_PRECONDITION);
  }

  // ---- 前置：目标文件冲突（幂等保护）----
  assertNoExistingArtifact(logger, [plainPath, artifactPath, manifestPath], v.force === true, false);
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
  // 明文 sha256：加密自检的**基准**（自检走"解密 → 解压"全链，验证产物最终能还原出这份明文）
  const plainSha256 = await sha256File(plainPath);
  if (dumpRes.stderr.trim()) logger.warn(`pg_dump stderr（非致命，需人工确认）：${dumpRes.stderr.trim().slice(0, 400)}`);
  logger.info(`pg_dump 完成：${formatBytes(plainBytes)} / ${formatDuration(dumpMs)}（sha256 ${plainSha256.slice(0, 16)}…）`);

  // ---- 2) 内容统计 ----
  logger.step('解析 dump 内容（表 / COPY 段 / 逐表行数 / 扩展）');
  const statsStarted = Date.now();
  const stats = await collectStats(plainPath);
  const statsMs = Date.now() - statsStarted;
  const keyTableRows: Record<string, number> = {};
  for (const { table } of KEY_TABLES) keyTableRows[table] = stats.rowCounts[table] ?? -1; // -1 = 备份里没有该表

  // ---- 3) 校验 ----
  const checks: BackupCheck[] = verifyDumpStats(stats, { sizeBytes: plainBytes, expectTables, minRows });
  // M12-P5：明文外发的**事实留痕**（machine-readable）——"这次上传是明文"必须能从 manifest 读出来，
  // 而不是只活在一次性日志里；ok=true（它记录的是"已按闸门口径放行"，不是"校验通过"）。
  if (v.upload === true && encryption === 'none') {
    checks.push({
      name: 'plaintext-upload-acknowledged',
      ok: true,
      detail: uploadGate.local
        ? `未加密备份上传到**本机**端点 ${process.env.STORAGE_ENDPOINT ?? '（未配置）'}（开发链路自动放行）`
        : `未加密备份上传到**非本机**端点 ${process.env.STORAGE_ENDPOINT ?? '（未配置）'}，已由 --allow-plaintext-upload 显式确认`,
    });
  }
  const failedChecks = checks.filter((c) => !c.ok);
  logger.info(`内容统计：表 ${stats.tables} / COPY 段 ${stats.copySegments} / 行 ${stats.totalRows} / 扩展 [${stats.extensions.join(',')}]`);
  for (const c of checks) logger.raw(`  [${c.ok ? 'ok' : 'FAIL'}] ${c.name} — ${c.detail}`);

  // ---- 4) 压缩 ----
  let preEncryptionBytes = 0;
  let preEncryptionSha256 = '';
  let compressMs = 0;
  if (compress) {
    logger.step(`gzip -${v['gzip-level']} 压缩`);
    const t0 = Date.now();
    await gzipFile(plainPath, preEncryptionPath, Number(v['gzip-level']));
    compressMs = Date.now() - t0;
    preEncryptionBytes = statSync(preEncryptionPath).size;
    preEncryptionSha256 = await sha256File(preEncryptionPath);
    logger.info(
      `压缩完成：${formatBytes(preEncryptionBytes)}（压缩比 ${(plainBytes / Math.max(preEncryptionBytes, 1)).toFixed(2)}x）/ ${formatDuration(compressMs)}`,
    );
  } else {
    preEncryptionBytes = plainBytes;
    preEncryptionSha256 = await sha256File(plainPath);
  }

  // ---- 4b) 静态加密（可选；**加密后立刻解密回读自检**——"加完解不开"等于没有备份）----
  let artifactBytes = preEncryptionBytes;
  let artifactSha256 = preEncryptionSha256;
  let encryptMs = 0;
  let decryptVerified = false;
  if (encryption === 'gpg') {
    logger.step(`gpg 加密 → ${artifactName}`);
    const t0 = Date.now();
    const enc = await encryptFile({ inPath: preEncryptionPath, outPath: artifactPath, mode: gpgMode, passphrase });
    encryptMs = Date.now() - t0;
    if (!enc.ok) {
      // 不留半截密文（它比"没有加密备份"更危险：看起来像备份，其实解不开）
      if (existsSync(artifactPath)) rmSync(artifactPath);
      fail(logger, enc.detail, EXIT_FAIL);
    }
    artifactBytes = enc.outBytes;
    artifactSha256 = await sha256File(artifactPath);
    logger.info(
      `加密完成：${formatBytes(artifactBytes)}（体积 +${(((artifactBytes - preEncryptionBytes) / Math.max(preEncryptionBytes, 1)) * 100).toFixed(2)}%）/ ${formatDuration(encryptMs)}`,
    );

    logger.step('加密自检：解密回读（gpg → gunzip）并与明文 dump 的 sha256 比对');
    const verifyStarted = Date.now();
    const opened = openArtifactStream(artifactPath, { passphrase });
    let reHash = '';
    let readDetail = 'ok';
    try {
      reHash = await sha256Stream(opened.stream);
      const res = await opened.finished;
      readDetail = res.ok ? 'ok' : res.detail;
      decryptVerified = res.ok && reHash === plainSha256;
    } catch (err) {
      readDetail = (err as Error).message;
      decryptVerified = false;
    }
    const decryptCheck: BackupCheck = {
      name: 'encrypted-artifact-decryptable',
      ok: decryptVerified,
      detail: decryptVerified
        ? `解密回读 sha256 与明文 dump 一致（${reHash.slice(0, 16)}…，${formatDuration(Date.now() - verifyStarted)}）——密文确实由当前密钥解得开`
        : `解密回读失败或与明文不一致（链路：${readDetail}；回读 sha256 ${reHash.slice(0, 16) || 'n/a'}… ≠ 期望 ${plainSha256.slice(0, 16)}…）`,
    };
    checks.push(decryptCheck);
    logger.raw(`  [${decryptCheck.ok ? 'ok' : 'FAIL'}] ${decryptCheck.name} — ${decryptCheck.detail}`);
    if (!decryptVerified) {
      // 关键：**不删**明文产物——自检失败时唯一的可用副本就是它
      logger.error(`加密自检失败：产物 ${artifactPath} 不可信；已保留 ${preEncryptionPath}（明文/压缩产物）供人工处理`);
      logger.error(`常见原因：${GPG_PASSPHRASE_ENV} 与加密时不一致、keyring 私钥缺失、磁盘写入被截断`);
      process.exit(EXIT_VERIFY);
    }
  }

  // ---- 4c) 明文清理（**放在加密自检之后**：自检失败时不能把唯一可用副本删掉）----
  if (compress && !keepPlain) {
    rmSync(plainPath);
    logger.info('已删除明文 .sql（用 --keep-plain 保留）');
  }

  // ---- 5) 远端归档（可选；先传产物，manifest 生成后单独传）----
  const backupFileNameOnDisk = artifactName;
  let mc: McClient | null = null;
  let mcMounts: { hostPath: string; containerPath: string }[] = [];
  let mcDirRef = outDir;
  let remoteTarget = '';
  const uploaded: string[] = [];
  let remoteBytes = 0;
  let remoteEtag: string | null = null;
  let remoteContentVerified = false;
  // M11 Final Audit M6：内容校验结论必须先于一切副作用——校验不通过的截断 dump
  // 绝不推异地，也绝不触发 prune 删掉更早的好备份
  if (failedChecks.length > 0) {
    logger.error(`备份校验未通过（${failedChecks.map((c) => c.name).join(', ')}）——跳过上传与保留策略，请勿把该文件当作可用备份`);
    process.exit(EXIT_VERIFY);
  }
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
    if (encryption === 'none') {
      // 放行 ≠ 无所谓：闸门只在"本机端点 / 已显式确认"两种情形下放行，这里把事实再喊一次（日志 + manifest 都有）
      logger.warn(
        `明文外发：本次上传的产物**未加密**（${uploadGate.local ? '本机端点自动放行' : '--allow-plaintext-upload 显式确认'}）；` +
          'manifest.checks.plaintext-upload-acknowledged 已记录该事实。生产请改用 --encrypt gpg。',
      );
    }
    logger.step(`远端归档到 ${remoteTarget}（${mc.description}）`);
    const mk = await mc.makeBucket(bucket);
    if (mk.code !== 0) logger.warn(`建桶返回非 0（可能已存在）：${safeMcError(mk)}（未阻断）`);
    const cp = await mc.exec(['cp', `${mcDirRef}/${backupFileNameOnDisk}`, `${mc.ref(bucket)}/${prefix}${backupFileNameOnDisk}`], {
      mounts: mcMounts,
      timeoutMs: 3_600_000,
    });
    if (cp.code !== 0) fail(logger, `上传失败 ${backupFileNameOnDisk}：${safeMcError(cp)}`, EXIT_FAIL);
    // 远端核对（截断/传错对象是静默事故的常见形态）：体积用 ls，内容用 stat 的 ETag
    const remotePath = `${mc.ref(bucket)}/${prefix}${backupFileNameOnDisk}`;
    const ls = await mc.list(remotePath, { mounts: mcMounts });
    const remoteSummary = parseMcListJson(ls.stdout);
    remoteBytes = remoteSummary.totalBytes;
    if (remoteBytes !== artifactBytes) {
      fail(logger, `远端对象体积不符：期望 ${artifactBytes} 字节，实际 ${remoteBytes} 字节（${remotePath}）`, EXIT_VERIFY);
    }
    // ETag 内容级核对：单段上传的 ETag == 对象内容 md5 ⇒ 零传输即可确认"桶里那一个就是本地这一个"。
    // 多段上传（大对象）ETag 形如 `<md5>-<n>`，此时**不假装核对过**，如实标注 contentVerified=false。
    const stat = await mc.stat(remotePath);
    const remoteStat = parseMcStatJson(stat.stdout);
    remoteEtag = remoteStat?.etag ?? null;
    const expectedMd5 = await md5File(artifactPath);
    const remoteMd5 = remoteEtag ? etagAsMd5(remoteEtag) : null;
    if (remoteStat && remoteStat.sizeBytes !== artifactBytes) {
      fail(logger, `远端对象体积不符（mc stat）：期望 ${artifactBytes} 字节，实际 ${remoteStat.sizeBytes} 字节（${remotePath}）`, EXIT_VERIFY);
    }
    if (remoteMd5) {
      if (remoteMd5 !== expectedMd5) {
        fail(logger, `远端对象内容不符（ETag/md5）：本地 ${expectedMd5}，远端 ${remoteMd5}（${remotePath}）`, EXIT_VERIFY);
      }
      remoteContentVerified = true;
      logger.info(`远端已确认：${prefix}${backupFileNameOnDisk}（${formatBytes(remoteBytes)}，ETag/md5=${remoteMd5} 一致）`);
    } else {
      logger.warn(
        `远端已确认体积（${formatBytes(remoteBytes)}），但 ETag 不是单段 md5（${remoteEtag ?? 'null'}）⇒ **未做内容级核对**；` +
          '需要内容级证明时用 minio-mirror.ts --checksum-sample',
      );
    }
    uploaded.push(`${prefix}${backupFileNameOnDisk}`);
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
      plainSha256,
      artifact: artifactPath,
      artifactBytes,
      artifactSha256,
      preEncryptionSha256,
    },
    stats,
    encryption:
      encryption === 'gpg'
        ? { scheme: 'gpg', mode: gpgMode.kind, recipient: gpgMode.recipient ?? null, cipher: GPG_CIPHER_ALGO, decryptVerified }
        : null,
    checks,
    keyTableRows,
    secrets: secretPresence(),
    durations: { dumpMs, statsMs, compressMs, encryptMs, totalMs },
    remote: mc
      ? { kind: 'minio', target: remoteTarget, uploaded, bytes: remoteBytes, etag: remoteEtag, contentVerified: remoteContentVerified }
      : null,
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
  // 口径：一份「备份集」= 同一时间戳的 .sql/.gz/.gpg + manifest.json（删就整套删，留就整套留，
  // 避免"留下 manifest 却删掉密文"这种看起来很完整、实际恢复不了的状态）。
  if (v.prune === true) {
    const { scanned, removed, setsRemoved, setNames } = pruneBackups(outDir, target.database, Number(v['prune-keep']), logger, true);
    logger.info(
      `保留策略：扫描 ${scanned} 份备份集，删除 ${setsRemoved} 套（${removed.length} 个文件）` +
        `（保留最近 ${v['prune-keep']} 套；含 .sql/.gz/.gpg/manifest 整套删除）` +
        `${setNames.length ? `：${setNames.slice(0, 3).join(', ')}${setNames.length > 3 ? ' …' : ''}` : ''}`,
    );
  } else {
    const { removed, setsRemoved } = pruneBackups(outDir, target.database, Number(v['prune-keep']), logger, false);
    if (removed.length) {
      logger.warn(
        `保留策略：有 ${setsRemoved} 套备份超出保留数（共 ${removed.length} 个文件，未删除；加 --prune 执行）：${removed.slice(0, 5).join(', ')}`,
      );
    }
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
