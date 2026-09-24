import { Body, Controller, Get, Inject, Param, Patch, Post, Req, UseGuards } from '@nestjs/common';
import { Request } from 'express';
import { AgentsAdminService } from './agents-admin.service';
import { Roles, RolesGuard } from '../../common/guards/roles.guard';
import { AuthedUser, JwtAuthGuard } from '../auth/jwt-auth.guard';

@Controller('agents')
@UseGuards(JwtAuthGuard, RolesGuard)
export class AgentsAdminController {
  constructor(@Inject(AgentsAdminService) private readonly service: AgentsAdminService) {}

  @Get()
  @Roles('admin')
  list(@Req() _req: Request & { user: AuthedUser }) {
    return this.service.list();
  }

  @Get(':id')
  @Roles('admin')
  get(@Param('id') id: string) {
    return this.service.get(id);
  }

  @Get(':id/versions')
  @Roles('admin')
  versions(@Param('id') id: string) {
    return this.service.get(id);
  }

  @Post()
  @Roles('admin')
  create(@Body() dto: {
    slug: string; name: string; description?: string; kind: string;
    systemPrompt: string; tools?: string[]; modelId?: string | null;
    temperature?: number; maxTokens?: number | null; config?: Record<string, unknown>;
  }) {
    return this.service.create(dto);
  }

  @Patch(':id/draft')
  @Roles('admin')
  editDraft(@Param('id') id: string, @Body() dto: {
    systemPrompt?: string; tools?: string[]; modelId?: string | null;
    temperature?: number; maxTokens?: number | null; config?: Record<string, unknown>;
  }) {
    return this.service.editDraft(id, dto);
  }

  @Post(':id/publish')
  @Roles('admin')
  publish(@Param('id') id: string) {
    return this.service.publish(id);
  }

  @Post(':id/rollback')
  @Roles('admin')
  rollback(@Param('id') id: string, @Body() dto: { versionId: string }) {
    return this.service.rollback(id, dto.versionId);
  }

  @Patch(':id/enabled')
  @Roles('admin')
  setEnabled(@Param('id') id: string, @Body() dto: { enabled: boolean }) {
    return this.service.setEnabled(id, dto.enabled);
  }
}
