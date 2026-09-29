import { Body, Controller, Get, Inject, Param, Patch, Req, UseGuards } from '@nestjs/common';
import { Request } from 'express';
import { ProvidersAdminService } from './providers-admin.service';
import { AuthedUser, JwtAuthGuard } from '../auth/jwt-auth.guard';

/**
 * M13+（模型配置页）Provider 管理 API（**平台管理员面**）。
 *
 * - 读：`GET /providers` —— 投影视图（hasKey/loaded/degradedReason/models），**绝无 Key 回显**；
 * - 写：`PATCH /providers/:id` —— apiKey（只写）/enabled/priority/baseUrl/timeoutMs，写后热 refresh。
 * 权限裁决与字段校验都在服务层（DB 权威 role='admin' + ProviderPatchSchema 单一事实源），
 * 控制器只做路由——与 system-settings 控制器同范式。
 */
@Controller('providers')
@UseGuards(JwtAuthGuard)
export class ProvidersAdminController {
  constructor(@Inject(ProvidersAdminService) private readonly providers: ProvidersAdminService) {}

  @Get()
  async list(@Req() req: Request & { user: AuthedUser }) {
    await this.providers.assertPlatformAdmin(req.user.userId);
    return { providers: await this.providers.list() };
  }

  @Patch(':id')
  async patch(
    @Req() req: Request & { user: AuthedUser },
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    return this.providers.patch(req.user.userId, id, body);
  }
}
