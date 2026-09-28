import { Body, Controller, Delete, Get, Inject, Param, Patch, Post, Req, UseGuards } from '@nestjs/common';
import { Request } from 'express';
import { OrganizationsService } from './organizations.service';
import { CreateOrganizationSchema, InviteSchema, UpdateOrganizationSchema } from './organizations.dto';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import { AuthedUser, JwtAuthGuard } from '../auth/jwt-auth.guard';
import { OrgStatusGuard, OrgStatusIdParam, SkipOrgStatusCheck } from '../../common/guards/org-status.guard';

/**
 * M8-P1 Organization API（JWT + RBAC + M10-P14 组织禁用态；全部组织操作经 AuthorizationService 裁决）。
 *
 * M10-P14（X-21）组织禁用守卫：
 * - `@OrgStatusIdParam('id')`：本控制器的路由参数 `:id` 即组织 id → 组织 `status=disabled` 时一切
 *   组织级端点（读/写/成员/邀请）403 ORG_DISABLED；
 * - `@SkipOrgStatusCheck()`：禁用/启用端点自身豁免（否则组织一经禁用便不可恢复）；其 RBAC
 *   （平台管理员或组织 owner）由 OrganizationsService.setStatus 裁决；
 * - 无角色豁免：平台管理员的治理能力来自上述**显式豁免端点**（disable/enable），而非在本守卫开口子
 *   （否则任何 role=admin 令牌即绕过冻结）；数据面冻结对成员/owner/平台管理员一致生效；
 * - 集成挂载要求：本守卫应于集成阶段在 app.module 全局挂载（见 common/guards/org-status.guard.ts 文件头）。
 */
@Controller('organizations')
@UseGuards(JwtAuthGuard, OrgStatusGuard)
@OrgStatusIdParam('id')
export class OrganizationsController {
  constructor(@Inject(OrganizationsService) private readonly orgs: OrganizationsService) {}

  @Get()
  list(@Req() req: Request & { user: AuthedUser }) {
    return this.orgs.list(req.user.userId);
  }

  @Post()
  create(@Req() req: Request & { user: AuthedUser }, @Body(new ZodValidationPipe(CreateOrganizationSchema)) dto: { name: string; slug?: string }) {
    return this.orgs.create(req.user.userId, dto);
  }

  @Get(':id')
  get(@Req() req: Request & { user: AuthedUser }, @Param('id') id: string) {
    return this.orgs.get(req.user.userId, id);
  }

  @Patch(':id')
  update(@Req() req: Request & { user: AuthedUser }, @Param('id') id: string, @Body(new ZodValidationPipe(UpdateOrganizationSchema)) dto: { name?: string }) {
    return this.orgs.update(req.user.userId, id, dto);
  }

  @Delete(':id')
  softDelete(@Req() req: Request & { user: AuthedUser }, @Param('id') id: string) {
    return this.orgs.softDelete(req.user.userId, id);
  }

  /**
   * M10-P14：禁用组织（冻结）。RBAC：平台管理员或组织 owner（organization.write）；
   * 个人空间不接受 owner 自助禁用（平台管理员除外）。冻结后组织级一切访问/管理 403 ORG_DISABLED。
   */
  @Post(':id/disable')
  @SkipOrgStatusCheck()
  disable(@Req() req: Request & { user: AuthedUser }, @Param('id') id: string) {
    return this.orgs.setStatus(req.user.userId, id, 'disabled');
  }

  /** M10-P14：启用组织（恢复）。RBAC 同上；冻结必须可恢复 → 本端点自身豁免禁用守卫。 */
  @Post(':id/enable')
  @SkipOrgStatusCheck()
  enable(@Req() req: Request & { user: AuthedUser }, @Param('id') id: string) {
    return this.orgs.setStatus(req.user.userId, id, 'active');
  }

  @Get(':id/members')
  members(@Req() req: Request & { user: AuthedUser }, @Param('id') id: string) {
    return this.orgs.listMembers(req.user.userId, id);
  }

  @Delete(':id/members/:userId')
  removeMember(@Req() req: Request & { user: AuthedUser }, @Param('id') id: string, @Param('userId') targetUserId: string) {
    return this.orgs.removeMember(req.user.userId, id, targetUserId);
  }

  @Post(':id/invitations')
  invite(@Req() req: Request & { user: AuthedUser }, @Param('id') id: string, @Body(new ZodValidationPipe(InviteSchema)) dto: { email: string; role?: 'admin' | 'member' | 'viewer' }) {
    return this.orgs.invite(req.user.userId, id, dto);
  }

  @Get(':id/invitations')
  invitations(@Req() req: Request & { user: AuthedUser }, @Param('id') id: string) {
    return this.orgs.listInvitations(req.user.userId, id);
  }

}

/**
 * 邀请接受端点（需要登录；email 取自 JWT 用户档案——客户端不可指定）。
 *
 * M10-P14：本控制器路由由 token 定位（请求中不含 organizationId）→ OrgStatusGuard 不参与判定；
 * 组织禁用态由服务层裁决（acceptInvitation 校验组织 status，禁用组织不可再接纳新成员。
 * revoke 只收回访问权，不因禁用而被拒）。
 */
@Controller('invitations')
@UseGuards(JwtAuthGuard)
export class InvitationsController {
  constructor(@Inject(OrganizationsService) private readonly orgs: OrganizationsService) {}

  @Post(':token/accept')
  accept(@Req() req: Request & { user: AuthedUser }, @Param('token') token: string) {
    // email 从用户档案解析（服务端），客户端不可指定
    return this.orgs.acceptInvitation(req.user.userId, token);
  }

  @Post(':token/revoke')
  revoke(@Req() req: Request & { user: AuthedUser }, @Param('token') token: string) {
    // 组织归属从邀请行解析（客户端不传 organizationId）
    return this.orgs.revokeInvitation(req.user.userId, token);
  }
}
