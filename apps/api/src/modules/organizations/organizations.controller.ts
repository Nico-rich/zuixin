import { Body, Controller, Delete, Get, Inject, Param, Patch, Post, Req, UseGuards, UsePipes } from '@nestjs/common';
import { Request } from 'express';
import { OrganizationsService } from './organizations.service';
import { AcceptInvitationSchema, CreateOrganizationSchema, InviteSchema, UpdateOrganizationSchema } from './organizations.dto';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import { AuthedUser, JwtAuthGuard } from '../auth/jwt-auth.guard';

/** M8-P1 Organization API（JWT + RBAC；全部组织操作经 AuthorizationService 裁决） */
@Controller('organizations')
@UseGuards(JwtAuthGuard)
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

/** 邀请接受端点（需要登录；email 取自 JWT 用户档案——客户端不可指定） */
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
