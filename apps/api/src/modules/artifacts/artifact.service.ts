import { Inject, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AppError, ErrorCode } from '../../common/errors/app-error';

export interface CreateArtifactInput {
  type: 'creative_brief' | 'image' | 'video' | 'report' | 'analysis' | 'other';
  title: string;
  summary?: string;
  content?: Record<string, unknown>;
  projectId?: string;
  conversationId?: string;
  messageId?: string;
  taskId?: string;
  /** AgentRun/ToolCall 追溯（非 Agent 场景留空——由调用链显式传递） */
  runId?: string;
  toolCallId?: string;
  /** M6-P4：resume 重放去重（部分唯一索引；同一 ToolCall 重试绝不产生第二个制品） */
  idempotencyKey?: string;
}

/** Artifact 最小写入方（M4）：仅 create/read，无 Workflow；归属校验与全站同模式 */
@Injectable()
export class ArtifactService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  async create(userId: string, input: CreateArtifactInput) {
    if (input.projectId) {
      const p = await this.prisma.project.findFirst({ where: { id: input.projectId, userId, deletedAt: null } });
      if (!p) throw new AppError(ErrorCode.NOT_FOUND, '项目不存在');
    }
    if (input.conversationId) {
      const c = await this.prisma.conversation.findFirst({ where: { id: input.conversationId, userId, deletedAt: null } });
      if (!c) throw new AppError(ErrorCode.NOT_FOUND, '对话不存在');
    }
    try {
      return await this.prisma.artifact.create({
        data: {
          userId,
          type: input.type,
          title: input.title,
          summary: input.summary,
          content: (input.content ?? undefined) as Prisma.InputJsonValue | undefined,
          projectId: input.projectId,
          conversationId: input.conversationId,
          messageId: input.messageId,
          taskId: input.taskId,
          runId: input.runId,
          toolCallId: input.toolCallId,
          idempotencyKey: input.idempotencyKey,
          status: 'ready',
        },
      });
    } catch (err) {
      // M6-P4：幂等键冲突（部分唯一索引）→ 返回已有制品，绝不产生第二个（resume 重放收敛）
      if (input.idempotencyKey && (err as { code?: string }).code === 'P2002') {
        const existing = await this.prisma.artifact.findFirst({ where: { idempotencyKey: input.idempotencyKey, userId } });
        if (existing) return existing;
      }
      throw err;
    }
  }

  async getById(userId: string, id: string) {
    const artifact = await this.prisma.artifact.findFirst({ where: { id, userId } });
    if (!artifact) throw new AppError(ErrorCode.NOT_FOUND, '制品不存在');
    return artifact;
  }

  async listByConversation(userId: string, conversationId: string) {
    const c = await this.prisma.conversation.findFirst({ where: { id: conversationId, userId, deletedAt: null } });
    if (!c) throw new AppError(ErrorCode.NOT_FOUND, '对话不存在');
    return this.prisma.artifact.findMany({
      where: { conversationId, userId },
      orderBy: { createdAt: 'desc' },
      take: 20,
    });
  }
}
