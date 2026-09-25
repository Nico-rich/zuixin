import { Inject, Injectable } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { AgentRunStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AgentRunMessagesService } from './agent-run-messages.service';
import { AGENT_RUN_QUEUE } from '../../core/queue/queue.module';
import { AppError, ErrorCode } from '../../common/errors/app-error';
import { EventBusService, agentRunChannel } from '../../core/events/event-bus.service';
import { DelegationService } from '../agent-delegation/delegation.service';
import { CreateAgentRunDto } from './agent-runs.dto';

const TERMINAL_STATUSES = ['completed', 'failed', 'cancelled', 'timeout'] as const;
const ACTIVE_STATUSES = ['queued', 'running', 'waiting'] as const;
/** cancel 提示通道（Redis Pub/Sub 快速通道；DB 条件更新仍是唯一事实来源） */
export const AGENT_RUN_CANCEL_CHANNEL = 'agent-run:cancel';

/**
 * AgentRun 读写（M4 只读 + M6-P3 异步创建入口）：
 * - 读：userId 权限边界；写路径：sync 由 Engine（P2）、async 由本服务创建 + Worker 执行。
 * - 异步创建：身份全部来自 JWT/DB（不信任客户端 userId/agentVersionId）；payload 只含 runId。
 */
@Injectable()
export class AgentRunsService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(AgentRunMessagesService) private readonly messages: AgentRunMessagesService,
    @InjectQueue(AGENT_RUN_QUEUE) private readonly agentRunQueue: Queue,
    @Inject(EventBusService) private readonly events: EventBusService,
    @Inject(DelegationService) private readonly delegation: DelegationService,
  ) {}

  /** SSE 观察端点用：归属校验（userId 首条件，防枚举 404）+ 当前状态 */
  async getStatus(userId: string, id: string) {
    const run = await this.prisma.agentRun.findFirst({ where: { id, userId }, select: { id: true, status: true } });
    if (!run) throw new AppError(ErrorCode.NOT_FOUND, '运行不存在');
    return run;
  }

  async get(userId: string, id: string) {
    const run = await this.prisma.agentRun.findFirst({
      where: { id, userId },
      include: {
        steps: {
          orderBy: { stepIndex: 'asc' },
          include: { toolCalls: { orderBy: { startedAt: 'asc' } } },
        },
        agent: { select: { id: true, slug: true, name: true } },
        agentVersion: { select: { id: true, version: true, status: true } },
        tasks: { orderBy: { createdAt: 'asc' } },
        artifacts: { orderBy: { createdAt: 'asc' } },
      },
    });
    if (!run) throw new AppError(ErrorCode.NOT_FOUND, '运行不存在');
    return run;
  }

  async listByConversation(userId: string, conversationId: string) {
    const c = await this.prisma.conversation.findFirst({ where: { id: conversationId, userId, deletedAt: null } });
    if (!c) throw new AppError(ErrorCode.NOT_FOUND, '对话不存在');
    return this.prisma.agentRun.findMany({
      where: { conversationId, userId },
      orderBy: { createdAt: 'desc' },
      take: 20,
      include: { agent: { select: { slug: true, name: true } } },
    });
  }

  /**
   * M6-P3 异步入口（HTTP 立即返回，不等 Agent 完成）：
   * JWT → 归属校验 → resolve Agent（缺省 general-assistant）→ active AgentVersion → 建 run(queued)
   * → seed 初始用户 transcript → 入队（payload {runId}）→ {runId, status:'queued'}。
   */
  async createAsync(userId: string, dto: CreateAgentRunDto) {
    const conversation = dto.conversationId
      ? await this.requireConversation(userId, dto.conversationId)
      : await this.createConversation(userId, dto.projectId ?? null);
    // M4 定稿规则：projectId 与 conversation.projectId 一致
    if (dto.projectId && conversation.projectId && dto.projectId !== conversation.projectId) {
      throw new AppError(ErrorCode.VALIDATION_ERROR, '项目与会话归属不一致');
    }
    const projectId = dto.projectId ?? conversation.projectId ?? null;

    // Agent 解析：仅 enabled 系统 Agent；版本由服务端 activeVersion 解析（客户端不可指定）
    const agent = await this.prisma.agent.findFirst({
      where: dto.agentId
        ? { id: dto.agentId, enabled: true, scope: 'system' }
        : { slug: 'general-assistant', enabled: true, scope: 'system' },
      include: { activeVersion: true },
    });
    if (!agent) throw new AppError(ErrorCode.NOT_FOUND, 'Agent 不存在或不可用');
    if (!agent.activeVersion) throw new AppError(ErrorCode.VALIDATION_ERROR, 'Agent 尚无已发布版本');
    const version = agent.activeVersion;
    const config = (version.config ?? {}) as { maxSteps?: number };

    const userMessage = await this.prisma.message.create({
      data: { conversationId: conversation.id, userId, role: 'user', content: dto.message },
    });
    if (conversation.title === '新对话') {
      await this.prisma.conversation.update({ where: { id: conversation.id }, data: { title: dto.message.slice(0, 30) } });
    }
    const assistantMessage = await this.prisma.message.create({
      data: { conversationId: conversation.id, userId, role: 'assistant', content: '', status: 'streaming' },
    });

    const run = await this.prisma.agentRun.create({
      data: {
        userId, agentId: agent.id, agentVersionId: version.id,
        projectId, conversationId: conversation.id,
        status: 'queued',
        maxSteps: config.maxSteps ?? 8,
        metadata: { agentTools: version.tools ?? [], assistantMessageId: assistantMessage.id, userMessageId: userMessage.id, async: true },
      },
    });
    // transcript：初始用户消息（seq 0；system/history 由 Worker 首次执行时 seed）
    await this.messages.append(userId, run.id, { role: 'user', content: dto.message });

    await this.agentRunQueue.add(
      'execute',
      { runId: run.id }, // payload 最小化：不含身份/transcript/prompt——Worker 以 DB 为唯一事实来源
      {
        jobId: `run-${run.id}`, // 冒号不可用于 BullMQ jobId
        attempts: 2, backoff: { type: 'exponential', delay: 2000 },
        removeOnComplete: true, removeOnFail: { count: 500 },
      },
    );
    return { runId: run.id, status: 'queued' };
  }

  /**
   * M6-P5 Cancel（原子状态转换）：
   * - 条件更新 queued/running/waiting → cancelled（count=0 = 已终态 → 409 RUN_NOT_CANCELLABLE）；
   * - 终态绝不重新打开；cancel 与 complete/timeout 竞争由 DB 串行裁决（输家 count=0）；
   * - waiting 附带 best-effort 任务取消意图（仅 pending → cancelled；processing 不打断，其完成后的
   *   唤醒 hook 发现 run 已非 waiting → no-op，TOCTOU 由此闭合）；
   * - Redis 提示通道（快速取消，非事实来源）——worker 心跳 15s 兜底检测 DB 状态。
   */
  async cancel(userId: string, runId: string) {
    const run = await this.prisma.agentRun.findFirst({ where: { id: runId, userId }, select: { id: true, status: true, waitingOnTaskId: true, waitingOnApprovalId: true } });
    if (!run) throw new AppError(ErrorCode.NOT_FOUND, '运行不存在');
    const done = await this.prisma.agentRun.updateMany({
      where: { id: runId, userId, status: { in: ACTIVE_STATUSES as unknown as AgentRunStatus[] } },
      data: { status: 'cancelled', completedAt: new Date() },
    });
    if (done.count === 0) throw new AppError(ErrorCode.RUN_NOT_CANCELLABLE, '运行已结束，无法取消');

    // 等待中的生成任务：pending → cancelled（best-effort 取消意图；任务终态 hook 不会复活已 cancelled 的 run）
    if (run.status === 'waiting' && run.waitingOnTaskId) {
      await this.prisma.generationTask.updateMany({
        where: { id: run.waitingOnTaskId, status: 'pending' },
        data: { status: 'cancelled', statusMessage: 'Agent 运行已取消', completedAt: new Date() },
      }).catch(() => undefined);
    }
    // M7-P1：等待中的审批 → cancelled（best-effort；不唤醒——run 已 cancelled）
    if (run.status === 'waiting' && run.waitingOnApprovalId) {
      await this.prisma.approval.updateMany({
        where: { id: run.waitingOnApprovalId, status: 'requested' },
        data: { status: 'cancelled', cancelledAt: new Date() },
      }).catch(() => undefined);
    }
    // M7-P7：委派级联取消（子及后代条件取消；已终态容忍）
    await this.delegation.cancelChildren(runId).catch(() => undefined);
    // 快速通道：worker 收到提示立即 abort（heartbeat 15s 仍是 DB 事实兜底）
    await this.events.publish(AGENT_RUN_CANCEL_CHANNEL, { runId }).catch(() => undefined);
    // M6-P6 观察通道：SSE 订阅者实时看到取消终态（并收流）
    await this.events.publish(agentRunChannel(runId), { type: 'run.cancelled', runId, status: 'cancelled' }).catch(() => undefined);
    return { runId, status: 'cancelled' };
  }

  /**
   * M6-P5 Retry（绝不重新打开旧 Run）：
   * - 旧 run 必须终态（否则 409 RUN_NOT_RETRYABLE）；旧 run 永远保持 terminal；
   * - 新 run：retryOfRunId=旧run.id、attempt=旧.attempt+1、同 conversation 新 assistant 消息；
   *   用户消息从旧 transcript 第一条 user 消息复制（不新建 user Message，避免用户气泡重复）；
   * - 上下文重新组装（retry = 新执行，允许新上下文）；Agent 重新验证 scope（enabled+system）+ activeVersion 重解析；
   * - 幂等：DB 部分唯一索引 (retryOfRunId)——重复 POST retry 返回同一 retry run，绝不多建。
   */
  async retry(userId: string, oldRunId: string) {
    const old = await this.prisma.agentRun.findFirst({ where: { id: oldRunId, userId }, select: { id: true, status: true, attempt: true, conversationId: true, projectId: true, agentId: true, metadata: true } });
    if (!old) throw new AppError(ErrorCode.NOT_FOUND, '运行不存在');
    if (!(TERMINAL_STATUSES as readonly string[]).includes(old.status)) {
      throw new AppError(ErrorCode.RUN_NOT_RETRYABLE, '运行尚未结束，无法重试');
    }
    // 幂等：已有 retry 子 run → 直接返回（并发下由部分唯一索引兜底 P2002 → 查重返回）
    const existingRetry = await this.prisma.agentRun.findFirst({ where: { userId, retryOfRunId: old.id } });
    if (existingRetry) return { runId: existingRetry.id, status: existingRetry.status, attempt: existingRetry.attempt, retryOfRunId: old.id };

    // 用户消息：旧 transcript 第一条 user 行（sync 旧 run 无 transcript → 回退 metadata.userMessageId 的 Message 内容）
    const userTranscript = await this.prisma.agentRunMessage.findFirst({ where: { runId: old.id, role: 'user' }, orderBy: { sequence: 'asc' } });
    let retryMessage = userTranscript?.content;
    if (!retryMessage) {
      const userMessageId = (old.metadata as { userMessageId?: string } | null)?.userMessageId;
      const m = userMessageId ? await this.prisma.message.findFirst({ where: { id: userMessageId, userId } }) : null;
      retryMessage = m?.content ?? undefined;
    }
    if (!retryMessage) throw new AppError(ErrorCode.RUN_NOT_RETRYABLE, '无可重试的用户消息');

    // 重新验证 scope：Agent 仍 enabled+system；版本 = 当前 activeVersion（retry = 新执行）
    const agent = await this.prisma.agent.findFirst({
      where: { id: old.agentId, enabled: true, scope: 'system' },
      include: { activeVersion: true },
    });
    if (!agent || !agent.activeVersion) throw new AppError(ErrorCode.RUN_NOT_RETRYABLE, 'Agent 已不可用，无法重试');
    const version = agent.activeVersion;
    const config = (version.config ?? {}) as { maxSteps?: number };

    // conversation：原对话仍属用户且未删除 → 复用；否则新建（同 projectId 语义）
    let conversationId = old.conversationId;
    if (conversationId) {
      const c = await this.prisma.conversation.findFirst({ where: { id: conversationId, userId, deletedAt: null } });
      if (!c) conversationId = null;
    }
    const projectId = old.projectId
      ? ((await this.prisma.project.findFirst({ where: { id: old.projectId, userId, deletedAt: null } }))?.id ?? null)
      : null;
    if (!conversationId) {
      const created = await this.prisma.conversation.create({ data: { userId, projectId } });
      conversationId = created.id;
    }

    const assistantMessage = await this.prisma.message.create({
      data: { conversationId, userId, role: 'assistant', content: '', status: 'streaming' },
    });

    const create = () => this.prisma.agentRun.create({
      data: {
        userId, agentId: agent.id, agentVersionId: version.id,
        projectId, conversationId,
        status: 'queued', maxSteps: config.maxSteps ?? 8,
        retryOfRunId: old.id, attempt: old.attempt + 1,
        metadata: { agentTools: version.tools ?? [], assistantMessageId: assistantMessage.id, async: true, retryOf: old.id },
      },
    });
    let run: { id: string; status: string; attempt: number };
    try {
      run = await create();
    } catch (err) {
      // 并发重复 retry：部分唯一索引 P2002 → 返回已存在的 retry run（绝不产生第二个）
      if ((err as { code?: string }).code === 'P2002') {
        const won = await this.prisma.agentRun.findFirst({ where: { userId, retryOfRunId: old.id } });
        if (won) return { runId: won.id, status: won.status, attempt: won.attempt, retryOfRunId: old.id };
      }
      throw err;
    }
    // transcript seed：旧用户消息复制（seq 0；retry 上下文由 worker 首次执行时重新组装）
    await this.messages.append(userId, run.id, { role: 'user', content: retryMessage });
    await this.agentRunQueue.add(
      'execute',
      { runId: run.id },
      {
        jobId: `run-${run.id}`,
        attempts: 2, backoff: { type: 'exponential', delay: 2000 },
        removeOnComplete: true, removeOnFail: { count: 500 },
      },
    );
    return { runId: run.id, status: run.status, attempt: run.attempt, retryOfRunId: old.id };
  }

  private async requireConversation(userId: string, id: string) {
    const c = await this.prisma.conversation.findFirst({ where: { id, userId, deletedAt: null } });
    if (!c) throw new AppError(ErrorCode.NOT_FOUND, '对话不存在');
    return c;
  }

  private async createConversation(userId: string, projectId: string | null) {
    if (projectId) {
      const p = await this.prisma.project.findFirst({ where: { id: projectId, userId, deletedAt: null } });
      if (!p) throw new AppError(ErrorCode.NOT_FOUND, '项目不存在');
    }
    return this.prisma.conversation.create({ data: { userId, projectId } });
  }
}
