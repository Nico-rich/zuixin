import { Inject, Injectable } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { PrismaService } from '../prisma/prisma.service';
import { AgentRunMessagesService } from './agent-run-messages.service';
import { AGENT_RUN_QUEUE } from '../../core/queue/queue.module';
import { AppError, ErrorCode } from '../../common/errors/app-error';
import { CreateAgentRunDto } from './agent-runs.dto';

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
  ) {}

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
