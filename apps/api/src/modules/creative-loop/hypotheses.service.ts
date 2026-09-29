/**
 * M9-P5 创意假设服务（CRUD + 状态机 + 归属校验）；M10-P4 起落 **CreativeHypothesis 专表**。
 *
 * 不变量：
 * - 状态推进**唯一入口** = `transition`（内部走 `assertTransition` 纯规则 + `HypothesisStore.cas`
 *   **status CAS + version CAS**——锚定读取时的 status 与行版本，失败 → 400"已被并发修改"，
 *   绝不盲目覆盖；version 谓词防的是"编辑与状态推进互相静默覆盖"的 lost update，M11-P5/D2-02）；
 * - 非状态字段更新（编辑/挂接执行引用）= `HypothesisStore.casFields` **version CAS**（读时版本锚定）；
 * - 终态只读（`isTerminal` → 编辑/删除/再推进一律拒绝）；
 * - 归属：组织/项目 scope = 专表直列 `organizationId`/`projectId`（查询 server-side scope）；
 *   每次读写都过 RBAC（workflow.read/write）；
 * - 本服务**不编排**（loop 启动/收敛在 loop-orchestrator.service.ts），也不消费评测/实验事实（同上）；
 * - M12-P1 学习桥：`create` 额外返回**同 statement 的历史判定先例**（只读参考字段，绝不落库、绝不改写
 *   历史行——verdict 此前无消费方，闭环在 validated/rejected 处断裂）。
 */

import { Inject, Injectable } from '@nestjs/common';
import { AppError, ErrorCode } from '../../common/errors/app-error';
import { CreativeLoopAccessService, LoopScope } from './creative-loop-access.service';
import { HypothesisDoc, HypothesisStore, InsightStore, StoredDoc } from './creative-loop-store';
import { HypothesisStatus, assertTransition, isTerminal } from './hypothesis-status';
import { SuccessCriteria } from './insight-rules';

export interface HypothesisView extends HypothesisDoc {
  id: string;
  createdAt: Date;
  updatedAt: Date;
  /** 终态标记（消费方无需复算状态机） */
  terminal: boolean;
  /**
   * （仅 create 返回）同组织/项目内**同 statement** 历史假设的既有判定先例（M12-P1 学习桥）。
   * **只读参考**：绝不落库、绝不改写历史行、也绝不作为本假设的判定（判定仍只由判据/人工产生）。
   * 其它读路径不含该字段（不存在于存储文档中）。
   */
  priorVerdicts?: PriorVerdictRef[];
}

/** 历史判定先例（verdict→新假设创建的只读参考字段；来源 = 既有终态假设行的 verdict） */
export interface PriorVerdictRef {
  hypothesisId: string;
  statement: string;
  status: HypothesisStatus;
  decision: 'validated' | 'rejected';
  decidedBy: 'criteria' | 'manual' | 'system';
  reason: string;
  decidedAt: string;
  /** 固定标注：历史判定事实（消费方不得与本假设的判定混淆） */
  source: 'historical-verdict';
}

/** 创建时返回的历史先例条数上限（有界；按 updatedAt 倒序取最近 N 条） */
export const PRIOR_VERDICT_TAKE = 5;

/** 可编辑字段（状态机语义：running 期间假设陈述已渲染进 loop 定义与审批理由，**不可再改**） */
export interface UpdateHypothesisInput {
  statement?: string;
  rationale?: string | null;
  target?: string | null;
  platform?: string | null;
  insightId?: string | null;
  successCriteria?: SuccessCriteria | null;
}

/** 用户可编辑的状态（draft/ready；running 起锁定，终态只读） */
const EDITABLE_STATUSES: readonly HypothesisStatus[] = ['draft', 'ready'];

@Injectable()
export class HypothesesService {
  constructor(
    @Inject(HypothesisStore) private readonly store: HypothesisStore,
    @Inject(InsightStore) private readonly insights: InsightStore,
    @Inject(CreativeLoopAccessService) private readonly access: CreativeLoopAccessService,
  ) {}

  async create(userId: string, input: {
    statement: string;
    rationale?: string | null;
    target?: string | null;
    platform?: string | null;
    insightId?: string | null;
    successCriteria?: SuccessCriteria | null;
    organizationId?: string;
    projectId?: string | null;
  }): Promise<HypothesisView> {
    const scope: LoopScope = await this.access.resolveScope(userId, {
      organizationId: input.organizationId,
      projectId: input.projectId ?? undefined,
    });
    await this.access.requireWrite(userId, scope.organizationId);
    // 来源洞察必须同组织可见（绝不跨租户引用）
    if (input.insightId) {
      const insight = await this.insights.get(input.insightId);
      if (!insight || insight.doc.organizationId !== scope.organizationId) {
        throw new AppError(ErrorCode.NOT_FOUND, '来源洞察不存在');
      }
    }
    const doc: HypothesisDoc = {
      kind: 'creative_hypothesis',
      organizationId: scope.organizationId,
      projectId: scope.projectId,
      status: 'draft',
      statement: input.statement,
      rationale: input.rationale ?? null,
      target: input.target ?? null,
      platform: input.platform ?? null,
      insightId: input.insightId ?? null,
      successCriteria: input.successCriteria ?? null,
      loop: null,
      evaluationRunId: null,
      baselineRunId: null,
      experimentId: null,
      verdict: null,
      history: [],
    };
    const stored = await this.store.create(userId, doc);
    // M12-P1 verdict→下一次决策桥：把**同 statement 的历史判定**作为参考返回（只读，绝不落库）
    const priorVerdicts = await this.priorVerdictsFor(scope, doc.statement);
    return { ...this.toView(stored), priorVerdicts };
  }

  /**
   * 历史判定先例（**只读输入**）：同组织（+同项目）内**同 statement** 且已有 verdict 的假设结论，
   * 供创建方在"再试一次/换方向"时带上上一轮的学到什么（此前 verdict 无任何消费方 → 闭环断裂）。
   *
   * 边界：先例只是参考事实——**绝不**写入新假设文档、**绝不**改写历史行、**绝不**据此预判新假设
   * （判定仍只由判据收敛或人工显式 decision 产生；LLM 不得决定治理判定）。
   * 查询失败不阻断创建（先例是增益信息，不是创建的前置条件）——降级为空并告警。
   */
  private async priorVerdictsFor(scope: LoopScope, statement: string): Promise<PriorVerdictRef[]> {
    let rows: StoredDoc<HypothesisDoc>[];
    try {
      rows = await this.store.listVerdicts({
        organizationId: scope.organizationId,
        projectId: scope.projectId,
        statement,
        take: PRIOR_VERDICT_TAKE,
      });
    } catch {
      // 只读增益信息：绝不因先例查询失败让创建失败（记录留痕由 store/DB 层承担）
      return [];
    }
    const refs: PriorVerdictRef[] = [];
    for (const row of rows) {
      const verdict = row.doc.verdict;
      if (!verdict || (verdict.decision !== 'validated' && verdict.decision !== 'rejected')) continue;
      refs.push({
        hypothesisId: row.id,
        statement: row.doc.statement,
        status: row.doc.status,
        decision: verdict.decision,
        decidedBy: verdict.decidedBy,
        reason: verdict.reason,
        decidedAt: verdict.decidedAt,
        source: 'historical-verdict',
      });
    }
    return refs;
  }

  async list(userId: string, query: { organizationId?: string; projectId?: string; status?: HypothesisStatus; limit?: number }): Promise<{ hypotheses: HypothesisView[] }> {
    const scope = await this.access.resolveScope(userId, {
      organizationId: query.organizationId,
      projectId: query.projectId,
    });
    await this.access.requireRead(userId, scope.organizationId);
    const rows = await this.store.list({
      organizationId: scope.organizationId,
      projectId: scope.projectId ?? undefined,
      status: query.status,
      take: query.limit ?? 50,
    });
    return { hypotheses: rows.map((r) => this.toView(r)) };
  }

  async get(userId: string, id: string): Promise<HypothesisView> {
    const stored = await this.requireReadable(userId, id);
    return this.toView(stored);
  }

  async update(userId: string, id: string, input: UpdateHypothesisInput): Promise<HypothesisView> {
    const stored = await this.requireWritable(userId, id);
    if (!EDITABLE_STATUSES.includes(stored.doc.status)) {
      throw new AppError(
        ErrorCode.VALIDATION_ERROR,
        `当前状态不可编辑（${stored.doc.status}）——loop 已启动后假设锁定`,
      );
    }
    if (input.insightId) {
      const insight = await this.insights.get(input.insightId);
      if (!insight || insight.doc.organizationId !== stored.doc.organizationId) {
        throw new AppError(ErrorCode.NOT_FOUND, '来源洞察不存在');
      }
    }
    const next: HypothesisDoc = {
      ...stored.doc,
      ...(input.statement !== undefined ? { statement: input.statement } : {}),
      ...(input.rationale !== undefined ? { rationale: input.rationale } : {}),
      ...(input.target !== undefined ? { target: input.target } : {}),
      ...(input.platform !== undefined ? { platform: input.platform } : {}),
      ...(input.insightId !== undefined ? { insightId: input.insightId } : {}),
      ...(input.successCriteria !== undefined ? { successCriteria: input.successCriteria } : {}),
    };
    // M10-P4：非状态字段更新 = **version CAS**（锚定读取时的行版本——并发状态推进/并发编辑一律不被覆盖）
    const count = await this.store.casFields(id, stored.version, next);
    if (count === 0) throw new AppError(ErrorCode.VALIDATION_ERROR, '假设状态已被并发修改，请刷新后重试');
    return this.toView({ ...stored, doc: next, version: stored.version + 1 });
  }

  /** 删除：仅 draft/rejected（历史事实——已启动/已验证的假设行保留，绝不删除） */
  async remove(userId: string, id: string): Promise<{ deleted: true }> {
    const stored = await this.requireWritable(userId, id);
    const count = await this.store.remove(id, ['draft', 'rejected']);
    if (count === 0) {
      throw new AppError(ErrorCode.VALIDATION_ERROR, `当前状态不可删除（${stored.doc.status}）`);
    }
    return { deleted: true };
  }

  /**
   * 人工状态推进（**只开放人工可达边**）。
   * - draft → ready：提交假设（此后可用 `/start` 启动 loop）；
   * - draft/ready → rejected：人工放弃（记 verdict，保留假设行作为决策历史）；
   * - running：拒绝直改（loop 在执行，判定走 `/conclude`；取消 run 是运维动作）；
   * - validated/终态：拒绝（终态只读）。
   * 客户端**绝不可直设 running/validated**——否则绕过了 loop 事实与判定依据。
   */
  async setStatus(
    userId: string,
    id: string,
    input: { status: 'ready' | 'rejected'; reason?: string },
  ): Promise<HypothesisView> {
    const stored = await this.requireWritable(userId, id);
    const from = stored.doc.status;
    if (from === 'running') {
      throw new AppError(ErrorCode.VALIDATION_ERROR, 'loop 执行中不可直改状态（待 run 结束或先取消 run）');
    }
    if (from !== 'draft' && from !== 'ready') {
      throw new AppError(ErrorCode.VALIDATION_ERROR, `假设已终态（${from}），不可再变更`);
    }
    assertTransition(from, input.status); // 状态机唯一裁决（非法边 → 400，绝不落库）
    const patch = input.status === 'rejected'
      ? {
        verdict: {
          decision: 'rejected' as const,
          decidedBy: 'manual' as const,
          reason: input.reason ?? '人工放弃假设（未启动 loop）',
          criteria: stored.doc.successCriteria,
          facts: null,
          evaluationRunId: stored.doc.evaluationRunId,
          experimentId: stored.doc.experimentId,
          decidedAt: new Date().toISOString(),
        },
      }
      : {};
    return this.transition(userId, id, input.status, { by: 'manual', patch });
  }

  /**
   * 状态推进（**唯一入口**）：纯规则校验 → 条件更新（status 谓词 + **读取时 version 谓词**）。
   * 返回推进后的文档；CAS 失败（并发状态推进/并发编辑/状态已变）→ 400
   * （调用方无需重试语义，刷新后按最新状态决策——绝不把旧快照写回去）。
   */
  async transition(
    userId: string,
    id: string,
    to: HypothesisStatus,
    opts: { by: string; patch?: Partial<HypothesisDoc> },
  ): Promise<HypothesisView> {
    const stored = await this.requireWritable(userId, id);
    const from = stored.doc.status;
    assertTransition(from, to);
    const at = new Date().toISOString();
    const next: HypothesisDoc = {
      ...stored.doc,
      ...(opts.patch ?? {}),
      status: to,
      history: [...stored.doc.history, { from, to, at, by: opts.by }],
    };
    // M11-P5/D2-02：状态转移写整份文档 → 必须同时锚定 status 与**读取时版本**
    // （否则并发 casFields 写入的非状态字段会被本次转移用旧快照静默覆盖）
    const count = await this.store.cas(id, [from], next, stored.version);
    if (count === 0) throw new AppError(ErrorCode.VALIDATION_ERROR, '假设状态已被并发修改，请刷新后重试');
    return this.toView({ ...stored, doc: next });
  }

  /**
   * 内部受控写入（loop 编排/判定专用——控制器不暴露）：
   * 仅改非状态字段，走 **version CAS**（锚定读取时的行版本——绝不与并发状态推进互相覆盖）。
   */
  async patch(
    id: string,
    patch: Partial<Pick<HypothesisDoc, 'loop' | 'insightId' | 'evaluationRunId' | 'baselineRunId' | 'experimentId' | 'verdict' | 'successCriteria'>>,
    opts: { allowStatuses?: readonly HypothesisStatus[] } = {},
  ): Promise<StoredDoc<HypothesisDoc>> {
    const stored = await this.store.get(id);
    if (!stored) throw new AppError(ErrorCode.NOT_FOUND, '假设不存在');
    if (isTerminal(stored.doc.status) && (patch.loop || patch.evaluationRunId || patch.experimentId)) {
      // 终态行只允许补记判定事实（verdict），绝不重开执行引用
      throw new AppError(ErrorCode.VALIDATION_ERROR, '假设已终态，不可再变更执行引用');
    }
    if (opts.allowStatuses && !opts.allowStatuses.includes(stored.doc.status)) {
      throw new AppError(ErrorCode.VALIDATION_ERROR, `当前状态不允许该操作（${stored.doc.status}）`);
    }
    const next: HypothesisDoc = { ...stored.doc, ...patch };
    // M10-P4：非状态字段更新 = **version CAS**（并发状态推进/并发编辑的输家 count=0，绝不覆盖）
    const count = await this.store.casFields(id, stored.version, next);
    if (count === 0) throw new AppError(ErrorCode.VALIDATION_ERROR, '假设状态已被并发修改，请刷新后重试');
    return { ...stored, doc: next, version: stored.version + 1 };
  }

  /** 读路径（服务层内部用；返回存储行，不含视图包装） */
  async requireReadable(userId: string, id: string): Promise<StoredDoc<HypothesisDoc>> {
    const stored = await this.store.get(id);
    if (!stored) throw new AppError(ErrorCode.NOT_FOUND, '假设不存在');
    // M10-P15（BUG-12）：非成员 404 的文案必须与上方"假设不存在"逐字相同（否则文案成为存在性信道）
    await this.access.authorizeResource(userId, { organizationId: stored.doc.organizationId, userId: stored.userId }, 'workflow.read', '假设不存在');
    return stored;
  }

  /** 写路径（同左：先 404 防枚举，再 403 权限位） */
  async requireWritable(userId: string, id: string): Promise<StoredDoc<HypothesisDoc>> {
    const stored = await this.store.get(id);
    if (!stored) throw new AppError(ErrorCode.NOT_FOUND, '假设不存在');
    await this.access.authorizeResource(userId, { organizationId: stored.doc.organizationId, userId: stored.userId }, 'workflow.write', '假设不存在');
    return stored;
  }

  toView(stored: StoredDoc<HypothesisDoc>): HypothesisView {
    return {
      ...stored.doc,
      id: stored.id,
      createdAt: stored.createdAt,
      updatedAt: stored.updatedAt,
      terminal: isTerminal(stored.doc.status),
    };
  }
}
