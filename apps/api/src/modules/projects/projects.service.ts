import { Inject, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AppError, ErrorCode } from '../../common/errors/app-error';
import { CreateProjectDto, UpdateProjectDto } from './projects.dto';

@Injectable()
export class ProjectsService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  list(userId: string) {
    return this.prisma.project.findMany({
      where: { userId, deletedAt: null },
      orderBy: { updatedAt: 'desc' },
      take: 50,
      select: { id: true, name: true, description: true, metadata: true, createdAt: true, updatedAt: true },
    });
  }

  create(userId: string, dto: CreateProjectDto) {
    return this.prisma.project.create({
      data: { userId, name: dto.name, description: dto.description, metadata: (dto.metadata ?? undefined) as Prisma.InputJsonValue | undefined },
    });
  }

  get(userId: string, id: string) {
    return this.requireOwned(userId, id);
  }

  async update(userId: string, id: string, dto: UpdateProjectDto) {
    await this.requireOwned(userId, id);
    return this.prisma.project.update({
      where: { id },
      data: {
        ...(dto.name ? { name: dto.name } : {}),
        ...(dto.description !== undefined ? { description: dto.description } : {}),
        ...(dto.metadata !== undefined ? { metadata: dto.metadata as Prisma.InputJsonValue | null } : {}),
      },
    });
  }

  async softDelete(userId: string, id: string) {
    await this.requireOwned(userId, id);
    // 软删除：项目下对话保留（仍可访问），仅不再挂在该项目下
    await this.prisma.project.update({ where: { id }, data: { deletedAt: new Date() } });
  }

  /** 归属校验：非本人 → 404（防枚举） */
  private async requireOwned(userId: string, id: string) {
    const p = await this.prisma.project.findFirst({ where: { id, userId, deletedAt: null } });
    if (!p) throw new AppError(ErrorCode.NOT_FOUND, '项目不存在');
    return p;
  }
}
