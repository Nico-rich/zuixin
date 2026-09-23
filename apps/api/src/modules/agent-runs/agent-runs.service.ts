import { Inject, Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AppError, ErrorCode } from '../../common/errors/app-error';

/** AgentRun 只读查询（M4）：userId 权限边界；写路径由 AgentLoop 负责 */
@Injectable()
export class AgentRunsService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  async get(userId: string, id: string) {
    const run = await this.prisma.agentRun.findFirst({
      where: { id, userId },
      include: {
        steps: {
          orderBy: { stepIndex: 'asc' },
          include: { toolCalls: { orderBy: { startedAt: 'asc' } } },
        },
        agent: { select: { id: true, slug: true, name: true, version: true } },
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
}
