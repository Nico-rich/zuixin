import { Inject, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AppError, ErrorCode } from '../../common/errors/app-error';
import { OrganizationsService } from '../organizations/organizations.service';
import { CreateProjectDto, UpdateProjectDto } from './projects.dto';

@Injectable()
export class ProjectsService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(OrganizationsService) private readonly orgs: OrganizationsService,
  ) {}

  list(userId: string) {
    // M8-P1：本人项目 + 所属组织成员可见的项目（组织 scope）
    return this.prisma.project.findMany({
      where: {
        deletedAt: null,
        OR: [
          { userId },
          { organization: { deletedAt: null, members: { some: { userId } } } },
        ],
      },
      orderBy: { updatedAt: 'desc' },
      take: 50,
      select: { id: true, name: true, description: true, metadata: true, organizationId: true, createdAt: true, updatedAt: true },
    });
  }

  async create(userId: string, dto: CreateProjectDto & { organizationId?: string | null }) {
    // M8-P1：项目必须属于组织——指定组织需 membership；缺省 = 个人组织
    let organizationId = dto.organizationId ?? null;
    if (organizationId) {
      await this.orgs.requirePermission(userId, organizationId, 'project.write'); // viewer 是成员但不可写
    } else {
      organizationId = (await this.orgs.ensurePersonalOrganization(userId)).id;
    }
    return this.prisma.project.create({
      data: { userId, organizationId, name: dto.name, description: dto.description, metadata: (dto.metadata ?? undefined) as Prisma.InputJsonValue | undefined },
    });
  }

  get(userId: string, id: string) {
    return this.requireOwned(userId, id);
  }

  async update(userId: string, id: string, dto: UpdateProjectDto) {
    await this.requireOwned(userId, id);
    const data: Prisma.ProjectUpdateInput = {};
    if (dto.name) data.name = dto.name;
    if (dto.description !== undefined) data.description = dto.description;
    if (dto.metadata === null) data.metadata = Prisma.JsonNull;
    else if (dto.metadata !== undefined) data.metadata = dto.metadata as Prisma.InputJsonValue;
    return this.prisma.project.update({ where: { id }, data });
  }

  async softDelete(userId: string, id: string) {
    await this.requireOwned(userId, id);
    // 软删除：项目下对话保留（仍可访问），仅不再挂在该项目下
    await this.prisma.project.update({ where: { id }, data: { deletedAt: new Date() } });
  }

  /** 归属校验：本人或所属组织成员 → 404（防枚举；跨组织不可见） */
  private async requireOwned(userId: string, id: string) {
    const p = await this.prisma.project.findFirst({
      where: {
        id, deletedAt: null,
        OR: [
          { userId },
          { organization: { deletedAt: null, members: { some: { userId } } } },
        ],
      },
    });
    if (!p) throw new AppError(ErrorCode.NOT_FOUND, '项目不存在');
    return p;
  }
}
