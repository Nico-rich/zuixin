import { Body, Controller, Delete, Get, Inject, Param, Patch, Post, Req, UseGuards } from '@nestjs/common';
import { Request } from 'express';
import { ProjectsService } from './projects.service';
import { CreateProjectDtoSchema, UpdateProjectDtoSchema } from './projects.dto';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import { AuthedUser, JwtAuthGuard } from '../auth/jwt-auth.guard';

// 注：校验管道挂在 @Body 参数上而非方法级——方法级 @UsePipes 会作用于 @Param('id')，把路径参数当 DTO 校验
@Controller('projects')
@UseGuards(JwtAuthGuard)
export class ProjectsController {
  constructor(@Inject(ProjectsService) private readonly projects: ProjectsService) {}

  @Get()
  list(@Req() req: Request & { user: AuthedUser }) {
    return this.projects.list(req.user.userId);
  }

  @Post()
  create(@Req() req: Request & { user: AuthedUser }, @Body(new ZodValidationPipe(CreateProjectDtoSchema)) dto: { name: string; description?: string; metadata?: Record<string, unknown> }) {
    return this.projects.create(req.user.userId, dto);
  }

  @Get(':id')
  get(@Req() req: Request & { user: AuthedUser }, @Param('id') id: string) {
    return this.projects.get(req.user.userId, id);
  }

  @Patch(':id')
  update(@Req() req: Request & { user: AuthedUser }, @Param('id') id: string, @Body(new ZodValidationPipe(UpdateProjectDtoSchema)) dto: { name?: string; description?: string | null; metadata?: Record<string, unknown> | null }) {
    return this.projects.update(req.user.userId, id, dto);
  }

  @Delete(':id')
  remove(@Req() req: Request & { user: AuthedUser }, @Param('id') id: string) {
    return this.projects.softDelete(req.user.userId, id);
  }
}
