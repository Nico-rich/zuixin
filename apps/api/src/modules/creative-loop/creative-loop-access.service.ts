/**
 * M9-P5 归属与权限裁决（**复用组织 RBAC，绝不新增权限位**）。
 *
 * 依据设计文档：loop 属工作流域 → 一律复用既有 `workflow.read` / `workflow.write` 权限位
 * （catalog 冻结在 authorization.service.ts；本模块**不改** catalog、不加权限位）。
 *
 * 裁决口径（与 M9-P1 Evaluation 控制器同构，deny-by-default）：
 * - 集合级：解析组织归属（显式 organizationId / 项目所属组织 / 个人组织）→ requirePermission；
 * - 资源级：不存在 → 404；非成员 → 404（assertCanAccess 防枚举）；成员但权限位不足 → 403。
 */

import { Inject, Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { OrganizationsService } from '../organizations/organizations.service';
import { AppError, ErrorCode } from '../../common/errors/app-error';

export interface LoopScope {
  organizationId: string;
  projectId: string | null;
}

@Injectable()
export class CreativeLoopAccessService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(OrganizationsService) private readonly orgs: OrganizationsService,
  ) {}

  /**
   * 组织/项目归属解析（服务端裁决；客户端只能提交 id，绝不提交 userId）。
   * projectId 给定时：项目必须可见（本人或所属组织成员）且未删除；显式 organizationId 必须与项目组织一致。
   */
  async resolveScope(userId: string, input: { organizationId?: string; projectId?: string } = {}): Promise<LoopScope> {
    if (input.projectId) {
      const project = await this.prisma.project.findFirst({
        where: {
          id: input.projectId,
          deletedAt: null,
          OR: [{ userId }, { organization: { deletedAt: null, members: { some: { userId } } } }],
        },
        select: { id: true, organizationId: true },
      });
      if (!project) throw new AppError(ErrorCode.NOT_FOUND, '项目不存在');
      const organizationId = project.organizationId;
      if (!organizationId) throw new AppError(ErrorCode.VALIDATION_ERROR, '项目未挂组织，无法承载创意闭环');
      if (input.organizationId && input.organizationId !== organizationId) {
        throw new AppError(ErrorCode.VALIDATION_ERROR, '项目与组织不匹配');
      }
      return { organizationId, projectId: project.id };
    }
    if (input.organizationId) return { organizationId: input.organizationId, projectId: null };
    return { organizationId: (await this.orgs.ensurePersonalOrganization(userId)).id, projectId: null };
  }

  async requireRead(userId: string, organizationId: string) {
    return this.orgs.requirePermission(userId, organizationId, 'workflow.read');
  }

  async requireWrite(userId: string, organizationId: string) {
    return this.orgs.requirePermission(userId, organizationId, 'workflow.write');
  }

  /**
   * 资源级裁决：404 防枚举 → 权限位（读路径同样要求成员身份，绝不因知道 id 而放行）。
   *
   * M10-P15（BUG-12）：`notFoundMessage` 让"非成员"与"资源不存在"**逐字节同形**。
   * 此前所有调用方都先自查 `store.get(id) === null` → 抛资源专属文案（如「假设不存在」），
   * 而这里的非成员分支经 `assertCanAccess` 抛「资源不存在」——两者同为 404 但**文案不同**，
   * 于是文案本身成了"该 id 是否存在（于他人组织）"的枚举信道。调用方传入与自查同源的文案即可闭合。
   */
  async authorizeResource(
    userId: string,
    row: { organizationId: string; userId?: string } | null,
    action: 'workflow.read' | 'workflow.write',
    notFoundMessage = '资源不存在',
  ): Promise<void> {
    if (!row) throw new AppError(ErrorCode.NOT_FOUND, notFoundMessage);
    try {
      await this.orgs.assertCanAccess(userId, row.organizationId);
    } catch (err) {
      // assertCanAccess 的唯一抛出就是"非成员 → 404"：折成与自查分支同一文案（状态码/错误码一致）
      if (err instanceof AppError && err.code === ErrorCode.NOT_FOUND) {
        throw new AppError(ErrorCode.NOT_FOUND, notFoundMessage);
      }
      throw err;
    }
    await this.orgs.requirePermission(userId, row.organizationId, action);
  }
}
