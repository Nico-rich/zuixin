import { Body, Controller, Delete, Get, Inject, Param, Patch, Post, Put, Query, Req, UseGuards } from '@nestjs/common';
import { Request } from 'express';
import { EvaluationDatasetsService } from './datasets.service';
import { EvaluationEvaluatorsService } from './evaluators.service';
import { EvaluationRunsService } from './evaluation-runs.service';
import { ExperimentsService } from './experiments.service';
import { OrganizationsService } from '../organizations/organizations.service';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import { AuthedUser, JwtAuthGuard } from '../auth/jwt-auth.guard';
import { AppError, ErrorCode } from '../../common/errors/app-error';
import {
  CaseInputDto, CreateDatasetDto, CreateEvaluatorDto, CreateExperimentDto, CreateRunDto, CreateVariantDto,
  CreateDatasetSchema, CreateEvaluatorSchema, CreateExperimentSchema, CreateRunSchema, CreateVariantSchema,
  ExperimentStatusSchema, ListQuerySchema, ReplaceCasesSchema, UpdateDatasetSchema, UpdateEvaluatorSchema, UpdateExperimentSchema,
} from './evaluation.dto';

/**
 * M9-P1 Evaluation API（JWT + 组织 RBAC）。
 *
 * 归属裁决（与 M8 RBAC 矩阵一致，deny-by-default）：
 * - 集合端点：organizationId 缺省 = 请求者个人组织；显式组织须过 requirePermission（非成员 → 403）；
 *   读 = evaluation.read（owner/admin/member/viewer 全有），写 = evaluation.write（**仅 owner/admin**）；
 * - 资源端点：先按 id 取行（不存在 → 404），再 assertCanAccess（非成员 → 404 防枚举），
 *   写操作再要求 evaluation.write（viewer/member → 403）。
 *
 * 评测域**不写**任何权限/quota/RBAC/provider/approval 状态：本控制器只读写评测与实验表。
 */
@Controller('evaluation')
@UseGuards(JwtAuthGuard)
export class EvaluationController {
  constructor(
    @Inject(EvaluationDatasetsService) private readonly datasets: EvaluationDatasetsService,
    @Inject(EvaluationEvaluatorsService) private readonly evaluators: EvaluationEvaluatorsService,
    @Inject(EvaluationRunsService) private readonly runs: EvaluationRunsService,
    @Inject(ExperimentsService) private readonly experiments: ExperimentsService,
    @Inject(OrganizationsService) private readonly orgs: OrganizationsService,
  ) {}

  // ===== datasets =====

  @Post('datasets')
  async createDataset(
    @Req() req: Request & { user: AuthedUser },
    @Body(new ZodValidationPipe(CreateDatasetSchema)) dto: CreateDatasetDto,
  ) {
    const orgId = await this.resolveOrg(req.user.userId, dto.organizationId);
    await this.requireWrite(req.user.userId, orgId);
    return this.datasets.create(req.user.userId, orgId, dto);
  }

  @Get('datasets')
  async listDatasets(
    @Req() req: Request & { user: AuthedUser },
    @Query(new ZodValidationPipe(ListQuerySchema)) query: { organizationId?: string; limit?: number },
  ) {
    const orgId = await this.resolveOrg(req.user.userId, query.organizationId);
    await this.requireRead(req.user.userId, orgId);
    return { datasets: await this.datasets.list(orgId, query.limit ?? 50) };
  }

  @Get('datasets/:id')
  async getDataset(@Req() req: Request & { user: AuthedUser }, @Param('id') id: string) {
    const scope = await this.datasets.scope(id);
    await this.authorizeResource(req.user.userId, scope, 'evaluation.read');
    return this.datasets.get(scope!.organizationId, id);
  }

  @Patch('datasets/:id')
  async updateDataset(
    @Req() req: Request & { user: AuthedUser },
    @Param('id') id: string,
    @Body(new ZodValidationPipe(UpdateDatasetSchema)) dto: { name?: string; description?: string | null },
  ) {
    const scope = await this.datasets.scope(id);
    await this.authorizeResource(req.user.userId, scope, 'evaluation.write');
    return this.datasets.updateMetadata(scope!.organizationId, id, dto);
  }

  /** 替换 case 集合（copy-on-write：version + 1，旧版本行保留——历史 run 因此永远可复现） */
  @Put('datasets/:id/cases')
  async replaceCases(
    @Req() req: Request & { user: AuthedUser },
    @Param('id') id: string,
    @Body(new ZodValidationPipe(ReplaceCasesSchema)) dto: { cases: CaseInputDto[] },
  ) {
    const scope = await this.datasets.scope(id);
    await this.authorizeResource(req.user.userId, scope, 'evaluation.write');
    return this.datasets.replaceCases(scope!.organizationId, id, dto.cases);
  }

  @Get('datasets/:id/versions')
  async datasetVersions(@Req() req: Request & { user: AuthedUser }, @Param('id') id: string) {
    const scope = await this.datasets.scope(id);
    await this.authorizeResource(req.user.userId, scope, 'evaluation.read');
    return this.datasets.versions(scope!.organizationId, id);
  }

  // ===== evaluators =====

  @Post('evaluators')
  async createEvaluator(
    @Req() req: Request & { user: AuthedUser },
    @Body(new ZodValidationPipe(CreateEvaluatorSchema)) dto: CreateEvaluatorDto,
  ) {
    const orgId = await this.resolveOrg(req.user.userId, dto.organizationId);
    await this.requireWrite(req.user.userId, orgId);
    return this.evaluators.create(req.user.userId, orgId, dto);
  }

  @Get('evaluators')
  async listEvaluators(
    @Req() req: Request & { user: AuthedUser },
    @Query(new ZodValidationPipe(ListQuerySchema)) query: { organizationId?: string },
  ) {
    const orgId = await this.resolveOrg(req.user.userId, query.organizationId);
    await this.requireRead(req.user.userId, orgId);
    return { evaluators: await this.evaluators.list(orgId) };
  }

  @Get('evaluators/:id')
  async getEvaluator(@Req() req: Request & { user: AuthedUser }, @Param('id') id: string) {
    const scope = await this.evaluators.scope(id);
    await this.authorizeResource(req.user.userId, scope, 'evaluation.read');
    return this.evaluators.get(scope!.organizationId, id);
  }

  @Patch('evaluators/:id')
  async updateEvaluator(
    @Req() req: Request & { user: AuthedUser },
    @Param('id') id: string,
    @Body(new ZodValidationPipe(UpdateEvaluatorSchema)) dto: { name?: string; config?: Record<string, unknown> },
  ) {
    const scope = await this.evaluators.scope(id);
    await this.authorizeResource(req.user.userId, scope, 'evaluation.write');
    return this.evaluators.update(scope!.organizationId, id, dto);
  }

  /** 删除受保护：已被评测结果引用 → 400（历史事实只读，绝不级联销毁） */
  @Delete('evaluators/:id')
  async deleteEvaluator(@Req() req: Request & { user: AuthedUser }, @Param('id') id: string) {
    const scope = await this.evaluators.scope(id);
    await this.authorizeResource(req.user.userId, scope, 'evaluation.write');
    return this.evaluators.remove(scope!.organizationId, id);
  }

  // ===== runs =====

  @Post('runs')
  async createRun(
    @Req() req: Request & { user: AuthedUser },
    @Body(new ZodValidationPipe(CreateRunSchema)) dto: CreateRunDto,
  ) {
    const orgId = await this.resolveOrg(req.user.userId, dto.organizationId);
    await this.requireWrite(req.user.userId, orgId);
    return this.runs.create(req.user.userId, orgId, dto);
  }

  @Get('runs')
  async listRuns(
    @Req() req: Request & { user: AuthedUser },
    @Query(new ZodValidationPipe(ListQuerySchema)) query: { organizationId?: string; datasetId?: string; limit?: number },
  ) {
    const orgId = await this.resolveOrg(req.user.userId, query.organizationId);
    await this.requireRead(req.user.userId, orgId);
    return { runs: await this.runs.list(orgId, { datasetId: query.datasetId, limit: query.limit ?? 50 }) };
  }

  @Get('runs/:id')
  async getRun(@Req() req: Request & { user: AuthedUser }, @Param('id') id: string) {
    const scope = await this.runs.scope(id);
    await this.authorizeResource(req.user.userId, scope, 'evaluation.read');
    return this.runs.get(scope!.organizationId, id);
  }

  /** baseline vs candidate 对照（读路径聚合；无 baselineRunId → null） */
  @Get('runs/:id/comparison')
  async comparison(@Req() req: Request & { user: AuthedUser }, @Param('id') id: string) {
    const scope = await this.runs.scope(id);
    await this.authorizeResource(req.user.userId, scope, 'evaluation.read');
    return { comparison: await this.runs.comparison(scope!.organizationId, id) };
  }

  @Post('runs/:id/cancel')
  async cancelRun(@Req() req: Request & { user: AuthedUser }, @Param('id') id: string) {
    const scope = await this.runs.scope(id);
    await this.authorizeResource(req.user.userId, scope, 'evaluation.write');
    return this.runs.cancel(scope!.organizationId, id);
  }

  // ===== experiments =====

  @Post('experiments')
  async createExperiment(
    @Req() req: Request & { user: AuthedUser },
    @Body(new ZodValidationPipe(CreateExperimentSchema)) dto: CreateExperimentDto,
  ) {
    const orgId = await this.resolveOrg(req.user.userId, dto.organizationId);
    await this.requireWrite(req.user.userId, orgId);
    return this.experiments.create(req.user.userId, orgId, dto);
  }

  @Get('experiments')
  async listExperiments(
    @Req() req: Request & { user: AuthedUser },
    @Query(new ZodValidationPipe(ListQuerySchema)) query: { organizationId?: string; limit?: number },
  ) {
    const orgId = await this.resolveOrg(req.user.userId, query.organizationId);
    await this.requireRead(req.user.userId, orgId);
    return { experiments: await this.experiments.list(orgId, query.limit ?? 50) };
  }

  @Get('experiments/:id')
  async getExperiment(@Req() req: Request & { user: AuthedUser }, @Param('id') id: string) {
    const scope = await this.experiments.scope(id);
    await this.authorizeResource(req.user.userId, scope, 'evaluation.read');
    return this.experiments.get(scope!.organizationId, id);
  }

  @Patch('experiments/:id')
  async updateExperiment(
    @Req() req: Request & { user: AuthedUser },
    @Param('id') id: string,
    @Body(new ZodValidationPipe(UpdateExperimentSchema)) dto: { name?: string; hypothesis?: Record<string, unknown> | null },
  ) {
    const scope = await this.experiments.scope(id);
    await this.authorizeResource(req.user.userId, scope, 'evaluation.write');
    return this.experiments.update(scope!.organizationId, id, dto);
  }

  @Post('experiments/:id/status')
  async transitionExperiment(
    @Req() req: Request & { user: AuthedUser },
    @Param('id') id: string,
    @Body(new ZodValidationPipe(ExperimentStatusSchema)) dto: { status: 'running' | 'completed' | 'archived' },
  ) {
    const scope = await this.experiments.scope(id);
    await this.authorizeResource(req.user.userId, scope, 'evaluation.write');
    return this.experiments.transition(scope!.organizationId, id, dto.status);
  }

  @Post('experiments/:id/variants')
  async addVariant(
    @Req() req: Request & { user: AuthedUser },
    @Param('id') id: string,
    @Body(new ZodValidationPipe(CreateVariantSchema)) dto: CreateVariantDto,
  ) {
    const scope = await this.experiments.scope(id);
    await this.authorizeResource(req.user.userId, scope, 'evaluation.write');
    return this.experiments.addVariant(scope!.organizationId, id, dto);
  }

  // ===== 归属裁决 =====

  /** 组织归属解析：显式 organizationId 或请求者个人组织（服务端解析，绝不信客户端 userId） */
  private async resolveOrg(userId: string, organizationId?: string): Promise<string> {
    return organizationId ?? (await this.orgs.ensurePersonalOrganization(userId)).id;
  }

  private async requireRead(userId: string, organizationId: string) {
    return this.orgs.requirePermission(userId, organizationId, 'evaluation.read');
  }

  private async requireWrite(userId: string, organizationId: string) {
    return this.orgs.requirePermission(userId, organizationId, 'evaluation.write');
  }

  /** 资源级裁决：不存在 → 404；非成员 → 404（防枚举）；随后按 action 要求 evaluation.read/write（403） */
  private async authorizeResource(
    userId: string,
    row: { organizationId: string } | null,
    action: 'evaluation.read' | 'evaluation.write',
  ): Promise<void> {
    if (!row) throw new AppError(ErrorCode.NOT_FOUND, '资源不存在');
    await this.orgs.assertCanAccess(userId, row.organizationId);
    await this.orgs.requirePermission(userId, row.organizationId, action);
  }
}
