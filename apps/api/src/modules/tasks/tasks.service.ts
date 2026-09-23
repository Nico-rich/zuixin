import { Inject, Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AppError, ErrorCode } from '../../common/errors/app-error';

@Injectable()
export class TasksService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  async get(userId: string, id: string) {
    const task = await this.prisma.generationTask.findFirst({ where: { id, userId } });
    if (!task) throw new AppError(ErrorCode.NOT_FOUND, '任务不存在');
    return task;
  }

  async listByConversation(userId: string, conversationId: string) {
    const c = await this.prisma.conversation.findFirst({ where: { id: conversationId, userId, deletedAt: null } });
    if (!c) throw new AppError(ErrorCode.NOT_FOUND, '对话不存在');
    return this.prisma.generationTask.findMany({
      where: { conversationId, userId },
      orderBy: { createdAt: 'desc' },
      take: 20,
    });
  }

  /** M2 仅支持取消 pending 任务（进行中取消随 M3） */
  async cancelPending(userId: string, id: string) {
    const task = await this.prisma.generationTask.findFirst({ where: { id, userId } });
    if (!task) throw new AppError(ErrorCode.NOT_FOUND, '任务不存在');
    if (task.status !== 'pending') throw new AppError(ErrorCode.TASK_NOT_CANCELLABLE, '任务已开始处理，无法取消');
    return this.prisma.generationTask.update({
      where: { id }, data: { status: 'cancelled', statusMessage: '已取消', completedAt: new Date() },
    });
  }
}
