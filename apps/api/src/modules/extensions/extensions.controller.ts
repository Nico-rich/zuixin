import { Body, Controller, Get, Inject, Param, Patch, Post, Query, Req, UseGuards } from '@nestjs/common';
import { Request } from 'express';
import { ExtensionsService } from './extensions.service';
import {
  CreateExtensionSchema, InstallSchema, OrgScopedSchema, PublishSchema, UpdateExtensionSchema,
} from './extensions.dto';
import { ExtensionKind } from './manifest';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import { AuthedUser, JwtAuthGuard } from '../auth/jwt-auth.guard';

/**
 * M8-P6 Extension SDK API（JWT + 组织 RBAC）：
 * 扩展 CRUD / 版本状态机（publish-deprecate-archive）/ 安装-卸载-启停 / 市场目录 / 步骤模板查询。
 * 管理语义 = 组织 agent.write（平台级扩展需平台管理员）；绝不执行 manifest 中的任何内容。
 */
@Controller('extensions')
@UseGuards(JwtAuthGuard)
export class ExtensionsController {
  constructor(@Inject(ExtensionsService) private readonly extensions: ExtensionsService) {}

  @Post()
  create(@Req() req: Request & { user: AuthedUser }, @Body(new ZodValidationPipe(CreateExtensionSchema)) dto: {
    organizationId?: string | null; name: string; slug: string; description?: string; kind: ExtensionKind; manifest: unknown;
  }) {
    return this.extensions.create(req.user.userId, dto);
  }

  @Get()
  list(@Req() req: Request & { user: AuthedUser }, @Query('organizationId') organizationId: string) {
    return this.extensions.list(req.user.userId, organizationId);
  }

  /** 市场目录（仅已发布：平台级 + 本组织私有） */
  @Get('catalog')
  catalog(@Req() req: Request & { user: AuthedUser }, @Query('organizationId') organizationId: string) {
    return this.extensions.catalog(req.user.userId, organizationId);
  }

  @Get('installations')
  installations(@Req() req: Request & { user: AuthedUser }, @Query('organizationId') organizationId: string) {
    return this.extensions.installations(req.user.userId, organizationId);
  }

  /** workflow_step 类扩展的步骤模板声明（供创建 workflow 时引用；本 Phase 不改执行器） */
  @Get('steps')
  steps(@Req() req: Request & { user: AuthedUser }, @Query('organizationId') organizationId: string) {
    return this.extensions.stepTemplates(req.user.userId, organizationId);
  }

  @Get(':id')
  get(@Req() req: Request & { user: AuthedUser }, @Param('id') id: string, @Query('organizationId') organizationId: string) {
    return this.extensions.get(req.user.userId, id, organizationId);
  }

  @Patch(':id')
  update(@Req() req: Request & { user: AuthedUser }, @Param('id') id: string, @Body(new ZodValidationPipe(UpdateExtensionSchema)) dto: {
    name?: string; description?: string; manifest?: unknown;
  }) {
    return this.extensions.update(req.user.userId, id, dto);
  }

  @Post(':id/publish')
  publish(@Req() req: Request & { user: AuthedUser }, @Param('id') id: string, @Body(new ZodValidationPipe(PublishSchema)) dto: { versionId?: string }) {
    return this.extensions.publish(req.user.userId, id, dto.versionId);
  }

  @Post(':id/deprecate')
  deprecate(@Req() req: Request & { user: AuthedUser }, @Param('id') id: string) {
    return this.extensions.deprecate(req.user.userId, id);
  }

  @Post(':id/archive')
  archive(@Req() req: Request & { user: AuthedUser }, @Param('id') id: string) {
    return this.extensions.archive(req.user.userId, id);
  }

  @Post(':id/install')
  install(@Req() req: Request & { user: AuthedUser }, @Param('id') id: string, @Body(new ZodValidationPipe(InstallSchema)) dto: {
    organizationId: string; versionId?: string; config?: Record<string, unknown>;
  }) {
    return this.extensions.install(req.user.userId, id, dto);
  }

  @Post(':id/uninstall')
  uninstall(@Req() req: Request & { user: AuthedUser }, @Param('id') id: string, @Body(new ZodValidationPipe(OrgScopedSchema)) dto: { organizationId: string }) {
    return this.extensions.uninstall(req.user.userId, id, dto.organizationId);
  }

  @Post(':id/enable')
  enable(@Req() req: Request & { user: AuthedUser }, @Param('id') id: string, @Body(new ZodValidationPipe(OrgScopedSchema)) dto: { organizationId: string }) {
    return this.extensions.setEnabled(req.user.userId, id, dto.organizationId, true);
  }

  @Post(':id/disable')
  disable(@Req() req: Request & { user: AuthedUser }, @Param('id') id: string, @Body(new ZodValidationPipe(OrgScopedSchema)) dto: { organizationId: string }) {
    return this.extensions.setEnabled(req.user.userId, id, dto.organizationId, false);
  }
}
