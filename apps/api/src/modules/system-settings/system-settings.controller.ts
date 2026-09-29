import { Body, Controller, Get, Inject, Param, Patch, Req, UseGuards } from '@nestjs/common';
import { Request } from 'express';
import { z } from 'zod';
import { SystemSettingsService } from './system-settings.service';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import { AuthedUser, JwtAuthGuard } from '../auth/jwt-auth.guard';

/** 粗粒度请求体（必须是对象）；**按键的 strict schema 在服务层白名单内裁决**（单一事实源） */
const PatchBodySchema = z.record(z.unknown());
type PatchBodyDto = z.infer<typeof PatchBodySchema>;

/**
 * M12-P4 系统策略设置 API（**平台管理员面**）。
 *
 * 边界（红线）：
 * - RBAC = 仅平台管理员（`user.role='admin'`，DB 权威）；**组织 owner/admin 一律 403**；
 * - 键面 = 硬编码白名单（`GET` 只列白名单键；非白名单键 → 404）；**绝无通用写口**
 *   （不存在 `PUT /system-settings` 整表覆盖、不存在任意 key=value 透传）；
 * - 配额/RBAC 面不开放：`limits` 的配额类子键只读（PATCH 命中 → 400）；
 * - 每次写入强制审计（action=systemSetting.update；实验晋级走 experiments 通道，action=experiment.promotion）；
 * - LLM/Agent 无任何写路径：本控制器是唯一写入口，且工具注册表（ToolsModule）不注册任何 settings 工具。
 */
@Controller('system-settings')
@UseGuards(JwtAuthGuard)
export class SystemSettingsController {
  constructor(@Inject(SystemSettingsService) private readonly settings: SystemSettingsService) {}

  /** 受控键清单 + 生效值（只读投影：白名单之外的存储内容绝不回显） */
  @Get()
  async list(@Req() req: Request & { user: AuthedUser }) {
    await this.settings.assertPlatformAdmin(req.user.userId);
    return { settings: await this.settings.list() };
  }

  @Get(':key')
  async get(@Req() req: Request & { user: AuthedUser }, @Param('key') key: string) {
    await this.settings.assertPlatformAdmin(req.user.userId);
    return this.settings.get(key);
  }

  /** PATCH 语义：与既有值深合并 + 白名单投影 + 服务端生效值校验 + 审计 */
  @Patch(':key')
  async patch(
    @Req() req: Request & { user: AuthedUser },
    @Param('key') key: string,
    @Body(new ZodValidationPipe(PatchBodySchema)) body: PatchBodyDto,
  ) {
    return this.settings.patch(req.user.userId, key, body);
  }
}
