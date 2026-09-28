import { Inject, Injectable, Logger } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { PrismaService } from '../prisma/prisma.service';
import { AppError, ErrorCode } from '../../common/errors/app-error';
import { EVALUATION_QUEUE } from '../../core/queue/queue.module';
import { addJobBounded } from '../../core/queue/bounded-add';
import { EventBusService } from '../../core/events/event-bus.service';
import { LLMManagerService } from '../../providers/llm/llm-manager.service';
import { EvaluationDatasetsService } from './datasets.service';
import { EvaluationEvaluatorsService } from './evaluators.service';
import { CreateRunDto } from './evaluation.dto';
import { EvaluationConfigSnapshot, EvaluatorScoreRow, RunComparison, RunScoreSummary } from './evaluation.types';
import { compareRuns, ResultFact, summarizeScores } from './score-aggregation';

/**
 * cancel 提示通道（Redis Pub/Sub 快速通道；DB 条件更新仍是唯一事实来源）。
 * 与 agent-run 同款：worker 收到提示立即 abort 在途 case；DB 状态复查（每 case 一次）是兜底。
 */
export const EVALUATION_RUN_CANCEL_CHANNEL = 'evaluation-run:cancel';
const ACTIVE_STATUSES = ['pending', 'running'];

/**
 * M9-P1 评测运行（服务层）：
 * - **创建即锁定**：datasetVersion / agentVersionId / configSnapshot 三者在创建时冻结；
 *   数据集后续编辑（bump 版本）绝不改变既有 run 的 case 集合与参数——可复现性的结构保证；
 * - 状态机：pending → running → completed|failed|cancelled（全部条件更新，终态绝不重开）；
 * - 执行在 Worker（payload 仅 {runId}）；本服务负责创建/读取/取消/对照聚合（读路径无新表）；
 * - 评测**不写入**任何权限/quota/RBAC/provider/approval 状态（无此类依赖注入，结构上不可能）。
 */
@Injectable()
export class EvaluationRunsService {
  private readonly logger = new Logger('EvaluationRuns');

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(EvaluationDatasetsService) private readonly datasets: EvaluationDatasetsService,
    @Inject(EvaluationEvaluatorsService) private readonly evaluators: EvaluationEvaluatorsService,
    @Inject(LLMManagerService) private readonly llmManager: LLMManagerService,
    @Inject(EventBusService) private readonly events: EventBusService,
    @InjectQueue(EVALUATION_QUEUE) private readonly queue: Queue,
  ) {}

  /**
   * 创建评测 run（HTTP 立即返回 {runId,status:'pending'}）：
   * dataset（当前版本 cases）⊕ AgentVersion ⊕ evaluators → configSnapshot 冻结 → caseRuns 预建 → 入队。
   * 任何身份字段均由服务端从 DB 解析（客户端只能提交 id）。
   */
  async create(userId: string, organizationId: string, dto: CreateRunDto) {
    // 1) 数据集（作用域 = 该组织；跨组织/不存在 → 404）
    const dataset = await this.datasets.get(organizationId, dto.datasetId);
    const cases = dataset.cases;
    if (cases.length === 0) {
      throw new AppError(ErrorCode.VALIDATION_ERROR, '数据集当前版本无用例，无法创建评测');
    }
    // 2) 锁定的 Agent 版本（enabled + 可执行 scope；agentId 从版本行解析，绝不采信客户端）
    const version = await this.prisma.agentVersion.findUnique({
      where: { id: dto.agentVersionId },
      include: { agent: { select: { id: true, slug: true, enabled: true, scope: true, organizationId: true } } },
    });
    if (!version || !version.agent.enabled) throw new AppError(ErrorCode.NOT_FOUND, 'Agent 版本不存在或 Agent 已停用');
    if (version.agent.scope === 'organization' && version.agent.organizationId !== organizationId) {
      throw new AppError(ErrorCode.NOT_FOUND, 'Agent 版本不存在'); // 跨组织引用 → 404 防枚举
    }
    if (version.agent.scope !== 'system' && version.agent.scope !== 'organization') {
      throw new AppError(ErrorCode.VALIDATION_ERROR, '该 Agent 作用域不可用于评测');
    }
    // 3) 评测器绑定（全部必须属于该组织）
    const evaluators = await this.evaluators.requireByIds(organizationId, dto.evaluatorIds ?? []);
    // 4) 基线 run（同组织；跨组织 → 404）
    if (dto.baselineRunId) {
      const baseline = await this.prisma.evaluationRun.findFirst({
        where: { id: dto.baselineRunId, organizationId },
        select: { id: true },
      });
      if (!baseline) throw new AppError(ErrorCode.NOT_FOUND, '基线评测运行不存在');
    }

    // 5) 快照冻结（provider 归属为 best-effort 观测值：解析失败不阻断创建，执行期会给出明确失败）
    const modelId = dto.modelId ?? version.modelId ?? null;
    const provider = modelId ? await this.resolveProvider(modelId) : null;
    const configSnapshot: EvaluationConfigSnapshot = {
      schema: 1,
      lockedAt: new Date().toISOString(),
      agentId: version.agent.id,
      agentVersionId: version.id,
      agentVersion: version.version,
      agentSlug: version.agent.slug,
      modelId,
      providerId: provider?.providerId ?? null,
      providerName: provider?.providerName ?? null,
      temperature: dto.temperature ?? version.temperature,
      maxTokens: dto.maxTokens ?? version.maxTokens ?? null,
      systemPrompt: version.systemPrompt,
      tools: (version.tools as string[] | null) ?? [],
      evaluatorIds: evaluators.map((e) => e.id),
      datasetId: dataset.id,
      datasetVersion: dataset.version,
      ...(dto.modelId !== undefined || dto.temperature !== undefined || dto.maxTokens !== undefined
        ? {
            overrides: {
              ...(dto.modelId !== undefined ? { modelId: dto.modelId } : {}),
              ...(dto.temperature !== undefined ? { temperature: dto.temperature } : {}),
              ...(dto.maxTokens !== undefined ? { maxTokens: dto.maxTokens } : {}),
            },
          }
        : {}),
    };

    const run = await this.prisma.evaluationRun.create({
      data: {
        organizationId,
        userId,
        datasetId: dataset.id,
        datasetVersion: dataset.version,
        agentId: version.agent.id,
        agentVersionId: version.id,
        configSnapshot: configSnapshot as never,
        status: 'pending',
        totalCases: cases.length,
        completedCases: 0,
        baselineRunId: dto.baselineRunId ?? null,
      },
    });
    // caseRun 预建（UNIQUE(runId,caseId) 幂等：重复创建同 run 的 case 行不可能发生）
    await this.prisma.evaluationCaseRun.createMany({
      data: cases.map((c) => ({ runId: run.id, caseId: c.id, status: 'pending', input: c.input as never })),
    });

    await addJobBounded(this.queue, 'execute', { runId: run.id }, {
      jobId: `eval-${run.id}`, // 冒号不可用于 BullMQ jobId
      attempts: 2,
      backoff: { type: 'exponential', delay: 2_000 },
      removeOnComplete: true,
      removeOnFail: { count: 500 },
    });
    return { runId: run.id, status: run.status, totalCases: run.totalCases, datasetVersion: run.datasetVersion };
  }

  async list(organizationId: string, filters: { datasetId?: string; limit?: number } = {}) {
    const rows = await this.prisma.evaluationRun.findMany({
      where: { organizationId, ...(filters.datasetId ? { datasetId: filters.datasetId } : {}) },
      orderBy: { createdAt: 'desc' },
      take: filters.limit ?? 50,
      select: {
        id: true, datasetId: true, datasetVersion: true, agentId: true, agentVersionId: true,
        status: true, totalCases: true, completedCases: true, baselineRunId: true,
        createdAt: true, completedAt: true,
      },
    });
    return rows;
  }

  /** 资源归属（控制器裁决用） */
  async scope(id: string): Promise<{ id: string; organizationId: string } | null> {
    return this.prisma.evaluationRun.findUnique({ where: { id }, select: { id: true, organizationId: true } });
  }

  /**
   * 运行详情（读路径聚合）：run + caseRuns（含锁定版本的 case 行）+ 每评测器/总体分数摘要。
   * 注意：EvaluationCaseRun.caseId 无 FK（schema 冻结）——case 行由 (datasetId,datasetVersion) 显式读取后内存对齐。
   */
  async get(organizationId: string, id: string) {
    const run = await this.prisma.evaluationRun.findFirst({ where: { id, organizationId } });
    if (!run) throw new AppError(ErrorCode.NOT_FOUND, '评测运行不存在');
    const [caseRuns, cases, evaluators] = await Promise.all([
      this.prisma.evaluationCaseRun.findMany({
        where: { runId: id },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        include: { results: true },
      }),
      this.datasets.casesOfVersion(run.datasetId, run.datasetVersion),
      this.runEvaluators(organizationId, run.configSnapshot),
    ]);
    const caseById = new Map(cases.map((c) => [c.id, c]));
    const results = caseRuns.flatMap((c) => c.results);
    const summary = summarizeScores(
      results.map((r) => ({ caseRunId: r.caseRunId, evaluatorId: r.evaluatorId, score: r.score, passed: r.passed })),
      caseRuns.map((c) => ({ id: c.id, caseId: c.caseId, status: c.status })),
      evaluators,
    );
    return {
      run,
      cases: caseRuns.map((c) => ({
        ...c,
        case: caseById.get(c.caseId) ?? null,
        results: [...c.results].sort((a, b) => a.evaluatorId.localeCompare(b.evaluatorId)),
      })),
      scores: summary,
    };
  }

  /** baseline vs candidate 对照（读路径聚合，无新表；case 级对齐按 caseId） */
  async comparison(organizationId: string, id: string): Promise<RunComparison | null> {
    const run = await this.prisma.evaluationRun.findFirst({ where: { id, organizationId } });
    if (!run) throw new AppError(ErrorCode.NOT_FOUND, '评测运行不存在');
    if (!run.baselineRunId) return null;
    const baselineRun = await this.prisma.evaluationRun.findFirst({
      where: { id: run.baselineRunId, organizationId },
      select: { id: true, datasetId: true, datasetVersion: true },
    });
    if (!baselineRun) return null;
    const [baselineCaseRuns, candidateCaseRuns] = await Promise.all([
      this.prisma.evaluationCaseRun.findMany({ where: { runId: baselineRun.id }, include: { results: true } }),
      this.prisma.evaluationCaseRun.findMany({ where: { runId: run.id }, include: { results: true } }),
    ]);
    const toFacts = (rows: Array<{ id: string; caseId: string; status: string; results: Array<{ caseRunId: string; evaluatorId: string; score: number; passed: boolean }> }>) => ({
      caseRuns: rows.map((r) => ({ id: r.id, caseId: r.caseId, status: r.status })),
      results: rows.flatMap((r) => r.results.map((x) => ({ caseRunId: x.caseRunId, evaluatorId: x.evaluatorId, score: x.score, passed: x.passed }))),
    });
    const caseIds = [...new Set([...baselineCaseRuns, ...candidateCaseRuns].map((c) => c.caseId))].sort();
    return compareRuns({
      candidateRunId: run.id,
      baselineRunId: baselineRun.id,
      comparable: baselineRun.datasetVersion === run.datasetVersion,
      baseline: toFacts(baselineCaseRuns),
      candidate: toFacts(candidateCaseRuns),
      caseIds,
      evaluators: await this.runEvaluators(organizationId, run.configSnapshot),
    });
  }

  /**
   * 取消（pending|running → cancelled；条件更新）：
   * 终态绝不重开；已在跑的 case 结果保留（事实不可撤销），run 状态即停止信号（runner 每 case 复查）。
   */
  async cancel(organizationId: string, id: string) {
    const run = await this.prisma.evaluationRun.findFirst({ where: { id, organizationId }, select: { id: true } });
    if (!run) throw new AppError(ErrorCode.NOT_FOUND, '评测运行不存在');
    const done = await this.prisma.evaluationRun.updateMany({
      where: { id, organizationId, status: { in: ACTIVE_STATUSES } },
      data: { status: 'cancelled', completedAt: new Date() },
    });
    if (done.count === 0) throw new AppError(ErrorCode.RUN_NOT_CANCELLABLE, '评测运行已结束，无法取消');
    // 快速通道（best-effort）：worker 收到即 abort 在途 case；DB 状态仍是唯一裁决
    await this.events.publish(EVALUATION_RUN_CANCEL_CHANNEL, { runId: id }).catch(() => undefined);
    return { runId: id, status: 'cancelled' };
  }

  /** 该 run 绑定的评测器（快照 evaluatorIds；已删除的评测器由结果行兜底呈现） */
  private async runEvaluators(organizationId: string, configSnapshot: unknown) {
    const ids = ((configSnapshot as EvaluationConfigSnapshot | null)?.evaluatorIds) ?? [];
    if (ids.length === 0) return [];
    const rows = await this.prisma.evaluator.findMany({
      where: { id: { in: ids }, organizationId },
      select: { id: true, name: true, type: true },
    });
    return rows;
  }

  /** provider 归属解析（best-effort 观测值） */
  private async resolveProvider(modelId: string): Promise<{ providerId: string; providerName: string } | null> {
    try {
      const resolved = await this.llmManager.resolve(modelId);
      return { providerId: resolved.providerId, providerName: resolved.providerName };
    } catch (err) {
      this.logger.warn(`模型解析失败（快照 provider 记为 null，执行期将显式失败）：${modelId} — ${(err as Error).message}`);
      return null;
    }
  }
}

export type { EvaluatorScoreRow, RunScoreSummary, ResultFact };
