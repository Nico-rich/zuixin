/**
 * M10-P9 运维脚本：对象存储（MinIO/S3）桶 mirror + **对象数/总体积核对**（审计 PR-7/PR-10）。
 *
 * 来源：`docs/operations/m8-disaster-recovery.md` §3.2/§4.3 的手工 `mc mirror` 命令脚本化。
 *
 * 支持四类路径（`--source`/`--target` 各写一个）：
 *   - 桶：`<bucket>`（与 `--bucket-alias`/env 里的 MinIO 连接组合成 `<alias>/<bucket>`）
 *   - 本地目录：`./data/storage` 之类的文件系统路径（local 驱动开发环境；容器内映射到 /mnt/target）
 * 组合出四条常用链路：
 *   ① 桶 → 本地目录（离线副本/冷备）        ② 桶 → 异地域桶（offsite）
 *   ③ 本地目录 → 桶（把 local 驱动的数据搬进 S3）④ 本地目录 → 本地目录（rsync 语义）
 *
 * 核对（**本脚本存在的理由**）：mirror 命令退出码 0 ≠ 数据一致。完成后必须比对
 * 源/目标的 **对象数 + 每对象体积 + 总体积**，并可按 `--checksum-sample N` 抽查内容哈希；
 * 任何不一致 ⇒ 退出码 3（告警可依赖）。
 *
 * 安全：绝不触碰业务桶以外的桶（默认只操作显式给出的桶名）；凭证只经 env/临时 env 文件传递。
 *
 * 用法：`cd apps/api && npx tsx scripts/minio-mirror.ts --help`
 */

import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readdirSync, rmdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

/** 内容抽样校验的单对象上限：超过它只比体积（避免把 GB 级对象读进内存）。 */
const MAX_CHECKSUM_BYTES = 64 * 1024 * 1024;

import {
  DEFAULT_EXIT_CODES, EXIT_FAIL, EXIT_OK, EXIT_PRECONDITION, EXIT_USAGE, EXIT_VERIFY,
  createLogger, fail, formatBytes, formatDuration, stamp,
} from './lib/cli';
import { loadEnv, storageConfigFromEnv } from './lib/env';
import {
  MC_CONTAINER_TARGET, McClient, diffMirror, parseMcListJson, safeMcError, sampleKeys, summarizeDir,
  type McMirrorSummary, type McMode,
} from './lib/mc';
import { helpText, parseArgs, type FlagSpec } from './lib/args';

const SCRIPT = 'minio-mirror.ts';
const SPECS: readonly FlagSpec[] = [
  { name: 'source', alias: 's', type: 'string', valueName: '<bucket|dir>', help: '源：桶名或本地目录（必填）' },
  { name: 'target', alias: 't', type: 'string', valueName: '<bucket|dir>', help: '目标：桶名或本地目录（必填）' },
  { name: 'delete', type: 'boolean', help: '镜像删除（目标多余对象一并删除；默认关闭，防误删）' },
  { name: 'dry-run', type: 'boolean', help: '只列出将传输的对象（mc --dry-run），不写入' },
  { name: 'checksum-sample', type: 'number', valueName: '<n>', default: 0, help: '抽样做内容级 md5 比对的对象数（默认 0=只比体积）' },
  { name: 'env-file', type: 'string', valueName: '<path>', help: 'env 文件路径（取 STORAGE_* 连接信息）' },
  { name: 'endpoint', type: 'string', valueName: '<url>', help: 'MinIO 端点（默认 STORAGE_ENDPOINT）' },
  { name: 'access-key', type: 'string', valueName: '<key>', help: '访问密钥（默认 STORAGE_ACCESS_KEY_ID；不建议命令行传）' },
  { name: 'secret-key', type: 'string', valueName: '<secret>', help: '密钥（默认 STORAGE_SECRET_ACCESS_KEY；不建议命令行传）' },
  { name: 'mc-mode', type: 'string', valueName: '<docker|native>', default: 'docker', help: 'mc 运行形态（默认 docker，镜像已在本机）' },
  { name: 'mc-network', type: 'string', valueName: '<net>', default: 'container:docker-minio-1', help: 'mc 容器 network（默认复用 minio 容器）' },
  { name: 'mc-image', type: 'string', valueName: '<image>', default: 'quay.io/minio/mc:latest', help: 'mc 镜像' },
  { name: 'mkdir-target', type: 'boolean', help: '目标目录不存在时自动创建（默认拒绝：目标写错地方是常见事故）' },
  { name: 'no-make-bucket', type: 'boolean', help: '不自动创建目标桶（默认会自动建；生产严格管控时用）' },
  { name: 'out-dir', alias: 'o', type: 'string', valueName: '<dir>', help: 'mirror 报告输出目录（默认 <仓库根>/backup）' },
  { name: 'timeout-ms', type: 'number', valueName: '<ms>', default: 3_600_000, help: 'mirror 超时（默认 1h）' },
];

type PathKind = 'bucket' | 'dir';

interface ResolvedPath {
  raw: string;
  kind: PathKind;
  /** bucket：桶名；dir：宿主机绝对路径 */
  value: string;
  /** mc 里的引用（容器内路径或 alias/bucket） */
  ref: string;
}

function classify(raw: string, cwd: string): ResolvedPath {
  const looksLikePath = raw.includes('/') || raw.includes('\\') || raw.startsWith('.') || /^[A-Za-z]:/.test(raw);
  if (!looksLikePath && /^[a-z0-9][a-z0-9.-]{1,62}$/.test(raw)) {
    return { raw, kind: 'bucket', value: raw, ref: raw };
  }
  if (!looksLikePath) {
    throw new Error(`无法判定 "${raw}" 是桶名还是目录：桶名须为小写字母/数字/点/连字符（2~63 字符），目录请写相对或绝对路径`);
  }
  return { raw, kind: 'dir', value: resolve(cwd, raw), ref: resolve(cwd, raw) };
}

/** 本地目录 → 本地目录（无 mc 参与；用于 local 驱动数据目录的离线拷贝）。 */
function copyDirTree(source: string, target: string, deleteExtra: boolean, logger: ReturnType<typeof createLogger>): { copied: number; bytes: number } {
  let copied = 0;
  let bytes = 0;
  const walk = (rel: string) => {
    const srcDir = resolve(source, rel);
    mkdirSync(resolve(target, rel), { recursive: true });
    for (const entry of readdirSync(srcDir, { withFileTypes: true })) {
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(childRel);
      else if (entry.isFile()) {
        const from = resolve(source, childRel);
        const to = resolve(target, childRel);
        const size = statSync(from).size;
        if (!existsSync(to) || statSync(to).size !== size) {
          copyFileSync(from, to);
          copied += 1;
          bytes += size;
          if (copied % 50 === 0) logger.info(`  已拷贝 ${copied} 个对象…`);
        }
      }
    }
  };
  walk('');
  if (deleteExtra) {
    const removeExtra = (rel: string) => {
      const dstDir = resolve(target, rel);
      if (!existsSync(dstDir)) return;
      const srcDir = resolve(source, rel);
      for (const entry of readdirSync(dstDir, { withFileTypes: true })) {
        const childRel = rel ? `${rel}/${entry.name}` : entry.name;
        const target2 = resolve(target, childRel);
        if (!existsSync(resolve(srcDir, entry.name))) {
          if (entry.isDirectory()) {
            removeExtra(childRel);
            if (readdirSync(target2).length === 0) rmdirSync(target2);
          } else {
            unlinkSync(target2);
            logger.warn(`  已删除目标多余对象：${childRel}`);
          }
        } else if (entry.isDirectory()) removeExtra(childRel);
      }
    };
    removeExtra('');
  }
  return { copied, bytes };
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
        summary: '对象存储桶/目录 mirror（mc）+ 对象数与总体积核对（不一致即非 0 退出）',
        specs: SPECS,
        notes: [
          '路径写法：桶直接写桶名（agent-storage）；目录写路径（./data/storage）。容器模式下目录自动映射到 /mnt/target。',
          '核对：源/目标的对象数、逐对象体积、总体积必须完全一致；--checksum-sample N 再抽查 N 个对象的内容 md5。',
          '--delete 会删除目标端多余对象（危险）；默认关闭。演练请永远指向临时桶/临时目录。',
          'local 驱动（STORAGE_DRIVER=local）的数据在 ./data/storage，不在 MinIO 里——用「目录 → 目录」链路备份它。',
        ],
        examples: [
          'npx tsx scripts/minio-mirror.ts --source agent-storage --target ./backup/storage --mkdir-target',
          'npx tsx scripts/minio-mirror.ts -s agent-storage -t agent-storage-offsite --checksum-sample 3',
          'npx tsx scripts/minio-mirror.ts -s ./data/storage -t agent-storage --dry-run',
          'npx tsx scripts/minio-mirror.ts -s ./data/storage -t /mnt/offsite/storage --delete',
        ],
        exitCodes: DEFAULT_EXIT_CODES,
      }),
    );
    process.exit(EXIT_OK);
  }
  const v = parsed.parsed.values;
  const logger = createLogger('minio-mirror');
  const startedAll = Date.now();

  const sourceArg = v.source as string | undefined;
  const targetArg = v.target as string | undefined;
  if (!sourceArg) fail(logger, '缺少 --source <桶|目录>', EXIT_USAGE);
  if (!targetArg) fail(logger, '缺少 --target <桶|目录>', EXIT_USAGE);

  let envReport;
  try {
    envReport = loadEnv({ explicit: v['env-file'] as string | undefined });
  } catch (err) {
    fail(logger, (err as Error).message, EXIT_USAGE);
  }
  const storage = storageConfigFromEnv();
  const mode: McMode = String(v['mc-mode']) === 'native' ? 'native' : 'docker';
  const accessKey = (v['access-key'] as string | undefined) ?? storage.accessKeyId;
  const secretKey = (v['secret-key'] as string | undefined) ?? storage.secretAccessKey;
  const endpoint = (v['endpoint'] as string | undefined) ?? storage.endpoint ?? '';

  let source: ResolvedPath;
  let target: ResolvedPath;
  try {
    source = classify(sourceArg, process.cwd());
    target = classify(targetArg, process.cwd());
  } catch (err) {
    fail(logger, (err as Error).message, EXIT_USAGE);
  }
  if (source.kind === target.kind && source.value === target.value) fail(logger, '源与目标是同一个位置', EXIT_USAGE);
  if (source.kind === 'bucket' && source.value === target.value) fail(logger, '源桶与目标桶相同', EXIT_USAGE);

  const touchesMc = source.kind === 'bucket' || target.kind === 'bucket';
  if (touchesMc && (!accessKey || !secretKey)) {
    fail(logger, '涉及桶的操作需要 STORAGE_ACCESS_KEY_ID / STORAGE_SECRET_ACCESS_KEY（见 .env 或 --env-file）', EXIT_PRECONDITION);
  }
  if (touchesMc && !endpoint) fail(logger, '涉及桶的操作需要 STORAGE_ENDPOINT（或 --endpoint）', EXIT_PRECONDITION);

  for (const p of [source, target]) {
    if (p.kind === 'dir' && !existsSync(p.value)) {
      const isTarget = p === target;
      if (isTarget && v['mkdir-target'] === true) {
        mkdirSync(p.value, { recursive: true });
        logger.info(`已创建目标目录：${p.value}`);
      } else {
        fail(logger, `目录不存在：${p.value}${isTarget ? '（目标目录不会自动创建；确认路径或加 --mkdir-target）' : ''}`, EXIT_PRECONDITION);
      }
    }
  }

  logger.raw('');
  logger.raw('=== M10-P9 对象存储 mirror ===');
  logger.raw(`源          ：${source.kind === 'bucket' ? `桶 ${source.value}` : `目录 ${source.value}`}`);
  logger.raw(`目标        ：${target.kind === 'bucket' ? `桶 ${target.value}` : `目录 ${target.value}`}`);
  logger.raw(`删除多余    ：${v.delete === true ? '是（--delete）' : '否'}`);
  logger.raw(`dry-run     ：${v['dry-run'] === true ? '是（不写入）' : '否'}`);
  logger.raw(`内容抽样    ：${v['checksum-sample']} 个对象（0 = 只比体积）`);
  logger.raw(`env 文件    ：${envReport.file ?? '（未找到，仅用进程环境）'}`);
  logger.raw(`存储驱动    ：${storage.driver}（桶模式与驱动无关；local 驱动的数据在 ${storage.localDir}）`);

  const client = touchesMc
    ? new McClient({
        mode,
        origin: endpoint,
        accessKey,
        secretKey,
        image: String(v['mc-image']),
        network: String(v['mc-network']),
      })
    : null;
  if (client) logger.raw(`mc          ：${client.description}`);

  /** 只有目录侧需要挂载（桶侧走 alias）；容器模式下目录映射到 /mnt/target。 */
  const mountsFor = (p: ResolvedPath): { hostPath: string; containerPath: string }[] =>
    p.kind === 'dir' ? client?.mountFor(p.value, MC_CONTAINER_TARGET, mode) ?? [] : [];
  const refOf = (p: ResolvedPath): string => {
    if (p.kind === 'bucket') return client?.ref(p.value) ?? p.value;
    return mode === 'docker' ? MC_CONTAINER_TARGET : p.value;
  };
  // 目录 → 目录 不经 mc（容器模式下两个 /mnt/target 会冲突；本地拷贝语义等价且更快）
  const useLocalCopy = source.kind === 'dir' && target.kind === 'dir';
  const outDir = resolve((v['out-dir'] as string | undefined) ?? process.env.BACKUP_DIR ?? resolve(__dirname, '../../../backup'));

  let result: { count: number; totalBytes: number } | null = null;

  if (useLocalCopy) {
    logger.step(`本地目录拷贝（不经 mc）：${source.value} → ${target.value}`);
    const copyStarted = Date.now();
    const { copied, bytes } = v['dry-run'] === true
      ? { copied: 0, bytes: 0 }
      : copyDirTree(source.value, target.value, v.delete === true, logger);
    logger.info(`拷贝完成：${copied} 个对象 / ${formatBytes(bytes)} / ${formatDuration(Date.now() - copyStarted)}`);
    const srcSummary = summarizeDir(source.value);
    const dstSummary = summarizeDir(target.value);
    logger.raw(`源  ：${srcSummary.count} 个对象 / ${formatBytes(srcSummary.totalBytes)}`);
    logger.raw(`目标：${dstSummary.count} 个对象 / ${formatBytes(dstSummary.totalBytes)}`);
    if (v['dry-run'] === true) {
      logger.raw('dry-run 结论：未写入任何对象。');
      process.exit(EXIT_OK);
    }
    const diff = diffMirror(srcSummary, dstSummary);
    result = { count: dstSummary.count, totalBytes: dstSummary.totalBytes };
    const reportPath = resolve(outDir, `minio-mirror-${stamp()}.report.json`);
    writeReport(reportPath, { source, target, mode: 'local-copy', srcSummary, dstSummary, diff });
    if (!diff.ok) {
      logger.error(`目录核对失败：缺失 ${diff.missingInTarget.length} / 多余 ${diff.extraInTarget.length} / 体积不符 ${diff.sizeMismatch.length}`);
      for (const k of diff.missingInTarget.slice(0, 10)) logger.error(`  缺失：${k}`);
      for (const m of diff.sizeMismatch.slice(0, 10)) logger.error(`  体积不符：${m.key} 源 ${m.sourceBytes} → 目标 ${m.targetBytes}`);
      logger.raw(`mirror 报告：${reportPath}`);
      process.exit(EXIT_VERIFY);
    }
    logger.info('目录核对通过（对象数与体积完全一致）');
    logger.raw(`mirror 报告：${reportPath}`);
  } else if (client) {
    // 目标桶不存在则创建（幂等）：mirror 到不存在的桶会失败，而"异地冷备桶"通常就是新建的。
    // `--no-make-bucket` 可关掉（要求运维先手工建桶，适合生产管控严格的场景）。
    if (target.kind === 'bucket' && v['no-make-bucket'] !== true && v['dry-run'] !== true) {
      const mb = await client.makeBucket(target.value, { mounts: mountsFor(target) });
      if (mb.code !== 0) logger.warn(`建桶返回非 0（可能已存在）：${safeMcError(mb)}（未阻断）`);
    }
    if (v['dry-run'] === true) {
      logger.step('dry-run：mc mirror --dry-run（只列出将要传输的对象）');
      const dry = await client.exec(
        ['mirror', '--overwrite', ...(v.delete === true ? ['--remove'] : []), '--dry-run', refOf(source), refOf(target)],
        { mounts: [...mountsFor(source), ...mountsFor(target)], timeoutMs: Number(v['timeout-ms']) },
      );
      if (dry.code !== 0) fail(logger, `mc mirror --dry-run 失败：${safeMcError(dry)}`, EXIT_FAIL);
      logger.raw(dry.stdout.trim() || '（无待传输对象）');
      logger.raw('dry-run 结论：未写入任何对象。');
      process.exit(EXIT_OK);
    }
    logger.step(`mc mirror ${refOf(source)} → ${refOf(target)}`);
    const mirrorStarted = Date.now();
    const mirrorMounts = [...mountsFor(source), ...mountsFor(target)];
    const mirror = await client.exec(
      ['mirror', '--overwrite', ...(v.delete === true ? ['--remove'] : []), refOf(source), refOf(target)],
      { mounts: mirrorMounts, timeoutMs: Number(v['timeout-ms']) },
    );
    if (mirror.code !== 0) fail(logger, `mc mirror 失败：${safeMcError(mirror)}`, EXIT_FAIL);
    logger.info(`mc mirror 完成：${formatDuration(Date.now() - mirrorStarted)}`);

    // ---- 核对：源/目标对象数与体积 ----
    logger.step('核对：对象数 / 逐对象体积 / 总体积');
    // 注意：容器模式下 mc 只认得容器内路径 ⇒ 必须用 refOf()（/mnt/target），不能用宿主机路径
    const srcSummary = await listPath(client, refOf(source), mountsFor(source), Number(v['timeout-ms']));
    const dstSummary = await listPath(client, refOf(target), mountsFor(target), Number(v['timeout-ms']));
    logger.raw(`源  ：${srcSummary.count} 个对象 / ${formatBytes(srcSummary.totalBytes)}`);
    logger.raw(`目标：${dstSummary.count} 个对象 / ${formatBytes(dstSummary.totalBytes)}`);
    const diff = diffMirror(srcSummary, dstSummary);
    result = { count: dstSummary.count, totalBytes: dstSummary.totalBytes };

    // ---- 内容抽样（可选）：对抽样对象做**真实 md5**（读取原始字节，不经 utf8 解码）----
    const sampleCount = Number(v['checksum-sample']);
    const checksumResults: { key: string; match: boolean; sourceMd5: string; targetMd5: string }[] = [];
    if (sampleCount > 0 && diff.ok) {
      const keys = sampleKeys(srcSummary, sampleCount);
      const sizes = new Map(srcSummary.objects.map((o) => [o.key, o.sizeBytes]));
      logger.step(`内容抽样校验（md5）：${keys.length} 个对象`);
      for (const key of keys) {
        const size = sizes.get(key) ?? 0;
        if (size > MAX_CHECKSUM_BYTES) {
          logger.warn(`  跳过 ${key}（${formatBytes(size)} > 上限 ${formatBytes(MAX_CHECKSUM_BYTES)}；大对象内容校验请另跑离线校验工具）`);
          continue;
        }
        // refOf() 才能正确处理"目录源"（容器内 /mnt/target）；直接用 client.ref(dirPath) 会拼出
        // `m10/C:\...` 这种非法桶名（实测踩过）
        const [a, b] = await Promise.all([
          client.cat(`${refOf(source)}/${key}`, { timeoutMs: 300_000, mounts: mountsFor(source) }),
          client.cat(`${refOf(target)}/${key}`, { timeoutMs: 300_000, mounts: mountsFor(target) }),
        ]);
        if (a.code !== 0 || b.code !== 0) {
          logger.warn(`  跳过 ${key}（mc cat 失败：${safeMcError(a.code !== 0 ? a : b)}）`);
          continue;
        }
        const md5 = (buf: Buffer | undefined) => createHash('md5').update(buf ?? Buffer.alloc(0)).digest('hex');
        const sourceMd5 = md5(a.stdoutBuffer);
        const targetMd5 = md5(b.stdoutBuffer);
        checksumResults.push({ key, match: sourceMd5 === targetMd5, sourceMd5, targetMd5 });
        logger.raw(`  ${sourceMd5 === targetMd5 ? 'match' : 'MISMATCH'}  ${key}  源 ${sourceMd5} / 目标 ${targetMd5}`);
      }
    }

    const reportPath = resolve(outDir, `minio-mirror-${stamp()}.report.json`);
    writeReport(reportPath, { source, target, mode, srcSummary, dstSummary, diff, checksumResults, dryRun: false });

    const checksumFailures = checksumResults.filter((c) => !c.match);
    if (!diff.ok || checksumFailures.length > 0) {
      logger.error(`mirror 核对失败：缺失 ${diff.missingInTarget.length} / 多余 ${diff.extraInTarget.length} / 体积不符 ${diff.sizeMismatch.length} / 哈希不符 ${checksumFailures.length}`);
      for (const k of diff.missingInTarget.slice(0, 10)) logger.error(`  缺失：${k}`);
      for (const m of diff.sizeMismatch.slice(0, 10)) logger.error(`  体积不符：${m.key} 源 ${m.sourceBytes} → 目标 ${m.targetBytes}`);
      for (const c of checksumFailures.slice(0, 10)) logger.error(`  哈希不符：${c.key}`);
      logger.raw(`mirror 报告：${reportPath}`);
      process.exit(EXIT_VERIFY);
    }
    logger.info('mirror 核对通过（对象数与体积一致）');
    logger.raw(`mirror 报告：${reportPath}`);
  }

  logger.raw('');
  logger.raw(`结论：PASS —— 目标 ${result?.count ?? 0} 个对象 / ${formatBytes(result?.totalBytes ?? 0)}，与源一致（总耗时 ${formatDuration(Date.now() - startedAll)}）`);
  process.exit(EXIT_OK);
}

async function listPath(
  client: McClient,
  ref: string,
  mounts: { hostPath: string; containerPath: string }[],
  timeoutMs: number,
): Promise<McMirrorSummary> {
  const res = await client.list(ref, { mounts, timeoutMs });
  if (res.code !== 0) throw new Error(`mc ls 失败（${ref}）：${safeMcError(res)}`);
  return parseMcListJson(res.stdout);
}

function writeReport(path: string, payload: Record<string, unknown>): void {
  try {
    const dir = resolve(path, '..');
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(path, `${JSON.stringify({ tool: 'm10-minio-mirror', createdAt: new Date().toISOString(), ...payload }, null, 2)}\n`, 'utf8');
  } catch {
    /* 报告写不进去不阻断主流程（stdout 已有结论） */
  }
}

void main().catch((err) => {
  process.stderr.write(`minio-mirror.ts 未捕获异常：${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
  process.exit(EXIT_FAIL);
});
