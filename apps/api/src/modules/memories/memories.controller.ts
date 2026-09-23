import { Body, Controller, Delete, Get, Inject, Param, Patch, Post, Query, Req, UseGuards } from '@nestjs/common';
import { Request } from 'express';
import { CreateMemoryInput, MemoryService, UpdateMemoryInput } from '../../core/memory/memory.service';
import { CreateMemoryDtoSchema, UpdateMemoryDtoSchema } from './memories.dto';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import { AuthedUser, JwtAuthGuard } from '../auth/jwt-auth.guard';

@Controller('memories')
@UseGuards(JwtAuthGuard)
export class MemoriesController {
  constructor(@Inject(MemoryService) private readonly memories: MemoryService) {}

  @Get()
  list(
    @Req() req: Request & { user: AuthedUser },
    @Query('scope') scope?: string,
    @Query('projectId') projectId?: string,
    @Query('status') status?: string,
    @Query('q') q?: string,
  ) {
    return this.memories.list(req.user.userId, { scope: scope as never, projectId, status: status as never, q });
  }

  @Post()
  create(@Req() req: Request & { user: AuthedUser }, @Body(new ZodValidationPipe(CreateMemoryDtoSchema)) dto: {
    scope: 'user' | 'project'; projectId?: string | null; content: string;
    category: 'preference' | 'profile' | 'instruction' | 'project_context' | 'workflow' | 'other';
    importance?: number; confidence?: number | null; status?: 'candidate' | 'active' | 'rejected';
    source?: string; sourceMessageId?: string | null;
  }) {
    // zod 已校验；字面量类型与 Prisma 字符串枚举名义不兼容，显式收窄
    return this.memories.create(req.user.userId, dto as CreateMemoryInput);
  }

  @Patch(':id')
  update(@Req() req: Request & { user: AuthedUser }, @Param('id') id: string, @Body(new ZodValidationPipe(UpdateMemoryDtoSchema)) dto: {
    content?: string; category?: string; importance?: number; confidence?: number | null; status?: string;
  }) {
    return this.memories.update(req.user.userId, id, dto as UpdateMemoryInput);
  }

  @Delete(':id')
  remove(@Req() req: Request & { user: AuthedUser }, @Param('id') id: string) {
    return this.memories.remove(req.user.userId, id);
  }
}
