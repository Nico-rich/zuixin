import { Inject, Injectable, Logger } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { OrganizationRole, OrganizationStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AppError, ErrorCode } from '../../common/errors/app-error';
import { orgDisabledError } from '../../common/guards/org-status.guard';
import { AuthorizationService, OrgPermission } from './authorization.service';

const INVITATION_TTL_MS = 7 * 24 * 3600_000;

/**
 * M8-P1 Organization 生命周期 + 成员/邀请：
 * - 每个用户自动获得 Personal Organization（backfill + 懒创建；slug=personal-{userId}，幂等）；
 * - 创建组织者自动成为 owner；组织可属于多个（membership 多对多）；
 * - 邀请：token 单次使用（accept 条件更新 pending+未过期 → accepted + member；重复 409）；
 *   revoke 条件更新；懒过期（读时标记）；
 * - soft delete：owner 专属（organization.write）；删除后不可见/不可用；
 * - 全部写操作经 AuthorizationService（RBAC 矩阵）；owner 不可移除自己（组织必须至少一名 owner）。
 *
 * M10-P14（X-21）组织治理态：
 * - `status=active|disabled`（禁用 = 冻结：数据保留、成员仍可登录，但一切组织级资源访问与管理被拒）；
 * - 裁决口径：**平台管理员**（`user.role='admin'`）可禁用/启用任意组织；**组织 owner**（organization.write）
 *   可自助禁用/启用本组织；org admin/member/viewer 一律无此权（与 softDelete 同口径：组织级治理动作 = owner）；
 * - 个人空间（isPersonal）**不可被 owner 自助禁用**（它是登录后的默认工作区；禁用将使账号不可用），
 *   平台管理员仍可执行平台级禁用（滥用处置），且启用路径不受限（冻结必须可恢复）；
 * - 幂等：目标态与当前态一致时直接返回当前态（不重复写库）。
 */
@Injectable()
export class OrganizationsService {
  private readonly logger = new Logger('Organizations');

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(AuthorizationService) private readonly auth: AuthorizationService,
  ) {}

  /** 懒创建个人组织（登录/注册时调用；幂等——slug 唯一冲突即复用） */
  async ensurePersonalOrganization(userId: string): Promise<{ id: string }> {
    const existing = await this.prisma.organization.findFirst({
      where: { ownerUserId: userId, isPersonal: true, deletedAt: null },
      select: { id: true },
    });
    if (existing) return existing;
    const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { displayName: true, email: true } });
    if (!user) throw new AppError(ErrorCode.NOT_FOUND, '用户不存在');
    try {
      const org = await this.prisma.organization.create({
        data: {
          id: `personal-${userId}`, name: `${user.displayName ?? user.email} 的个人空间`,
          slug: `personal-${userId}`, isPersonal: true, ownerUserId: userId,
          members: { create: { userId, role: 'owner' } },
        },
      });
      return org;
    } catch (err) {
      // 并发懒创建 → slug 唯一冲突：复用已存在行（幂等）
      if ((err as { code?: string }).code === 'P2002') {
        const won = await this.prisma.organization.findFirst({ where: { slug: `personal-${userId}` } });
        if (won) return won;
      }
      throw err;
    }
  }

  async list(userId: string) {
    return this.prisma.organization.findMany({
      where: { deletedAt: null, members: { some: { userId } } },
      orderBy: { createdAt: 'asc' },
      select: {
        id: true, name: true, slug: true, isPersonal: true, createdAt: true,
        members: { where: { userId }, select: { role: true } },
        _count: { select: { members: true, projects: true } },
      },
    });
  }

  async create(userId: string, input: { name: string; slug?: string }) {
    const slug = input.slug ?? `org-${randomBytes(6).toString('hex')}`;
    try {
      return await this.prisma.organization.create({
        data: {
          name: input.name, slug, ownerUserId: userId,
          members: { create: { userId, role: 'owner' } },
        },
        include: { members: { select: { userId: true, role: true } } },
      });
    } catch (err) {
      if ((err as { code?: string }).code === 'P2002') throw new AppError(ErrorCode.VALIDATION_ERROR, '组织标识已存在');
      throw err;
    }
  }

  async get(userId: string, id: string) {
    await this.auth.require(userId, id); // organization.read 隐含于成员身份
    return this.prisma.organization.findFirst({
      where: { id, deletedAt: null },
      include: { members: { select: { userId: true, role: true, joinedAt: true } } },
    });
  }

  async update(userId: string, id: string, input: { name?: string }) {
    await this.auth.authorize(userId, id, 'organization.write');
    const data: Record<string, string> = {};
    if (input.name) data.name = input.name;
    return this.prisma.organization.update({ where: { id }, data });
  }

  async softDelete(userId: string, id: string) {
    await this.auth.authorize(userId, id, 'organization.write');
    const org = await this.prisma.organization.findUnique({ where: { id } });
    if (org?.isPersonal) throw new AppError(ErrorCode.VALIDATION_ERROR, '个人空间不可删除');
    await this.prisma.organization.update({ where: { id }, data: { deletedAt: new Date() } });
    this.logger.log({ organizationId: id }, '组织已软删除');
    return { deleted: true };
  }

  // ===== M10-P14：组织禁用/启用（治理态）=====

  /**
   * 组织治理态切换（幂等）：
   * - RBAC：平台管理员（user.role='admin'，DB 权威读取）或组织 owner（成员行角色，等价于 organization.write，
   *   但**不**经 authorize——冻结必须可恢复，治理端点自身必须绕过禁用态检查）；
   * - 冻结范围：`Organization.status=disabled` → AuthorizationService.require/authorize 一律拒绝
   *   （服务层），OrgStatusGuard 在控制器挂载点拒绝（HTTP 面），二者同码 ORG_DISABLED / 403；
   * - 个人空间保护：owner 不可自助禁用个人空间（平台管理员可）；启用不受此限制（冻结必须可恢复）。
   */
  async setStatus(userId: string, id: string, status: OrganizationStatus) {
    const org = await this.prisma.organization.findUnique({
      where: { id },
      select: { id: true, isPersonal: true, status: true, deletedAt: true },
    });
    if (!org || org.deletedAt) throw new AppError(ErrorCode.NOT_FOUND, '组织不存在');

    const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { role: true } });
    const platformAdmin = user?.role === 'admin';
    if (!platformAdmin) {
      // 组织级治理动作 = owner（RBAC 矩阵中 organization.write 恰好仅 owner 命中）。
      // 注意：此处**不能**走 authz.authorize——那条路径对禁用组织以 ORG_DISABLED 拒绝，
      // 会让"启用"（恢复）不可达。故直接读成员行角色裁决（治理端点必须绕过自身冻结检查）。
      const membership = await this.auth.membership(userId, id);
      if (!membership || membership.role !== 'owner') throw new AppError(ErrorCode.FORBIDDEN, '仅组织 owner 可变更组织治理态');
      if (status === 'disabled' && org.isPersonal) {
        throw new AppError(ErrorCode.VALIDATION_ERROR, '个人空间不可禁用（账号默认工作区）；平台管理员可执行平台级禁用');
      }
    }

    if (org.status === status) return { id, status, unchanged: true };
    const updated = await this.prisma.organization.update({ where: { id }, data: { status } });
    this.logger.log({ organizationId: id, status, platformAdmin, by: userId }, '组织治理态已变更');
    return { id, status: updated.status, unchanged: false };
  }

  /** 组织是否处于禁用态（服务层判定点；行不存在 → false，交由调用方既有 404 语义） */
  async isDisabled(organizationId: string): Promise<boolean> {
    const org = await this.prisma.organization.findFirst({ where: { id: organizationId }, select: { status: true } });
    return org?.status === 'disabled';
  }

  /** 服务层禁用校验（守卫覆盖不到的入口：组织归属由服务端从资源行解析、请求体无 organizationId） */
  async assertActive(organizationId: string, action = '执行该操作'): Promise<void> {
    if (await this.isDisabled(organizationId)) throw orgDisabledError(`组织已被禁用，无法${action}`);
  }

  async listMembers(userId: string, id: string) {
    await this.auth.authorize(userId, id, 'member.read');
    return this.prisma.organizationMember.findMany({
      where: { organizationId: id },
      include: { user: { select: { id: true, email: true, displayName: true } } },
      orderBy: { joinedAt: 'asc' },
    });
  }

  async removeMember(userId: string, id: string, targetUserId: string) {
    await this.auth.authorize(userId, id, 'member.write');
    const target = await this.prisma.organizationMember.findUnique({
      where: { organizationId_userId: { organizationId: id, userId: targetUserId } },
    });
    if (!target) throw new AppError(ErrorCode.NOT_FOUND, '成员不存在');
    if (target.role === 'owner') throw new AppError(ErrorCode.VALIDATION_ERROR, '组织必须至少保留一名 owner');
    await this.prisma.organizationMember.delete({ where: { id: target.id } });
    return { removed: true };
  }

  async invite(userId: string, id: string, input: { email: string; role?: OrganizationRole }) {
    await this.auth.authorize(userId, id, 'member.write');
    const role = input.role ?? 'member';
    if (role === 'owner') throw new AppError(ErrorCode.VALIDATION_ERROR, '邀请不能授予 owner（由组织所有者转移）');
    // 已在组织 → 拒绝（幂等语义明确化）
    const existingUser = await this.prisma.user.findUnique({ where: { email: input.email.toLowerCase() }, select: { id: true } });
    if (existingUser) {
      const already = await this.prisma.organizationMember.findUnique({
        where: { organizationId_userId: { organizationId: id, userId: existingUser.id } },
      });
      if (already) throw new AppError(ErrorCode.VALIDATION_ERROR, '该用户已是组织成员');
    }
    const invitation = await this.prisma.organizationInvitation.create({
      data: {
        organizationId: id, email: input.email.toLowerCase(),
        role, invitedByUserId: userId,
        token: randomBytes(24).toString('hex'),
        expiresAt: new Date(Date.now() + INVITATION_TTL_MS),
      },
    });
    return { invitationId: invitation.id, token: invitation.token, email: invitation.email, role: invitation.role, expiresAt: invitation.expiresAt };
  }

  async listInvitations(userId: string, id: string) {
    await this.auth.authorize(userId, id, 'member.read');
    const rows = await this.prisma.organizationInvitation.findMany({
      where: { organizationId: id },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
    // 懒过期：读时标记（条件更新，绝不复活已决邀请）
    for (const row of rows) {
      if (row.status === 'pending' && row.expiresAt.getTime() < Date.now()) {
        await this.prisma.organizationInvitation.updateMany({
          where: { id: row.id, status: 'pending' },
          data: { status: 'expired' },
        });
        row.status = 'expired';
      }
    }
    return rows;
  }

  /** 接受邀请（登录用户；email 从用户档案解析——客户端不可指定；token 单次使用——条件更新唯一赢家） */
  async acceptInvitation(userId: string, token: string) {
    const invitation = await this.prisma.organizationInvitation.findUnique({ where: { token } });
    const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { email: true } });
    if (!invitation || !user || invitation.email !== user.email.toLowerCase()) {
      throw new AppError(ErrorCode.NOT_FOUND, '邀请不存在');
    }
    if (invitation.status !== 'pending') throw new AppError(ErrorCode.VALIDATION_ERROR, '邀请已处理');
    if (invitation.expiresAt.getTime() < Date.now()) {
      await this.prisma.organizationInvitation.updateMany({
        where: { id: invitation.id, status: 'pending' },
        data: { status: 'expired' },
      });
      throw new AppError(ErrorCode.VALIDATION_ERROR, '邀请已过期');
    }
    // M10-P14：禁用组织不可再接纳新成员（本入口请求体无 organizationId → 守卫不判定，故在服务层校验）。
    // 顺序关键：**先**校验组织治理态，**再**消费 token——否则一次组织冻结会把合法受邀者的邀请烧掉
    // （token 单次使用 → 组织恢复后受邀者永远无法加入，恢复语义被破坏）。
    const org = await this.prisma.organization.findFirst({ where: { id: invitation.organizationId, deletedAt: null } });
    if (!org) throw new AppError(ErrorCode.NOT_FOUND, '组织不存在');
    if (org.status === 'disabled') throw orgDisabledError('组织已被禁用，无法加入');
    const consumed = await this.prisma.organizationInvitation.updateMany({
      where: { id: invitation.id, status: 'pending', expiresAt: { gt: new Date() } },
      data: { status: 'accepted', acceptedByUserId: userId },
    });
    if (consumed.count === 0) throw new AppError(ErrorCode.VALIDATION_ERROR, '邀请已被使用或已过期');
    // 成员 upsert（已存在 → 保留原角色；否则按邀请角色）
    await this.prisma.organizationMember.upsert({
      where: { organizationId_userId: { organizationId: invitation.organizationId, userId } },
      create: { organizationId: invitation.organizationId, userId, role: invitation.role },
      update: {},
    });
    return { organizationId: invitation.organizationId, role: invitation.role };
  }

  async revokeInvitation(userId: string, token: string) {
    const invitation = await this.prisma.organizationInvitation.findUnique({ where: { token } });
    if (!invitation) throw new AppError(ErrorCode.NOT_FOUND, '邀请不存在');
    const organizationId = invitation.organizationId; // 组织归属从邀请行解析（绝不依赖客户端传参）
    await this.auth.authorize(userId, organizationId, 'member.write');
    const done = await this.prisma.organizationInvitation.updateMany({
      where: { id: invitation.id, status: 'pending' },
      data: { status: 'revoked' },
    });
    if (done.count === 0) throw new AppError(ErrorCode.VALIDATION_ERROR, '邀请已处理');
    return { revoked: true };
  }

  /** 资源行组织校验（防跨组织 IDOR）：行有 organizationId 时，请求者必须是该组织成员 */
  async assertCanAccess(userId: string, rowOrganizationId: string | null | undefined): Promise<void> {
    if (!rowOrganizationId) return; // 历史无组织行：退回 userId 归属校验（兼容）
    const m = await this.auth.membership(userId, rowOrganizationId);
    if (!m) throw new AppError(ErrorCode.NOT_FOUND, '资源不存在'); // 404 防枚举
  }

  /** membership 校验（资源创建/挂接时使用；非成员 → 403） */
  async requireMembership(userId: string, organizationId: string) {
    return this.auth.require(userId, organizationId);
  }

  /** 权限校验（RBAC 矩阵；如 project.write——viewer 是成员但不可写） */
  async requirePermission(userId: string, organizationId: string, action: OrgPermission) {
    return this.auth.authorize(userId, organizationId, action);
  }
}
