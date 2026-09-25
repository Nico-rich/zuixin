import { Inject, Injectable, Logger } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { createHash } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service';
import { ToolRegistry } from '../../core/tools/tool-registry.service';
import { ExternalActionsService } from '../external-actions/external-actions.service';
import { AgentRunMessagesService } from '../agent-runs/agent-run-messages.service';
import { AGENT_RUN_QUEUE } from '../../core/queue/queue.module';
import { AppError, ErrorCode, RETRYABLE_CODES } from '../../common/errors/app-error';
import { QuotaService } from '../billing/quota.service';
import {
  WorkflowContext, WorkflowDefinition, WorkflowStepDef, evaluateCondition, renderTemplate,
} from './workflow-types';

const APPROVAL_TTL_MS = 24 * 3600_000;

/**
 * M7-P6 Workflow 步骤机（确定性编排；复用 M6 原语，独立表）：
 * - 步骤：condition（安全路径求值跳转）/ tool（只读工具同步执行）/ agent（子 AgentRun + waiting 唤醒）/
 *   approval（Approval + waiting）/ external_action（复用 P3 服务，审批 id 取前置审批步骤）/ output（run 终态输出）；
 * - 幂等/崩溃恢复：UNIQUE(runId, stepIndex) 行复用——completed → 前进；running 残留 → 同行重试（attempt+1）；
 *   waiting → 按 DB 事实重评估（审批终态/子 run 终态）——resume 不依赖内存；
 * - 步骤级重试：仅 RETRYABLE_CODES（瞬态），maxAttempts 上限；失败默认 run failed（onError=skip 可跳过）；
 * - 工具步骤只允许 permission='read'（写副作用必须走 agent 步骤的 ToolCall 追溯体系）。
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
  ) {}

  async execute(runId: string, workerId: string): Promise<{ outcome: 'continue' | 'waiting' | 'done' }> {
    const run = await this.prisma.workflowRun.findUnique({
      where: { id: runId },
      include: { version: true, steps: { orderBy: { stepIndex: 'asc' } } },
    });
    if (!run || run.status !== 'running') return { outcome: 'done' };
    const def = run.version.definition as unknown as WorkflowDefinition;
    const steps = def.steps;

    if (run.currentStep >= steps.length) {
      await this.finalize(runId, workerId, { status: 'completed', output: run.output });
      return { outcome: 'done' };
    }

    const step = steps[run.currentStep];
    const stepRow = run.steps.find((s) => s.stepIndex === run.currentStep);
    // completed 行（崩溃于前进前）→ 直接前进
    if (stepRow?.status === 'completed' && stepRow.stepIndex === run.currentStep) {
      await this.advance(runId, workerId, run.currentStep + 1, run.steps);
      return { outcome: 'continue' };
    }
    const ctx = this.buildContext(run.input, run.steps);

    try {
      return await this.executeStep(run, step, stepRow, ctx, workerId, steps);
    } catch (err) {
      const appErr = err instanceof AppError ? err : new AppError(ErrorCode.INTERNAL, (err as Error).message);
      const maxAttempts = step.maxAttempts ?? 0;
      const attempt = (stepRow?.attempt ?? 0) + 1;
      const retryable = RETRYABLE_CODES.has(appErr.code);
      if (retryable && attempt <= maxAttempts) {
        // 步骤级重试（瞬态失败）：同行 attempt+1，继续执行同一步
        await this.upsertStep(runId, run.currentStep, step.id, step.type, { attempt });
        this.logger.warn({ runId, stepId: step.id, attempt }, '步骤瞬态失败 → 步骤级重试');
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
      await this.finalize(runId, workerId, { status: 'failed', errorCode: appErr.code, errorMessage: appErr.message });
      return { outcome: 'done' };
    }
  }

  private async executeStep(
    run: { id: string; userId: string; projectId: string | null; input: unknown; currentStep: number },
    step: WorkflowStepDef,
    stepRow: { status: string; approvalId: string | null; agentRunId: string | null; attempt: number } | undefined,
    ctx: WorkflowContext,
    workerId: string,
    steps: WorkflowStepDef[],
  ): Promise<{ outcome: 'continue' | 'waiting' | 'done' }> {
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
        const tool = this.registry.get(step.tool!.name);
        if (!tool) throw new AppError(ErrorCode.VALIDATION_ERROR, `工具不存在: ${step.tool!.name}`);
        if (tool.permission !== 'read') {
          throw new AppError(ErrorCode.TOOL_DENIED, '工作流工具步骤仅支持只读工具；写操作请用 agent 步骤');
        }
        const args = renderArgs(step.tool!.arguments, ctx);
        const idempotencyKey = createHash('sha256').update(`wf:${run.id}:${run.currentStep}`).digest('hex');
        const output = await tool.execute(args, {
          userId: run.userId, projectId: run.projectId ?? undefined,
          agentRunId: '', agentRunStepId: '', toolCallId: '', // 工作流工具步骤无 ToolCall 追溯（只读工具不使用这些 FK）
          idempotencyKey, signal: new AbortController().signal,
        });
        await this.upsertStep(run.id, run.currentStep, step.id, 'tool', {
          status: 'completed', output, completedAt: new Date(), attempt: (stepRow?.attempt ?? 0) + 1,
        });
        await this.advance(run.id, workerId, run.currentStep + 1, []);
        return { outcome: 'continue' };
      }

      case 'agent': {
        // waiting 重评估：子 run 终态 → 步骤终态 + 前进（resume 不依赖内存）
        if (stepRow?.status === 'waiting' && stepRow.agentRunId) {
          const child = await this.prisma.agentRun.findUnique({ where: { id: stepRow.agentRunId } });
          if (!child || !['completed', 'failed', 'cancelled', 'timeout'].includes(child.status)) {
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
        await this.agentRunQueue.add(
          'execute', { runId: childRun.id },
          { jobId: `run-${childRun.id}`, attempts: 2, backoff: { type: 'exponential', delay: 2000 }, removeOnComplete: true, removeOnFail: { count: 500 } },
        );
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
            await this.upsertStep(run.id, run.currentStep, step.id, 'approval', {
              status: 'completed', completedAt: new Date(), attempt: (stepRow?.attempt ?? 0) + 1,
              output: { approvalId: approval.id, status: 'approved' },
            });
            await this.advance(run.id, workerId, run.currentStep + 1, []);
            return { outcome: 'continue' };
          }
          throw new AppError(
            approval.status === 'expired' ? ErrorCode.APPROVAL_EXPIRED : ErrorCode.APPROVAL_REJECTED,
            approval.status === 'expired' ? '审批已过期' : '审批未通过',
          );
        }
        const approval = await this.prisma.approval.create({
          data: {
            userId: run.userId, projectId: run.projectId, workflowRunId: run.id,
            status: 'requested', riskLevel: step.approval!.riskLevel ?? 'medium',
            reason: step.approval!.reason,
            expiresAt: new Date(Date.now() + (step.approval!.expiresMs ?? APPROVAL_TTL_MS)),
          },
        });
        await this.upsertStep(run.id, run.currentStep, step.id, 'approval', {
          status: 'waiting', approvalId: approval.id, attempt: (stepRow?.attempt ?? 0) + 1,
        });
        return this.reEnterWaiting(run.id, workerId, null, approval.id);
      }

      case 'external_action': {
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
        const result = await this.actions.execute({
          userId: run.userId, projectId: run.projectId ?? undefined,
          approvalId: approvalRow.approvalId,
          connectionId: step.externalAction!.connectionId,
          provider: step.externalAction!.provider ?? 'mock',
          actionType: step.externalAction!.actionType,
          payload,
          permission: 'external_action',
          idempotencyKey: `wf:${run.id}:${run.currentStep}`,
          signal: new AbortController().signal,
        });
        await this.upsertStep(run.id, run.currentStep, step.id, 'external_action', {
          status: 'completed', output: result, completedAt: new Date(), attempt: (stepRow?.attempt ?? 0) + 1,
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
