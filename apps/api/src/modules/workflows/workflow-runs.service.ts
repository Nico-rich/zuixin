import { Inject, Injectable, Logger } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { createHash, randomUUID } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service';
import { WORKFLOW_QUEUE } from '../../core/queue/queue.module';
import { AppError, ErrorCode } from '../../common/errors/app-error';
import { EventBusService } from '../../core/events/event-bus.service';
import { WORKFLOW_CANCEL_CHANNEL } from '../../core/events/workflow-channels';
import { WorkflowDefinition } from './workflow-types';
import { AuditService } from '../audit/audit.service';
import { BillingService } from '../billing/billing.service';
import { QuotaService } from '../billing/quota.service';

const TERMINAL = ['completed', 'failed', 'cancelled', 'timeout'] as const;
const ACTIVE = ['queued', 'running', 'waiting'] as const;

/**
 * M7-P6 WorkflowRun 读写 + 生命周期（复用 M6 原语集）：
 * - create：锁定最新 published 版本（不可变快照）；幂等键去重（部分唯一索引 WHERE attempt=1 + P2002 兜底）；
 * - cancel：条件更新 queued/running/waiting → cancelled + 附带清理（审批/子 AgentRun best-effort）+ 快速通道；
 * - retry：终态 run → 新 run（attempt+1，同 workflow 新执行）；绝不重新打开旧 run；
 * - timeline：步骤投影（只读，无 Event 表）。
 */
@Injectable()
export class WorkflowRunsService {
  private readonly logger = new Logger('WorkflowRuns');

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @InjectQueue(WORKFLOW_QUEUE) private readonly workflowQueue: Queue,
    @Inject(EventBusService) private readonly events: EventBusService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(BillingService) private readonly billing: BillingService,
    @Inject(QuotaService) private readonly quota: QuotaService,
  ) {}

  /** 最新 published 版本（Run 锁定快照） */
  private async publishedVersion(userId: string, workflowId: string) {
    const wf = await this.prisma.workflow.findFirst({ where: { id: workflowId, userId } });
    if (!wf) throw new AppError(ErrorCode.NOT_FOUND, '工作流不存在');
    const version = await this.prisma.workflowVersion.findFirst({
      where: { workflowId, status: 'published' },
      orderBy: { version: 'desc' },
    });
    if (!version) throw new AppError(ErrorCode.WORKFLOW_NOT_PUBLISHED, '工作流尚未发布，无法创建运行');
    return { wf, version };
  }

  /** 创建 run（manual/webhook/schedule/event 共用入口；幂等：同键返回已有 run） */
  async createRun(userId: string, input: {
    workflowId: string;
    triggerType: 'manual' | 'webhook' | 'schedule' | 'event';
    triggerId?: string;
    idempotencyKey?: string;
    payload?: Record<string, unknown>;
    attempt?: number;
  }) {
    // M8-P2：配额裁决在创建入口（服务端）
    await this.quota.assertQuota(userId, undefined, 'workflow_run', 1);
    const { wf, version } = await this.publishedVersion(userId, input.workflowId);
    const idempotencyKey = input.idempotencyKey ?? randomUUID();
    const existing = await this.prisma.workflowRun.findFirst({ where: { workflowId: wf.id, idempotencyKey } });
    if (existing) return existing; // 幂等：同一触发绝不产生第二个 run

    const create = () => this.prisma.workflowRun.create({
      data: {
        workflowId: wf.id, versionId: version.id, userId,
        projectId: wf.projectId,
        triggerType: input.triggerType, triggerId: input.triggerId,
        idempotencyKey, input: (input.payload ?? {}) as never,
        attempt: input.attempt ?? 1,
        status: 'queued',
      },
    });
    let run: { id: string; status: string };
    try {
      run = await create();
    } catch (err) {
      // 并发同键：部分唯一索引（attempt=1）P2002 → 返回已有 run（绝不产生第二个）
      if ((err as { code?: string }).code === 'P2002') {
        const won = await this.prisma.workflowRun.findFirst({ where: { workflowId: wf.id, idempotencyKey } });
        if (won) return won;
      }
      throw err;
    }
    await this.workflowQueue.add(
      'execute', { runId: run.id },
      {
        jobId: `wf-${run.id}`, attempts: 2, backoff: { type: 'exponential', delay: 2000 },
        removeOnComplete: true, removeOnFail: { count: 500 },
      },
    );
    await this.audit.write({
      userId, action: 'workflow_run.created', projectId: wf.projectId,
      targetType: 'workflow_run', targetId: run.id, workflowRunId: run.id,
      metadata: { workflowId: wf.id, version: version.version, triggerType: input.triggerType },
    });
    // M8-P2 计量（幂等键 = run id；重复触发/重放绝不重复计量）
    await this.billing.recordUsage({
      userId, projectId: wf.projectId, kind: 'workflow_run', quantity: 1,
      runId: run.id, idempotencyKey: `wf:${run.id}:workflow-run`,
    }).catch(() => undefined);
    return run;
  }

  async list(userId: string, workflowId: string, take = 20) {
    await this.prisma.workflow.findFirstOrThrow({ where: { id: workflowId, userId } }).catch(() => {
      throw new AppError(ErrorCode.NOT_FOUND, '工作流不存在');
    });
    return this.prisma.workflowRun.findMany({
      where: { workflowId, userId },
      orderBy: { createdAt: 'desc' },
      take,
      include: { version: { select: { version: true } } },
    });
  }

  async get(userId: string, runId: string) {
    const run = await this.prisma.workflowRun.findFirst({
      where: { id: runId, userId },
      include: {
        version: { select: { version: true, definition: true } },
        steps: { orderBy: { stepIndex: 'asc' } },
      },
    });
    if (!run) throw new AppError(ErrorCode.NOT_FOUND, '运行不存在');
    return run;
  }

  /** Timeline 投影（只读；步骤状态 + 审批 + 子 run 事实） */
  async timeline(userId: string, runId: string) {
    const run = await this.get(userId, runId);
    const items: Array<Record<string, unknown>> = [];
    items.push({
      id: `wf-${run.id}`, type: 'workflow.started', status: 'info',
      timestamp: run.startedAt.toISOString(), title: '工作流开始执行',
    });
    for (const step of run.steps) {
      items.push({
        id: `wf-step-${step.id}`, type: `step.${step.status}`, status: step.status === 'completed' ? 'success' : step.status === 'failed' ? 'failed' : step.status === 'waiting' ? 'running' : 'info',
        timestamp: (step.completedAt ?? step.startedAt ?? step.createdAt).toISOString(),
        title: `步骤 ${step.stepIndex + 1} · ${step.stepType}`,
        summary: step.errorMessage ?? undefined,
        metadata: {
          stepId: step.stepId, attempt: step.attempt,
          approvalId: step.approvalId, agentRunId: step.agentRunId, externalActionId: step.externalActionId,
        },
      });
    }
    const terminalType = ({
      completed: 'workflow.completed', failed: 'workflow.failed',
      cancelled: 'workflow.cancelled', timeout: 'workflow.timeout',
    } as Record<string, string | undefined>)[run.status];
    if (terminalType) {
      items.push({
        id: `wf-end-${run.id}`, type: terminalType,
        status: run.status === 'completed' ? 'success' : 'failed',
        timestamp: (run.completedAt ?? run.startedAt).toISOString(),
        title: run.status === 'completed' ? '工作流完成' : `工作流${run.status}`,
      });
    }
    items.sort((a, b) => String(a.timestamp).localeCompare(String(b.timestamp)) || String(a.id).localeCompare(String(b.id)));
    return {
      runId: run.id, workflowId: run.workflowId, version: run.version.version,
      status: run.status, triggerType: run.triggerType,
      startedAt: run.startedAt.toISOString(), completedAt: run.completedAt?.toISOString() ?? null,
      items,
    };
  }

  /** Cancel（复用 M6 条件更新三态 + 附带清理 + 快速通道 + 观察事件） */
  async cancel(userId: string, runId: string) {
    const run = await this.prisma.workflowRun.findFirst({
      where: { id: runId, userId },
      select: { id: true, status: true, waitingOnApprovalId: true, waitingOnAgentRunId: true },
    });
    if (!run) throw new AppError(ErrorCode.NOT_FOUND, '运行不存在');
    const done = await this.prisma.workflowRun.updateMany({
      where: { id: runId, userId, status: { in: ACTIVE as unknown as import('@prisma/client').WorkflowRunStatus[] } },
      data: {
        status: 'cancelled', completedAt: new Date(),
        waitingOnApprovalId: null, waitingOnAgentRunId: null, workerId: null, leaseUntil: null, heartbeatAt: null,
      },
    });
    if (done.count === 0) throw new AppError(ErrorCode.WORKFLOW_RUN_NOT_CANCELLABLE, '运行已结束，无法取消');
    // 附带清理（best-effort；终态绝不复活）
    // 附带清理按 workflowRunId 兜底——覆盖「审批已建但 run.waitingOnApprovalId 未落库」的竞态窗口
    await this.prisma.approval.updateMany({
      where: { workflowRunId: runId, status: 'requested' },
      data: { status: 'cancelled', cancelledAt: new Date() },
    }).catch(() => undefined);
    if (run.waitingOnAgentRunId) {
      await this.prisma.agentRun.updateMany({
        where: { id: run.waitingOnAgentRunId, status: { in: ['queued', 'running', 'waiting'] } },
        data: { status: 'cancelled', completedAt: new Date() },
      }).catch(() => undefined);
    }
    await this.events.publish(WORKFLOW_CANCEL_CHANNEL, { runId }).catch(() => undefined);
    await this.audit.write({
      userId, action: 'workflow_run.cancelled',
      targetType: 'workflow_run', targetId: runId, workflowRunId: runId,
    });
    return { runId, status: 'cancelled' };
  }

  /** Retry（绝不重新打开旧 run）：终态 → 新 run（attempt+1；幂等键带 attempt 后缀避免唯一索引冲突） */
  async retry(userId: string, runId: string) {
    const old = await this.prisma.workflowRun.findFirst({
      where: { id: runId, userId },
      select: { id: true, workflowId: true, status: true, attempt: true, input: true, triggerType: true },
    });
    if (!old) throw new AppError(ErrorCode.NOT_FOUND, '运行不存在');
    if (!(TERMINAL as readonly string[]).includes(old.status)) {
      throw new AppError(ErrorCode.WORKFLOW_RUN_NOT_RETRYABLE, '运行尚未结束，无法重试');
    }
    return this.createRun(userId, {
      workflowId: old.workflowId,
      triggerType: 'manual',
      triggerId: `retry:${old.id}`,
      idempotencyKey: `${runId}:retry:${old.attempt + 1}`,
      payload: (old.input ?? {}) as Record<string, unknown>,
      attempt: old.attempt + 1,
    });
  }
}
