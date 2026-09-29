import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { ObservabilityService } from '../../core/tracing/observability.service';
import type { StorageAdapter, StorageObjectInfo } from '../../core/storage/storage.types';
import { SchedulerService } from './scheduler.service';
import { RecurringJobProvisioner } from './recurring-job-provisioner';

/**
 * M12-P5：**孤儿存储对象清扫**（M12 审计项："孤儿附件清扫器缺 storage list 能力"）。
 *
 * 背景：附件/媒体产物/知识文件的字节落在对象存储（local 驱动即磁盘目录），元数据在 DB
 * （`Attachment.storageKey` / `Document.storageKey` / `Artifact.storageKey`）。两条链路一旦错位——
 * 上传成功但事务回滚、任务失败只有半截对象、历史清理只删了 DB 行——**字节就成了无主孤儿的净增量**：
 * 没有任何既有机制会回收它（媒体清扫只动任务状态，不动物件）。本服务补上这个收尾环节。
 *
 * 判定（**保守到近乎保守过头**，因为对象删除不可逆）：
 * 1. 只处理驱动**支持枚举**的情况（`StorageAdapter.list` 可选能力）。驱动不支持 ⇒ 明确记为
 *    `supported: false` 并告警，**绝不**把"没扫"报告成"干净"；
 * 2. 只处理**超龄**对象（`lastModified < now - minAgeDays`，默认 7 天）——上传-落库的窗口、
 *    排队中的任务、刚生成还没登记的文件都在保护期内；
 * 3. **年龄未知（`lastModified === null`）的对象永不删除**（拿不到时间就不猜年龄）；
 * 4. 只删除 **DB 三张表里都查不到 `storageKey`** 的对象（Attachment ∪ Document ∪ Artifact 并集）；
 * 5. 保护前缀（备份归档等**非业务对象**）永不删除——业务桶与备份桶分离是既有约定
 *    （见 scripts/backup.ts `--bucket db-backups` 的告警），此处再加一道兜底；
 * 6. **默认干跑**（`apply = false`）：只统计不删除；真正删除需显式开启
 *    （job payload `{ "apply": true }` 或 env `STORAGE_ORPHAN_SWEEP_APPLY=true`）。
 *
 * 有界性（与其他周期任务同一范式）：单页 200 个对象、单次最多 25 页、单次最多删 200 个；
 * 到上限即停并把 `truncated` 如实回显——剩余留给下一个周期（绝不长时间占用 worker）。
 * 幂等：删除本身幂等（对象不存在即 no-op），重复执行不会二次伤害；DB 引用判定每轮重算，绝不缓存。
 *
 * 失败语义：枚举失败（S3 超时等）**向上抛**（作业按失败重试），但抛出前会把本轮的**部分统计**打成
 * 一条 warn——"扫了一半炸了"必须与"扫完没发现孤儿"可区分。
 *
 * 绝不做的事：不动 DB 行（只读三张引用表）、不动非超龄对象、不动无法判定年龄的对象、不删保护前缀。
 */
export const STORAGE_ORPHAN_SWEEP_HANDLER = 'storage.orphan-sweep';
/** 平台周期作业身份（幂等键稳定且**版本化**：语义变更才换 v2） */
export const STORAGE_ORPHAN_SWEEP_IDEMPOTENCY_KEY = 'platform:storage-orphan-sweep:v1';
/** 周期：每日 04:41（UTC）——避开整点、UTC 日界与保留策略（03:23）时段 */
export const STORAGE_ORPHAN_SWEEP_CRON = '41 4 * * *';
export const STORAGE_ORPHAN_SWEEP_JOB_NAME = '孤儿存储对象清扫（超龄未引用对象）';

/** 超龄门槛（天）：小于它的对象一律不碰（上传-落库窗口 / 进行中的任务） */
export const DEFAULT_ORPHAN_MIN_AGE_DAYS = 7;
/** 单页枚举上限（同时是 DB `in` 查询的规模上界） */
export const DEFAULT_ORPHAN_PAGE_LIMIT = 200;
/** 单次执行的页数预算（200 × 25 = 单次最多看 5000 个对象） */
export const DEFAULT_ORPHAN_MAX_PAGES = 25;
/** 单次执行的删除预算（真正的删除动作） */
export const DEFAULT_ORPHAN_MAX_DELETES = 200;
/**
 * 保护前缀（**永不删除**）：非业务对象（备份归档/清单）即便落在同一个桶里也不会被清掉。
 * env `STORAGE_ORPHAN_SWEEP_PROTECTED_PREFIXES` 可**追加**（逗号分隔）——只增不减，绝不因配置而放开保护。
 */
export const DEFAULT_ORPHAN_PROTECTED_PREFIXES = ['backups/', 'backup/', 'db-backups/', 'manifests/'] as const;

const DAY_MS = 24 * 60 * 60 * 1_000;

export interface StorageOrphanSweepOptions {
  /** 真正执行删除（缺省 = 干跑）。周期作业默认不写 payload ⇒ 干跑；运维可显式开启或按 env 生效 */
  apply?: boolean;
  minAgeDays?: number;
  pageLimit?: number;
  maxPages?: number;
  maxDeletes?: number;
  /** 注入"当前时间"（测试确定性；生产绝不用） */
  now?: Date;
}

export interface StorageOrphanSweepResult {
  /** 驱动是否支持枚举（false ⇒ 本次什么都没扫，其余计数一律为 0） */
  supported: boolean;
  /** 是否真的删了（false = 干跑） */
  applied: boolean;
  /** 枚举到的对象总数（含被跳过的） */
  scanned: number;
  /** 通过"超龄 + 未引用 + 非保护前缀"判定、进入删除动作（或干跑计数）的对象数 */
  candidates: number;
  /** 实际删除成功数（干跑恒为 0） */
  deleted: number;
  /** 删除失败数（单对象失败不中断整轮） */
  failed: number;
  /** 因保护前缀跳过 */
  protectedSkipped: number;
  /** 因"年龄未知"（lastModified=null）跳过 */
  unknownAgeSkipped: number;
  /** 仍有未扫完的对象 / 删除预算用尽（下个周期继续） */
  truncated: boolean;
  /** 生效的超龄门槛（回显，便于日志/测试断言） */
  minAgeDays: number;
  /** 截止时刻（严格早于它的对象才可能被删） */
  cutoff: Date;
  /** 枚举的页数 */
  pages: number;
}

/** 超龄天数解析（env STORAGE_ORPHAN_MIN_AGE_DAYS；非法/非正 → 默认 7 天） */
export function orphanMinAgeDays(): number {
  const raw = process.env.STORAGE_ORPHAN_MIN_AGE_DAYS ?? process.env.storageOrphanMinAgeDays;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : DEFAULT_ORPHAN_MIN_AGE_DAYS;
}

/** 是否开启真正删除（env；缺省 false = 干跑——"默认不删"是安全默认） */
export function orphanSweepApply(): boolean {
  const raw = (process.env.STORAGE_ORPHAN_SWEEP_APPLY ?? process.env.storageOrphanSweepApply ?? '').trim().toLowerCase();
  return raw === 'true' || raw === '1' || raw === 'yes';
}

/** 保护前缀（默认集 ∪ env 追加集；env 只做加法） */
export function orphanProtectedPrefixes(): string[] {
  const extra = (process.env.STORAGE_ORPHAN_SWEEP_PROTECTED_PREFIXES ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s.length > 0);
  return [...new Set([...DEFAULT_ORPHAN_PROTECTED_PREFIXES, ...extra])];
}

function clampInt(value: number | undefined, fallback: number, min: number, max: number): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(Math.max(Math.trunc(n), min), max);
}

@Injectable()
export class StorageOrphanSweepService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger('StorageOrphanSweep');
  private readonly provisioner: RecurringJobProvisioner;

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(SchedulerService) private readonly scheduler: SchedulerService,
    @Inject('STORAGE_ADAPTER') private readonly storage: StorageAdapter,
    @Inject(ObservabilityService) private readonly metrics: ObservabilityService,
  ) {
    this.provisioner = new RecurringJobProvisioner({
      prisma,
      scheduler,
      logger: this.logger,
      spec: {
        name: STORAGE_ORPHAN_SWEEP_JOB_NAME,
        handler: STORAGE_ORPHAN_SWEEP_HANDLER,
        cron: STORAGE_ORPHAN_SWEEP_CRON,
        idempotencyKey: STORAGE_ORPHAN_SWEEP_IDEMPOTENCY_KEY,
        // 单次执行有界（25 页 × 200 对象 / 200 删除）；失败退避重投 3 次仍失败 → dead（运维面可见）
        timeoutMs: 600_000, maxAttempts: 3, backoffMs: 5_000,
        inactiveHint: '孤儿对象清扫当前停用，需运维显式 resume',
      },
    });
  }

  /**
   * 启动：① 注册 handler（纯内存，必须成功——否则运维/测试建的同 handler 作业会被判"未注册"）；
   * ② 开通平台周期作业（周期探测 + 退避重试，绝不阻塞启动）。
   * 本服务由 SchedulerModule 提供（API 与 Worker 两进程共同导入）：真实执行方是 worker。
   */
  async onModuleInit(): Promise<void> {
    this.scheduler.registerHandler(STORAGE_ORPHAN_SWEEP_HANDLER, (ctx) =>
      this.sweep((ctx.payload ?? {}) as StorageOrphanSweepOptions).then(() => undefined));
    await this.provisioner.start();
  }

  onModuleDestroy(): void {
    this.provisioner.stop();
  }

  /** 单轮清扫（幂等；缺省干跑）。详见文件头注释的判定与边界。 */
  async sweep(opts: StorageOrphanSweepOptions = {}): Promise<StorageOrphanSweepResult> {
    const minAgeDays = clampInt(opts.minAgeDays, orphanMinAgeDays(), 1, 3_650);
    const pageLimit = clampInt(opts.pageLimit, DEFAULT_ORPHAN_PAGE_LIMIT, 1, 1_000);
    const maxPages = clampInt(opts.maxPages, DEFAULT_ORPHAN_MAX_PAGES, 1, 1_000);
    const maxDeletes = clampInt(opts.maxDeletes, DEFAULT_ORPHAN_MAX_DELETES, 1, 10_000);
    const apply = opts.apply ?? orphanSweepApply();
    const cutoff = new Date((opts.now ?? new Date()).getTime() - minAgeDays * DAY_MS);
    const protectedPrefixes = orphanProtectedPrefixes();

    const list = this.storage.list;
    if (typeof list !== 'function') {
      // 能力缺失 ≠ 空桶：如实回显 supported=false 并告警（绝不把"没扫"说成"干净"）
      this.logger.warn(
        { driver: this.storage.constructor?.name ?? 'unknown' },
        '存储驱动不支持对象枚举（list 能力缺失）→ 孤儿对象清扫本轮未执行（这不是"没有孤儿"的结论）',
      );
      return {
        supported: false, applied: false, scanned: 0, candidates: 0, deleted: 0, failed: 0,
        protectedSkipped: 0, unknownAgeSkipped: 0, truncated: false, minAgeDays, cutoff, pages: 0,
      };
    }

    let scanned = 0;
    let candidates = 0;
    let deleted = 0;
    let failed = 0;
    let protectedSkipped = 0;
    let unknownAgeSkipped = 0;
    let pages = 0;
    let cursor: string | null = null;
    let truncated = false;

    for (let page = 0; page < maxPages; page++) {
      let res;
      try {
        res = await list.call(this.storage, { limit: pageLimit, cursor });
      } catch (err) {
        // 部分统计必须先留痕：枚举中断 ≠ 扫完没发现孤儿（作业会按失败重试，语义是"本轮未完成"）
        this.logger.warn(
          { pages, scanned, candidates, deleted, failed, err: message(err) },
          '孤儿对象清扫枚举中断（本轮未完成；已完成的统计如下）',
        );
        throw err;
      }
      pages += 1;
      scanned += res.objects.length;

      const eligible: StorageObjectInfo[] = [];
      for (const obj of res.objects) {
        if (this.isProtected(obj.key, protectedPrefixes)) { protectedSkipped += 1; continue; }
        if (obj.lastModified === null) { unknownAgeSkipped += 1; continue; } // 年龄未知：永不删
        if (obj.lastModified.getTime() >= cutoff.getTime()) continue;        // 未超龄
        eligible.push(obj);
      }

      if (eligible.length > 0) {
        const referenced = await this.referencedKeys(eligible.map((o) => o.key));
        for (const obj of eligible) {
          if (referenced.has(obj.key)) continue; // DB 有主：绝不动
          candidates += 1;
          if (!apply) continue;
          if (deleted + failed >= maxDeletes) { truncated = true; break; }
          try {
            await this.storage.delete(obj.key);
            deleted += 1;
          } catch (err) {
            failed += 1; // 单对象失败不中断整轮（下个周期会再遇到它）
            this.logger.warn({ key: obj.key, err: message(err) }, '孤儿对象删除失败（下轮重试）');
          }
        }
      }

      cursor = res.nextCursor;
      if (cursor === null) break;                                  // 扫到末尾：本轮完整
      if (apply && deleted + failed >= maxDeletes) { truncated = true; break; }
      if (page === maxPages - 1) truncated = true;                 // 页预算用尽且还有下一页
    }

    if (candidates > 0) {
      this.logger.log(
        { applied: apply, scanned, candidates, deleted, failed, protectedSkipped, unknownAgeSkipped, truncated, minAgeDays, cutoff },
        apply ? '孤儿对象清扫完成（已删除未引用超龄对象）' : '孤儿对象清扫完成（干跑：仅统计，未删除）',
      );
    } else {
      // 0 候选也留痕（debug）："扫了但没孤儿"与"没扫"必须可区分
      this.logger.debug({ scanned, pages, protectedSkipped, unknownAgeSkipped, minAgeDays, cutoff }, '孤儿对象清扫完成：无候选');
    }
    if (truncated) {
      this.logger.warn(
        { scanned, pages, maxPages, deleted, failed, maxDeletes },
        '孤儿对象清扫达到单轮预算：剩余对象由下个周期继续（调大 maxPages/maxDeletes 或提高频率）',
      );
    }

    // 活性指标：value = 实际删除数（干跑恒 0），labels 回显干跑与预算状态（平台级事实 → organizationId 显式 null）
    await this.metrics.recordMetric('storage_orphan_sweep_deleted', deleted, 'count', {
      apply, dryRun: !apply, scanned, candidates, failed, truncated, minAgeDays,
    }, null);

    return {
      supported: true, applied: apply, scanned, candidates, deleted, failed,
      protectedSkipped, unknownAgeSkipped, truncated, minAgeDays, cutoff, pages,
    };
  }

  /** 保护前缀判定（大小写无关；前缀语义与 storage key 的 POSIX 口径一致） */
  private isProtected(key: string, prefixes: string[]): boolean {
    const lower = key.toLowerCase();
    return prefixes.some((p) => lower.startsWith(p));
  }

  /**
   * 三张引用表的并集：这些 key 是**有主**的（Attachment ∪ Document ∪ Artifact）。
   * 只查传入的这一批 key（`IN` 有界），绝不整表载入；`Document.storageKey` 可空，空值天然不命中。
   */
  private async referencedKeys(keys: string[]): Promise<Set<string>> {
    const [attachments, documents, artifacts] = await Promise.all([
      this.prisma.attachment.findMany({ where: { storageKey: { in: keys } }, select: { storageKey: true } }),
      this.prisma.document.findMany({ where: { storageKey: { in: keys } }, select: { storageKey: true } }),
      this.prisma.artifact.findMany({ where: { storageKey: { in: keys } }, select: { storageKey: true } }),
    ]);
    const out = new Set<string>();
    for (const row of [...attachments, ...documents, ...artifacts]) {
      if (typeof row.storageKey === 'string' && row.storageKey.length > 0) out.add(row.storageKey);
    }
    return out;
  }
}

function message(err: unknown): string {
  return err instanceof Error ? err.message || err.name : String(err);
}
