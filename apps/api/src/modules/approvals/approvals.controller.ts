import { Controller, Get, Inject, Param, Post, Query, Req, UseGuards, UsePipes } from '@nestjs/common';
import { Request } from 'express';
import { ApprovalsService } from './approvals.service';
import { ListApprovalsSchema } from './approvals.dto';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import { AuthedUser, JwtAuthGuard } from '../auth/jwt-auth.guard';

/**
 * M7-P1 Approval API（JWT + ownership + 404 防枚举）：
 * - decide 是条件更新：重复/过期 decide → 409 APPROVAL_NOT_PENDING / APPROVAL_EXPIRED；
 * - approve 后由服务层唤醒 AgentRun（M6 waiting → queued → resume 执行 Tool）。
 */
@Controller('approvals')
@UseGuards(JwtAuthGuard)
export class ApprovalsController {
  constructor(@Inject(ApprovalsService) private readonly approvals: ApprovalsService) {}

  @Get()
  @UsePipes(new ZodValidationPipe(ListApprovalsSchema))
  list(
    @Req() req: Request & { user: AuthedUser },
    @Query() q: { projectId?: string | null; status?: string; agentRunId?: string },
  ) {
    return this.approvals.list(req.user.userId, q);
  }

  @Get(':id')
  get(@Req() req: Request & { user: AuthedUser }, @Param('id') id: string) {
    return this.approvals.get(req.user.userId, id);
  }

  @Post(':id/approve')
  approve(@Req() req: Request & { user: AuthedUser }, @Param('id') id: string) {
    return this.approvals.approve(req.user.userId, id);
  }

  @Post(':id/reject')
  reject(@Req() req: Request & { user: AuthedUser }, @Param('id') id: string) {
    return this.approvals.reject(req.user.userId, id);
  }

  @Post(':id/cancel')
  cancel(@Req() req: Request & { user: AuthedUser }, @Param('id') id: string) {
    return this.approvals.cancel(req.user.userId, id);
  }
}
