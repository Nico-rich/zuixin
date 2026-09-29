import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Logger } from '@nestjs/common';
import {
  StorageOrphanSweepService, STORAGE_ORPHAN_SWEEP_HANDLER, STORAGE_ORPHAN_SWEEP_CRON,
  STORAGE_ORPHAN_SWEEP_IDEMPOTENCY_KEY, STORAGE_ORPHAN_SWEEP_JOB_NAME,
  DEFAULT_ORPHAN_MIN_AGE_DAYS, DEFAULT_ORPHAN_PAGE_LIMIT, DEFAULT_ORPHAN_MAX_PAGES,
  DEFAULT_ORPHAN_MAX_DELETES, DEFAULT_ORPHAN_PROTECTED_PREFIXES,
  orphanMinAgeDays, orphanProtectedPrefixes,
} from './storage-orphan-sweep.service';
import type { JobHandler, JobHandlerContext } from './scheduler.service';
import type {
  StorageAdapter, StorageListOptions, StorageListPage, StorageObjectInfo,
} from '../../core/storage/storage.types';

/**
 * M12-P5 单测（审计项：「孤儿附件清扫器缺少存储 list 能力」）：不触 DB/存储/队列——
 * prisma/scheduler/storage/metrics 均为替身。
 *
 * 断言契约（判定顺序即风险顺序）：能力缺失 ≠ 空桶 → 只碰超龄对象 → 年龄未知永不删 →
 * DB 三表引用并集 → 保护前缀 → 默认干跑 → 单轮有界（页/删除预算）+ truncated 如实回显 →
 * 枚举失败先留部分统计再上抛 → 活性指标。
 */
const DAY_MS = 24 * 60 * 60 * 1_000;
/** 注入的"当前时刻"（判定全部相对它，因此断言与真实时钟无关） */
const NOW = new Date('2026-09-29T12:00:00.000Z');

const daysAgo = (n: number) => new Date(NOW.getTime() - n * DAY_MS);
const obj = (key: string, lastModified: Date | null, sizeBytes = 1_024): StorageObjectInfo =>
  ({ key, lastModified, sizeBytes });
const page = (objects: StorageObjectInfo[], nextCursor: string | null = null): StorageListPage =>
  ({ objects, nextCursor });

/** 存储驱动替身：`list` 缺省即"驱动不支持枚举"（undefined 与"返回空页"必须可区分） */
class FakeStorage {
  // 声明为可变参数：否则 `mock.calls[0]` 是空元组 `[]`，`calls[0][0]` 在 strict 下不可访问（TS2493）
  readonly put = vi.fn(async (..._args: unknown[]) => undefined);
  readonly createPresignedUrl = vi.fn(async (..._args: unknown[]) => 'https://storage.invalid/obj');
  readonly delete = vi.fn(async (..._args: unknown[]) => undefined);
  list?: (options?: StorageListOptions) => Promise<StorageListPage>;
  constructor(list?: FakeStorage['list']) { this.list = list; }
}

type RefTable = 'attachment' | 'document' | 'artifact';

function makeService(input: {
  /** false ⇒ 驱动不实现 list（能力缺失，不是空桶） */
  list?: false;
  /** DB 引用事实（三张引用表各自的 storageKey 集合） */
  refs?: Partial<Record<RefTable, string[]>>;
} = {}) {
  const refs: Record<RefTable, Set<string>> = {
    attachment: new Set(input.refs?.attachment ?? []),
    document: new Set(input.refs?.document ?? []),
    artifact: new Set(input.refs?.artifact ?? []),
  };
  /** 引用表替身：按 DB 语义只返回"确实命中 in 列表"的行（空值 storageKey 天然不命中） */
  const table = (set: Set<string>) =>
    vi.fn(async (args: { where: { storageKey: { in: string[] } } }) =>
      args.where.storageKey.in
        .filter((k) => set.has(k))
        // 返回类型放宽到 `string | null`：Document.storageKey 可空，测试需要注入空值行
        .map((storageKey): { storageKey: string | null } => ({ storageKey })));
  const prisma = {
    user: { findFirst: vi.fn(async () => ({ id: 'admin-1' })) },
    scheduledJob: { findFirst: vi.fn(async () => null as { id: string; status: string } | null) },
    attachment: { findMany: table(refs.attachment) },
    document: { findMany: table(refs.document) },
    artifact: { findMany: table(refs.artifact) },
  };
  const handlers = new Map<string, JobHandler>();
  const scheduler = {
    registerHandler: vi.fn((name: string, fn: JobHandler) => { handlers.set(name, fn); }),
    schedule: vi.fn(async () => ({ job: { id: 'sched-1', status: 'scheduled' }, created: true })),
    getHandler: (name: string) => handlers.get(name),
  };
  const metrics = { recordMetric: vi.fn(async () => undefined) };
  const list = vi.fn(async (_options?: StorageListOptions): Promise<StorageListPage> =>
    ({ objects: [], nextCursor: null }));
  const storage = new FakeStorage(input.list === false ? undefined : (list as unknown as FakeStorage['list']));
  const svc = new StorageOrphanSweepService(
    prisma as never, scheduler as never, storage as unknown as StorageAdapter, metrics as never,
  );
  return { svc, prisma, scheduler, metrics, handlers, storage, list };
}

const ctx = (payload: Record<string, unknown> | null = null): JobHandlerContext => ({
  jobId: 'job-1', name: 'n', handler: STORAGE_ORPHAN_SWEEP_HANDLER, attempt: 1,
  payload, organizationId: null, traceId: null,
});

describe('StorageOrphanSweepService.sweep（M12-P5：保守 + 有界 + 默认干跑）', () => {
  const prevEnv = {
    apply: process.env.STORAGE_ORPHAN_SWEEP_APPLY,
    applyCamel: process.env.storageOrphanSweepApply,
    minAge: process.env.STORAGE_ORPHAN_MIN_AGE_DAYS,
    minAgeCamel: process.env.storageOrphanMinAgeDays,
    prefixes: process.env.STORAGE_ORPHAN_SWEEP_PROTECTED_PREFIXES,
  };
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.STORAGE_ORPHAN_SWEEP_APPLY;
    delete process.env.storageOrphanSweepApply;
    delete process.env.STORAGE_ORPHAN_MIN_AGE_DAYS;
    delete process.env.storageOrphanMinAgeDays;
    delete process.env.STORAGE_ORPHAN_SWEEP_PROTECTED_PREFIXES;
  });
  afterEach(() => {
    const restore = (k: string, v: string | undefined) => { if (v === undefined) delete process.env[k]; else process.env[k] = v; };
    restore('STORAGE_ORPHAN_SWEEP_APPLY', prevEnv.apply);
    restore('storageOrphanSweepApply', prevEnv.applyCamel);
    restore('STORAGE_ORPHAN_MIN_AGE_DAYS', prevEnv.minAge);
    restore('storageOrphanMinAgeDays', prevEnv.minAgeCamel);
    restore('STORAGE_ORPHAN_SWEEP_PROTECTED_PREFIXES', prevEnv.prefixes);
  });

  it('驱动无 list 能力 ⇒ supported:false（能力缺失 ≠ 空桶）：不删、不查引用表、只告警', async () => {
    const { svc, prisma, storage, metrics } = makeService({ list: false });
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    try {
      await expect(svc.sweep({ now: NOW })).resolves.toMatchObject({
        supported: false, applied: false, scanned: 0, candidates: 0, deleted: 0, failed: 0,
        protectedSkipped: 0, unknownAgeSkipped: 0, truncated: false, pages: 0,
        minAgeDays: DEFAULT_ORPHAN_MIN_AGE_DAYS,
      });
      expect(storage.delete).not.toHaveBeenCalled();
      expect(prisma.attachment.findMany).not.toHaveBeenCalled();
      expect(prisma.document.findMany).not.toHaveBeenCalled();
      expect(prisma.artifact.findMany).not.toHaveBeenCalled();
      expect(metrics.recordMetric).not.toHaveBeenCalled(); // 早退路径：本轮没有删除事实可记
      expect(warn).toHaveBeenCalledWith(
        expect.objectContaining({ driver: 'FakeStorage' }),
        expect.stringContaining('list 能力缺失'),
      );
    } finally {
      warn.mockRestore();
    }
  });

  it('默认干跑：候选如实统计但一个都不删（applied=false / deleted=0）；只有超龄对象进 DB 引用查询', async () => {
    const { svc, prisma, storage, list } = makeService({ refs: { attachment: ['old/att-1'] } });
    list.mockResolvedValueOnce(page([
      obj('old/unref-1', daysAgo(8)),        // 超龄 + 未引用 ⇒ 候选
      obj('old/att-1', daysAgo(8)),          // 超龄 + DB 有主 ⇒ 跳过
      obj('fresh-1', daysAgo(1)),            // 未超龄 ⇒ 连引用查询都不进
      obj('unknown-1', null),                // 年龄未知 ⇒ 永不删
      obj('backups/2026-09-29.sql', daysAgo(30)), // 保护前缀 ⇒ 永不删
    ]));
    const res = await svc.sweep({ now: NOW });
    expect(res).toMatchObject({
      supported: true, applied: false, scanned: 5, candidates: 1, deleted: 0, failed: 0,
      protectedSkipped: 1, unknownAgeSkipped: 1, truncated: false, pages: 1,
      minAgeDays: DEFAULT_ORPHAN_MIN_AGE_DAYS,
    });
    expect(res.cutoff).toEqual(new Date(NOW.getTime() - DEFAULT_ORPHAN_MIN_AGE_DAYS * DAY_MS));
    expect(storage.delete).not.toHaveBeenCalled(); // 干跑：绝不产生写副作用
    // 引用查询只带"通过年龄 + 前缀筛选"的 key（未超龄/保护前缀绝不进 IN 列表），三表并查
    const expectedIn = ['old/unref-1', 'old/att-1'];
    for (const t of ['attachment', 'document', 'artifact'] as const) {
      expect(prisma[t].findMany).toHaveBeenCalledWith({ where: { storageKey: { in: expectedIn } }, select: { storageKey: true } });
    }
  });

  it('payload apply=true ⇒ 只删"超龄 + 未引用 + 非保护前缀"的对象（其余一律不动）', async () => {
    const { svc, storage, list } = makeService({ refs: { attachment: ['old/att-1'] } });
    list.mockResolvedValueOnce(page([
      obj('old/unref-1', daysAgo(8)),
      obj('old/unref-2', daysAgo(9)),
      obj('old/att-1', daysAgo(8)),
      obj('fresh-1', daysAgo(1)),
      obj('unknown-1', null),
      obj('manifests/index.json', daysAgo(30)),
    ]));
    const res = await svc.sweep({ apply: true, now: NOW });
    expect(res).toMatchObject({ applied: true, scanned: 6, candidates: 2, deleted: 2, failed: 0, truncated: false });
    expect(storage.delete.mock.calls.map((c) => c[0])).toEqual(['old/unref-1', 'old/unref-2']);
  });

  it('env STORAGE_ORPHAN_SWEEP_APPLY=true/1/yes 同样开启删除；显式 apply:false 优先（运维可临时压回干跑）', async () => {
    for (const raw of ['true', '1', 'yes', 'TRUE']) {
      vi.clearAllMocks();
      process.env.STORAGE_ORPHAN_SWEEP_APPLY = raw;
      const { svc, storage, list } = makeService();
      list.mockResolvedValueOnce(page([obj('old/unref-1', daysAgo(8))]));
      await expect(svc.sweep({ now: NOW })).resolves.toMatchObject({ applied: true, deleted: 1 });
      expect(storage.delete).toHaveBeenCalledWith('old/unref-1');
    }

    for (const raw of ['false', '0', '']) {
      vi.clearAllMocks();
      process.env.STORAGE_ORPHAN_SWEEP_APPLY = raw;
      const { svc, storage, list } = makeService();
      list.mockResolvedValueOnce(page([obj('old/unref-1', daysAgo(8))]));
      await expect(svc.sweep({ now: NOW })).resolves.toMatchObject({ applied: false, candidates: 1, deleted: 0 });
      expect(storage.delete).not.toHaveBeenCalled();
    }

    process.env.STORAGE_ORPHAN_SWEEP_APPLY = 'true';
    const { svc, storage, list } = makeService();
    list.mockResolvedValueOnce(page([obj('old/unref-1', daysAgo(8))]));
    await expect(svc.sweep({ apply: false, now: NOW })).resolves.toMatchObject({ applied: false, deleted: 0 });
    expect(storage.delete).not.toHaveBeenCalled();
  });

  it('保守底线：未超龄（含恰好等于截止时刻）不候选；lastModified=null 的对象永不删', async () => {
    const { svc, storage, list } = makeService();
    list.mockResolvedValueOnce(page([
      obj('fresh-3d', daysAgo(3)),
      obj('boundary-7d', new Date(NOW.getTime() - DEFAULT_ORPHAN_MIN_AGE_DAYS * DAY_MS)), // 恰好 = cutoff ⇒ 不删
      obj('ripe-8d', daysAgo(8)),
      obj('unknown-1', null),
    ]));
    const res = await svc.sweep({ apply: true, now: NOW });
    expect(res).toMatchObject({ scanned: 4, candidates: 1, deleted: 1, unknownAgeSkipped: 1, truncated: false });
    expect(storage.delete.mock.calls.map((c) => c[0])).toEqual(['ripe-8d']);
  });

  it('超龄门槛：payload/env 可覆盖；非法/非正一律回落默认（绝不因误配变成"门槛 0 ⇒ 什么都删"）', async () => {
    const wide = makeService();
    wide.list.mockResolvedValue(page([obj('age-3d', daysAgo(3))]));
    await expect(wide.svc.sweep({ now: NOW })).resolves.toMatchObject({ minAgeDays: 7, candidates: 0 });
    await expect(wide.svc.sweep({ minAgeDays: 1, now: NOW })).resolves.toMatchObject({ minAgeDays: 1, candidates: 1 });

    const bad = makeService();
    bad.list.mockResolvedValue(page([obj('age-3d', daysAgo(3))]));
    await expect(bad.svc.sweep({ minAgeDays: 0, now: NOW })).resolves.toMatchObject({ minAgeDays: DEFAULT_ORPHAN_MIN_AGE_DAYS });
    await expect(bad.svc.sweep({ minAgeDays: Number.NaN, now: NOW })).resolves.toMatchObject({ minAgeDays: DEFAULT_ORPHAN_MIN_AGE_DAYS });

    process.env.STORAGE_ORPHAN_MIN_AGE_DAYS = '30';
    expect(orphanMinAgeDays()).toBe(30);
    await expect(bad.svc.sweep({ now: NOW })).resolves.toMatchObject({ minAgeDays: 30, candidates: 0 }); // 8 天前不再够格
  });

  it('DB 引用并集（Attachment ∪ Document ∪ Artifact）：任一表命中即绝不删；三表皆无才候选', async () => {
    const { svc, prisma, storage, list } = makeService({
      refs: { attachment: ['att-1'], document: ['doc-1'], artifact: ['art-1'] },
    });
    // Document.storageKey 可空：空值行必须被忽略（既不算引用，也不崩）
    prisma.document.findMany.mockResolvedValueOnce([{ storageKey: null }, { storageKey: 'doc-1' }]);
    list.mockResolvedValueOnce(page([
      obj('att-1', daysAgo(8)), obj('doc-1', daysAgo(8)), obj('art-1', daysAgo(8)), obj('orphan-1', daysAgo(8)),
    ]));
    const res = await svc.sweep({ apply: true, now: NOW });
    expect(res).toMatchObject({ scanned: 4, candidates: 1, deleted: 1, failed: 0 });
    expect(storage.delete.mock.calls.map((c) => c[0])).toEqual(['orphan-1']);
    expect(prisma.document.findMany.mock.calls[0][0]).toEqual({
      where: { storageKey: { in: ['att-1', 'doc-1', 'art-1', 'orphan-1'] } }, select: { storageKey: true },
    });
  });

  it('保护前缀默认集（backups/ backup/ db-backups/ manifests/）永不删，且根本不进 DB 引用查询', async () => {
    const { svc, prisma, storage, list } = makeService();
    list.mockResolvedValueOnce(page([
      obj('backups/2026-09-29.sql', daysAgo(30)),
      obj('backup/db.tar', daysAgo(30)),
      obj('db-backups/pg.dump', daysAgo(30)),
      obj('manifests/index.json', daysAgo(30)),
      obj('BACKUPS/UP.SQL', daysAgo(30)),      // 大小写无关
      obj('backups-archive/keep.bin', daysAgo(30)), // 前缀语义 ≠ 包含（不是保护对象）
      obj('orphan-1', daysAgo(30)),
    ]));
    const res = await svc.sweep({ apply: true, now: NOW });
    expect(res).toMatchObject({ scanned: 7, protectedSkipped: 5, candidates: 2, deleted: 2 });
    expect(storage.delete.mock.calls.map((c) => c[0])).toEqual(['backups-archive/keep.bin', 'orphan-1']);
    expect(prisma.attachment.findMany.mock.calls[0][0].where.storageKey.in)
      .toEqual(['backups-archive/keep.bin', 'orphan-1']); // 保护对象连查都不查
  });

  it('env STORAGE_ORPHAN_SWEEP_PROTECTED_PREFIXES 只做追加（默认集永不失效），空白项忽略', async () => {
    process.env.STORAGE_ORPHAN_SWEEP_PROTECTED_PREFIXES = ' media/raw/ ,TMP/ ,';
    expect(orphanProtectedPrefixes()).toEqual([...DEFAULT_ORPHAN_PROTECTED_PREFIXES, 'media/raw/', 'tmp/']);
    const { svc, storage, list } = makeService();
    list.mockResolvedValueOnce(page([
      obj('media/raw/a.bin', daysAgo(30)),
      obj('tmp/b.bin', daysAgo(30)),
      obj('backups/c.sql', daysAgo(30)),
      obj('orphan-1', daysAgo(30)),
    ]));
    const res = await svc.sweep({ apply: true, now: NOW });
    expect(res).toMatchObject({ protectedSkipped: 3, candidates: 1, deleted: 1 });
    expect(storage.delete.mock.calls.map((c) => c[0])).toEqual(['orphan-1']);
  });

  it('枚举选项：单页上限默认 200 / 显式生效 / 收敛上限 1000；游标逐页回传（绝不重复读同一页）', async () => {
    const dflt = makeService();
    dflt.list.mockResolvedValueOnce(page([], null));
    await dflt.svc.sweep({ now: NOW });
    expect(dflt.list.mock.calls[0][0]).toEqual({ limit: DEFAULT_ORPHAN_PAGE_LIMIT, cursor: null });

    const explicit = makeService();
    explicit.list
      .mockResolvedValueOnce(page([], 'cursor-2'))
      .mockResolvedValueOnce(page([], null));
    await explicit.svc.sweep({ pageLimit: 7, now: NOW });
    expect(explicit.list.mock.calls).toEqual([[{ limit: 7, cursor: null }], [{ limit: 7, cursor: 'cursor-2' }]]);

    const capped = makeService();
    capped.list.mockResolvedValueOnce(page([], null));
    await capped.svc.sweep({ pageLimit: 99_999, now: NOW });
    expect(capped.list.mock.calls[0][0]!.limit).toBe(1_000); // 绝不让"大页"把内存/DB IN 撑爆
  });

  it('页预算用尽且仍有下一页 ⇒ truncated=true 并告警；扫到末尾 ⇒ truncated=false 且不告警', async () => {
    const { svc, list } = makeService();
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    try {
      list.mockResolvedValue(page([obj('orphan-1', daysAgo(8))], 'more'));
      const res = await svc.sweep({ apply: true, maxPages: 2, now: NOW });
      expect(res).toMatchObject({ pages: 2, scanned: 2, truncated: true, deleted: 2, candidates: 2 });
      expect(list).toHaveBeenCalledTimes(2); // 绝不无界翻页
      expect(warn).toHaveBeenCalledWith(
        expect.objectContaining({ pages: 2, maxPages: 2, deleted: 2 }),
        expect.stringContaining('预算'),
      );

      warn.mockClear(); // 只关心第二轮：完整扫完不该有"预算用尽"的噪音
      const done = makeService();
      done.list.mockResolvedValueOnce(page([obj('orphan-1', daysAgo(8))], null));
      await expect(done.svc.sweep({ apply: true, now: NOW }))
        .resolves.toMatchObject({ pages: 1, scanned: 1, truncated: false, deleted: 1 });
      expect(done.storage.delete.mock.calls.map((c) => c[0])).toEqual(['orphan-1']);
      expect(warn).not.toHaveBeenCalled(); // 完整扫完：不该有"预算用尽"的噪音
    } finally {
      warn.mockRestore();
    }
  });

  it('删除预算用尽 ⇒ 立即停手并 truncated=true（剩余留给下个周期）；干跑不做删除预算截断（只统计）', async () => {
    const cut = makeService();
    cut.list.mockResolvedValueOnce(page([
      obj('orphan-1', daysAgo(8)), obj('orphan-2', daysAgo(8)), obj('orphan-3', daysAgo(8)), obj('orphan-4', daysAgo(8)),
    ], null));
    const res = await cut.svc.sweep({ apply: true, maxDeletes: 2, now: NOW });
    expect(res).toMatchObject({ scanned: 4, candidates: 3, deleted: 2, failed: 0, truncated: true, pages: 1 });
    expect(cut.storage.delete.mock.calls.map((c) => c[0])).toEqual(['orphan-1', 'orphan-2']);

    // 满页删完预算后仍有下一页 ⇒ 也如实标记 truncated
    const pagewise = makeService();
    pagewise.list.mockResolvedValue(page([obj('orphan-1', daysAgo(8)), obj('orphan-2', daysAgo(8))], 'more'));
    await expect(pagewise.svc.sweep({ apply: true, maxDeletes: 2, now: NOW }))
      .resolves.toMatchObject({ pages: 1, deleted: 2, truncated: true });
    expect(pagewise.list).toHaveBeenCalledTimes(1);

    const dry = makeService();
    dry.list.mockResolvedValueOnce(page([
      obj('orphan-1', daysAgo(8)), obj('orphan-2', daysAgo(8)), obj('orphan-3', daysAgo(8)), obj('orphan-4', daysAgo(8)),
    ], null));
    await expect(dry.svc.sweep({ maxDeletes: 1, now: NOW }))
      .resolves.toMatchObject({ candidates: 4, deleted: 0, truncated: false }); // 干跑不设删除预算
    expect(dry.storage.delete).not.toHaveBeenCalled();
  });

  it('list() 抛错 ⇒ 先留部分统计（warn）再上抛（作业按失败重试），绝不静默半途而废', async () => {
    const { svc, list, storage, metrics } = makeService();
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    try {
      list
        .mockResolvedValueOnce(page([obj('orphan-1', daysAgo(8)), obj('orphan-2', daysAgo(8))], 'more'))
        .mockRejectedValueOnce(new Error('S3 枚举超时'));
      await expect(svc.sweep({ apply: true, now: NOW })).rejects.toThrow('S3 枚举超时');
      expect(storage.delete).toHaveBeenCalledTimes(2); // 第一页已删的事实必须留痕（不是"什么都没发生"）
      expect(warn).toHaveBeenCalledWith(
        expect.objectContaining({ pages: 1, scanned: 2, candidates: 2, deleted: 2, failed: 0, err: 'S3 枚举超时' }),
        expect.stringContaining('枚举中断'),
      );
      expect(metrics.recordMetric).not.toHaveBeenCalled(); // 未完成的一轮绝不记"活性"
    } finally {
      warn.mockRestore();
    }
  });

  it('单对象删除失败不中断整轮：failed 如实计数 + 告警，其余对象照常删除', async () => {
    const { svc, storage, list } = makeService();
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    try {
      list.mockResolvedValueOnce(page([obj('bad-1', daysAgo(8)), obj('ok-1', daysAgo(8))], null));
      storage.delete.mockRejectedValueOnce(new Error('AccessDenied'));
      const res = await svc.sweep({ apply: true, now: NOW });
      expect(res).toMatchObject({ candidates: 2, deleted: 1, failed: 1, truncated: false });
      expect(storage.delete.mock.calls.map((c) => c[0])).toEqual(['bad-1', 'ok-1']);
      expect(warn).toHaveBeenCalledWith(
        expect.objectContaining({ key: 'bad-1', err: 'AccessDenied' }),
        expect.stringContaining('删除失败'),
      );
    } finally {
      warn.mockRestore();
    }
  });

  it('活性指标 storage_orphan_sweep_deleted = 实际删除数 + 干跑/预算 labels（平台级 organizationId 显式 null）', async () => {
    const { svc, metrics, list } = makeService({ refs: { attachment: ['old/att-1'] } });
    list.mockResolvedValueOnce(page([
      obj('old/unref-1', daysAgo(8)), obj('old/att-1', daysAgo(8)), obj('fresh-1', daysAgo(1)), obj('unknown-1', null),
    ], null));
    await svc.sweep({ apply: true, now: NOW });
    expect(metrics.recordMetric).toHaveBeenCalledWith(
      'storage_orphan_sweep_deleted', 1, 'count',
      expect.objectContaining({ apply: true, dryRun: false, scanned: 4, candidates: 1, failed: 0, truncated: false, minAgeDays: 7 }),
      null,
    );

    vi.clearAllMocks();
    const dry = makeService();
    dry.list.mockResolvedValueOnce(page([obj('old/unref-1', daysAgo(8)), obj('unknown-1', null)], null));
    await dry.svc.sweep({ now: NOW });
    expect(dry.metrics.recordMetric).toHaveBeenCalledWith(
      'storage_orphan_sweep_deleted', 0, 'count',
      expect.objectContaining({ apply: false, dryRun: true, scanned: 2, candidates: 1 }),
      null,
    );
  });
});

describe('StorageOrphanSweepService 启动接线（handler 注册 + 周期作业开通，绝不阻塞启动）', () => {
  beforeEach(() => { vi.clearAllMocks(); vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('onModuleInit：注册 handler=storage.orphan-sweep；开通 recurring 周期作业（幂等键 + cron + 平台 admin 归属 + 有界参数）', async () => {
    const { svc, scheduler } = makeService();
    await svc.onModuleInit();
    expect(scheduler.registerHandler).toHaveBeenCalledWith(STORAGE_ORPHAN_SWEEP_HANDLER, expect.any(Function));
    expect(scheduler.schedule).toHaveBeenCalledWith(expect.objectContaining({
      handler: STORAGE_ORPHAN_SWEEP_HANDLER, type: 'recurring', cron: STORAGE_ORPHAN_SWEEP_CRON,
      idempotencyKey: STORAGE_ORPHAN_SWEEP_IDEMPOTENCY_KEY, ownerUserId: 'admin-1', organizationId: null,
      payload: null, timeoutMs: 600_000, maxAttempts: 3, backoffMs: 5_000,
    }));
    expect(STORAGE_ORPHAN_SWEEP_CRON.split(/\s+/)).toHaveLength(5); // scheduler 的 cron 粗校验口径
    svc.onModuleDestroy();
  });

  it('handler 真实可执行：payload.apply=true 原样透传 ⇒ 走删除路径（周期作业默认不写 payload = 干跑）', async () => {
    const { svc, scheduler, storage, list } = makeService();
    await svc.onModuleInit();
    list.mockResolvedValueOnce(page([obj('orphan-1', new Date(Date.now() - 30 * DAY_MS))], null));
    const handler = scheduler.getHandler(STORAGE_ORPHAN_SWEEP_HANDLER)!;
    await expect(handler(ctx({ apply: true }))).resolves.toBeUndefined(); // handler 契约：只回报成功/失败
    expect(storage.delete).toHaveBeenCalledWith('orphan-1');

    list.mockResolvedValueOnce(page([obj('orphan-2', new Date(Date.now() - 30 * DAY_MS))], null));
    await handler(ctx(null)); // payload 缺省 ⇒ 干跑（安全默认）
    expect(storage.delete).toHaveBeenCalledTimes(1);
    svc.onModuleDestroy();
  });

  it('onModuleDestroy：停机清定时器（无泄漏），此后绝不再探测', async () => {
    const { svc, scheduler } = makeService();
    const baseline = vi.getTimerCount();
    await svc.onModuleInit();
    expect(vi.getTimerCount()).toBe(baseline + 1); // 开通后转入慢巡检（唯一新增定时器）
    svc.onModuleDestroy();
    expect(vi.getTimerCount()).toBe(baseline);
    svc.onModuleDestroy(); // 幂等
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(scheduler.schedule).toHaveBeenCalledTimes(1); // 停机后绝无残留探测
  });

  it('作业身份常量稳定（幂等键版本化：语义变更才换 v2；cron 避开整点与保留策略时段）', () => {
    expect(STORAGE_ORPHAN_SWEEP_HANDLER).toBe('storage.orphan-sweep');
    expect(STORAGE_ORPHAN_SWEEP_IDEMPOTENCY_KEY).toBe('platform:storage-orphan-sweep:v1');
    expect(STORAGE_ORPHAN_SWEEP_CRON).toBe('41 4 * * *');
    expect(STORAGE_ORPHAN_SWEEP_JOB_NAME).toContain('孤儿');
    expect([DEFAULT_ORPHAN_MIN_AGE_DAYS, DEFAULT_ORPHAN_PAGE_LIMIT, DEFAULT_ORPHAN_MAX_PAGES, DEFAULT_ORPHAN_MAX_DELETES])
      .toEqual([7, 200, 25, 200]);
  });
});
