/**
 * M11-P1（D1-09 / NV-11）运维脚本：**凭证密文密钥版本迁移**（rewrap）。
 *
 * 解决的问题（M10 审计结论）：`CryptoService.rewrap()` 是"库方法但没有生产调用方"、
 * `Credential.keyVersion` 列恒为 1 —— 一旦 `ENCRYPTION_KEYS` 引入新版本（轮换/泄漏应急），
 * 存量密文永远不会被迁移，旧密钥必须无限期保留（轮换从未真正发生）。本脚本是 `rewrap()` 的
 * **生产调用方**：按主键分批扫描 `Credential`（`id > 上一批末行`，不用 Prisma `cursor`——游标行被
 * 并发删除时 Prisma 返回空集会让扫描"正常结束"却漏行）→ 落后于当前版本的行重加密为当前版本 →
 * 写回 `{ encryptedValue, keyVersion }`。
 *
 * 纪律：
 * - **默认 dry-run（只读）**：不加 `--apply` 绝不写库（运维脚本最危险的默认值 = "直接改数据"）；
 * - **幂等**：已是最新版本的行不写库；中断/失败后重跑即从断点收敛（分批基于主键，迁移不改主键）；
 * - **每批一个事务**：批内任一写入失败 ⇒ 整批回滚（绝不产出"半迁移批次"）；
 * - **绝不打印密钥与明文**：输出只有行 id / 连接 id / 类型 / 版本号 / 错误码与错误消息；
 * - **退出码即契约**：迁移不了的行走非 0 退出（编排必须看得见"还有欠账"）。
 *
 * 用法：`cd apps/api && npx tsx scripts/rewrap.ts --help`
 *
 * 轮换三步（与 `docs/operations/*runbook*` 口径一致）：
 *   1. 配 `ENCRYPTION_KEYS="1:<旧>,2:<新>"`（**先并存**：旧版本仍可解，新写入走 v2）→ 发布；
 *   2. `npx tsx scripts/rewrap.ts`（dry-run 看规模）→ `npx tsx scripts/rewrap.ts --apply`（迁移）；
 *   3. 确认无欠账后，再从 `ENCRYPTION_KEYS` 摘除旧版本（**摘除后旧密文永久不可解**）。
 */

import { PrismaClient } from '@prisma/client';
import { writeSync } from 'node:fs';

import { CryptoService, encryptionKeyConfigFromEnv } from '../src/core/crypto/crypto.service';
import {
  DEFAULT_MAX_FAILURE_DETAILS, DEFAULT_REWRAP_BATCH_SIZE, runRewrap,
  type RewrapRow, type RewrapStats, type RewrapStore,
} from '../src/core/crypto/rewrap.runner';
import { EXIT_FAIL, EXIT_OK, EXIT_PRECONDITION, EXIT_USAGE, EXIT_VERIFY, createLogger, fail, formatDuration } from './lib/cli';
import { loadEnv, parseDatabaseUrl, type DatabaseTarget } from './lib/env';
import { helpText, parseArgs, type FlagSpec } from './lib/args';

const SCRIPT = 'rewrap.ts';
const SUMMARY = '凭证密文密钥版本迁移（把旧版本密文重加密为当前版本，并写回 keyVersion）';

/** 失败行在输出里的机器可读标识：这些行正是读路径会以 `CREDENTIAL_REWRAP_REQUIRED` 告警的对象 */
const REWRAP_CODE = 'CREDENTIAL_REWRAP_REQUIRED';

/** 交互式事务超时：一批 500 行的 UPDATE 远小于此值；给慢库/锁等待留余量，避免"批大 = 超时回滚" */
const TX_TIMEOUT_MS = 60_000;
const TX_MAX_WAIT_MS = 10_000;

const SPECS: readonly FlagSpec[] = [
  { name: 'apply', type: 'boolean', help: '执行迁移（写库）；未提供时 = dry-run 只判定不写' },
  { name: 'dry-run', type: 'boolean', help: '只判定不写库（**默认行为**；与 --apply 同时给出视为参数冲突）' },
  { name: 'batch-size', type: 'number', valueName: '<n>', default: DEFAULT_REWRAP_BATCH_SIZE, help: '每批扫描/事务行数' },
  { name: 'limit', type: 'number', valueName: '<n>', default: 0, help: '最多扫描 N 行后收尾（0 = 不限；灰度试跑用）' },
  { name: 'max-failure-details', type: 'number', valueName: '<n>', default: DEFAULT_MAX_FAILURE_DETAILS, help: '明细输出的失败行上限（超出只计数）' },
  { name: 'env-file', type: 'string', valueName: '<path>', help: 'env 文件路径（默认按 cwd/.env → <仓库根>/.env 搜索）' },
  { name: 'json', type: 'boolean', help: '末尾追加一行 JSON 审计摘要（编排消费；不含任何凭证内容）' },
];

/** PrismaClient → 执行器端口（唯一适配点：执行器只依赖"按主键游标扫描 + CAS 写回 + 事务"三件事） */
function asStore(prisma: PrismaClient): RewrapStore {
  return {
    credential: {
      findMany: (args) => prisma.credential.findMany(args as never) as unknown as Promise<RewrapRow[]>,
      updateMany: (args) => prisma.credential.updateMany(args as never),
    },
    $transaction: (fn) =>
      prisma.$transaction(
        (tx) => fn({ credential: { updateMany: (args) => tx.credential.updateMany(args as never) } }),
        { timeout: TX_TIMEOUT_MS, maxWait: TX_MAX_WAIT_MS },
      ),
  };
}

async function main(): Promise<void> {
  const logger = createLogger(SCRIPT);
  const parsed = parseArgs(process.argv.slice(2), SPECS);
  if (!parsed.ok) fail(logger, parsed.error, EXIT_USAGE);
  if (parsed.help) {
    logger.raw(helpText({
      script: SCRIPT,
      summary: SUMMARY,
      usage: `npx tsx scripts/${SCRIPT} [选项]`,
      specs: SPECS,
      notes: [
        '未加 --apply 时只判定并输出规模（dry-run 是默认值，绝不写库）',
        '幂等：已是最新版本的行不写库；中断后重跑从断点收敛（分批基于主键范围，迁移不改主键）',
        '每批一个事务：批内任一写入失败 ⇒ 整批回滚，前序批次保留（重跑继续）',
        '需先配好 ENCRYPTION_KEYS="1:<旧>,2:<新>"（只配单一版本时无需迁移）',
        '输出绝不含密钥/明文：只有行 id、连接 id、类型、版本号与错误码',
        '摘除旧密钥版本前，务必先以 exit 0 迁完（否则旧密文永久不可解）',
      ],
      examples: [
        `npx tsx scripts/${SCRIPT}                      # dry-run（默认）：只看有多少行需要迁移`,
        `npx tsx scripts/${SCRIPT} --apply               # 执行迁移`,
        `npx tsx scripts/${SCRIPT} --apply --limit 100   # 灰度：只处理前 100 行`,
      ],
      exitCodes: [
        ['0', '成功（含 dry-run 报告）；无无法迁移的行'],
        ['1', '执行失败（数据库/批次事务错误；前序批次已提交，重跑即可继续）'],
        ['2', '参数错误（未知参数、取值非法、--apply 与 --dry-run 同时给出）'],
        ['3', '存在无法迁移的行（密文版本未知/格式非法）——这些行读路径会以 CREDENTIAL_REWRAP_REQUIRED 告警'],
        ['4', '前置条件不满足（缺少/非法 ENCRYPTION_KEY(S)、DATABASE_URL）'],
      ],
    }));
    process.exit(EXIT_OK);
  }
  const values = parsed.parsed.values;
  const apply = values.apply === true;
  const dryRun = values['dry-run'] === true;
  if (apply && dryRun) fail(logger, '--apply 与 --dry-run 语义冲突：请只给其中一个（默认即 dry-run）', EXIT_USAGE);
  const batchSize = Number(values['batch-size']);
  if (!Number.isInteger(batchSize) || batchSize < 1) fail(logger, `--batch-size 必须是 ≥1 的整数，收到 "${values['batch-size']}"`, EXIT_USAGE);
  const limit = Number(values.limit);
  if (!Number.isInteger(limit) || limit < 0) fail(logger, `--limit 必须是 ≥0 的整数（0 = 不限），收到 "${values.limit}"`, EXIT_USAGE);
  const maxFailureDetails = Number(values['max-failure-details']);
  if (!Number.isInteger(maxFailureDetails) || maxFailureDetails < 0) {
    fail(logger, `--max-failure-details 必须是 ≥0 的整数，收到 "${values['max-failure-details']}"`, EXIT_USAGE);
  }

  // env：进程环境优先（编排注入的 Secret 不被文件覆盖）；只报"有没有"，绝不回显值
  const envReport = (() => {
    try {
      return loadEnv({ explicit: typeof values['env-file'] === 'string' ? values['env-file'] : undefined });
    } catch (err) {
      return fail(logger, `env 加载失败：${(err as Error).message}`, EXIT_PRECONDITION);
    }
  })();
  logger.info(`env 文件：${envReport.file ?? '（未找到，仅用进程环境变量）'}`);

  let target: DatabaseTarget;
  try {
    target = parseDatabaseUrl(process.env.DATABASE_URL);
  } catch (err) {
    fail(logger, `DATABASE_URL 不可用：${(err as Error).message}`, EXIT_PRECONDITION);
  }

  // CryptoService：配置非法立即暴露（KEY_VERSION_INVALID），绝不"部分忽略后带病跑迁移"
  let crypto: CryptoService;
  try {
    crypto = new CryptoService(encryptionKeyConfigFromEnv());
  } catch (err) {
    fail(logger, `加密密钥配置不可用（检查 ENCRYPTION_KEYS/ENCRYPTION_KEY）：${(err as Error).message}`, EXIT_PRECONDITION);
  }
  const versions = crypto.versions();
  logger.info(`密钥：已配置版本 [${versions.join(', ')}]，当前写入版本 v${crypto.currentKeyVersion}（密钥值绝不输出）`);
  if (versions.length === 1) {
    logger.warn(`只配置了单一密钥版本 v${versions[0]}：没有"更新的版本"可迁移（如需轮换：先配 ENCRYPTION_KEYS="${versions[0]}:<旧>,${versions[0] + 1}:<新>" 再跑本脚本）`);
  }
  logger.info(`数据库：${target.redacted}`);
  logger.info(`模式：${apply ? 'APPLY（写库）' : 'DRY-RUN（只判定，不写库）'}；batch=${batchSize}；limit=${limit === 0 ? '不限' : limit}`);

  const prisma = new PrismaClient();
  let stats: RewrapStats;
  try {
    stats = await runRewrap(asStore(prisma), crypto, {
      batchSize, limit, apply, maxFailureDetails,
    });
  } catch (err) {
    // 扫描/事务之外的意外错误（连接中断等）：不吞、如实非 0 退出
    fail(logger, `迁移执行失败：${(err as Error).message}`, EXIT_FAIL);
  } finally {
    await prisma.$disconnect().catch(() => undefined);
  }

  // 审计输出：失败行逐条（机器可 grep；**绝不含明文/密钥**）
  for (const failure of stats.failures) {
    logger.error(`[${REWRAP_CODE}] credential=${failure.id} connection=${failure.connectionId} type=${failure.type} keyVersion=${failure.keyVersion} error=${failure.code} 原因=${failure.reason}`);
  }
  if (stats.failuresTruncated > 0) logger.error(`（另有 ${stats.failuresTruncated} 条失败明细因上限未逐条输出）`);
  for (const batchError of stats.batchErrors) {
    logger.error(`批 ${batchError.batch} 事务失败并回滚：error=${batchError.code} 原因=${batchError.reason}`);
  }

  const fromSummary = Object.entries(stats.fromVersions)
    .map(([v, n]) => `v${v}→v${stats.targetVersion}:${n}`)
    .join(' ') || '（无）';
  logger.info('———— 审计摘要 ————');
  logger.info(`扫描 ${stats.scanned} 行 / ${stats.batches} 批；耗时 ${formatDuration(stats.durationMs)}`);
  logger.info(`${stats.dryRun ? '待迁移' : '已迁移'} ${stats.rewritten} 行（源版本分布：${fromSummary}）`);
  logger.info(`无需迁移 ${stats.upToDate} 行；keyVersion 列漂移纠正 ${stats.driftFixed} 行；并发替换跳过 ${stats.concurrentSkipped} 行`);
  logger.info(`失败 ${stats.failed} 行；仍未处于当前版本 ${stats.remaining} 行${stats.limitReached ? '（--limit 已收尾，剩余行未扫描）' : ''}`);

  if (stats.aborted) fail(logger, '批次事务失败已中止（前序批次已提交）：修复数据库问题后重跑本脚本（幂等）', EXIT_FAIL);
  if (stats.failed > 0) {
    fail(logger, `存在 ${stats.failed} 行无法迁移（读路径将以 ${REWRAP_CODE} 告警）：请核对密钥集是否缺少这些密文所需的版本——**在迁移完成前绝不摘除旧版本密钥**`, EXIT_VERIFY);
  }
  if (stats.concurrentSkipped > 0) {
    logger.warn(`${stats.concurrentSkipped} 行在写回时被并发替换（store() 删除重建语义）已跳过：通常已是当前版本；如需确认可再跑一次（幂等）`);
  }
  if (stats.dryRun && stats.rewritten > 0) {
    logger.info(`DRY-RUN 结束：${stats.rewritten} 行需要迁移；加 --apply 执行（幂等，可分批 --limit 灰度）`);
  } else if (stats.rewritten === 0) {
    logger.info(`无需迁移：全部已处于当前版本 v${stats.targetVersion}`);
  }

  if (values.json === true) {
    // 同步写 fd 1：process.exit 会截断管道里未 flush 的缓冲输出，而编排正是靠这一行消费结果
    writeSync(1, `${JSON.stringify({ script: SCRIPT, ...stats, database: target.redacted })}\n`);
  }
  process.exit(EXIT_OK);
}

void main();
