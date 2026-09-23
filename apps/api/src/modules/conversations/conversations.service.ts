import { Inject, Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AppError, ErrorCode } from '../../common/errors/app-error';

@Injectable()
export class ConversationsService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  list(userId: string, projectId?: string) {
    return this.prisma.conversation.findMany({
      where: { userId, deletedAt: null, ...(projectId ? { projectId } : {}) },
      orderBy: { updatedAt: 'desc' },
      take: 50,
      select: { id: true, title: true, projectId: true, createdAt: true, updatedAt: true },
    });
  }

  async create(userId: string, dto: { title?: string; projectId?: string | null }) {
    if (dto.projectId) await this.requireProject(userId, dto.projectId);
    return this.prisma.conversation.create({
      data: { userId, title: dto.title ?? '新对话', projectId: dto.projectId ?? null },
      select: { id: true, title: true, projectId: true, createdAt: true, updatedAt: true },
    });
  }

  get(userId: string, id: string) {
    return this.requireOwned(userId, id);
  }

  /** 更新标题 / 移动项目（null = 移出项目） */
  async update(userId: string, id: string, dto: { title?: string; projectId?: string | null }) {
    await this.requireOwned(userId, id);
    if (dto.projectId) await this.requireProject(userId, dto.projectId);
    const data: { title?: string; projectId?: string | null } = {};
    if (dto.title) data.title = dto.title;
    if (dto.projectId !== undefined) data.projectId = dto.projectId;
    return this.prisma.conversation.update({ where: { id }, data });
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
      select: {
        id: true, conversationId: true, role: true, content: true, status: true, errorCode: true,
        intentType: true, intentConfidence: true, createdAt: true,
        attachments: { select: { id: true, kind: true, type: true, mimeType: true, originalName: true } },
      },
    });
  }

  /** 归属校验：非本人 → 404（防枚举） */
  private async requireOwned(userId: string, id: string) {
    const c = await this.prisma.conversation.findFirst({ where: { id, userId, deletedAt: null } });
    if (!c) throw new AppError(ErrorCode.NOT_FOUND, '对话不存在');
    return c;
  }

  /** 目标项目归属校验：非本人项目 → 404 */
  private async requireProject(userId: string, projectId: string) {
    const p = await this.prisma.project.findFirst({ where: { id: projectId, userId, deletedAt: null } });
    if (!p) throw new AppError(ErrorCode.NOT_FOUND, '项目不存在');
  }
}
