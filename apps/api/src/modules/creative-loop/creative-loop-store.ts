/**
 * M10-P4 持久化落点（**专表**：`CreativeHypothesis` / `CreativeInsight`，W0 预整合 schema）。
 *
 * M9-P5 曾以通用文档容器 `Artifact(type='other', content.kind=...)` 承载（当时 schema 冻结），
 * 本文件把读写切换为专表——**容器污染防护由表结构天然保证**（不再有 kind 判别误读）：
 * - 组织归属 = `organizationId` 直列（**查询一律 server-side scope**，删除 JSON path 谓词）；
 * - 生命周期/判定事实（status/statement/successCriteria/loop/verdict/history）逐列落库，
 *   数据库级 CHECK（enum）与外键（组织/项目/用户）保证合法值与归属；
 * - 状态推进为 **status CAS + version CAS**（`updateMany` 谓词 = id + organizationId + status ∈ from
 *   + **version = 读取时版本**，count=0 → 调用方转 400/409）。**两个谓词缺一不可**：状态转移会写整份
 *   文档，若只锚定 status，则"读 → 并发 casFields 写非状态字段 → 本转移落库"会静默覆盖对方（双方都
 *   返回成功）——即 lost update（M11-P5/D2-02）。version 谓词使**任何**并发写入（状态推进/编辑/解读
 *   挂接）都让输家 count=0；
 * - 非状态字段更新为 **version CAS**（读时版本 → `where.version` 条件 + `version = version+1`），
 *   并发状态推进/并发编辑一律不被盲目覆盖；
 * - 洞察解读写入锚定 `factsHash` **且** version（双锚点）：事实层变化 → 拒写（隔离不变量不变），
 *   期间任何其它写入 → 拒写（并发解读绝不互相覆盖）。
 *
 * 存量回填（一次性、幂等、**有界**）：dev 库中既有的旧容器行（`Artifact(type='other')` + `content.kind` ∈
 * {creative_hypothesis, creative_insight}）在**首次访问本 store** 时按 id 原样搬入专表
 * （`createMany({ skipDuplicates: true })` → 重复执行安全）；旧行**只读不删**（保留审计痕迹，
 * 模块此后不再读取它们）。
 * - **有界载入**：主键游标分批（每批 `BACKFILL_BATCH_SIZE` 行、每批单次 createMany）——绝不 `findMany`
 *   无界载入、绝不逐行 N+1；
 * - **逐行隔离**：批内出现毒行（外键/枚举不成立）时退化为逐行插入并跳过该行——绝不因一行历史脏数据
 *   丢掉整批，也绝不阻塞模块启动；
 * - **失败退避**：扫描级失败（DB 不可用等）在 `BACKFILL_RETRY_BACKOFF_MS` 窗口内不重扫——失败绝不在
 *   请求路径上被反复放大；窗口后自动重试（回填幂等，重试安全）。
 *
 * 回填谓词边界：`Artifact.content` 是 JSONB，判别谓词 `content->>'kind'` 在既有 schema 下**无表达式
 * 索引**（也无 GIN 索引可用：`type` + path 组合超出既有索引面）→ 该查询是**顺序扫描**。故它只在首次
 * 访问触发一次，绝不进入常规读路径（常规读写一律走专表直列谓词，见各方法注释）。
 *
 * 服务层接口（StoredDoc / HypothesisStore / InsightStore）：两个条件写入方法显式接收 `expectedVersion`
 * （`cas(id, from, next, expectedVersion)` / `saveInterpretation(id, factsHash, next, expectedVersion)`）——
 * **先读后写处必须传入读取时的 `StoredDoc.version`**（调用方读取即拿到锚点，绝不"读一次版本猜一次"）。
 */

import { Inject, Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AppError, ErrorCode } from '../../common/errors/app-error';
import { HypothesisStatus, isHypothesisStatus } from './hypothesis-status';
import { SuccessCriteria } from './insight-rules';

/** 旧容器判别（**仅存量回填使用**；新读写一律走专表，绝不读 Artifact） */
export const CREATIVE_LOOP_ARTIFACT_TYPE = 'other';
export const HYPOTHESIS_KIND = 'creative_hypothesis';
export const INSIGHT_KIND = 'creative_insight';

export interface HypothesisVerdict {
  decision: 'validated' | 'rejected';
  /**
   * criteria = 服务端按判据判定（loop 跑通后收敛）；
   * manual = 人工/Agent 显式判定；
   * system = 系统归因判定（loop 运行 failed/timeout，未产出可用结果 → 驳回）
   */
  decidedBy: 'criteria' | 'manual' | 'system';
  reason: string;
  criteria: SuccessCriteria | null;
  /** 判定依据事实（服务端聚合；**绝不含解读文本**） */
  facts: Record<string, unknown> | null;
  evaluationRunId: string | null;
  experimentId: string | null;
  decidedAt: string;
}

export interface HypothesisHistoryEntry {
  from: HypothesisStatus;
  to: HypothesisStatus;
  at: string;
  /** 触发者：system（loop 编排/失败收敛）/ criteria（判据判定）/ manual（人工显式操作） */
  by: string;
}

export interface HypothesisLoopRef {
  workflowId: string;
  runId: string;
  /** 已启动次数（重跑递增；幂等键含 attempt） */
  attempts: number;
  startedAt: string;
}

export interface HypothesisDoc {
  kind: typeof HYPOTHESIS_KIND;
  organizationId: string;
  projectId: string | null;
  status: HypothesisStatus;
  statement: string;
  rationale: string | null;
  target: string | null;
  platform: string | null;
  /** 来源洞察（可空；仅引用，绝不改写洞察事实） */
  insightId: string | null;
  successCriteria: SuccessCriteria | null;
  loop: HypothesisLoopRef | null;
  evaluationRunId: string | null;
  baselineRunId: string | null;
  experimentId: string | null;
  verdict: HypothesisVerdict | null;
  history: HypothesisHistoryEntry[];
}

export interface InsightInterpretation {
  /** 固定标注（分层不变量：LLM 文本只在 interpretation 层） */
  source: 'llm-interpretation';
  items: string[];
  model: string | null;
  attachedAt: string;
}

export interface InsightDoc {
  kind: typeof INSIGHT_KIND;
  organizationId: string;
  projectId: string | null;
  window: { start: string; end: string; days: number };
  filters: Record<string, unknown>;
  /** 事实层（服务端聚合；解读写入路径绝不触碰） */
  facts: Record<string, unknown>;
  /** 派生层（服务端计算；解读写入路径绝不触碰） */
  derived: Record<string, unknown>;
  /** facts+derived 稳定指纹（解读写入 CAS 谓词） */
  factsHash: string;
  /** 解读层（LLM，可选；明确隔离） */
  interpretation: InsightInterpretation | null;
  /** 分层标注（消费方不得混淆） */
  layering: Record<string, string>;
}

export interface StoredDoc<T> {
  id: string;
  userId: string;
  doc: T;
  createdAt: Date;
  updatedAt: Date;
  /** 行版本（M10-P4：非状态字段更新的 CAS 锚点；每次写入 +1） */
  version: number;
}

/** 旧容器行的内容形状（回填时按字段尽可能还原；缺字段一律按空值处理） */
type LegacyDoc = Record<string, unknown>;

// ===== 存量回填（幂等 + 有界分批 + 逐行隔离 + 失败退避；首次访问触发） =====

/** 回填批大小（主键游标分页——**有界载入**：单批行数上限，绝不一次把旧容器全表读进内存） */
export const BACKFILL_BATCH_SIZE = 500;
/** 扫描级失败后的退避窗口（窗口内不重扫：失败绝不在请求路径上被反复放大） */
export const BACKFILL_RETRY_BACKOFF_MS = 60_000;

/** 每个 PrismaService 实例一份（进程内共享）：成功 → 永久记忆；扫描级失败 → 退避窗口后重试 */
interface BackfillMemo {
  /** 回填任务（进行中或已完成；成功后常驻 = 只扫一次） */
  task?: Promise<void>;
  /** 最近一次扫描级失败时刻（退避锚点） */
  failedAt?: number;
}
const backfill = new WeakMap<PrismaService, BackfillMemo>();
const backfillLogger = new Logger('CreativeLoopBackfill');

/** 旧容器行（回填读取的最小列集——不读用不到的列） */
interface LegacyArtifactRow {
  id: string;
  userId: string;
  content: unknown;
  createdAt: Date;
}

/**
 * 旧容器行 → 专表（**只读迁移**：不删旧行、按 id 幂等插入、毒行跳过不阻塞其余行）。
 * 组织归属取 `content.organizationId`（旧实现的组织判别同源），缺失/失联（外键不成立）→ 跳过并告警。
 *
 * 分页：`orderBy id asc` + `cursor (skip 1)`（主键唯一有序 → 游标稳定，绝不漏行/重行）；
 * 判别谓词是 JSONB path（**无表达式索引可用**，见文件头"回填谓词边界"）→ 顺序扫描，故仅首次触发。
 */
async function runLegacyBackfill(prisma: PrismaService): Promise<void> {
  let cursor: string | undefined;
  let scanned = 0;
  let migrated = 0;
  let skipped = 0;
  for (;;) {
    const rows: LegacyArtifactRow[] = await prisma.artifact.findMany({
      where: {
        type: CREATIVE_LOOP_ARTIFACT_TYPE as never,
        OR: [kindEquals(HYPOTHESIS_KIND), kindEquals(INSIGHT_KIND)],
      },
      select: { id: true, userId: true, content: true, createdAt: true },
      orderBy: { id: 'asc' },
      take: BACKFILL_BATCH_SIZE,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });
    if (rows.length === 0) break;
    scanned += rows.length;
    cursor = rows[rows.length - 1].id;
    const batch = await migrateBatch(prisma, rows);
    migrated += batch.migrated;
    skipped += batch.skipped;
    if (rows.length < BACKFILL_BATCH_SIZE) break; // 不满一批 = 已到尾批
  }
  backfillLogger.log({ scanned, migrated, skipped }, 'M10-P4 存量回填完成（幂等只读迁移；主键游标分批）');
}

/**
 * 单批回填：先服务端筛（缺 organizationId / 状态非法 → 跳过并告警），再**每张表一次 createMany**
 * （`skipDuplicates` → 重复执行安全：既有专表行绝不被旧容器内容回滚）。
 */
async function migrateBatch(
  prisma: PrismaService,
  rows: readonly LegacyArtifactRow[],
): Promise<{ migrated: number; skipped: number }> {
  const hypotheses: Array<Record<string, unknown>> = [];
  const insights: Array<Record<string, unknown>> = [];
  let skipped = 0;
  for (const row of rows) {
    const doc = (row.content ?? {}) as LegacyDoc;
    const organizationId = typeof doc.organizationId === 'string' ? doc.organizationId : '';
    if (!organizationId) {
      skipped++;
      backfillLogger.warn({ artifactId: row.id }, '旧容器行缺少 organizationId，跳过回填（保留原行）');
      continue;
    }
    if (doc.kind === HYPOTHESIS_KIND) {
      const status = doc.status;
      if (!isHypothesisStatus(status)) {
        skipped++;
        backfillLogger.warn({ artifactId: row.id, status }, '旧假设状态非法，跳过回填（保留原行）');
        continue;
      }
      hypotheses.push({
        id: row.id,
        organizationId,
        projectId: typeof doc.projectId === 'string' ? doc.projectId : null,
        userId: row.userId,
        status: status as never,
        statement: typeof doc.statement === 'string' ? doc.statement : '',
        rationale: typeof doc.rationale === 'string' ? doc.rationale : null,
        target: typeof doc.target === 'string' ? doc.target : null,
        platform: typeof doc.platform === 'string' ? doc.platform : null,
        insightId: typeof doc.insightId === 'string' ? doc.insightId : null,
        successCriteria: jsonOrNull(doc.successCriteria),
        loop: jsonOrNull(doc.loop),
        evaluationRunId: typeof doc.evaluationRunId === 'string' ? doc.evaluationRunId : null,
        baselineRunId: typeof doc.baselineRunId === 'string' ? doc.baselineRunId : null,
        experimentId: typeof doc.experimentId === 'string' ? doc.experimentId : null,
        verdict: jsonOrNull(doc.verdict),
        history: jsonOrEmptyArray(doc.history),
        version: 1,
        createdAt: row.createdAt, // 保留原时间线（updatedAt 由 Prisma @updatedAt 落为回填时刻）
      });
    } else {
      insights.push({
        id: row.id,
        organizationId,
        projectId: typeof doc.projectId === 'string' ? doc.projectId : null,
        userId: row.userId,
        window: jsonOrObject(doc.window),
        filters: jsonOrObject(doc.filters),
        facts: jsonOrObject(doc.facts),
        derived: jsonOrObject(doc.derived),
        factsHash: typeof doc.factsHash === 'string' ? doc.factsHash : '',
        interpretation: jsonOrNull(doc.interpretation),
        layering: jsonOrObject(doc.layering),
        version: 1,
        createdAt: row.createdAt,
      });
    }
  }
  const h = await insertBatch(
    (data) => prisma.creativeHypothesis.createMany({ data: data as never, skipDuplicates: true }),
    hypotheses,
    'CreativeHypothesis',
  );
  const i = await insertBatch(
    (data) => prisma.creativeInsight.createMany({ data: data as never, skipDuplicates: true }),
    insights,
    'CreativeInsight',
  );
  return { migrated: h.migrated + i.migrated, skipped: skipped + h.skipped + i.skipped };
}

/**
 * 批量插入（**每批一次往返**，绝不逐行 N+1）；批失败 → 退化为逐行以**隔离毒行**：
 * 常见毒行 = 历史行的组织/用户/项目已被删除（外键不成立）——跳过该行并告警，其余行照常回填
 * （绝不因一行历史脏数据丢掉整批，也绝不阻塞模块启动）。
 */
async function insertBatch(
  insert: (data: Array<Record<string, unknown>>) => Promise<{ count: number }>,
  data: Array<Record<string, unknown>>,
  label: string,
): Promise<{ migrated: number; skipped: number }> {
  if (data.length === 0) return { migrated: 0, skipped: 0 };
  try {
    const res = await insert(data);
    return { migrated: res.count, skipped: 0 };
  } catch (err) {
    backfillLogger.warn(
      { label, rows: data.length, err: (err as Error).message },
      '批量回填失败，退化为逐行隔离（毒行跳过并保留原行）',
    );
    let migrated = 0;
    let skipped = 0;
    for (const row of data) {
      try {
        const res = await insert([row]);
        migrated += res.count;
      } catch (rowErr) {
        skipped++;
        backfillLogger.warn({ id: row.id, err: (rowErr as Error).message }, '旧容器行回填失败，已跳过（保留原行）');
      }
    }
    return { migrated, skipped };
  }
}

/**
 * 幂等触发（并发首次访问共用同一 Promise；成功后永久记忆 = 只扫一次）。
 * 扫描级失败（如 DB 不可用）→ 记退避锚点：`BACKFILL_RETRY_BACKOFF_MS` 窗口内**不再重扫**
 * （读路径绝不因回填失败而失败，也绝不把失败放大成每次请求一次全表扫描）；窗口后下一次访问重试。
 */
function ensureLegacyBackfill(prisma: PrismaService): Promise<void> {
  let memo = backfill.get(prisma);
  if (!memo) {
    memo = {};
    backfill.set(prisma, memo);
  }
  if (memo.task) return memo.task;
  if (memo.failedAt !== undefined && Date.now() - memo.failedAt < BACKFILL_RETRY_BACKOFF_MS) {
    return Promise.resolve(); // 退避窗口内：本次不重扫（读路径照常返回专表现状）
  }
  const task = runLegacyBackfill(prisma).catch((err) => {
    memo!.failedAt = Date.now();
    memo!.task = undefined; // 失败不记忆：退避窗口后重试（绝不因回填失败让模块不可用）
    backfillLogger.warn(
      { err: (err as Error).message, retryAfterMs: BACKFILL_RETRY_BACKOFF_MS },
      '存量回填失败（本次跳过；退避窗口后重试）',
    );
  });
  memo.task = task;
  return task;
}

/** 旧容器行判别谓词（JSONB path；**仅回填使用**） */
function kindEquals(kind: string): Prisma.ArtifactWhereInput {
  return { content: { path: ['kind'], equals: kind } } as Prisma.ArtifactWhereInput;
}

function jsonOrNull(value: unknown): Prisma.InputJsonValue {
  return (value === undefined || value === null ? Prisma.DbNull : value) as Prisma.InputJsonValue;
}

function jsonOrObject(value: unknown): Prisma.InputJsonValue {
  return (value && typeof value === 'object' ? value : {}) as Prisma.InputJsonValue;
}

function jsonOrEmptyArray(value: unknown): Prisma.InputJsonValue {
  return (Array.isArray(value) ? value : []) as Prisma.InputJsonValue;
}

// ===== 行 ↔ 文档映射 =====

interface HypothesisRow {
  id: string;
  organizationId: string;
  projectId: string | null;
  userId: string;
  status: string;
  statement: string;
  rationale: string | null;
  target: string | null;
  platform: string | null;
  insightId: string | null;
  successCriteria: unknown;
  loop: unknown;
  evaluationRunId: string | null;
  baselineRunId: string | null;
  experimentId: string | null;
  verdict: unknown;
  history: unknown;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

interface InsightRow {
  id: string;
  organizationId: string;
  projectId: string | null;
  userId: string;
  window: unknown;
  filters: unknown;
  facts: unknown;
  derived: unknown;
  factsHash: string;
  interpretation: unknown;
  layering: unknown;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

/** 文档 → 专表列（**可写字段**：organizationId 是创建时的不可变归属，绝不因更新漂移） */
function hypothesisColumns(doc: HypothesisDoc): Record<string, unknown> {
  if (!isHypothesisStatus(doc.status)) {
    throw new AppError(ErrorCode.INTERNAL, `假设状态非法: ${String(doc.status)}`);
  }
  return {
    status: doc.status,
    statement: doc.statement,
    rationale: doc.rationale,
    target: doc.target,
    platform: doc.platform,
    insightId: doc.insightId,
    successCriteria: jsonOrNull(doc.successCriteria),
    loop: jsonOrNull(doc.loop),
    evaluationRunId: doc.evaluationRunId,
    baselineRunId: doc.baselineRunId,
    experimentId: doc.experimentId,
    verdict: jsonOrNull(doc.verdict),
    history: jsonOrEmptyArray(doc.history),
  };
}

function rowToHypothesis(row: HypothesisRow): StoredDoc<HypothesisDoc> {
  return {
    id: row.id,
    userId: row.userId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    version: row.version,
    doc: {
      kind: HYPOTHESIS_KIND,
      organizationId: row.organizationId,
      projectId: row.projectId,
      status: row.status as HypothesisStatus,
      statement: row.statement,
      rationale: row.rationale,
      target: row.target,
      platform: row.platform,
      insightId: row.insightId,
      successCriteria: (row.successCriteria ?? null) as SuccessCriteria | null,
      loop: (row.loop ?? null) as HypothesisLoopRef | null,
      evaluationRunId: row.evaluationRunId,
      baselineRunId: row.baselineRunId,
      experimentId: row.experimentId,
      verdict: (row.verdict ?? null) as HypothesisVerdict | null,
      history: (Array.isArray(row.history) ? row.history : []) as HypothesisHistoryEntry[],
    },
  };
}

function insightColumns(doc: InsightDoc): Record<string, unknown> {
  return {
    window: jsonOrObject(doc.window),
    filters: jsonOrObject(doc.filters),
    facts: jsonOrObject(doc.facts),
    derived: jsonOrObject(doc.derived),
    factsHash: doc.factsHash,
    interpretation: jsonOrNull(doc.interpretation),
    layering: jsonOrObject(doc.layering),
  };
}

function rowToInsight(row: InsightRow): StoredDoc<InsightDoc> {
  return {
    id: row.id,
    userId: row.userId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    version: row.version,
    doc: {
      kind: INSIGHT_KIND,
      organizationId: row.organizationId,
      projectId: row.projectId,
      window: jsonOrObject(row.window) as unknown as InsightDoc['window'],
      filters: jsonOrObject(row.filters) as unknown as Record<string, unknown>,
      facts: jsonOrObject(row.facts) as unknown as Record<string, unknown>,
      derived: jsonOrObject(row.derived) as unknown as Record<string, unknown>,
      factsHash: row.factsHash,
      interpretation: (row.interpretation ?? null) as InsightInterpretation | null,
      layering: jsonOrObject(row.layering) as unknown as Record<string, string>,
    },
  };
}

/** 假设专表读写（唯一持久化实现） */
@Injectable()
export class HypothesisStore {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  async create(userId: string, doc: HypothesisDoc): Promise<StoredDoc<HypothesisDoc>> {
    await ensureLegacyBackfill(this.prisma);
    const row = await this.prisma.creativeHypothesis.create({
      data: {
        organizationId: doc.organizationId,
        projectId: doc.projectId,
        userId,
        ...hypothesisColumns(doc),
      } as never,
    });
    return rowToHypothesis(row as unknown as HypothesisRow);
  }

  async get(id: string): Promise<StoredDoc<HypothesisDoc> | null> {
    await ensureLegacyBackfill(this.prisma);
    const row = await this.prisma.creativeHypothesis.findUnique({ where: { id } });
    return row ? rowToHypothesis(row as unknown as HypothesisRow) : null;
  }

  /** 列表（组织/项目/状态一律 **server-side 直列谓词**——绝不 JS 侧过滤，绝不 JSON path） */
  async list(filter: {
    userId?: string;
    organizationId?: string;
    projectId?: string;
    status?: HypothesisStatus;
    take?: number;
  }): Promise<Array<StoredDoc<HypothesisDoc>>> {
    await ensureLegacyBackfill(this.prisma);
    const rows = await this.prisma.creativeHypothesis.findMany({
      where: {
        ...(filter.organizationId ? { organizationId: filter.organizationId } : {}),
        ...(filter.userId ? { userId: filter.userId } : {}),
        ...(filter.projectId ? { projectId: filter.projectId } : {}),
        ...(filter.status ? { status: filter.status as never } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: filter.take ?? 50,
    });
    return rows.map((row) => rowToHypothesis(row as unknown as HypothesisRow));
  }

  /**
   * 状态推进（**status CAS + version CAS**）：仅当当前 status ∈ from **且行版本仍等于调用方读取时的
   * version** 时才写入整份新文档。返回受影响行数（0 = 并发/状态已变 → 调用方转错，绝不盲目覆盖）；
   * 成功则 version +1。
   *
   * version 谓词为何不可省（M11-P5/D2-02，lost update）：本方法写整份文档，若只锚定 status，
   * 则 `读(v) → 并发 casFields 改非状态字段(v+1) → 本转移落库` 中 status 谓词仍然成立 →
   * 状态转移会把读到的**旧**非状态字段一并写回，静默覆盖对方的写入（双方都返回成功）。
   * 锚定 version 后，任何并发写入都会让后到者 count=0（调用方转 400/静默重读），不变量重新成立。
   */
  async cas(id: string, from: readonly HypothesisStatus[], next: HypothesisDoc, expectedVersion: number): Promise<number> {
    await ensureLegacyBackfill(this.prisma);
    const res = await this.prisma.creativeHypothesis.updateMany({
      where: {
        id,
        organizationId: next.organizationId, // server-side 组织 scope（归属不可变，谓词恒真；防御性收口）
        status: { in: from as never[] },
        version: expectedVersion, // 读取时版本锚点（并发编辑/解读挂接一律让本转移失效）
      },
      data: { ...hypothesisColumns(next), version: { increment: 1 } } as never,
    });
    return res.count;
  }

  /**
   * 非状态字段更新（**version CAS**）：expectedVersion = 调用方读取时的行版本；
   * 期间任何写入（状态推进/编辑/解读挂接）都会使 version 前移 → count=0 → 调用方转错，绝不覆盖。
   */
  async casFields(id: string, expectedVersion: number, next: HypothesisDoc): Promise<number> {
    await ensureLegacyBackfill(this.prisma);
    const res = await this.prisma.creativeHypothesis.updateMany({
      where: { id, version: expectedVersion, organizationId: next.organizationId },
      data: { ...hypothesisColumns(next), version: { increment: 1 } } as never,
    });
    return res.count;
  }

  /** 删除（仅允许草稿/已驳回：已启动过 loop 的假设行是历史事实，绝不删除） */
  async remove(id: string, allowed: readonly HypothesisStatus[]): Promise<number> {
    await ensureLegacyBackfill(this.prisma);
    const res = await this.prisma.creativeHypothesis.deleteMany({
      where: { id, status: { in: allowed as never[] } },
    });
    return res.count;
  }
}

/** 洞察专表读写（唯一持久化实现） */
@Injectable()
export class InsightStore {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  async create(userId: string, doc: InsightDoc): Promise<StoredDoc<InsightDoc>> {
    await ensureLegacyBackfill(this.prisma);
    const row = await this.prisma.creativeInsight.create({
      data: {
        organizationId: doc.organizationId,
        projectId: doc.projectId,
        userId,
        ...insightColumns(doc),
      } as never,
    });
    return rowToInsight(row as unknown as InsightRow);
  }

  async get(id: string): Promise<StoredDoc<InsightDoc> | null> {
    await ensureLegacyBackfill(this.prisma);
    const row = await this.prisma.creativeInsight.findUnique({ where: { id } });
    return row ? rowToInsight(row as unknown as InsightRow) : null;
  }

  async list(filter: { userId?: string; organizationId?: string; projectId?: string; take?: number }): Promise<Array<StoredDoc<InsightDoc>>> {
    await ensureLegacyBackfill(this.prisma);
    const rows = await this.prisma.creativeInsight.findMany({
      where: {
        ...(filter.organizationId ? { organizationId: filter.organizationId } : {}),
        ...(filter.userId ? { userId: filter.userId } : {}),
        ...(filter.projectId ? { projectId: filter.projectId } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: filter.take ?? 50,
    });
    return rows.map((row) => rowToInsight(row as unknown as InsightRow));
  }

  /**
   * 解读写入（**隔离不变量 + 并发不覆盖**，双锚点条件更新）：
   * - 锚点① `factsHash`：仅当行内事实指纹与调用方读取时一致才写入；事实层已变化 → count=0
   *   （解读必须基于最新事实重写）；
   * - 锚点② `version`：仅当行版本仍等于调用方读取时的版本才写入——期间任何其它写入（解读覆盖/
   *   事实层重建）都会让 count=0，绝不静默覆盖对方（与 `cas` 同一 lost update 防护）。
   * 写入内容 = 原文档逐字段复制 + interpretation 覆盖（facts/derived 绝不进入本方法的构造路径）。
   */
  async saveInterpretation(id: string, factsHash: string, next: InsightDoc, expectedVersion: number): Promise<number> {
    await ensureLegacyBackfill(this.prisma);
    const res = await this.prisma.creativeInsight.updateMany({
      where: { id, factsHash, organizationId: next.organizationId, version: expectedVersion },
      data: { ...insightColumns(next), version: { increment: 1 } } as never,
    });
    return res.count;
  }
}
