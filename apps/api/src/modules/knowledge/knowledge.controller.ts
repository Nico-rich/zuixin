import { Body, Controller, Delete, Get, Inject, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import { Request } from 'express';
import { KnowledgeService } from '../../core/knowledge/knowledge.service';
import { AuthedUser, JwtAuthGuard } from '../auth/jwt-auth.guard';

@Controller('knowledge')
@UseGuards(JwtAuthGuard)
export class KnowledgeController {
  constructor(@Inject(KnowledgeService) private readonly knowledge: KnowledgeService) {}

  /** 创建文档（text 源直传 content；file 源传已上传附件 id）并同步完成索引 */
  @Post('documents')
  create(@Req() req: Request & { user: AuthedUser }, @Body() dto: {
    name: string; projectId?: string; sourceType: 'text' | 'file';
    content?: string; attachmentId?: string;
  }) {
    return this.knowledge.createDocument(req.user.userId, dto);
  }

  @Get('documents')
  list(@Req() req: Request & { user: AuthedUser }, @Query('projectId') projectId?: string) {
    return this.knowledge.listDocuments(req.user.userId, projectId);
  }

  @Get('documents/:id')
  get(@Req() req: Request & { user: AuthedUser }, @Param('id') id: string) {
    return this.knowledge.getDocument(req.user.userId, id);
  }

  @Post('documents/:id/reindex')
  reindex(@Req() req: Request & { user: AuthedUser }, @Param('id') id: string) {
    return this.knowledge.reindex(req.user.userId, id);
  }

  @Delete('documents/:id')
  remove(@Req() req: Request & { user: AuthedUser }, @Param('id') id: string) {
    return this.knowledge.deleteDocument(req.user.userId, id);
  }
}
