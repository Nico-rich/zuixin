/**
 * M9-P5 Loop 编排（**把闭环落成一条既有 workflow 定义，绝不新增编排器**）。
 *
 * 闭环映射（复用边界见 loop-template.ts 各步骤注释）：
 *   insight_snapshot(tool=performance.insights, M7-P8 只读) → generate_creative(agent, M5 生成链)
 *   → human_review(approval, M7-P1 人工门) → publish_creative(external_action, M7-P3 全链)
 *   → [失败链: rollback_publish(compensation, M9-P4)] → observe_performance(wait, M9-P4)
 *   → loop_outcome(output)
 *
 * 生命周期归属（**绝不重复实现**）：
 * - workflow / version / run 生命周期 = M7-P6 `WorkflowsService` / `WorkflowRunsService`（本服务只调用）；
 * - 真实平台写操作 = M7-P3 `ExternalActionsService`（引擎内部调用：审批绑定 + 审计 + 幂等全链，绝不绕过）；
 * - 评测 / 实验 = M9-P1（本服务只做**引用挂接**与只读消费，绝不新建第二套）；
 * - 假设状态机 = HypothesesService：用户触发走带 RBAC 的 `transition`；系统收敛走 `systemTransition`，
 *   两者同样**条件更新**（CAS 锚定当前 status，失败绝不覆盖）。
 *
 * 边界（M8 冻结边界延续）：loop 只在**单次人工审批**后提交一次平台写操作；绝不批量投放、绝不无审批写。
 */

import { Inject, Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { WorkflowsService } from '../workflows/workflows.service';
import { WorkflowRunsService } from '../workflows/workflow-runs.service';
import { EvaluationRunsService } from '../evaluation/evaluation-runs.service';
import { ExperimentsService } from '../evaluation/experiments.service';
import { AppError, ErrorCode } from '../../common/errors/app-error';
import { HypothesesService, HypothesisView } from './hypotheses.service';
import { HypothesisDoc, HypothesisStore, HypothesisVerdict, InsightStore, StoredDoc } from './creative-loop-store';
import { HypothesisStatus, assertTransition } from './hypothesis-status';
import {
  LOOP_STEP_IDS, LoopTemplateInput, buildLoopDefinition, loopRunIdempotencyKey, loopWorkflowName,
} from './loop-template';
import { derivePerfMetrics, isCriteriaSatisfied, stableStringify, sumPerfFacts } from './insight-rules';

/** run 终态（与 M7-P6 一致；本服务**只读**run 状态，绝不写 run 生命周期） */
const RUN_TERMINAL = ['completed', 'failed', 'cancelled', 'timeout'] as const;
/** 可触发系统收敛的终态（cancelled 需人工判定，绝不自动终态化假设） */
const RUN_CONCLUSIVE = ['completed', 'failed', 'timeout'] as const;

export interface LoopStartInput {
  /** 绩效观察窗（ms；缺省模板值 1h，受 validateDefinition 上限 7 天约束） */
  waitMs?: number;
  platform?: string;
  actionType?: string;
  connectionId?: string;
  agentId?: string;
  riskLevel?: 'low' | 'medium' | 'high';
  approvalReason?: string;
  /** 覆盖假设上的目标受众（**仅首次启动生效**——定义一经固化即版本锁定） */
  target?: string;
}

export interface LoopPending {
  reason:
    | 'awaiting-approval' | 'observing' | 'awaiting-facts' | 'awaiting-criteria'
    | 'cancelled-needs-verdict' | 'run-failed-needs-verdict' | null;
  detail: string;
}

export interface LoopRunStepSummary {
  stepId: string;
  stepIndex: number;
  stepType: string;
  status: string;
  attempt: number;
  approvalId: string | null;
  externalActionId: string | null;
  agentRunId: string | null;
  startedAt: Date | null;
  completedAt: Date | null;
  errorCode: string | null;
}

export interface LoopRunSummary {
  runId: string;
  workflowId: string;
  versionId: string;
  version: number;
  status: string;
  attempt: number;
  currentStep: number;
  waitingOnApprovalId: string | null;
  startedAt: Date;
  completedAt: Date | null;
  errorCode: string | null;
  output: unknown;
  steps: LoopRunStepSummary[];
}

export interface LoopStatusResult {
  hypothesis: HypothesisView;
  run: LoopRunSummary | null;
  insightId: string | null;
  insightFactsHash: string | null;
  pending: LoopPending;
  /** 已发布内容的回滚状态（P5 补偿链事实的只读投影；无 run/未发布 → not-required） */
  rollback: LoopRollback;
}

/** run 步骤行最小事实（本模块**只读**——步骤/补偿留痕由 M9-P4 引擎写入） */
export interface LoopRunStepRow {
  stepId: string;
  stepType: string;
  status: string;
  externalActionId: string | null;
  output: unknown;
  errorCode: string | null;
}

export interface LoopRollback {
  /** 是否有已完成的平台写操作需要回滚 */
  required: boolean;
  status: 'not-required' | 'pending' | 'completed' | 'failed';
  publishActionId: string | null;
  compensateStepId: string | null;
  errorCode: string | null;
  detail: string;
}

/**
 * 已发布内容的回滚投影（纯函数，只读事实；**绝不重算、绝不代执行回滚**）。
 *
 * 事实源 = M9-P4 引擎写在 run 步骤行上的留痕：
 * - 发布是否完成 = `publish_creative` 行 status='completed'（未完成 → 没有写出去的东西，无需回滚）；
 * - 回滚是否执行过 = 回滚锚点行的 `stepType='compensation'`。正常流程里 `rollback_publish` 会被记为
 *   skipped，但那时 stepType 仍是定义中的 'external_action'；只有补偿链**真实执行**才会留下
 *   'compensation' 留痕（锚点行由补偿服务复用/创建）；
 * - 回滚结果 = 锚点行 status/errorCode（补偿失败**绝不重试**，故失败必须被人看见并人工兜底）。
 *
 * 诚实性要求：**绝不把"没看到补偿留痕"读成"已回滚"**——已发布且无补偿留痕 = pending（待回滚）。
 */
export function rollbackOf(steps: readonly LoopRunStepRow[]): LoopRollback {
  const publish = steps.find((s) => s.stepId === LOOP_STEP_IDS.publishCreative);
  const published = publish?.status === 'completed' ? publish : undefined;
  if (!published) {
    return {
      required: false, status: 'not-required', publishActionId: null, compensateStepId: null, errorCode: null,
      detail: '平台写操作未执行，无需回滚',
    };
  }
  const output = (published.output ?? null) as Record<string, unknown> | null;
  const publishActionId = (output?.externalActionId as string | undefined) ?? published.externalActionId ?? null;
  const anchor = steps.find((s) => s.stepId === LOOP_STEP_IDS.rollbackPublish && s.stepType === 'compensation');
  const base = { required: true, publishActionId, compensateStepId: LOOP_STEP_IDS.rollbackPublish };
  if (!anchor) {
    return { ...base, status: 'pending', errorCode: null, detail: '已发布但未见补偿链留痕（待回滚/未执行）' };
  }
  if (anchor.status === 'completed') {
    return { ...base, status: 'completed', errorCode: null, detail: '补偿链已回滚平台写操作' };
  }
  if (anchor.status === 'failed') {
    return {
      ...base, status: 'failed', errorCode: anchor.errorCode ?? null,
      detail: '补偿链回滚失败（补偿绝不重试）——已发布的写操作需人工处理',
    };
  }
  return { ...base, status: 'pending', errorCode: anchor.errorCode ?? null, detail: `补偿链状态 ${anchor.status}（待回滚）` };
}

@Injectable()
export class CreativeLoopOrchestrator {
  private readonly logger = new Logger('CreativeLoop');

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(HypothesisStore) private readonly store: HypothesisStore,
    @Inject(InsightStore) private readonly insights: InsightStore,
    @Inject(HypothesesService) private readonly hypotheses: HypothesesService,
    @Inject(WorkflowsService) private readonly workflows: WorkflowsService,
    @Inject(WorkflowRunsService) private readonly runs: WorkflowRunsService,
    @Inject(EvaluationRunsService) private readonly evaluationRuns: EvaluationRunsService,
    @Inject(ExperimentsService) private readonly experiments: ExperimentsService,
  ) {}

  /**
   * 启动 loop（ready → running）。幂等收敛：
   * - 已在运行（running 且已记 runId）→ **幂等读**：直接返回现状，绝不新建 workflow/run
   *   （双击、客户端重放、网络重试的确定性结果；要再跑一次须新建假设行——状态机无 running → ready 边）；
   * - 定义固化：首次启动创建并发布 workflow（版本锁定）；重跑复用同一 published 版本，
   *   参数与固化定义不一致 → 400（绝不在半路换定义）；
   * - run 幂等：同假设同 attempt 的幂等键 → 绝不产生第二个 run（双击收敛为同一 run）；
   * - 状态推进条件更新：CAS 失败但 runId 已是本次 run → 视为并发双击，返回当前状态（不算错误）。
   */
  async start(userId: string, hypothesisId: string, input: LoopStartInput = {}): Promise<LoopStatusResult> {
    const stored = await this.hypotheses.requireWritable(userId, hypothesisId);
    const doc = stored.doc;
    if (doc.status === 'running' && doc.loop?.runId) {
      // 已在运行：**幂等返回现状**（双击/请求重放绝不重复启动、绝不新建第二个 run；重跑需新建假设）
      this.logger.log({ hypothesisId, runId: doc.loop.runId }, 'loop 已在运行，启动请求幂等返回现状');
      return this.statusOf(stored);
    }
    if (doc.status !== 'ready') {
      assertTransition(doc.status, 'running'); // 复用纯规则抛错（消息含 from → to）
    }
    const attempt = (doc.loop?.attempts ?? 0) + 1;
    const templateInput: LoopTemplateInput = {
      hypothesisId,
      statement: doc.statement,
      target: input.target ?? doc.target ?? undefined,
      platform: input.platform ?? doc.platform ?? undefined,
      insightId: doc.insightId,
      actionType: input.actionType,
      connectionId: input.connectionId,
      waitMs: input.waitMs,
      agentId: input.agentId,
      approvalReason: input.approvalReason,
      riskLevel: input.riskLevel,
    };
    const definition = buildLoopDefinition(templateInput);
    const workflowId = await this.ensureLoopWorkflow(userId, hypothesisId, doc, definition);
    const run = await this.runs.createRun(userId, {
      workflowId,
      triggerType: 'manual',
      idempotencyKey: loopRunIdempotencyKey(hypothesisId, attempt),
      payload: {
        hypothesisId,
        statement: doc.statement,
        insightId: doc.insightId,
        organizationId: doc.organizationId,
        projectId: doc.projectId,
      },
      attempt,
    });
    try {
      await this.hypotheses.transition(userId, hypothesisId, 'running', {
        by: 'manual',
        patch: {
          loop: {
            workflowId,
            runId: run.id,
            attempts: attempt,
            startedAt: new Date().toISOString(),
          },
        },
      });
    } catch (err) {
      // 并发双击：另一请求已把假设推进到 running，且落的就是同一 run（幂等键相同）→ 返回现状
      const fresh = await this.store.get(hypothesisId);
      if (err instanceof AppError && fresh?.doc.status === 'running' && fresh.doc.loop?.runId === run.id) {
        this.logger.log({ hypothesisId, runId: run.id }, 'loop 并发启动收敛为同一 run');
        return this.statusOf(fresh);
      }
      throw err;
    }
    this.logger.log({ hypothesisId, runId: run.id, attempt }, 'loop 已启动');
    return this.statusOf(await this.requireStored(hypothesisId));
  }

  /**
   * loop 状态（读路径收敛：run 已终态 → 系统推进假设状态机/判定）。
   * 收敛是"事实 → 状态"的确定性投影，与 Pre-M9 性能包"读路径刷新收敛"同一模式（无新队列/新表）；
   * 仅有 workflow.read 的成员（如 viewer）读取时同样收敛——推进是 run 终态的后果，不是用户决策。
   */
  async status(userId: string, hypothesisId: string): Promise<LoopStatusResult> {
    const stored = await this.hypotheses.requireReadable(userId, hypothesisId);
    return this.statusOf(stored);
  }

  /** loop 运行明细（引用 workflowRun；run 生命周期仍归 M7-P6，完整 timeline 用 /workflows/runs/:id） */
  async runDetail(userId: string, hypothesisId: string): Promise<{
    hypothesis: HypothesisView;
    run: LoopRunSummary | null;
    pending: LoopPending;
    rollback: LoopRollback;
  }> {
    const stored = await this.hypotheses.requireReadable(userId, hypothesisId);
    const result = await this.statusOf(stored);
    return { hypothesis: result.hypothesis, run: result.run, pending: result.pending, rollback: result.rollback };
  }

  /**
   * 显式判定（人工/Agent）：decision 缺省 = 按假设判据 + 服务端事实判定。
   * - running 且 run 未终态 → 400（loop 仍在执行，绝不中途终态化）；
   * - draft/ready → 仅 rejected 可达（状态机无 draft→validated / ready→validated 边）。
   */
  async conclude(
    userId: string,
    hypothesisId: string,
    input: { decision?: 'validated' | 'rejected'; reason?: string } = {},
  ): Promise<LoopStatusResult> {
    const stored = await this.hypotheses.requireWritable(userId, hypothesisId);
    const doc = stored.doc;
    const run = doc.loop ? await this.readRun(doc.loop.runId) : null;
    if (doc.status === 'running' && run && !RUN_TERMINAL.includes(run.status as never)) {
      throw new AppError(ErrorCode.VALIDATION_ERROR, `loop 仍在执行（run=${run.status}），待运行结束后判定`);
    }
    const collected = await this.collectFacts(stored);
    const criteriaVerdict = doc.successCriteria ? isCriteriaSatisfied(doc.successCriteria, collected.flat) : null;
    let target: HypothesisStatus;
    let by: 'manual' | 'criteria';
    let reason: string;
    if (input.decision) {
      target = input.decision;
      by = 'manual';
      reason = input.reason ?? `人工判定：${input.decision === 'validated' ? '假设成立' : '假设不成立'}`;
    } else {
      if (!criteriaVerdict) throw new AppError(ErrorCode.VALIDATION_ERROR, '假设未声明成功判据，需显式 decision');
      if (!criteriaVerdict.satisfiable) throw new AppError(ErrorCode.VALIDATION_ERROR, `判据不可评估：${criteriaVerdict.reason}`);
      target = criteriaVerdict.satisfied ? 'validated' : 'rejected';
      by = 'criteria';
      reason = criteriaVerdict.reason;
    }
    const verdict: HypothesisVerdict = {
      decision: target === 'validated' ? 'validated' : 'rejected',
      decidedBy: by,
      reason,
      criteria: doc.successCriteria,
      facts: collected.detail,
      evaluationRunId: doc.evaluationRunId,
      experimentId: doc.experimentId,
      decidedAt: new Date().toISOString(),
    };
    await this.hypotheses.transition(userId, hypothesisId, target, { by, patch: { verdict } });
    return this.statusOf(await this.requireStored(hypothesisId));
  }

  /** 挂接 M9-P1 评测运行（只引用；分数事实由 P1 的 `scores` 摘要提供——绝不重算） */
  async attachEvaluation(userId: string, hypothesisId: string, evaluationRunId: string): Promise<LoopStatusResult> {
    const stored = await this.hypotheses.requireWritable(userId, hypothesisId);
    if (stored.doc.status !== 'running' && stored.doc.status !== 'ready') {
      throw new AppError(ErrorCode.VALIDATION_ERROR, `当前状态不可挂接评测（${stored.doc.status}）`);
    }
    const scope = await this.evaluationRuns.scope(evaluationRunId);
    if (!scope || scope.organizationId !== stored.doc.organizationId) {
      throw new AppError(ErrorCode.NOT_FOUND, '评测运行不存在');
    }
    const detail = await this.evaluationRuns.get(scope.organizationId, evaluationRunId);
    await this.hypotheses.patch(hypothesisId, {
      evaluationRunId,
      ...(detail.run.baselineRunId ? { baselineRunId: detail.run.baselineRunId } : {}),
    });
    return this.statusOf(await this.requireStored(hypothesisId));
  }

  /** 挂接 M9-P1 实验（只引用；实验生命周期归 P1） */
  async attachExperiment(userId: string, hypothesisId: string, experimentId: string): Promise<LoopStatusResult> {
    const stored = await this.hypotheses.requireWritable(userId, hypothesisId);
    if (stored.doc.status !== 'running' && stored.doc.status !== 'ready') {
      throw new AppError(ErrorCode.VALIDATION_ERROR, `当前状态不可挂接实验（${stored.doc.status}）`);
    }
    const scope = await this.experiments.scope(experimentId);
    if (!scope || scope.organizationId !== stored.doc.organizationId) {
      throw new AppError(ErrorCode.NOT_FOUND, '实验不存在');
    }
    await this.hypotheses.patch(hypothesisId, { experimentId });
    return this.statusOf(await this.requireStored(hypothesisId));
  }

  // ===== 内部 =====

  private async requireStored(hypothesisId: string): Promise<StoredDoc<HypothesisDoc>> {
    const stored = await this.store.get(hypothesisId);
    if (!stored) throw new AppError(ErrorCode.NOT_FOUND, '假设不存在');
    return stored;
  }

  /** 状态 + run 投影 + 待办原因（run 终态时先做一次收敛投影） */
  private async statusOf(stored: StoredDoc<HypothesisDoc>): Promise<LoopStatusResult> {
    let current = stored;
    let run = current.doc.loop ? await this.readRun(current.doc.loop.runId) : null;
    if (run && current.doc.status === 'running' && RUN_CONCLUSIVE.includes(run.status as never)) {
      await this.reconcile(current, run);
      current = await this.requireStored(stored.id);
      run = current.doc.loop ? await this.readRun(current.doc.loop.runId) : run;
    }
    const insight = current.doc.insightId ? await this.insights.get(current.doc.insightId) : null;
    return {
      hypothesis: this.hypotheses.toView(current),
      run: run ? this.toRunSummary(run) : null,
      insightId: current.doc.insightId,
      insightFactsHash: insight?.doc.factsHash ?? null,
      pending: this.pendingOf(current.doc, run),
      rollback: rollbackOf(run?.steps ?? []),
    };
  }

  /** 待办原因（只读投影；供 API 展示"卡在哪一步"） */
  private pendingOf(doc: HypothesisDoc, run: RunRow | null): LoopPending {
    if (doc.status !== 'running') return { reason: null, detail: doc.status };
    if (!run) return { reason: 'awaiting-criteria', detail: 'loop 未启动' };
    if (run.status === 'waiting') {
      return run.waitingOnApprovalId
        ? { reason: 'awaiting-approval', detail: `待人工审批 approval=${run.waitingOnApprovalId}` }
        : { reason: 'observing', detail: '绩效观察窗（wait 步骤）' };
    }
    if (run.status === 'cancelled') return { reason: 'cancelled-needs-verdict', detail: 'run 已取消，需人工判定' };
    if (run.status === 'failed' || run.status === 'timeout') {
      // 已发布的写操作是否被回滚是**运维事实**，必须随待办一起暴露（绝不因 run 失败就默认"已回滚"）
      const rollback = rollbackOf(run.steps ?? []);
      return {
        reason: 'run-failed-needs-verdict',
        detail: `run ${run.status}${rollback.required ? `；回滚状态 ${rollback.status}` : ''}`,
      };
    }
    if (run.status === 'completed') {
      return doc.successCriteria
        ? { reason: 'awaiting-facts', detail: '循环已跑完，等待回流事实满足判据' }
        : { reason: 'awaiting-criteria', detail: '假设未声明成功判据，需显式判定' };
    }
    return { reason: 'observing', detail: `run ${run.status}` };
  }

  /**
   * run 终态 → 假设状态收敛（系统驱动；条件更新 + 状态机校验，CAS 冲突静默交由调用方重读）。
   * - completed：按判据判定（无判据/事实不足 → 保持 running，绝不臆断）；
   * - failed/timeout：系统判定驳回（loop 未产出可用结果）；
   * - cancelled：**不自动终态化**（取消是运维动作，判定留给人）。
   */
  private async reconcile(stored: StoredDoc<HypothesisDoc>, run: RunRow): Promise<void> {
    if (stored.doc.status !== 'running') return;
    try {
      if (run.status === 'completed') {
        await this.concludeByCriteria(stored);
        return;
      }
      // 回滚事实随判决一并留痕：run 失败 ≠ 已发布的写操作已回滚（补偿失败绝不重试，必须人工兜底）
      const rollback = rollbackOf(run.steps ?? []);
      await this.systemTransition(stored, 'rejected', {
        by: 'system',
        verdict: {
          decision: 'rejected',
          decidedBy: 'system',
          reason: `loop 运行 ${run.status}${run.errorCode ? `（${run.errorCode}）` : ''}，未产出可用结果`
            + (rollback.required && rollback.status !== 'completed' ? `；已发布的写操作未回滚（${rollback.status}），需人工处理` : ''),
          criteria: stored.doc.successCriteria,
          facts: {
            runId: run.id, status: run.status, errorCode: run.errorCode,
            publishActionId: rollback.publishActionId, rollback: rollback.status, rollbackDetail: rollback.detail,
          },
          evaluationRunId: stored.doc.evaluationRunId,
          experimentId: stored.doc.experimentId,
          decidedAt: new Date().toISOString(),
        },
      });
    } catch (err) {
      // 并发读同时收敛 → 输家 CAS 失败：这不是错误（状态已由赢家推进，上层重读即为最新）
      if (err instanceof AppError && err.code === ErrorCode.VALIDATION_ERROR) {
        this.logger.debug({ hypothesisId: stored.id }, '并发收敛：CAS 未命中（另一请求已推进）');
        return;
      }
      throw err;
    }
  }

  /** 按判据收敛（判据缺失/事实不可评估 → 不推进，返回 null） */
  private async concludeByCriteria(stored: StoredDoc<HypothesisDoc>): Promise<HypothesisStatus | null> {
    const criteria = stored.doc.successCriteria;
    if (!criteria) return null;
    const collected = await this.collectFacts(stored);
    const verdict = isCriteriaSatisfied(criteria, collected.flat);
    if (!verdict.satisfiable) return null;
    const target: HypothesisStatus = verdict.satisfied ? 'validated' : 'rejected';
    await this.systemTransition(stored, target, {
      by: 'criteria',
      verdict: {
        decision: target === 'validated' ? 'validated' : 'rejected',
        decidedBy: 'criteria',
        reason: verdict.reason,
        criteria,
        facts: collected.detail,
        evaluationRunId: stored.doc.evaluationRunId,
        experimentId: stored.doc.experimentId,
        decidedAt: new Date().toISOString(),
      },
    });
    return target;
  }

  /** 系统驱动推进（**条件更新**：锚定当前 status；失败由 reconcile 静默处理） */
  private async systemTransition(
    stored: StoredDoc<HypothesisDoc>,
    to: HypothesisStatus,
    opts: { by: 'system' | 'criteria'; verdict: HypothesisVerdict },
  ): Promise<void> {
    const from = stored.doc.status;
    assertTransition(from, to);
    const next: HypothesisDoc = {
      ...stored.doc,
      status: to,
      verdict: opts.verdict,
      history: [...stored.doc.history, { from, to, at: new Date().toISOString(), by: opts.by }],
    };
    const count = await this.store.cas(stored.id, [from], next);
    if (count === 0) throw new AppError(ErrorCode.VALIDATION_ERROR, '假设状态已被并发修改，请刷新后重试');
  }

  /**
   * 判定事实（服务端聚合，**不含任何解读文本**）：
   * - 评测：M9-P1 `EvaluationRunsService.get` 的 `scores` 摘要（avgScore/passRate 由 P1 独家计算）；
   * - 绩效：M7-P8 回流事实 `CreativePerformance`（窗口 = loop 启动时刻起）求和 + 服务端派生。
   */
  private async collectFacts(stored: StoredDoc<HypothesisDoc>): Promise<{ flat: Record<string, number | null>; detail: Record<string, unknown> }> {
    const doc = stored.doc;
    const flat: Record<string, number | null> = { avg_score: null, pass_rate: null, roas: null, ctr: null };
    const detail: Record<string, unknown> = {};
    if (doc.evaluationRunId) {
      try {
        const detailRun = await this.evaluationRuns.get(doc.organizationId, doc.evaluationRunId);
        flat.avg_score = detailRun.scores.overall.avgScore;
        flat.pass_rate = detailRun.scores.overall.passRate;
        detail.evaluation = {
          runId: doc.evaluationRunId,
          status: detailRun.run.status,
          overall: detailRun.scores.overall,
          rule: 'evaluation-run-summary',
        };
      } catch {
        detail.evaluation = { runId: doc.evaluationRunId, error: 'not-found-or-inaccessible' };
      }
    }
    const since = doc.loop?.startedAt ? new Date(doc.loop.startedAt) : new Date(0);
    const rows = await this.prisma.creativePerformance.findMany({
      where: {
        userId: stored.userId,
        ...(doc.projectId ? { projectId: doc.projectId } : {}),
        capturedAt: { gte: since },
      },
    });
    const facts = sumPerfFacts(rows);
    const derived = derivePerfMetrics(facts);
    flat.roas = rows.length > 0 ? derived.roas : null;
    flat.ctr = rows.length > 0 ? derived.ctr : null;
    detail.performance = { rows: rows.length, facts, derived, rule: 'server-sum' };
    return { flat, detail };
  }

  /**
   * loop workflow 固化（**版本锁定**，M9-P4 语义）：
   * - 首次：创建（v1 draft）→ 发布（published）；
   * - 重跑：复用已发布版本；参数与固化定义不一致 → 400（需新建假设，绝不在半路换定义）；
   * - 上次启动中途失败（workflow 已建但无 published 版本）→ 覆盖最新 draft 后发布（定义尚未生效）。
   *
   * **并发启动收敛**：workflow 名称（`loop:<hypothesisId>`）在既有 schema 下无唯一约束
   * （schema 冻结，不新增迁移），两个并发 `/start` 可能各自 `create` 一行；若各用各的行创建 run，
   * 幂等键（键含 workflowId）将双双生效 → 同一假设被执行两次（外部写步骤重复），这是不可接受的。
   * 因此创建后**重新按 (createdAt, id) 全序重新选取最早一行**：落败方删除自己刚建的行
   * （此刻尚无任何 run 引用它——run 在 ensureLoopWorkflow 返回后才创建，删除安全）并回退到胜者。
   * 胜者（最早行）永不被删除，故已返回的 workflowId 不会消失。
   * 同一假设的状态机无 running → ready 边 → 每个假设只可能首次启动一次，故只剩上述并发窗口。
   */
  private async ensureLoopWorkflow(
    userId: string,
    hypothesisId: string,
    doc: HypothesisDoc,
    definition: ReturnType<typeof buildLoopDefinition>,
  ): Promise<string> {
    const name = loopWorkflowName(hypothesisId);
    const existing = await this.prisma.workflow.findFirst({
      where: { userId, name },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], // 并发下所有请求对"同一行"达成一致
      include: { versions: { orderBy: { version: 'desc' } } },
    });
    if (existing) {
      const published = existing.versions.find((v) => v.status === 'published');
      if (published) {
        if (stableStringify(published.definition) !== stableStringify(definition)) {
          throw new AppError(
            ErrorCode.VALIDATION_ERROR,
            'loop 定义已固化（首次启动锁定，M9-P4 版本语义）：参数变更需新建假设，绝不在半路换定义',
          );
        }
        return existing.id;
      }
      await this.workflows.update(userId, existing.id, { definition });
      await this.workflows.publish(userId, existing.id);
      return existing.id;
    }
    // 项目必须归本人（WorkflowsService.create 的项目校验），否则只落组织归属
    const ownedProject = doc.projectId
      ? await this.prisma.project.findFirst({ where: { id: doc.projectId, userId, deletedAt: null }, select: { id: true } })
      : null;
    const created = await this.workflows.create(userId, {
      name,
      description: `M9-P5 创意闭环（假设 ${hypothesisId}）：洞察 → 生成 → 人工审批 → 平台写 → 观察 → 收敛`,
      projectId: ownedProject ? doc.projectId : null,
      organizationId: doc.organizationId,
      definition,
    });
    await this.workflows.publish(userId, created.id);
    // 并发创建收敛：重新取最早一行；若自己不是最早（另一请求先插入了），删除自己的重复行并回退到胜者
    const winner = await this.prisma.workflow.findFirst({
      where: { userId, name },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      select: { id: true },
    });
    if (winner && winner.id !== created.id) {
      await this.prisma.workflow.delete({ where: { id: created.id } });
      this.logger.warn(
        { hypothesisId, discardedWorkflowId: created.id, workflowId: winner.id },
        'loop workflow 并发创建，已收敛为最早一行（重复行未挂任何 run，删除）',
      );
      return winner.id;
    }
    this.logger.log({ hypothesisId, workflowId: created.id }, 'loop workflow 已固化并发布');
    return created.id;
  }

  private async readRun(runId: string): Promise<RunRow | null> {
    return this.prisma.workflowRun.findUnique({
      where: { id: runId },
      include: { steps: { orderBy: { stepIndex: 'asc' } }, version: { select: { version: true } } },
    });
  }

  private toRunSummary(run: RunRow): LoopRunSummary {
    return {
      runId: run.id,
      workflowId: run.workflowId,
      versionId: run.versionId,
      version: run.version?.version ?? 0,
      status: run.status,
      attempt: run.attempt,
      currentStep: run.currentStep,
      waitingOnApprovalId: run.waitingOnApprovalId ?? null,
      startedAt: run.startedAt,
      completedAt: run.completedAt ?? null,
      errorCode: run.errorCode ?? null,
      output: run.output ?? null,
      steps: (run.steps ?? []).map((s) => ({
        stepId: s.stepId,
        stepIndex: s.stepIndex,
        stepType: s.stepType,
        status: s.status,
        attempt: s.attempt,
        approvalId: s.approvalId ?? null,
        externalActionId: s.externalActionId ?? null,
        agentRunId: s.agentRunId ?? null,
        startedAt: s.startedAt ?? null,
        completedAt: s.completedAt ?? null,
        errorCode: s.errorCode ?? null,
      })),
    };
  }
}

/** run 行投影类型（含版本与步骤；仅本文件内使用——run 生命周期归 M7-P6） */
interface RunRow {
  id: string;
  workflowId: string;
  versionId: string;
  status: string;
  attempt: number;
  currentStep: number;
  waitingOnApprovalId: string | null;
  errorCode: string | null;
  startedAt: Date;
  completedAt: Date | null;
  output: unknown;
  version?: { version: number } | null;
  steps?: Array<{
    stepId: string; stepIndex: number; stepType: string; status: string; attempt: number;
    approvalId: string | null; externalActionId: string | null; agentRunId: string | null;
    startedAt: Date | null; completedAt: Date | null; errorCode: string | null; output: unknown;
  }>;
}
