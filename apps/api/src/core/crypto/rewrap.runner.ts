import { CryptoService } from './crypto.service';

/**
 * M11-P1（D1-09 / NV-11）：**密钥版本迁移执行器**（rewrap）。
 *
 * 背景（M10 审计结论）：`CryptoService.rewrap()` 是"库方法但无生产调用方"，`Credential.keyVersion`
 * 列恒为 1 —— 轮换能力在纸面上存在，实际**不可执行**：一旦 `ENCRYPTION_KEYS` 引入新版本，
 * 存量密文永远不会被迁移，旧密钥必须无限期保留。本执行器是 `rewrap()` 的**唯一生产调用点**。
 *
 * 设计要点（与 `scripts/rewrap.ts` 的运维口径一致）：
 * - **密文自述版本是唯一事实源**：是否需要迁移用 `crypto.needsRewrap(ciphertext)` 判定（而不是只看
 *   `keyVersion` 列）。列与密文失配（历史缺陷/人工改库）会被识别为 `driftFixed` 并按密文纠正——
 *   "`keyVersion` 与密文永不失配"是**本执行器维持的不变量**，不是它假设的前提。
 * - **主键分批扫描**（`id` 升序 + `where: { id: { gt: 上一批末行 } }`）：迁移只改
 *   `encryptedValue`/`keyVersion`，不动主键，因此位置在扫描过程中稳定 —— 不会漏行、不会重复处理同一行
 *   （幂等重跑亦安全）。**刻意不用 Prisma `cursor`**：`cursor` 行若被并发删除（凭证就是"删除重建"语义），
 *   Prisma 会返回**空集**，扫描会"看起来正常结束"却漏掉后面所有行 —— 这是最危险的一类静默半成品。
 * - **每批一个事务**：批内任一写入失败 ⇒ 整批回滚（绝不产出"半迁移批次"），已提交的前序批次保留；
 *   执行器就此中止并如实回报（`aborted` + `batchErrors`），由运维决定重跑（幂等）。
 * - **逐行失败不阻塞整批**：密文版本未知/格式非法（`KEY_VERSION_INVALID`）的行无法恢复明文，
 *   记入 `failures` 并继续处理其余行 —— 这些行正是读路径会以 `CREDENTIAL_REWRAP_REQUIRED`
 *   告警的"迁移欠账"（**绝不**产出"看起来迁移成功"的结果）。
 * - **CAS 写回**：`updateMany({ where: { id, encryptedValue: 旧密文 } })` —— 行被并发替换/删除
 *   （`CredentialService.store()` 是"删除重建"语义）时 `count === 0`，直接跳过：绝不覆盖他人写入的新密文。
 * - **绝不输出明文**：所有对外字段只有行 id / 连接 id / 类型 / 版本号 / 错误码与错误消息（消息内无密钥、无明文）。
 *
 * 注意：`Credential` 目前是**唯一**带 `keyVersion` 列的密文表（webhook secret / provider apiKey /
 * extension apiKey 的密文是自述版本、无独立列），因此端口只暴露 `credential`。
 */

/** 扫描行（仅取迁移需要的列；绝不取明文——表里本来也没有明文） */
export interface RewrapRow {
  id: string;
  connectionId: string;
  type: string;
  encryptedValue: string;
  keyVersion: number;
}

export interface RewrapFindManyArgs {
  take: number;
  /** 主键范围谓词（**不用 Prisma `cursor`**：cursor 行被并发删除时 Prisma 返回 0 行 ⇒ 静默截断，见 runRewrap 注释） */
  where?: { id: { gt: string } };
  orderBy: { id: 'asc' };
  select: { id: true; connectionId: true; type: true; encryptedValue: true; keyVersion: true };
}

export interface RewrapUpdateManyArgs {
  where: { id: string; encryptedValue?: string };
  data: { encryptedValue: string; keyVersion: number };
}

export interface RewrapWriteStore {
  updateMany(args: RewrapUpdateManyArgs): Promise<{ count: number }>;
}

/** 执行器依赖的最小数据库端口（结构化的 PrismaClient 子集；单测注入假库，脚本注入真实 Prisma） */
export interface RewrapStore {
  credential: RewrapWriteStore & {
    findMany(args: RewrapFindManyArgs): Promise<RewrapRow[]>;
  };
  $transaction<T>(fn: (tx: { credential: RewrapWriteStore }) => Promise<T>): Promise<T>;
}

export interface RewrapFailureDetail {
  id: string;
  connectionId: string;
  type: string;
  /** 列上记录的版本（诊断：与密文自述版本不一致即为 drift） */
  keyVersion: number;
  /** 失败错误码（`KEY_VERSION_INVALID` = 密文版本未知/格式非法，无法恢复明文） */
  code: string;
  /** 错误消息（不含密钥、不含明文） */
  reason: string;
}

export interface RewrapBatchError {
  /** 第几批（1 起） */
  batch: number;
  code: string;
  reason: string;
}

export interface RewrapStats {
  /** true = 只判定不写库 */
  dryRun: boolean;
  /** 扫描批次数 */
  batches: number;
  /** 扫描行数 */
  scanned: number;
  /** 已迁移（dry-run 下 = "将迁移"）的行数 */
  rewritten: number;
  /** 已是当前版本、无需改写的行数 */
  upToDate: number;
  /** `keyVersion` 列与密文自述版本失配、按密文纠正的行数（两个方向都算） */
  driftFixed: number;
  /** 写回时行已被并发替换/删除（CAS count=0）而跳过的行数 */
  concurrentSkipped: number;
  /** 无法迁移的行数（密文版本未知/格式非法） */
  failed: number;
  /** 运行结束后仍未处于当前版本的行数估计（failed + concurrentSkipped；幂等重跑可收敛） */
  remaining: number;
  /** 源版本分布（`版本 → 行数`，仅统计被迁移的行） */
  fromVersions: Record<string, number>;
  /** 失败明细（最多 `maxFailureDetails` 条；超出部分只计数） */
  failures: RewrapFailureDetail[];
  /** 因明细上限而未保留的失败条数 */
  failuresTruncated: number;
  /** 批次事务失败导致中止（前序批次已提交；幂等重跑可继续） */
  aborted: boolean;
  batchErrors: RewrapBatchError[];
  /** `--limit` 提前收尾（剩余行未扫描） */
  limitReached: boolean;
  durationMs: number;
  /** 当前写入版本（审计：迁移目标） */
  targetVersion: number;
  /** 已配置的密钥版本（升序；供审计"旧版本何时可摘除"） */
  configuredVersions: number[];
}

export interface RewrapOptions {
  /** 每批行数（默认 500） */
  batchSize?: number;
  /** 处理行数上限（0/undefined = 不限；供灰度/试跑） */
  limit?: number;
  /** true = 真正写库；默认 false（dry-run 只判定） */
  apply?: boolean;
  /** 失败明细保留上限（默认 100） */
  maxFailureDetails?: number;
}

export const DEFAULT_REWRAP_BATCH_SIZE = 500;
export const DEFAULT_MAX_FAILURE_DETAILS = 100;

function errCode(err: unknown): string {
  const code = (err as { code?: unknown })?.code;
  return typeof code === 'string' ? code : 'UNKNOWN';
}

function errReason(err: unknown): string {
  const msg = (err as { message?: unknown })?.message;
  return typeof msg === 'string' ? msg : String(err);
}

/**
 * 扫描并把"落后于当前密钥版本"的密文重加密为当前版本，同时把 `keyVersion` 列写回为密文自述版本。
 * 幂等：已是当前版本的行不写库；重复运行不产生额外写入。
 */
export async function runRewrap(
  store: RewrapStore,
  crypto: CryptoService,
  options: RewrapOptions = {},
): Promise<RewrapStats> {
  const startedAt = Date.now();
  const batchSize = Math.max(1, Math.trunc(options.batchSize ?? DEFAULT_REWRAP_BATCH_SIZE));
  const limit = options.limit && options.limit > 0 ? Math.trunc(options.limit) : 0;
  const apply = options.apply === true;
  const maxFailureDetails = Math.max(0, Math.trunc(options.maxFailureDetails ?? DEFAULT_MAX_FAILURE_DETAILS));

  const stats: RewrapStats = {
    dryRun: !apply,
    batches: 0,
    scanned: 0,
    rewritten: 0,
    upToDate: 0,
    driftFixed: 0,
    concurrentSkipped: 0,
    failed: 0,
    remaining: 0,
    fromVersions: {},
    failures: [],
    failuresTruncated: 0,
    aborted: false,
    batchErrors: [],
    limitReached: false,
    durationMs: 0,
    targetVersion: crypto.currentKeyVersion,
    configuredVersions: crypto.versions(),
  };

  const recordFailure = (detail: RewrapFailureDetail): void => {
    stats.failed += 1;
    if (stats.failures.length < maxFailureDetails) stats.failures.push(detail);
    else stats.failuresTruncated += 1;
  };

  interface Planned {
    id: string;
    /** CAS 谓词：只更新"我读到的这一版密文"（并发替换后 count=0 而非覆盖） */
    previousValue: string;
    payload: string;
    keyVersion: number;
    drift: boolean;
    from: number;
  }

  let lastId: string | undefined;
  for (;;) {
    // `--limit` 精确到行：收窄本批 take，避免"limit=3 却读了 500 行"（灰度试跑必须可预期）
    if (limit && stats.scanned >= limit) {
      stats.limitReached = true;
      break;
    }
    const take = limit ? Math.min(batchSize, limit - stats.scanned) : batchSize;
    const rows: RewrapRow[] = await store.credential.findMany({
      take,
      ...(lastId ? { where: { id: { gt: lastId } } } : {}),
      orderBy: { id: 'asc' },
      select: { id: true, connectionId: true, type: true, encryptedValue: true, keyVersion: true },
    });
    if (rows.length === 0) break;

    stats.batches += 1;
    lastId = rows[rows.length - 1].id;

    // 1) 批内逐行**纯计算**判定/迁移：单行失败（版本未知）只记该行，不影响同批其他行
    const planned: Planned[] = [];
    for (const row of rows) {
      stats.scanned += 1;
      let ciphertextVersion: number;
      try {
        ciphertextVersion = crypto.keyVersionOf(row.encryptedValue); // 格式非法 → KEY_VERSION_INVALID
      } catch (err) {
        recordFailure({
          id: row.id, connectionId: row.connectionId, type: row.type, keyVersion: row.keyVersion,
          code: errCode(err), reason: errReason(err),
        });
        continue;
      }
      const drift = row.keyVersion !== ciphertextVersion;
      if (crypto.needsRewrap(row.encryptedValue)) {
        try {
          const migrated = crypto.rewrap(row.encryptedValue); // from → 当前版本（版本未知在此抛错）
          // 后置断言：写库前必须自证"结果已是当前版本"——绝不让一个未迁移的密文被当作迁移结果落库
          crypto.assertCurrentVersion(migrated.payload);
          planned.push({
            id: row.id, previousValue: row.encryptedValue, payload: migrated.payload,
            keyVersion: migrated.to, drift, from: migrated.from,
          });
          stats.rewritten += 1;
          stats.fromVersions[String(migrated.from)] = (stats.fromVersions[String(migrated.from)] ?? 0) + 1;
          if (drift) stats.driftFixed += 1;
        } catch (err) {
          recordFailure({
            id: row.id, connectionId: row.connectionId, type: row.type, keyVersion: row.keyVersion,
            code: errCode(err), reason: errReason(err),
          });
        }
      } else {
        stats.upToDate += 1;
        // 密文已是当前版本，但列值说谎（向下漂移）→ 只纠正列，不重新加密（避免无谓的密文换代）
        if (drift) {
          planned.push({
            id: row.id, previousValue: row.encryptedValue, payload: row.encryptedValue,
            keyVersion: ciphertextVersion, drift: true, from: ciphertextVersion,
          });
          stats.driftFixed += 1;
        }
      }
    }

    // 2) 整批一个事务：任一写入失败 ⇒ 整批回滚（不产出半迁移批次），中止并回报
    if (apply && planned.length > 0) {
      try {
        await store.$transaction(async (tx) => {
          for (const item of planned) {
            const res = await tx.credential.updateMany({
              where: { id: item.id, encryptedValue: item.previousValue },
              data: { encryptedValue: item.payload, keyVersion: item.keyVersion },
            });
            // CAS 失配 = 该行已被并发替换/删除（store() 的删除重建语义）→ 跳过，不覆盖新密文
            if (res.count === 0) stats.concurrentSkipped += 1;
          }
        });
      } catch (err) {
        stats.batchErrors.push({ batch: stats.batches, code: errCode(err), reason: errReason(err) });
        stats.aborted = true;
        break;
      }
    }
  }

  stats.remaining = stats.failed + stats.concurrentSkipped;
  stats.durationMs = Date.now() - startedAt;
  return stats;
}
