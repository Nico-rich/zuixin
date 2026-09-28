import { Inject, Injectable, Logger } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { createHash } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service';
import { ToolRegistry } from '../../core/tools/tool-registry.service';
import { ExternalActionsService } from '../external-actions/external-actions.service';
import { AgentRunMessagesService } from '../agent-runs/agent-run-messages.service';
import { AGENT_RUN_QUEUE } from '../../core/queue/queue.module';
import { addJobBounded } from '../../core/queue/bounded-add';
import { AppError, ErrorCode } from '../../common/errors/app-error';
import { QuotaService } from '../billing/quota.service';
import { assertApprovalBinding, bindPayload } from '../approvals/approval-binding';
import { WorkflowWaitService } from './workflow-wait.service';
import { CompensationRecord, StepRowFact, WorkflowCompensationService } from './workflow-compensation.service';
import {
  WorkflowContext, WorkflowDefinition, WorkflowStepDef, evaluateCondition, effectiveMaxRetries,
  getPath, isCompensationTarget, isRetryableStepError, lockedDefinition, renderTemplate,
  workflowDeadlineMsFromSetting,
} from './workflow-types';

const APPROVAL_TTL_MS = 24 * 3600_000;

/** 子 run 终态（等待步骤的放行条件） */
const CHILD_TERMINAL = ['completed', 'failed', 'cancelled', 'timeout'];

/** 步骤行（本文件只依赖这些字段；实际行来自 Prisma） */
interface StepRow {
  stepIndex: number;
  stepId: string;
  status: string;
  attempt: number;
  approvalId: string | null;
  agentRunId: string | null;
  output: unknown;
  errorCode: string | null;
  errorMessage: string | null;
  startedAt: Date | null;
}

/** 执行上下文（execute 的入参形状；实际对象为 Prisma WorkflowRun 行） */
interface RunShape {
  id: string;
  userId: string;
  projectId: string | null;
  input: unknown;
  output: unknown;
  currentStep: number;
  startedAt: Date;
}

export interface ExecuteOutcome {
  outcome: 'continue' | 'waiting' | 'done';
  /** M9-P4：时间窗 wait 的下次唤醒时刻（epoch ms）——processor 据此投递延迟作业（唯一 jobId） */
  waitUntilMs?: number;
}

/** 审批请求（绑定 + 表单）的纯构造结果——抽出便于单测 binding/表单语义 */
export interface WorkflowApprovalRequest {
  actionType: string;
  action: unknown;
  reason: string;
  form?: Record<string, unknown>;
}

/**
 * M7-P6 Workflow 步骤机（确定性编排；复用 M6 原语，独立表）：
 * - 步骤：condition（安全路径求值跳转）/ tool（只读工具同步执行）/ agent（子 AgentRun + waiting 唤醒）/
 *   approval（Approval + waiting）/ external_action（复用 P3 服务，审批 id 取前置审批步骤）/ output（run 终态输出）；
 * - 幂等/崩溃恢复：UNIQUE(runId, stepIndex) 行复用——completed → 前进；running 残留 → 同行重试（attempt+1）；
 *   waiting → 按 DB 事实重评估（审批终态/子 run 终态）——resume 不依赖内存；
 * - 步骤级重试：仅 RETRYABLE_CODES（瞬态），maxAttempts 上限；失败默认 run failed（onError=skip 可跳过）；
 * - 工具步骤只允许 permission='read'（写副作用必须走 agent 步骤的 ToolCall 追溯体系）。
 *
 * M9-P4 Advanced Workflow（**增量，不重写编排器**）：
 * ① wait 步骤：时间窗（untilMs/untilIso，期限落步骤行，恢复绝不重新计时）或等待子 AgentRun 终态
 *    （复用 waiting + waitingOnAgentRunId + wake）；到期/终态 → 前进；
 * ② 步骤级 timeoutMs/retryPolicy：deadline 受 run 总时限约束（超时归因 PROVIDER_TIMEOUT = 瞬态，可被重试接住）；
 *    retryPolicy 与既有 maxAttempts **取并集**（既有语义绝不收窄），可声明 retryableCodes 子集；
 * ③ compensate：非瞬态失败 → 对已成功步骤按 stepIndex **逆序**执行补偿链（复用同一锚点行 + 同一幂等键）；
 *    补偿步骤在正常流程中绝不执行；补偿自身失败只记录（绝不无限重试）；
 * ④ approval：reason 模板 + formFields 展示字段 + **执行前重算绑定摘要**（审批绑定具体动作，三处校验语义不变）；
 * ⑤ 版本锁定：定义一律取 run 锁定的不可变版本（`lockedDefinition`），绝不读 workflow 最新版本。
 */
@Injectable()
export class WorkflowExecutor {
  private readonly logger = new Logger('WorkflowExecutor');

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(ToolRegistry) private readonly registry: ToolRegistry,
    @Inject(ExternalActionsService) private readonly actions: ExternalActionsService,
    @Inject(AgentRunMessagesService) private readonly messages: AgentRunMessagesService,
    @InjectQueue(AGENT_RUN_QUEUE) private readonly agentRunQueue: Queue,
    @Inject(QuotaService) private readonly quota: QuotaService,
    @Inject(WorkflowWaitService) private readonly waits: WorkflowWaitService,
    @Inject(WorkflowCompensationService) private readonly compensations: WorkflowCompensationService,
  ) {}

  /**
   * 执行一步（单步推进；调用方循环）。
   * Pre-M9 D5：可选 `signal`（worker 的 lease fencing 中止信号）——
   * 步骤内调用（工具 / external_action）收到该信号可被立即中止；已中止 → 直接返回 done 且**不写任何状态**
   * （原实现用 `new AbortController().signal` 占位，步骤内调用永不可中止）。
   */
  async execute(runId: string, workerId: string, signal?: AbortSignal): Promise<ExecuteOutcome> {
    if (signal?.aborted) return { outcome: 'done' }; // 已被 fencing：绝不执行、绝不写状态
    const run = await this.prisma.workflowRun.findUnique({
      where: { id: runId },
      include: { version: true, steps: { orderBy: { stepIndex: 'asc' } } },
    });
    if (!run || run.status !== 'running') return { outcome: 'done' };
    // M9-P4 ⑤：定义一律取 run 锁定的不可变版本（绝不读 workflow 最新版本）
    const def = lockedDefinition(run.version);
    const steps = def.steps;

    if (run.currentStep >= steps.length) {
      await this.finalize(runId, workerId, { status: 'completed', output: run.output });
      return { outcome: 'done' };
    }

    const step = steps[run.currentStep];
    const stepRow = run.steps.find((s) => s.stepIndex === run.currentStep) as StepRow | undefined;

    // M9-P4 ③：失败行残留（崩溃于补偿/终态写入之前）→ **幂等**补做补偿链 + 落终态；绝不重执行该步骤副作用
    if (stepRow?.status === 'failed') {
      return this.compensateAndFinalize(run, def, run.steps as StepRow[], workerId, signal, {
        errorCode: stepRow.errorCode ?? ErrorCode.INTERNAL,
        errorMessage: stepRow.errorMessage ?? '步骤失败',
      });
    }
    // completed 行（崩溃于前进前）→ 直接前进
    if (stepRow?.status === 'completed' && stepRow.stepIndex === run.currentStep) {
      await this.advance(runId, workerId, run.currentStep + 1, run.steps);
      return { outcome: 'continue' };
    }
    // M9-P4 ③：补偿步骤（被其他步骤 compensate 引用）在正常流程中**绝不执行**（仅由失败回滚链触发）
    if (isCompensationTarget(steps, step.id)) {
      await this.upsertStep(runId, run.currentStep, step.id, step.type, {
        status: 'skipped', output: { skipped: true, reason: 'compensation-only step' } as never,
        completedAt: new Date(), attempt: (stepRow?.attempt ?? 0) + 1,
      });
      this.logger.warn({ runId, stepId: step.id }, '补偿步骤在正常流程中被跳过（仅失败回滚链执行）');
      await this.advance(runId, workerId, run.currentStep + 1, run.steps);
      return { outcome: 'continue' };
    }
    const ctx = this.buildContext(run.input, run.steps);

    try {
      return await this.executeStep(run, step, stepRow, ctx, workerId, steps, signal);
    } catch (err) {
      // D5：已被 fencing 中止 → 不落任何步骤/终态事实（该 run 已归新 worker 所有）
      if (signal?.aborted) {
        this.logger.warn({ runId }, '执行已中止（lease fencing）：跳过步骤/终态写入');
        return { outcome: 'done' };
      }
      const appErr = err instanceof AppError ? err : new AppError(ErrorCode.INTERNAL, (err as Error).message);
      const maxRetries = effectiveMaxRetries(step);
      const attempt = (stepRow?.attempt ?? 0) + 1;
      // M9-P4 ②：瞬态判定按 retryPolicy.retryableCodes 收窄（缺省 = RETRYABLE_CODES）；次数 = max(maxAttempts, maxRetries)
      if (isRetryableStepError(step, appErr.code) && attempt <= maxRetries) {
        // 步骤级重试（瞬态失败）：同行 attempt+1，继续执行同一步
        await this.upsertStep(runId, run.currentStep, step.id, step.type, { attempt });
        this.logger.warn({ runId, stepId: step.id, attempt, errorCode: appErr.code }, '步骤瞬态失败 → 步骤级重试');
        return { outcome: 'continue' };
      }
      if (step.onError === 'skip') {
        await this.upsertStep(runId, run.currentStep, step.id, step.type, {
          status: 'skipped', errorCode: appErr.code, errorMessage: appErr.message,
          completedAt: new Date(), attempt,
        });
        await this.advance(runId, workerId, run.currentStep + 1, run.steps);
        return { outcome: 'continue' };
      }
      await this.upsertStep(runId, run.currentStep, step.id, step.type, {
        status: 'failed', errorCode: appErr.code, errorMessage: appErr.message,
        completedAt: new Date(), attempt,
      });
      // M9-P4 ③：非瞬态失败（或重试耗尽）→ 逆序补偿链（幂等）→ run failed（output 记录补偿结果）
      return this.compensateAndFinalize(run, def, run.steps as StepRow[], workerId, signal, {
        errorCode: appErr.code, errorMessage: appErr.message,
      });
    }
  }

  private async executeStep(
    run: RunShape,
    step: WorkflowStepDef,
    stepRow: StepRow | undefined,
    ctx: WorkflowContext,
    workerId: string,
    steps: WorkflowStepDef[],
    signal?: AbortSignal,
  ): Promise<ExecuteOutcome> {
    switch (step.type) {
      case 'condition': {
        const next = steps[run.currentStep + 1]?.id ?? null;
        const { target, hit, actual } = evaluateCondition(step.condition!, ctx, next);
        const targetIndex = steps.findIndex((s) => s.id === target);
        if (target === null) {
          await this.upsertStep(run.id, run.currentStep, step.id, 'condition', {
            status: 'completed', output: { jumpTo: null }, completedAt: new Date(), attempt: (stepRow?.attempt ?? 0) + 1,
          });
          await this.finalize(run.id, workerId, { status: 'completed', output: run.input });
          return { outcome: 'done' };
        }
        if (targetIndex < 0) throw new AppError(ErrorCode.VALIDATION_ERROR, `条件跳转目标不存在: ${target}`);
        await this.upsertStep(run.id, run.currentStep, step.id, 'condition', {
          status: 'completed', output: { jumpTo: target, hit, actual }, completedAt: new Date(), attempt: (stepRow?.attempt ?? 0) + 1,
        });
        await this.advance(run.id, workerId, targetIndex, []);
        return { outcome: 'continue' };
      }

      case 'tool': {
        const output = await this.withStepDeadline(step, run, signal, (sig) =>
          this.invokeTool(run, step, run.currentStep, ctx, sig));
        await this.upsertStep(run.id, run.currentStep, step.id, 'tool', {
          status: 'completed', output: output as never, completedAt: new Date(), attempt: (stepRow?.attempt ?? 0) + 1,
        });
        await this.advance(run.id, workerId, run.currentStep + 1, []);
        return { outcome: 'continue' };
      }

      case 'agent': {
        // waiting 重评估：子 run 终态 → 步骤终态 + 前进（resume 不依赖内存）
        if (stepRow?.status === 'waiting' && stepRow.agentRunId) {
          const child = await this.prisma.agentRun.findUnique({ where: { id: stepRow.agentRunId } });
          if (!child || !CHILD_TERMINAL.includes(child.status)) {
            return this.reEnterWaiting(run.id, workerId, stepRow.agentRunId, null);
          }
          if (child.status === 'completed') {
            const content = await this.childResultContent(stepRow.agentRunId);
            await this.upsertStep(run.id, run.currentStep, step.id, 'agent', {
              status: 'completed', completedAt: new Date(), attempt: (stepRow?.attempt ?? 0) + 1,
              output: { childRunId: child.id, status: child.status, content },
            });
            await this.advance(run.id, workerId, run.currentStep + 1, []);
            return { outcome: 'continue' };
          }
          throw new AppError(ErrorCode.AGENT_CANCELLED, `子 AgentRun 终态: ${child.status}`);
        }
        // 创建子 AgentRun（身份/版本全部服务端解析；transcript 种子由 Worker 首次执行补齐）
        const agent = await this.resolveAgent(step.agent!.agentId);
        const message = renderTemplate(step.agent!.message, ctx);
        const childRun = await this.prisma.agentRun.create({
          data: {
            userId: run.userId, agentId: agent.id, agentVersionId: agent.activeVersion!.id,
            projectId: run.projectId, status: 'queued', maxSteps: 8,
            metadata: { workflowRunId: run.id, workflowStepIndex: run.currentStep, workflow: true },
          },
        });
        await this.messages.append(run.userId, childRun.id, { role: 'user', content: message });
        await addJobBounded(this.agentRunQueue, 'execute', { runId: childRun.id },
          { jobId: `run-${childRun.id}`, attempts: 2, backoff: { type: 'exponential', delay: 2000 }, removeOnComplete: true, removeOnFail: { count: 500 } },
          'workflow-agent-step');
        await this.upsertStep(run.id, run.currentStep, step.id, 'agent', {
          status: 'waiting', agentRunId: childRun.id, output: { childRunId: childRun.id }, attempt: (stepRow?.attempt ?? 0) + 1,
        });
        return this.reEnterWaiting(run.id, workerId, childRun.id, null);
      }

      case 'approval': {
        if (stepRow?.status === 'waiting' && stepRow.approvalId) {
          const approval = await this.prisma.approval.findUnique({ where: { id: stepRow.approvalId } });
          if (!approval) throw new AppError(ErrorCode.TOOL_DENIED, '审批记录缺失');
          if (approval.status === 'requested') return this.reEnterWaiting(run.id, workerId, null, approval.id);
          if (approval.status === 'approved') {
            // M9-P4 ④：**执行前重算**绑定摘要——审批必须绑定"此刻将被执行的具体动作"（三处校验语义一致，绝不放行漂移载荷）
            const bound = boundActionOf(steps, run.currentStep, step, ctx);
            assertApprovalBinding({
              payload: approval.payload, actionType: bound.actionType, action: bound.action,
              reason: `工作流步骤 ${step.id}`,
            });
            await this.upsertStep(run.id, run.currentStep, step.id, 'approval', {
              status: 'completed', completedAt: new Date(), attempt: (stepRow?.attempt ?? 0) + 1,
              output: { approvalId: approval.id, status: 'approved', boundActionType: bound.actionType },
            });
            await this.advance(run.id, workerId, run.currentStep + 1, []);
            return { outcome: 'continue' };
          }
          throw new AppError(
            approval.status === 'expired' ? ErrorCode.APPROVAL_EXPIRED : ErrorCode.APPROVAL_REJECTED,
            approval.status === 'expired' ? '审批已过期' : '审批未通过',
          );
        }
        // Pre-M9 Approval Binding：把审批绑定到"将被执行的具体动作"——取本步骤之后第一个 external_action
        // 步骤（定义来自已发布版本，运行时冻结），渲染其载荷并写入 __binding；无下游外部动作时绑定本步骤自身。
        // M9-P4 ④：reason 支持 {{...}} 模板；formFields 解析为展示字段（**不参与 binding 摘要**）。
        const request = buildApprovalRequest(step, steps, run.currentStep, ctx);
        const approval = await this.prisma.approval.create({
          data: {
            userId: run.userId, projectId: run.projectId, workflowRunId: run.id,
            status: 'requested', riskLevel: step.approval!.riskLevel ?? 'medium',
            reason: request.reason,
            payload: bindPayload(
              { stepId: step.id, boundActionType: request.actionType, boundAction: request.action, ...(request.form ? { form: request.form } : {}) },
              request.actionType, request.action,
            ) as never,
            expiresAt: new Date(Date.now() + (step.approval!.expiresMs ?? APPROVAL_TTL_MS)),
          },
        });
        await this.upsertStep(run.id, run.currentStep, step.id, 'approval', {
          status: 'waiting', approvalId: approval.id, attempt: (stepRow?.attempt ?? 0) + 1,
        });
        return this.reEnterWaiting(run.id, workerId, null, approval.id);
      }

      case 'external_action': {
        const result = await this.withStepDeadline(step, run, signal, (sig) =>
          this.invokeExternalAction(run, step, run.currentStep, ctx, sig));
        await this.upsertStep(run.id, run.currentStep, step.id, 'external_action', {
          status: 'completed', output: result as never, completedAt: new Date(), attempt: (stepRow?.attempt ?? 0) + 1,
        });
        await this.advance(run.id, workerId, run.currentStep + 1, []);
        return { outcome: 'continue' };
      }

      case 'wait': {
        if (!step.wait) throw new AppError(ErrorCode.VALIDATION_ERROR, `步骤 ${step.id} 缺少 wait 定义`);
        const plan = this.waits.resolve(step.wait, ctx);
        const attempt = (stepRow?.attempt ?? 0) + 1;

        if (plan.kind === 'agent_run') {
          // 等待子 AgentRun 终态（复用 waiting + waitingOnAgentRunId：事件唤醒 + recoverStale 兜底）
          const childRunId = (stepRow?.status === 'waiting' && stepRow.agentRunId) ? stepRow.agentRunId : plan.childRunId;
          const child = await this.prisma.agentRun.findUnique({ where: { id: childRunId } });
          // 归属校验：子 run 必须属于本 run 的用户（防跨租户等待/探测）
          if (!child || child.userId !== run.userId) {
            throw new AppError(ErrorCode.NOT_FOUND, '等待的子 AgentRun 不存在或不属于当前用户');
          }
          if (!CHILD_TERMINAL.includes(child.status)) {
            await this.upsertStep(run.id, run.currentStep, step.id, 'wait', {
              status: 'waiting', agentRunId: child.id, attempt,
              output: { kind: 'agent_run', childRunId: child.id, childStatus: child.status } as never,
            });
            return this.reEnterWaiting(run.id, workerId, child.id, null);
          }
          await this.upsertStep(run.id, run.currentStep, step.id, 'wait', {
            status: 'completed', completedAt: new Date(), attempt,
            output: { kind: 'agent_run', childRunId: child.id, childStatus: child.status } as never,
          });
          await this.advance(run.id, workerId, run.currentStep + 1, []);
          return { outcome: 'continue' };
        }

        // 时间窗：首次进入换算绝对期限并落库；恢复时取既有期限（**绝不重新计时**）
        const persisted = stepRow?.status === 'waiting' ? this.waits.persistedDeadline(stepRow.output) : null;
        const untilMs = persisted ?? plan.untilMs;
        const now = Date.now();
        if (!this.waits.isDue(untilMs, now)) {
          await this.upsertStep(run.id, run.currentStep, step.id, 'wait', {
            status: 'waiting', attempt,
            output: { kind: 'time', waitingUntil: new Date(untilMs).toISOString() } as never,
          });
          const woken = await this.reEnterWaiting(run.id, workerId, null, null);
          // 唤醒由 processor 的延迟作业承担（唯一 jobId）；recoverStale 巡检兜底丢 job
          return woken.outcome === 'waiting' ? { outcome: 'waiting', waitUntilMs: untilMs } : { outcome: 'done' };
        }
        await this.upsertStep(run.id, run.currentStep, step.id, 'wait', {
          status: 'completed', completedAt: new Date(), attempt,
          output: {
            kind: 'time', waitedUntil: new Date(untilMs).toISOString(),
            waitedMs: Math.max(0, now - (stepRow?.startedAt?.getTime() ?? now)),
          } as never,
        });
        await this.advance(run.id, workerId, run.currentStep + 1, []);
        return { outcome: 'continue' };
      }

      case 'output': {
        const output = renderArgs(step.output ?? {}, ctx);
        await this.upsertStep(run.id, run.currentStep, step.id, 'output', {
          status: 'completed', output, completedAt: new Date(), attempt: (stepRow?.attempt ?? 0) + 1,
        });
        await this.finalize(run.id, workerId, { status: 'completed', output });
        return { outcome: 'done' };
      }

      default:
        throw new AppError(ErrorCode.VALIDATION_ERROR, `未知步骤类型: ${(step as { type: string }).type}`);
    }
  }

  /**
   * M9-P4 ③：失败收口——逆序补偿链（幂等）→ run failed + output 记录补偿结果。
   * 补偿被 lease fencing 中止时不写终态（绝不与新 owner 竞争）；补偿失败只记录（绝不无限重试）。
   */
  private async compensateAndFinalize(
    run: RunShape,
    def: WorkflowDefinition,
    rows: StepRow[],
    workerId: string,
    signal: AbortSignal | undefined,
    failure: { errorCode: string; errorMessage: string },
  ): Promise<ExecuteOutcome> {
    const ctx = this.buildContext(run.input, rows);
    const compensation: CompensationRecord[] = await this.compensations.run({
      runId: run.id,
      def,
      rows: rows as StepRowFact[],
      signal,
      invoke: (compStep, compIndex) =>
        this.withStepDeadline(compStep, run, signal, (sig) => this.runCompensationAction(run, compStep, compIndex, ctx, sig)),
    });
    if (signal?.aborted) {
      this.logger.warn({ runId: run.id }, '补偿链执行中已被 fencing → 不写终态（由新 owner 续跑）');
      return { outcome: 'done' };
    }
    // run 终态 output 记录补偿结果（无补偿声明/无已成功步骤 → 不写 output，保持既有语义）
    const output = compensation.length > 0
      ? { ...(asRecord(run.output)), compensation }
      : undefined;
    await this.finalize(run.id, workerId, {
      status: 'failed', errorCode: failure.errorCode, errorMessage: failure.errorMessage, output,
    });
    return { outcome: 'done' };
  }

  /**
   * M9-P4 ②：步骤 deadline——timeoutMs（受 run 总时限约束）到点即中止在途调用 + 归因 PROVIDER_TIMEOUT。
   * 双保险：① 下传组合 signal（lease fencing ∪ deadline）真正中止在途 IO；② 竞速 reject
   * （工具/适配器忽略 signal 时也绝不放行超时步骤）。未声明 timeoutMs → 原样直通（既有语义不变）。
   */
  private async withStepDeadline<T>(
    step: WorkflowStepDef,
    run: { startedAt: Date },
    leaseSignal: AbortSignal | undefined,
    fn: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    const passThrough = (): Promise<T> => fn(leaseSignal ?? new AbortController().signal);
    if (!step.timeoutMs) return passThrough();
    const remaining = run.startedAt.getTime() + (await this.runDeadlineMs()) - Date.now();
    const effective = Math.min(step.timeoutMs, remaining);
    if (effective <= 0) throw new AppError(ErrorCode.PROVIDER_TIMEOUT, '步骤执行超时（run 总时限已尽）');
    const controller = new AbortController();
    const signal = leaseSignal ? AbortSignal.any([leaseSignal, controller.signal]) : controller.signal;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new AppError(ErrorCode.PROVIDER_TIMEOUT, `步骤执行超时（${effective}ms）`));
      }, effective);
    });
    const work = fn(signal);
    work.catch(() => undefined); // 竞速输家：绝不产生未处理拒绝
    try {
      return await Promise.race([work, timeout]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /** run 总时限（与 Worker 侧 lease 同一事实源：SystemSetting.limits.workflowDeadlineMs） */
  private async runDeadlineMs(): Promise<number> {
    const row = await this.prisma.systemSetting.findUnique({ where: { key: 'limits' } });
    return workflowDeadlineMsFromSetting(row?.value);
  }

  /** 工具步骤执行（锚点粒度：stepIndex 决定幂等键——正常路径与补偿路径同一把键） */
  private async invokeTool(
    run: RunShape, step: WorkflowStepDef, stepIndex: number, ctx: WorkflowContext, signal: AbortSignal,
  ): Promise<unknown> {
    const tool = this.registry.get(step.tool!.name);
    if (!tool) throw new AppError(ErrorCode.VALIDATION_ERROR, `工具不存在: ${step.tool!.name}`);
    if (tool.permission !== 'read') {
      throw new AppError(ErrorCode.TOOL_DENIED, '工作流工具步骤仅支持只读工具；写操作请用 agent 步骤');
    }
    const args = renderArgs(step.tool!.arguments, ctx);
    const idempotencyKey = stepIdempotencyKey(run.id, stepIndex);
    return tool.execute(args, {
      userId: run.userId, projectId: run.projectId ?? undefined,
      agentRunId: '', agentRunStepId: '', toolCallId: '', // 工作流工具步骤无 ToolCall 追溯（只读工具不使用这些 FK）
      idempotencyKey, signal, // D5/M9-P4：lease fencing ∪ 步骤 deadline 可中止在途只读工具
    });
  }

  /** 外部动作步骤执行（审批复核 + 幂等键 + 审计全部走既有 ExternalActionsService，绝不绕过） */
  private async invokeExternalAction(
    run: RunShape, step: WorkflowStepDef, stepIndex: number, ctx: WorkflowContext, signal: AbortSignal,
  ): Promise<Record<string, unknown>> {
    // 前置审批步骤的 approvalId（执行链复核的合法授权来源）
    const approvalRow = await this.prisma.workflowStepRun.findFirst({
      where: { workflowRunId: run.id, stepType: 'approval', status: 'completed' },
      orderBy: { stepIndex: 'asc' },
      select: { approvalId: true },
    });
    if (!approvalRow?.approvalId) {
      throw new AppError(ErrorCode.TOOL_DENIED, 'external_action 步骤前必须有已批准的审批步骤');
    }
    const payload = renderArgs(step.externalAction!.payload ?? {}, ctx);
    return this.actions.execute({
      userId: run.userId, projectId: run.projectId ?? undefined,
      approvalId: approvalRow.approvalId,
      connectionId: step.externalAction!.connectionId,
      provider: step.externalAction!.provider ?? 'mock',
      actionType: step.externalAction!.actionType,
      payload,
      permission: 'external_action',
      idempotencyKey: stepExternalActionKey(run.id, stepIndex), // M7-P6 既有键格式（绝不改口径——在途 run/恢复依赖它）
      signal, // D5/M9-P4：lease fencing ∪ 步骤 deadline 可中止在途外部动作（残留 executing 由 G7 恢复兜底）
    });
  }

  /** 补偿步骤执行（仅 tool / external_action；DTO + validateDefinition 已收敛类型） */
  private runCompensationAction(
    run: RunShape, step: WorkflowStepDef, stepIndex: number, ctx: WorkflowContext, signal: AbortSignal,
  ): Promise<unknown> {
    if (step.type === 'tool') return this.invokeTool(run, step, stepIndex, ctx, signal);
    if (step.type === 'external_action') return this.invokeExternalAction(run, step, stepIndex, ctx, signal);
    throw new AppError(ErrorCode.VALIDATION_ERROR, `补偿步骤类型不支持: ${step.type}`);
  }

  /** 进入 waiting（条件更新 running+workerId → waiting + 目标 + 释放 lease；count=0 = 外部终态竞争 → done） */
  private async reEnterWaiting(runId: string, workerId: string, agentRunId: string | null, approvalId: string | null): Promise<{ outcome: 'waiting' | 'done' }> {
    const done = await this.prisma.workflowRun.updateMany({
      where: { id: runId, status: 'running', workerId },
      data: {
        status: 'waiting',
        waitingOnAgentRunId: agentRunId, waitingOnApprovalId: approvalId,
        workerId: null, leaseUntil: null, heartbeatAt: null,
      },
    });
    return done.count > 0 ? { outcome: 'waiting' } : { outcome: 'done' };
  }

  private async advance(runId: string, workerId: string, next: number, _rows: unknown[]): Promise<void> {
    await this.prisma.workflowRun.updateMany({
      where: { id: runId, status: 'running', workerId },
      data: { currentStep: next },
    });
  }

  private async finalize(runId: string, workerId: string, data: { status: string; output?: unknown; errorCode?: string; errorMessage?: string }): Promise<void> {
    const done = await this.prisma.workflowRun.updateMany({
      where: { id: runId, status: 'running', workerId },
      data: {
        status: data.status as never, completedAt: new Date(),
        output: (data.output as never) ?? undefined,
        errorCode: data.errorCode, errorMessage: data.errorMessage,
        waitingOnAgentRunId: null, waitingOnApprovalId: null, workerId: null, leaseUntil: null, heartbeatAt: null,
      },
    });
    if (done.count === 0) this.logger.warn({ runId }, 'workflow 终态条件更新 count=0（外部已终态）');
    // Pre-M9 C1：终态释放配额预留（释放丢失由 TTL 兜底——期间保守多计）
    await this.quota.release(runId, 'workflow_run').catch(() => undefined);
  }

  private async upsertStep(runId: string, stepIndex: number, stepId: string, stepType: string, data: Record<string, unknown>): Promise<void> {
    const existing = await this.prisma.workflowStepRun.findUnique({
      where: { workflowRunId_stepIndex: { workflowRunId: runId, stepIndex } },
    });
    if (existing) {
      await this.prisma.workflowStepRun.update({ where: { id: existing.id }, data: data as never });
    } else {
      await this.prisma.workflowStepRun.create({
        data: {
          workflowRunId: runId, stepId, stepIndex, stepType,
          startedAt: new Date(), ...data,
        } as never,
      });
    }
  }

  private buildContext(input: unknown, rows: Array<{ stepId: string; status: string; output: unknown }>): WorkflowContext {
    const steps: WorkflowContext['steps'] = {};
    for (const r of rows) steps[r.stepId] = { status: r.status, output: r.output ?? undefined };
    return { input: (input ?? {}) as Record<string, unknown>, steps };
  }

  private async resolveAgent(agentId?: string) {
    const agent = await this.prisma.agent.findFirst({
      where: agentId
        ? { id: agentId, enabled: true, scope: 'system' }
        : { slug: 'general-assistant', enabled: true, scope: 'system' },
      include: { activeVersion: true },
    });
    if (!agent || !agent.activeVersion) throw new AppError(ErrorCode.VALIDATION_ERROR, 'Agent 不存在或无可执行版本');
    return agent;
  }

  /** 子 AgentRun 结构化结果：终态 + 最后 assistant 内容（截断；绝不含内部推理） */
  private async childResultContent(childRunId: string): Promise<string> {
    const rows = await this.prisma.agentRunMessage.findMany({
      where: { runId: childRunId, role: 'assistant' },
      orderBy: { sequence: 'desc' },
      take: 1,
    });
    const content = rows[0]?.content ?? '';
    return content.slice(0, 2000);
  }
}

/**
 * 工具步骤副作用幂等键（锚点 = (runId, stepIndex)；M7-P6 既有格式：sha256 hex）。
 * 补偿路径复用**同一把键**（补偿步骤自身的 stepIndex）→ 崩溃重放绝不重复执行副作用。
 */
export function stepIdempotencyKey(runId: string, stepIndex: number): string {
  return createHash('sha256').update(`wf:${runId}:${stepIndex}`).digest('hex');
}

/**
 * 外部动作步骤幂等键（锚点 = (runId, stepIndex)）——**M7-P6 既有键格式，绝不改口径**：
 * ExternalAction 的 UNIQUE(userId, provider, idempotencyKey) 是跨版本共享的事实源（在途 run 的
 * executing 残留恢复、审计对账均按该键寻址），故保持 `wf:<runId>:<stepIndex>` 原样。
 * 补偿路径（external_action 类型补偿）复用同一函数 → 同一把键。
 */
export function stepExternalActionKey(runId: string, stepIndex: number): string {
  return `wf:${runId}:${stepIndex}`;
}

/**
 * 审批绑定口径（Pre-M9 Approval Binding 原文，M9-P4 抽出复用）：取审批步骤之后**第一个** external_action
 * 步骤的动作类型与渲染载荷（定义来自已发布版本，运行时冻结）；无下游外部动作 → 绑定本步骤自身。
 * 三处校验（引擎审批门 / 工作流审批步骤 / external-actions.verifyApproval）共用同一 `assertApprovalBinding`。
 */
export function boundActionOf(
  steps: readonly WorkflowStepDef[],
  currentStep: number,
  step: WorkflowStepDef,
  ctx: WorkflowContext,
): { actionType: string; action: unknown } {
  const boundStep = steps.slice(currentStep + 1).find((s) => s.type === 'external_action');
  const actionType = boundStep?.externalAction?.actionType ?? `workflow.approval:${step.id}`;
  const action = boundStep ? renderArgs(boundStep.externalAction!.payload ?? {}, ctx) : { stepId: step.id };
  return { actionType, action };
}

/**
 * 审批请求构造（纯函数，便于单测）：reason 模板渲染 + 展示字段解析 + 绑定口径。
 * 展示字段（form）**仅供人读**，绝不参与 `payloadHash`（binding 只绑定将被执行的动作）。
 */
export function buildApprovalRequest(
  step: WorkflowStepDef,
  steps: readonly WorkflowStepDef[],
  currentStep: number,
  ctx: WorkflowContext,
): WorkflowApprovalRequest {
  const bound = boundActionOf(steps, currentStep, step, ctx);
  const form: Record<string, unknown> = {};
  for (const path of step.approval?.formFields ?? []) {
    const value = getPath(ctx, path);
    form[path] = value === undefined ? null : value;
  }
  return {
    actionType: bound.actionType,
    action: bound.action,
    reason: renderTemplate(step.approval?.reason ?? '', ctx),
    ...(Object.keys(form).length > 0 ? { form } : {}),
  };
}

/** 参数模板渲染：对象值递归替换 {{path}}（字符串值经 renderTemplate） */
function renderArgs(args: Record<string, unknown>, ctx: WorkflowContext): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args)) {
    if (typeof v === 'string') out[k] = renderTemplate(v, ctx);
    else if (Array.isArray(v)) out[k] = v.map((item) => (typeof item === 'string' ? renderTemplate(item, ctx) : item));
    else if (v && typeof v === 'object') out[k] = renderArgs(v as Record<string, unknown>, ctx);
    else out[k] = v;
  }
  return out;
}

/** 对象化（run.output 可能为 null/数组；绝不污染业务语义） */
function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? { ...(value as Record<string, unknown>) } : {};
}
