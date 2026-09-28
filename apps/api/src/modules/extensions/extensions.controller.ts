import { Body, Controller, Delete, Get, Inject, Param, Patch, Post, Query, Req, UseGuards } from '@nestjs/common';
import { Request } from 'express';
import { ExtensionsService } from './extensions.service';
import {
  AllowlistEntrySchema, CreateExtensionSchema, InstallSchema, OrgScopedSchema, PublishSchema, UpdateExtensionSchema,
} from './extensions.dto';
import { ExtensionKind } from './manifest';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import { AuthedUser, JwtAuthGuard } from '../auth/jwt-auth.guard';
import { OrgStatusGuard, SkipOrgStatusCheck } from '../../common/guards/org-status.guard';

/**
 * M8-P6 Extension SDK API（JWT + 组织 RBAC + M10-P14 组织禁用态）：
 * 扩展 CRUD / 版本状态机（publish-deprecate-archive）/ 安装-卸载-启停 / 市场目录 / 步骤模板查询 /
 * 组织白名单管理（M10-P14）。
 * 管理语义 = 组织 agent.write（平台级扩展需平台管理员）；绝不执行 manifest 中的任何内容。
 *
 * M10-P14（X-21）组织禁用守卫：本控制器**不声明** `@OrgStatusIdParam`——路由参数 `:id` 是扩展 id，
 * 绝不能当作组织 id 判定；组织上下文来自 query/body 的 `organizationId`（list/catalog/install/enable 等），
 * 组织禁用时一律 403 ORG_DISABLED（服务层 AuthorizationService 同码纵深）。
 * 白名单端点豁免（`@SkipOrgStatusCheck()`）：其 body.organizationId 是**治理目标**而非调用者组织上下文
 * （白名单查询/治理数据不受目标组织禁用态影响）。
 * 集成挂载要求：本守卫应于集成阶段在 app.module 全局挂载（见 common/guards/org-status.guard.ts 文件头）。
 */
@Controller('extensions')
@UseGuards(JwtAuthGuard, OrgStatusGuard)
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

  // ===== M10-P14（D16）组织白名单 =====

  /** 白名单查询（只读治理数据；平台级扩展任何登录用户可读，组织私有扩展需该组织 agent.read） */
  @Get(':id/allowlist')
  @SkipOrgStatusCheck()
  allowlist(@Req() req: Request & { user: AuthedUser }, @Param('id') id: string) {
    return this.extensions.listAllowlist(req.user.userId, id);
  }

  /** 增条目（extension owner：平台级=平台管理员，组织私有=所属组织 owner/admin；组织**不得**自加入） */
  @Post(':id/allowlist')
  @SkipOrgStatusCheck()
  addAllowlistEntry(@Req() req: Request & { user: AuthedUser }, @Param('id') id: string, @Body(new ZodValidationPipe(AllowlistEntrySchema)) dto: { organizationId: string }) {
    return this.extensions.addAllowlistEntry(req.user.userId, id, dto.organizationId);
  }

  /** 删条目（extension owner，或目标组织 owner/admin 自助退出；跨组织删除一律 403） */
  @Delete(':id/allowlist/:organizationId')
  @SkipOrgStatusCheck()
  removeAllowlistEntry(@Req() req: Request & { user: AuthedUser }, @Param('id') id: string, @Param('organizationId') organizationId: string) {
    return this.extensions.removeAllowlistEntry(req.user.userId, id, organizationId);
  }

  @Post(':id/disable')
  disable(@Req() req: Request & { user: AuthedUser }, @Param('id') id: string, @Body(new ZodValidationPipe(OrgScopedSchema)) dto: { organizationId: string }) {
    return this.extensions.setEnabled(req.user.userId, id, dto.organizationId, false);
  }
}
