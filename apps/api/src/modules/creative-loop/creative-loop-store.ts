/**
 * M9-P5 持久化落点（**已知 schema 缺口的最小实现——缺口如实记录，绝不伪造**）。
 *
 * 设计文档（docs/architecture/m9-phase4-6-design.md M9-P5 节）要求新模块持有"假设 CRUD + 状态机"，
 * 但本 Phase 的硬约束是 **禁止修改 schema.prisma / migrations / packages/shared，禁止 prisma 命令**，
 * 而当前 schema **不存在** CreativeHypothesis / CreativeInsight / CreativeLoop 任何表
 * （全仓 grep 无命中；M9 的预整合只覆盖了 P1/P2/P3 与 P6 的表）。故本 Phase 采用既有通用文档容器
 * `Artifact`（type='other'，M2 表，**不改列不改索引**）承载两类文档：
 *
 * - `content.kind = 'creative_hypothesis'`：假设文档（状态机、判据、loop/evaluation/experiment 引用、判定事实）；
 * - `content.kind = 'creative_insight'`：洞察文档（facts/derived/interpretation 分层 + factsHash 指纹）。
 *
 * 安全与语义约束（与"新建专表"等价的部分）：
 * - 会话内制品可见性：本模块写入的行一律 `conversationId = null`、`storageKey = null`，
 *   既有制品读路径（ArtifactService.listByConversation / getById）**看不到**这些行，
 *   绝不污染用户制品列表（全仓只有这两处读 Artifact，已核验）；
 * - 归属：`content.organizationId` + `content.projectId` 记录组织/项目 scope，服务层按 workflow.read/write 裁决；
 * - 状态推进：一律 **条件更新**（`updateMany` + JSON path 谓词，锚点 = kind + 当前 status）——
 *   CAS 失败（count=0，并发/状态已变）由调用方转 409，绝不盲目覆盖；
 * - 事实/解读隔离：洞察解读写入的 CAS 谓词含 `factsHash`——事实层变化后旧解读**拒绝落库**（见 insight.service）。
 *
 * 已知缺口（交付说明中如实列出，需 Coordinator 在后续 Phase 预整合专表后切换存储实现）：
 * ① 无独立表 → 无数据库级 CHECK/外键约束，状态机由服务层 + 条件更新保证；
 * ② 无 `organizationId` 列 → 组织过滤走 `content.path` JSON 谓词（Postgres JSONB，已实测）；
 * ③ 无 `updatedAt` 之外的版本列 → 状态维度由 status CAS 保证，非状态字段为最后写入者胜。
 * 切换成本受控：本文件是唯一持久化实现（HypothesisStore/InsightStore 全部读写集中于此），
 * 专表落库后只需替换本文件实现（服务层零改动）。
 */

import { Inject, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AppError, ErrorCode } from '../../common/errors/app-error';
import { HypothesisStatus, isHypothesisStatus } from './hypothesis-status';
import { SuccessCriteria } from './insight-rules';

/** 承载容器：ArtifactType 枚举无 creative-loop 专用值（枚举冻结）→ 统一用 'other' + content.kind 判别 */
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
}

interface ArtifactRow {
  id: string;
  userId: string;
  content: unknown;
  createdAt: Date;
  updatedAt: Date;
}

/** JSON path 谓词：kind 判别（所有读写都带——绝不误读其他 kind 的 'other' 制品） */
function kindEquals(kind: string): Prisma.ArtifactWhereInput {
  return { content: { path: ['kind'], equals: kind } } as Prisma.ArtifactWhereInput;
}

function statusEquals(status: string): Prisma.ArtifactWhereInput {
  return { content: { path: ['status'], equals: status } } as Prisma.ArtifactWhereInput;
}

function orgEquals(organizationId: string): Prisma.ArtifactWhereInput {
  return { content: { path: ['organizationId'], equals: organizationId } } as Prisma.ArtifactWhereInput;
}

function projectEquals(projectId: string): Prisma.ArtifactWhereInput {
  return { content: { path: ['projectId'], equals: projectId } } as Prisma.ArtifactWhereInput;
}

function readDoc<T>(row: ArtifactRow | null, expectedKind: string): T | null {
  if (!row) return null;
  const doc = row.content as { kind?: string } | null;
  if (!doc || doc.kind !== expectedKind) return null; // 容器污染防护：kind 不符一律视作不存在
  return doc as T;
}

/** 假设文档读写（唯一持久化实现；见文件头"已知缺口"） */
@Injectable()
export class HypothesisStore {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  async create(userId: string, doc: HypothesisDoc): Promise<StoredDoc<HypothesisDoc>> {
    const row = await this.prisma.artifact.create({
      data: {
        userId,
        projectId: doc.projectId,
        type: CREATIVE_LOOP_ARTIFACT_TYPE as never,
        title: doc.statement.slice(0, 80),
        summary: `创意假设（${doc.status}）`,
        content: doc as never,
        status: 'ready' as never, // 容器物化状态；假设生命周期在 content.status（文档头已说明）
      },
    });
    return { id: row.id, userId: row.userId, doc: doc, createdAt: row.createdAt, updatedAt: row.updatedAt };
  }

  async get(id: string): Promise<StoredDoc<HypothesisDoc> | null> {
    const row = await this.prisma.artifact.findFirst({
      where: { id, type: CREATIVE_LOOP_ARTIFACT_TYPE as never, AND: [kindEquals(HYPOTHESIS_KIND)] },
    });
    return this.toStored(row);
  }

  async list(filter: {
    userId?: string;
    organizationId?: string;
    projectId?: string;
    status?: HypothesisStatus;
    take?: number;
  }): Promise<Array<StoredDoc<HypothesisDoc>>> {
    const and: Prisma.ArtifactWhereInput[] = [kindEquals(HYPOTHESIS_KIND)];
    if (filter.organizationId) and.push(orgEquals(filter.organizationId));
    if (filter.projectId) and.push(projectEquals(filter.projectId));
    if (filter.status) and.push(statusEquals(filter.status));
    const rows = await this.prisma.artifact.findMany({
      where: {
        type: CREATIVE_LOOP_ARTIFACT_TYPE as never,
        ...(filter.userId ? { userId: filter.userId } : {}),
        AND: and,
      },
      orderBy: { createdAt: 'desc' },
      take: filter.take ?? 50,
    });
    return rows.map((row) => this.toStored(row)).filter((r): r is StoredDoc<HypothesisDoc> => r !== null);
  }

  /**
   * 状态推进（**条件更新**）：仅当当前 kind 命中且 status ∈ from 时写入整份新文档；
   * 返回受影响行数（0 = 并发/状态已变 → 调用方转 409，绝不盲目覆盖）。
   */
  async cas(id: string, from: readonly HypothesisStatus[], next: HypothesisDoc): Promise<number> {
    if (!isHypothesisStatus(next.status)) {
      throw new AppError(ErrorCode.INTERNAL, `假设状态非法: ${String(next.status)}`);
    }
    const res = await this.prisma.artifact.updateMany({
      where: {
        id,
        type: CREATIVE_LOOP_ARTIFACT_TYPE as never,
        AND: [kindEquals(HYPOTHESIS_KIND), { OR: from.map((s) => statusEquals(s)) }],
      },
      data: { content: next as never, title: next.statement.slice(0, 80), updatedAt: new Date() },
    });
    return res.count;
  }

  /** 删除（仅允许草稿/已驳回：已启动过 loop 的假设行是历史事实，绝不删除） */
  async remove(id: string, allowed: readonly HypothesisStatus[]): Promise<number> {
    const res = await this.prisma.artifact.deleteMany({
      where: {
        id,
        type: CREATIVE_LOOP_ARTIFACT_TYPE as never,
        AND: [kindEquals(HYPOTHESIS_KIND), { OR: allowed.map((s) => statusEquals(s)) }],
      },
    });
    return res.count;
  }

  private toStored(row: ArtifactRow | null): StoredDoc<HypothesisDoc> | null {
    const doc = readDoc<HypothesisDoc>(row, HYPOTHESIS_KIND);
    if (!row || !doc) return null;
    return { id: row.id, userId: row.userId, doc, createdAt: row.createdAt, updatedAt: row.updatedAt };
  }
}

/** 洞察文档读写（同上：唯一持久化实现） */
@Injectable()
export class InsightStore {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  async create(userId: string, doc: InsightDoc): Promise<StoredDoc<InsightDoc>> {
    const row = await this.prisma.artifact.create({
      data: {
        userId,
        projectId: doc.projectId,
        type: CREATIVE_LOOP_ARTIFACT_TYPE as never,
        title: `创意洞察（近 ${doc.window.days} 天）`,
        summary: doc.interpretation ? '洞察（含 LLM 解读，独立层）' : '洞察（事实层）',
        content: doc as never,
        status: 'ready' as never,
      },
    });
    return { id: row.id, userId: row.userId, doc, createdAt: row.createdAt, updatedAt: row.updatedAt };
  }

  async get(id: string): Promise<StoredDoc<InsightDoc> | null> {
    const row = await this.prisma.artifact.findFirst({
      where: { id, type: CREATIVE_LOOP_ARTIFACT_TYPE as never, AND: [kindEquals(INSIGHT_KIND)] },
    });
    const doc = readDoc<InsightDoc>(row, INSIGHT_KIND);
    if (!row || !doc) return null;
    return { id: row.id, userId: row.userId, doc, createdAt: row.createdAt, updatedAt: row.updatedAt };
  }

  async list(filter: { userId?: string; organizationId?: string; projectId?: string; take?: number }): Promise<Array<StoredDoc<InsightDoc>>> {
    const and: Prisma.ArtifactWhereInput[] = [kindEquals(INSIGHT_KIND)];
    if (filter.organizationId) and.push(orgEquals(filter.organizationId));
    if (filter.projectId) and.push(projectEquals(filter.projectId));
    const rows = await this.prisma.artifact.findMany({
      where: {
        type: CREATIVE_LOOP_ARTIFACT_TYPE as never,
        ...(filter.userId ? { userId: filter.userId } : {}),
        AND: and,
      },
      orderBy: { createdAt: 'desc' },
      take: filter.take ?? 50,
    });
    const out: Array<StoredDoc<InsightDoc>> = [];
    for (const row of rows) {
      const doc = readDoc<InsightDoc>(row, INSIGHT_KIND);
      if (doc) out.push({ id: row.id, userId: row.userId, doc, createdAt: row.createdAt, updatedAt: row.updatedAt });
    }
    return out;
  }

  /**
   * 解读写入（**隔离不变量**）：条件更新谓词含 factsHash——
   * 仅当行内事实指纹与调用方读取时一致才写入；事实层已变化 → count=0（解读必须基于最新事实重写）。
   * 写入内容 = 原文档逐字段复制 + interpretation 覆盖（facts/derived 绝不进入本方法的构造路径）。
   */
  async saveInterpretation(id: string, factsHash: string, next: InsightDoc): Promise<number> {
    const res = await this.prisma.artifact.updateMany({
      where: {
        id,
        type: CREATIVE_LOOP_ARTIFACT_TYPE as never,
        AND: [
          kindEquals(INSIGHT_KIND),
          { content: { path: ['factsHash'], equals: factsHash } } as Prisma.ArtifactWhereInput,
        ],
      },
      data: { content: next as never, updatedAt: new Date() },
    });
    return res.count;
  }
}
