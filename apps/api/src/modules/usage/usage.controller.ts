import { Controller, Get, Inject, Param, Req, UseGuards } from '@nestjs/common';
import { Request } from 'express';
import { UsageService, aggregateRunUsage } from './usage.service';
import { PrismaService } from '../prisma/prisma.service';
import { AuthedUser, JwtAuthGuard } from '../auth/jwt-auth.guard';

@Controller('usage')
@UseGuards(JwtAuthGuard)
export class UsageController {
  constructor(
    @Inject(UsageService) private readonly usage: UsageService,
    @Inject(PrismaService) private readonly prisma: PrismaService,
  ) {}

  /** 一次 AgentRun 的执行成本聚合（userId 归属校验；纯投影，不建汇总表） */
  @Get('agent-runs/:id')
  runUsage(@Req() req: Request & { user: AuthedUser }, @Param('id') id: string) {
    return aggregateRunUsage(this.prisma, req.user.userId, id);
  }
}
