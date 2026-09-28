import { Body, Controller, Delete, Get, Inject, Param, Patch, Post, Query, Req, UseGuards } from '@nestjs/common';
import { Request } from 'express';
import { HypothesesService } from './hypotheses.service';
import { InsightService } from './insight.service';
import { CreativeLoopOrchestrator } from './loop-orchestrator.service';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import { AuthedUser, JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RateLimit, RateLimitGuard } from '../../core/rate-limit/rate-limit.guard';
import { HypothesisStatus } from './hypothesis-status';
import {
  AttachEvaluationSchema, AttachExperimentSchema, BuildInsightDto, BuildInsightSchema, ConcludeDto, ConcludeSchema,
  CreateHypothesisDto, CreateHypothesisSchema, InterpretationDto, InterpretationSchema, ListHypothesesDto,
  ListHypothesesSchema, ListInsightsSchema, SetStatusDto, SetStatusSchema, StartLoopDto, StartLoopSchema,
  UpdateHypothesisDto, UpdateHypothesisSchema,
} from './creative-loop.dto';

/**
 * M9-P5 Creative Performance Loop API（JWT + 组织 RBAC）。
 *
 * 权限（**复用既有权限位，不新增**）：loop 属工作流域 → `workflow.read`（读）/ `workflow.write`（写），
 * 由服务层按假设文档的 organizationId 裁决（非成员 → 404 防枚举；成员但权限不足 → 403）。
 * 本控制器不直接写库：全部经服务层（状态推进=条件更新；真实平台写操作由 M9-P4 引擎经 M7-P3 全链执行）。
 */
@Controller('creative-loop')
@UseGuards(JwtAuthGuard)
export class CreativeLoopController {
  constructor(
    @Inject(HypothesesService) private readonly hypotheses: HypothesesService,
    @Inject(InsightService) private readonly insights: InsightService,
    @Inject(CreativeLoopOrchestrator) private readonly loop: CreativeLoopOrchestrator,
  ) {}

  // ===== 洞察（事实层 + 解读层分离）=====

  @Post('insights')
  buildInsight(@Req() req: Request & { user: AuthedUser }, @Body(new ZodValidationPipe(BuildInsightSchema)) dto: BuildInsightDto) {
    return this.insights.build(req.user.userId, dto);
  }

  @Get('insights')
  listInsights(
    @Req() req: Request & { user: AuthedUser },
    @Query(new ZodValidationPipe(ListInsightsSchema)) query: { organizationId?: string; projectId?: string; limit?: number },
  ) {
    return this.insights.list(req.user.userId, query);
  }

  @Get('insights/:id')
  getInsight(@Req() req: Request & { user: AuthedUser }, @Param('id') id: string) {
    return this.insights.get(req.user.userId, id);
  }

  /** LLM 解读写入（独立层；事实层绝不被改写——factsHash 条件更新 + 不变断言） */
  @Post('insights/:id/interpretation')
  attachInterpretation(
    @Req() req: Request & { user: AuthedUser },
    @Param('id') id: string,
    @Body(new ZodValidationPipe(InterpretationSchema)) dto: InterpretationDto,
  ) {
    return this.insights.attachInterpretation(req.user.userId, id, dto);
  }

  // ===== 创意假设 =====

  @Post('hypotheses')
  createHypothesis(@Req() req: Request & { user: AuthedUser }, @Body(new ZodValidationPipe(CreateHypothesisSchema)) dto: CreateHypothesisDto) {
    return this.hypotheses.create(req.user.userId, dto);
  }

  @Get('hypotheses')
  listHypotheses(@Req() req: Request & { user: AuthedUser }, @Query(new ZodValidationPipe(ListHypothesesSchema)) query: ListHypothesesDto) {
    return this.hypotheses.list(req.user.userId, {
      organizationId: query.organizationId,
      projectId: query.projectId,
      status: query.status as HypothesisStatus | undefined,
      limit: query.limit,
    });
  }

  @Get('hypotheses/:id')
  getHypothesis(@Req() req: Request & { user: AuthedUser }, @Param('id') id: string) {
    return this.hypotheses.get(req.user.userId, id);
  }

  @Patch('hypotheses/:id')
  updateHypothesis(
    @Req() req: Request & { user: AuthedUser },
    @Param('id') id: string,
    @Body(new ZodValidationPipe(UpdateHypothesisSchema)) dto: UpdateHypothesisDto,
  ) {
    return this.hypotheses.update(req.user.userId, id, dto);
  }

  /** 人工状态推进（draft→ready 提交 / draft|ready→rejected 放弃；绝不可直设 running/validated） */
  @Post('hypotheses/:id/status')
  setHypothesisStatus(
    @Req() req: Request & { user: AuthedUser },
    @Param('id') id: string,
    @Body(new ZodValidationPipe(SetStatusSchema)) dto: SetStatusDto,
  ) {
    return this.hypotheses.setStatus(req.user.userId, id, dto);
  }

  @Delete('hypotheses/:id')
  removeHypothesis(@Req() req: Request & { user: AuthedUser }, @Param('id') id: string) {
    return this.hypotheses.remove(req.user.userId, id);
  }

  // ===== loop 编排（M9-P4 引擎执行；限流同 workflow run 创建）=====

  /** 启动 loop：ready → running（建/复用 loop workflow → 发布 → 创建 run） */
  @Post('hypotheses/:id/start')
  @UseGuards(RateLimitGuard)
  @RateLimit({ name: 'creative-loop-start', limit: 30, windowMs: 60_000 })
  startLoop(
    @Req() req: Request & { user: AuthedUser },
    @Param('id') id: string,
    @Body(new ZodValidationPipe(StartLoopSchema)) dto: StartLoopDto,
  ) {
    return this.loop.start(req.user.userId, id, dto);
  }

  /** loop 状态（读路径收敛：run 终态 → 假设状态机推进/判定） */
  @Get('hypotheses/:id/status')
  loopStatus(@Req() req: Request & { user: AuthedUser }, @Param('id') id: string) {
    return this.loop.status(req.user.userId, id);
  }

  /** loop 运行明细（引用 workflowRun；run 生命周期归 M7-P6） */
  @Get('hypotheses/:id/run')
  loopRun(@Req() req: Request & { user: AuthedUser }, @Param('id') id: string) {
    return this.loop.runDetail(req.user.userId, id);
  }

  /** 判定：decision 缺省 = 按假设判据 + 服务端事实判定 */
  @Post('hypotheses/:id/conclude')
  conclude(
    @Req() req: Request & { user: AuthedUser },
    @Param('id') id: string,
    @Body(new ZodValidationPipe(ConcludeSchema)) dto: ConcludeDto,
  ) {
    return this.loop.conclude(req.user.userId, id, dto);
  }

  /** 挂接 M9-P1 评测运行（只引用，分数事实由 P1 摘要提供） */
  @Post('hypotheses/:id/evaluation')
  attachEvaluation(
    @Req() req: Request & { user: AuthedUser },
    @Param('id') id: string,
    @Body(new ZodValidationPipe(AttachEvaluationSchema)) dto: { evaluationRunId: string },
  ) {
    return this.loop.attachEvaluation(req.user.userId, id, dto.evaluationRunId);
  }

  /** 挂接 M9-P1 实验（只引用，实验生命周期归 P1） */
  @Post('hypotheses/:id/experiment')
  attachExperiment(
    @Req() req: Request & { user: AuthedUser },
    @Param('id') id: string,
    @Body(new ZodValidationPipe(AttachExperimentSchema)) dto: { experimentId: string },
  ) {
    return this.loop.attachExperiment(req.user.userId, id, dto.experimentId);
  }
}
