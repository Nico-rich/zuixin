import { Controller, Get, Inject, Query, Req, UseGuards } from '@nestjs/common';
import { Request } from 'express';
import { AuditService } from './audit.service';
import { AuthedUser, JwtAuthGuard } from '../auth/jwt-auth.guard';

/** M7-P9 审计读取面（userId 首条件；绝不跨用户） */
@Controller('audit-logs')
@UseGuards(JwtAuthGuard)
export class AuditController {
  constructor(@Inject(AuditService) private readonly audit: AuditService) {}

  @Get()
  list(
    @Req() req: Request & { user: AuthedUser },
    @Query('action') action?: string,
    @Query('targetType') targetType?: string,
    @Query('take') take?: string,
  ) {
    return this.audit.list(req.user.userId, { action, targetType, take: Number(take) || 50 });
  }
}
