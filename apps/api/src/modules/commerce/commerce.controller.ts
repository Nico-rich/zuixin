import { Controller, Get, Inject, Param, Query, Req, UseGuards, UsePipes } from '@nestjs/common';
import { Request } from 'express';
import { CommerceAnalysisService } from './commerce-analysis.service';
import { ListCommerceQuerySchema, ListCommerceQuery } from './commerce.dto';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import { AuthedUser, JwtAuthGuard } from '../auth/jwt-auth.guard';

/**
 * M13-W9 电商**只读展示面**（分析 / 创意简报）。
 *
 * 产品口径（必须在页面上如实标注，不得软化）：**工具即接口**——电商域的写路径
 * （采集/分析/建简报）全部由 Agent 工具执行并落在 ToolCall 幂等账本里；
 * 本控制器只提供"把既有制品读出来展示"的 GET，**没有任何写端点**，也不新增第二套业务逻辑
 * （全部透传既有 CommerceAnalysisService）。
 *
 * 分层红线保持：`facts / derived / anomalies = 服务端计算`，`possibleCauses / recommendations
 * = LLM 推测（source 标注）`——响应原样透出 `layering`，前端不得把推测渲染成事实。
 */
@Controller('commerce')
@UseGuards(JwtAuthGuard)
export class CommerceController {
  constructor(@Inject(CommerceAnalysisService) private readonly analysis: CommerceAnalysisService) {}

  @Get('analyses')
  @UsePipes(new ZodValidationPipe(ListCommerceQuerySchema))
  listAnalyses(@Req() req: Request & { user: AuthedUser }, @Query() q: ListCommerceQuery) {
    return this.analysis.listAnalyses(req.user.userId, q.limit);
  }

  @Get('analyses/:id')
  getAnalysis(@Req() req: Request & { user: AuthedUser }, @Param('id') id: string) {
    return this.analysis.getAnalysis(req.user.userId, id);
  }

  @Get('briefs')
  @UsePipes(new ZodValidationPipe(ListCommerceQuerySchema))
  listBriefs(@Req() req: Request & { user: AuthedUser }, @Query() q: ListCommerceQuery) {
    return this.analysis.listBriefs(req.user.userId, q.limit);
  }

  @Get('briefs/:id')
  getBrief(@Req() req: Request & { user: AuthedUser }, @Param('id') id: string) {
    return this.analysis.getBrief(req.user.userId, id);
  }
}
