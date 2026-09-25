import { Inject, Injectable, Logger } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { PrismaService } from '../prisma/prisma.service';
import { AGENT_RUN_QUEUE } from '../../core/queue/queue.module';
import { EventBusService, agentRunChannel } from '../../core/events/event-bus.service';
import { AppError, ErrorCode } from '../../common/errors/app-error';
import { AuditService } from '../audit/audit.service';

const CHILD_TERMINAL = ['completed', 'failed', 'cancelled', 'timeout'] as const;
const DEFAULT_MAX_DEPTH = 3;
const DEFAULT_MAX_CHILDREN = 5;

export interface DelegateInput {
  userId: string;
  parentRunId: string;
  projectId?: string;
  /** ToolCall 级幂等键（resume 重放绝不产生第二个子 run） */
  idempotencyKey: string;
  agentId?: string;
  task: string;
}

/**
 * M7-P7 安全 Agent Delegation：
 * - 上限：depth ≤ limits.delegationMaxDepth（默认 3）、子数 ≤ delegationMaxChildren（默认 5）；
 * - 环检测：目标 Agent 不得出现在血缘链（A→B→A / A→B→C→A 全阻断）；
 * - 权限继承：child tools = childVersion.tools ∩ parentTools（⊆ 保证；运行时由引擎 allowlist 再强制）；
 * - 幂等：idempotencyKey 唯一——resume 重放 → 子 run 终态则返回结构化结果（绝不重开子 run）；
 * - 唤醒：子 run 终态事件（本进程订阅）+ recoverStale 兜底双通道；父 run waitingOnDelegationId 条件更新去重；
 * - 级联取消：父 cancelled → 子（及其后代）条件取消，已终态容忍。
 */
@Injectable()
export class DelegationService {
  private readonly logger = new Logger('Delegation');

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @InjectQueue(AGENT_RUN_QUEUE) private readonly agentRunQueue: Queue,
    @Inject(EventBusService) private readonly events: EventBusService,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  private async limits(): Promise<{ maxDepth: number; maxChildren: number }> {
    const row = await this.prisma.systemSetting.findUnique({ where: { key: 'limits' } });
    const v = (row?.value ?? {}) as { delegationMaxDepth?: number; delegationMaxChildren?: number };
    return {
      maxDepth: Number.isFinite(Number(v.delegationMaxDepth)) ? Number(v.delegationMaxDepth) : DEFAULT_MAX_DEPTH,
      maxChildren: Number.isFinite(Number(v.delegationMaxChildren)) ? Number(v.delegationMaxChildren) : DEFAULT_MAX_CHILDREN,
    };
  }

  async delegate(input: DelegateInput): Promise<unknown> {
    // 1. 幂等：resume 重放（同 ToolCall）→ 复用已有委派
    const existing = await this.prisma.agentDelegation.findUnique({ where: { idempotencyKey: input.idempotencyKey } });
    if (existing) {
      const child = await this.prisma.agentRun.findUnique({ where: { id: existing.childRunId } });
      if (child && (CHILD_TERMINAL as readonly string[]).includes(child.status)) {
        return await this.childResult(existing.id, child);
      }
      return { __waiting_delegation: true, delegationId: existing.id, childRunId: existing.childRunId };
    }

    // 2. 父 run（身份与权限边界从 DB 行解析，不信任调用方）+ 深度/子数上限
    const parent = await this.prisma.agentRun.findUnique({
      where: { id: input.parentRunId, userId: input.userId },
      include: { agentVersion: true },
    });
    if (!parent) throw new AppError(ErrorCode.NOT_FOUND, '父运行不存在');
    const parentTools = ((parent.agentVersion?.tools as string[]) ?? []);
    const { maxDepth, maxChildren } = await this.limits();
    if (parent.depth + 1 > maxDepth) {
      throw new AppError(ErrorCode.DELEGATION_DEPTH_EXCEEDED, `委派深度超限（最多 ${maxDepth} 层）`);
    }
    const childrenCount = await this.prisma.agentDelegation.count({ where: { parentRunId: parent.id } });
    if (childrenCount >= maxChildren) {
      throw new AppError(ErrorCode.DELEGATION_CHILDREN_LIMIT, `子任务数超限（最多 ${maxChildren} 个）`);
    }

    // 3. 目标 Agent 解析 + 环检测（血缘链上出现目标 Agent → 阻断）
    const childAgent = await this.resolveAgent(input.agentId);
    const ancestry = await this.ancestryAgentIds(parent.id);
    if (ancestry.includes(childAgent.id)) {
      throw new AppError(ErrorCode.DELEGATION_CYCLE, '检测到委派环，已阻止');
    }

    // 4. 权限继承：child tools ⊆ parent tools（交集；绝不扩大）
    const childTools = ((childAgent.activeVersion!.tools as string[]) ?? []).filter((t) => parentTools.includes(t));

    // 5. 子 run（血缘 + depth + 权限快照）+ delegation 行（幂等键唯一，P2002 兜底）
    const createChild = () => this.prisma.agentRun.create({
      data: {
        userId: input.userId, agentId: childAgent.id, agentVersionId: childAgent.activeVersion!.id,
        projectId: parent.projectId, status: 'queued', maxSteps: 8,
        parentRunId: parent.id, delegatedByRunId: parent.id, depth: parent.depth + 1,
        metadata: { delegation: true, delegationTools: childTools },
      },
    });
    let child: { id: string };
    try {
      child = await createChild();
    } catch (err) {
      if ((err as { code?: string }).code === 'P2002') {
        const won = await this.prisma.agentDelegation.findUnique({ where: { idempotencyKey: input.idempotencyKey } });
        if (won) {
          const c = await this.prisma.agentRun.findUnique({ where: { id: won.childRunId } });
          if (c) return { __waiting_delegation: true, delegationId: won.id, childRunId: won.childRunId };
        }
      }
      throw err;
    }
    const delegationRow = await this.prisma.agentDelegation.create({
      data: {
        parentRunId: parent.id, delegatedByRunId: parent.id, childRunId: child.id,
        agentId: childAgent.id, task: input.task,
        idempotencyKey: input.idempotencyKey, status: 'queued', depth: parent.depth + 1,
      },
    });
    // 子 run transcript 种子（seq 0 用户消息；system/history 由 Worker 首次执行 seed）
    await this.prisma.agentRunMessage.create({
      data: { runId: child.id, sequence: 0, role: 'user', content: input.task },
    });
    await this.agentRunQueue.add(
      'execute', { runId: child.id },
      { jobId: `run-${child.id}`, attempts: 2, backoff: { type: 'exponential', delay: 2000 }, removeOnComplete: true, removeOnFail: { count: 500 } },
    );
    // 6. 子 run 终态 → 唤醒父 run（本进程订阅；recoverStale 兜底事件丢失）
    await this.events.subscribe(agentRunChannel(child.id), (event) => {
      const type = event.type as string | undefined;
      if (type && ['run.completed', 'run.failed', 'run.cancelled', 'run.timeout'].includes(type)) {
        void this.onChildTerminal(child.id).catch(() => undefined);
      }
    });
    this.logger.log({ parentRunId: parent.id, childRunId: child.id, depth: parent.depth + 1 }, '委派子任务已创建');
    await this.audit.write({
      userId: input.userId, action: 'delegation.created', projectId: parent.projectId,
      targetType: 'agent_delegation', targetId: delegationRow.id, agentRunId: parent.id,
      metadata: { childRunId: child.id, childAgentId: childAgent.id, depth: parent.depth + 1 },
    });
    return { __waiting_delegation: true, delegationId: delegationRow.id, childRunId: child.id };
  }

  /** 子 run 终态：同步 delegation 行 + 唤醒父 run（waitingOnDelegationId 条件更新 + 唯一 jobId） */
  async onChildTerminal(childRunId: string): Promise<void> {
    const delegation = await this.prisma.agentDelegation.findUnique({ where: { childRunId } });
    if (!delegation) return;
    const child = await this.prisma.agentRun.findUnique({ where: { id: childRunId } });
    if (!child || !(CHILD_TERMINAL as readonly string[]).includes(child.status)) return;
    // resultSummary：子终态结构化摘要（engine 复用行刷新用；绝不含内部推理——transcript 只存 assistant 产出）
    const lastAssistant = await this.prisma.agentRunMessage.findFirst({
      where: { runId: childRunId, role: 'assistant' }, orderBy: { sequence: 'desc' },
    });
    await this.prisma.agentDelegation.update({
      where: { id: delegation.id },
      data: {
        status: child.status, completedAt: new Date(), errorCode: child.errorCode,
        resultSummary: (lastAssistant?.content ?? '').slice(0, 2000),
      },
    }).catch(() => undefined);
    const parent = await this.prisma.agentRun.findFirst({
      where: { id: delegation.parentRunId, status: 'waiting', waitingOnDelegationId: delegation.id },
      select: { id: true },
    });
    if (!parent) return; // 已唤醒/已终态/非 waiting —— 绝不复活
    const woken = await this.prisma.agentRun.updateMany({
      where: { id: parent.id, status: 'waiting', waitingOnDelegationId: delegation.id },
      data: { status: 'queued', waitingOnDelegationId: null, workerId: null, leaseUntil: null, heartbeatAt: null },
    });
    if (woken.count === 0) return;
    await this.agentRunQueue.add(
      'execute', { runId: parent.id },
      { jobId: `run-${parent.id}-wake-${Date.now()}`, attempts: 2, backoff: { type: 'exponential', delay: 2000 }, removeOnComplete: true, removeOnFail: { count: 500 } },
    );
    this.logger.log({ childRunId, parentRunId: parent.id }, '子 run 终态 → 唤醒父 run');
  }

  /** 结构化子结果：绝不回传内部推理（仅终态 + 最后 assistant 内容截断） */
  private async childResult(delegationId: string, child: { id: string; status: string; errorCode: string | null }): Promise<unknown> {
    const lastAssistant = await this.prisma.agentRunMessage.findFirst({
      where: { runId: child.id, role: 'assistant' },
      orderBy: { sequence: 'desc' },
    });
    return {
      childRunId: child.id,
      status: child.status,
      content: (lastAssistant?.content ?? '').slice(0, 2000),
      errorCode: child.errorCode ?? undefined,
      delegationId,
    };
  }

  /** 血缘链 Agent 集合（含自身；环检测输入；上限 10 层防异常环） */
  private async ancestryAgentIds(runId: string): Promise<string[]> {
    const ids: string[] = [];
    let current: string | null = runId;
    for (let i = 0; i < 10 && current; i++) {
      // 显式类型标注：AgentRun 自关系（DelegationParent）生成递归类型，TS 推断会自引用
      const run: { agentId: string; parentRunId: string | null } | null = await this.prisma.agentRun.findUnique({
        where: { id: current }, select: { agentId: true, parentRunId: true },
      });
      if (!run) break;
      ids.push(run.agentId);
      current = run.parentRunId;
    }
    return ids;
  }

  private async resolveAgent(agentId?: string) {
    const agent = await this.prisma.agent.findFirst({
      where: agentId
        ? { id: agentId, enabled: true, scope: 'system' }
        : { slug: 'general-assistant', enabled: true, scope: 'system' },
      include: { activeVersion: true },
    });
    if (!agent || !agent.activeVersion) throw new AppError(ErrorCode.VALIDATION_ERROR, '目标 Agent 不存在或无可执行版本');
    return agent;
  }

  /** 级联取消（父 cancelled → 子及后代；已终态容忍；visited 防环） */
  async cancelChildren(parentRunId: string): Promise<number> {
    let cancelled = 0;
    const visited = new Set<string>([parentRunId]);
    const queue = [parentRunId];
    while (queue.length) {
      const current = queue.shift()!;
      const delegations = await this.prisma.agentDelegation.findMany({ where: { parentRunId: current }, select: { childRunId: true } });
      for (const d of delegations) {
        if (visited.has(d.childRunId)) continue;
        visited.add(d.childRunId);
        const done = await this.prisma.agentRun.updateMany({
          where: { id: d.childRunId, status: { in: ['queued', 'running', 'waiting'] } },
          data: { status: 'cancelled', completedAt: new Date() },
        }).catch(() => ({ count: 0 }));
        if (done.count > 0) {
          cancelled++;
          await this.prisma.agentDelegation.updateMany({
            where: { childRunId: d.childRunId },
            data: { status: 'cancelled', completedAt: new Date() },
          }).catch(() => undefined);
          queue.push(d.childRunId); // 后代继续级联
        }
      }
    }
    return cancelled;
  }

  /** 父 run 的子委派列表（可观测） */
  listForParent(parentRunId: string) {
    return this.prisma.agentDelegation.findMany({
      where: { parentRunId },
      orderBy: { createdAt: 'asc' },
      include: { childRun: { select: { id: true, status: true, depth: true, agentId: true } } },
    });
  }
}
