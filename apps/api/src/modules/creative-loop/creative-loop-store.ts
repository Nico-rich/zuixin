/**
 * M10-P4 持久化落点（**专表**：`CreativeHypothesis` / `CreativeInsight`，W0 预整合 schema）。
 *
 * M9-P5 曾以通用文档容器 `Artifact(type='other', content.kind=...)` 承载（当时 schema 冻结），
 * 本文件把读写切换为专表——**容器污染防护由表结构天然保证**（不再有 kind 判别误读）：
 * - 组织归属 = `organizationId` 直列（**查询一律 server-side scope**，删除 JSON path 谓词）；
 * - 生命周期/判定事实（status/statement/successCriteria/loop/verdict/history）逐列落库，
 *   数据库级 CHECK（enum）与外键（组织/项目/用户）保证合法值与归属；
 * - 状态推进仍为 **status CAS**（`updateMany` + status 谓词，count=0 → 调用方转 400/409）；
 * - 非状态字段更新为 **version CAS**（读时版本 → `where.version` 条件 + `version = version+1`），
 *   并发状态推进/并发编辑一律不被盲目覆盖；
 * - 洞察解读写入仍锚定 `factsHash`（事实层变化后旧解读拒绝落库——隔离不变量不变）。
 *
 * 存量回填（一次性、幂等）：dev 库中既有的旧容器行（`Artifact(type='other')` + `content.kind` ∈
 * {creative_hypothesis, creative_insight}）在**首次访问本 store** 时按 id 原样搬入专表
 * （`createMany({ skipDuplicates: true })` → 重复执行安全）；旧行**只读不删**（保留审计痕迹，
 * 模块此后不再读取它们）。回填失败按行记警告并跳过（绝不因历史脏数据阻塞模块启动），
 * 失败不缓存（下次访问重试）。
 *
 * 服务层接口（StoredDoc / HypothesisStore / InsightStore）公开方法签名保持不变
 * （仅 `StoredDoc` 增补 `version`——CAS 锚点；服务层改动限于把"非状态字段更新"改走 version CAS）。
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

// ===== 存量回填（幂等；首次访问触发，失败不缓存） =====

/** 每个 PrismaService 实例一份（进程内共享；失败不缓存 → 下次访问重试） */
const backfill = new WeakMap<PrismaService, Promise<void>>();
const backfillLogger = new Logger('CreativeLoopBackfill');

/**
 * 旧容器行 → 专表（**只读迁移**：不删旧行、按 id 幂等插入、单行失败不阻塞其余行）。
 * 组织归属取 `content.organizationId`（旧实现的组织判别同源），缺失/失联（外键不成立）→ 跳过并告警。
 */
async function runLegacyBackfill(prisma: PrismaService): Promise<void> {
  const rows = await prisma.artifact.findMany({
    where: {
      type: CREATIVE_LOOP_ARTIFACT_TYPE as never,
      OR: [kindEquals(HYPOTHESIS_KIND), kindEquals(INSIGHT_KIND)],
    },
    select: { id: true, userId: true, content: true, createdAt: true },
  });
  if (rows.length === 0) return;
  let migrated = 0;
  let skipped = 0;
  for (const row of rows) {
    const doc = (row.content ?? {}) as LegacyDoc;
    const kind = doc.kind;
    const organizationId = typeof doc.organizationId === 'string' ? doc.organizationId : '';
    if (!organizationId) {
      skipped++;
      backfillLogger.warn({ artifactId: row.id }, '旧容器行缺少 organizationId，跳过回填（保留原行）');
      continue;
    }
    try {
      if (kind === HYPOTHESIS_KIND) {
        const status = doc.status;
        if (!isHypothesisStatus(status)) {
          skipped++;
          backfillLogger.warn({ artifactId: row.id, status }, '旧假设状态非法，跳过回填（保留原行）');
          continue;
        }
        const created = await prisma.creativeHypothesis.createMany({
          data: [{
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
          }],
          skipDuplicates: true, // 已回填（同 id）→ 不动既有专表行
        });
        migrated += created.count;
      } else {
        const created = await prisma.creativeInsight.createMany({
          data: [{
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
          }],
          skipDuplicates: true,
        });
        migrated += created.count;
      }
    } catch (err) {
      // 常见：历史行的组织/用户/项目已被删除（外键不成立）——跳过该行，绝不让历史脏数据阻塞模块
      skipped++;
      backfillLogger.warn({ artifactId: row.id, err: (err as Error).message }, '旧容器行回填失败，已跳过（保留原行）');
    }
  }
  backfillLogger.log({ scanned: rows.length, migrated, skipped }, 'M10-P4 存量回填完成（幂等只读迁移）');
}

/** 幂等触发（并发首次访问共用同一 Promise；失败不缓存 → 下次访问重试） */
function ensureLegacyBackfill(prisma: PrismaService): Promise<void> {
  const running = backfill.get(prisma);
  if (running) return running;
  const task = runLegacyBackfill(prisma).catch((err) => {
    backfill.delete(prisma); // 失败不缓存：下次访问重试（绝不因回填失败让模块不可用）
    backfillLogger.warn({ err: (err as Error).message }, '存量回填失败（本次跳过；下次访问重试）');
  });
  backfill.set(prisma, task);
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
   * 状态推进（**status CAS**）：仅当当前 status ∈ from 时写入整份新文档。
   * 返回受影响行数（0 = 并发/状态已变 → 调用方转错，绝不盲目覆盖）；成功则 version +1。
   */
  async cas(id: string, from: readonly HypothesisStatus[], next: HypothesisDoc): Promise<number> {
    await ensureLegacyBackfill(this.prisma);
    const res = await this.prisma.creativeHypothesis.updateMany({
      where: {
        id,
        organizationId: next.organizationId, // server-side 组织 scope（归属不可变，谓词恒真；防御性收口）
        status: { in: from as never[] },
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
   * 解读写入（**隔离不变量**）：条件更新谓词含 factsHash——
   * 仅当行内事实指纹与调用方读取时一致才写入；事实层已变化 → count=0（解读必须基于最新事实重写）。
   * 写入内容 = 原文档逐字段复制 + interpretation 覆盖（facts/derived 绝不进入本方法的构造路径）。
   */
  async saveInterpretation(id: string, factsHash: string, next: InsightDoc): Promise<number> {
    await ensureLegacyBackfill(this.prisma);
    const res = await this.prisma.creativeInsight.updateMany({
      where: { id, factsHash, organizationId: next.organizationId },
      data: { ...insightColumns(next), version: { increment: 1 } } as never,
    });
    return res.count;
  }
}
