import { Inject, Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AppError, ErrorCode } from '../../common/errors/app-error';

@Injectable()
export class ConversationsService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  list(userId: string) {
    return this.prisma.conversation.findMany({
      where: { userId, deletedAt: null },
      orderBy: { updatedAt: 'desc' },
      take: 50,
      select: { id: true, title: true, createdAt: true, updatedAt: true },
    });
  }

  create(userId: string, dto: { title?: string }) {
    return this.prisma.conversation.create({
      data: { userId, title: dto.title ?? '新对话' },
      select: { id: true, title: true, createdAt: true, updatedAt: true },
    });
  }

  get(userId: string, id: string) {
    return this.requireOwned(userId, id);
  }

  async rename(userId: string, id: string, title: string) {
    await this.requireOwned(userId, id);
    return this.prisma.conversation.update({ where: { id }, data: { title } });
  }

  async softDelete(userId: string, id: string) {
    await this.requireOwned(userId, id);
    await this.prisma.conversation.update({ where: { id }, data: { deletedAt: new Date() } });
  }

  async getMessages(userId: string, conversationId: string) {
    await this.requireOwned(userId, conversationId);
    return this.prisma.message.findMany({
      where: { conversationId },
      orderBy: { createdAt: 'asc' },
      take: 200,
      select: { id: true, conversationId: true, role: true, content: true, status: true, errorCode: true, createdAt: true },
    });
  }

  /** 归属校验：非本人 → 404（防枚举） */
  private async requireOwned(userId: string, id: string) {
    const c = await this.prisma.conversation.findFirst({ where: { id, userId, deletedAt: null } });
    if (!c) throw new AppError(ErrorCode.NOT_FOUND, '对话不存在');
    return c;
  }
}
