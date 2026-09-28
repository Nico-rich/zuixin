import { Inject, Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AppError, ErrorCode } from '../../common/errors/app-error';
import { CreateExperimentDto, CreateVariantDto } from './evaluation.dto';
import { summarizeScores } from './score-aggregation';

/** 实验状态机（唯一权威迁移表；终态 archived 不可再迁出） */
const TRANSITIONS: Record<string, string[]> = {
  draft: ['running', 'archived'],
  running: ['completed', 'archived'],
  completed: ['archived'],
  archived: [],
};

/**
 * M9-P1 实验 / 变体（服务层）：
 * - 状态机 draft→running→completed→archived（条件更新；非法迁移 → 400，绝不静默改写）；
 * - variant.trafficPercent 之和 ≤ 100（服务端校验——流量切分是配置事实，绝不靠调用方自觉）；
 * - variant.metrics 是**由评测 run 聚合的对照事实**（只读派生；本服务读路径派生，绝不写入任何判定面）；
 * - 实验/变体绝不下发、绝不改变线上路由（M9-P3 Provider Routing 也不读本表——评测与流量选路严格分离）。
 */
@Injectable()
export class ExperimentsService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  async create(userId: string, organizationId: string, dto: CreateExperimentDto) {
    return this.prisma.experiment.create({
      data: {
        organizationId,
        userId,
        name: dto.name,
        hypothesis: (dto.hypothesis ?? null) as never,
        status: 'draft',
      },
    });
  }

  async list(organizationId: string, limit = 50) {
    const rows = await this.prisma.experiment.findMany({
      where: { organizationId },
      orderBy: { createdAt: 'desc' },
      take: limit,
      include: { _count: { select: { variants: true } } },
    });
    return rows.map((r) => ({ ...r, variantCount: r._count.variants, _count: undefined }));
  }

  /** 资源归属（控制器裁决用） */
  async scope(id: string): Promise<{ id: string; organizationId: string } | null> {
    return this.prisma.experiment.findUnique({ where: { id }, select: { id: true, organizationId: true } });
  }

  /** 详情：变体 + 每个变体按 agentVersionId 聚合的评测对照事实（读路径派生） */
  async get(organizationId: string, id: string) {
    const experiment = await this.prisma.experiment.findFirst({
      where: { id, organizationId },
      include: { variants: { orderBy: { createdAt: 'asc' } } },
    });
    if (!experiment) throw new AppError(ErrorCode.NOT_FOUND, '实验不存在');
    const variants = await Promise.all(experiment.variants.map(async (v) => ({
      ...v,
      evaluation: await this.variantEvaluation(organizationId, v.agentVersionId),
    })));
    return { ...experiment, variants };
  }

  async update(organizationId: string, id: string, dto: { name?: string; hypothesis?: Record<string, unknown> | null }) {
    await this.requireExperiment(organizationId, id);
    await this.prisma.experiment.update({
      where: { id },
      data: {
        ...(dto.name !== undefined ? { name: dto.name } : {}),
        ...(dto.hypothesis !== undefined ? { hypothesis: dto.hypothesis as never } : {}),
      },
    });
    return this.get(organizationId, id);
  }

  /** 状态迁移（条件更新；非法来源态 → 400，且绝不部分改写） */
  async transition(organizationId: string, id: string, status: 'running' | 'completed' | 'archived') {
    const current = await this.requireExperiment(organizationId, id);
    const allowed = TRANSITIONS[current.status] ?? [];
    if (!allowed.includes(status)) {
      throw new AppError(ErrorCode.VALIDATION_ERROR, `实验状态不可从 ${current.status} 迁移到 ${status}`);
    }
    const done = await this.prisma.experiment.updateMany({
      where: { id, organizationId, status: current.status },
      data: { status },
    });
    if (done.count === 0) throw new AppError(ErrorCode.VALIDATION_ERROR, '实验状态已被并发修改，请刷新后重试');
    return this.get(organizationId, id);
  }

  async addVariant(organizationId: string, id: string, dto: CreateVariantDto) {
    await this.requireExperiment(organizationId, id);
    const existing = await this.prisma.experimentVariant.findMany({ where: { experimentId: id } });
    const usedTraffic = existing.reduce((s, v) => s + v.trafficPercent, 0);
    const traffic = dto.trafficPercent ?? 0;
    if (usedTraffic + traffic > 100) {
      throw new AppError(ErrorCode.VALIDATION_ERROR, `变体流量之和不得超过 100%（已用 ${usedTraffic}%）`);
    }
    if (dto.agentVersionId) {
      // M10-P15（IDOR）：**必须带归属谓词**（与 EvaluationRunsService 建 run 时同一可见性口径：
      // 本组织版本 ∨ 系统级版本）。此前按 `findUnique({id})` 全局查 → 传入他组织的版本会 201
      // （外键被落库），传入不存在的版本才 404：两者状态码不同 ⇒ 跨租户存在性 oracle；
      // 且变体挂载了他人版本。系统级版本（organizationId=null, scope='system'）是平台目录，
      // 与 run 口径一致必须放行——只认 organizationId 会把正常流程误杀成 404。
      const version = await this.prisma.agentVersion.findFirst({
        where: { id: dto.agentVersionId, agent: { OR: [{ organizationId }, { scope: 'system' }] } },
        select: { id: true },
      });
      if (!version) throw new AppError(ErrorCode.NOT_FOUND, 'Agent 版本不存在');
    }
    const isBaseline = dto.isBaseline ?? existing.length === 0;
    if (isBaseline && existing.some((v) => v.isBaseline)) {
      // 单一基线不变量：显式指定新基线时清除旧的（条件写在同一事务语义内：先清除再写入）
      await this.prisma.experimentVariant.updateMany({ where: { experimentId: id, isBaseline: true }, data: { isBaseline: false } });
    }
    await this.prisma.experimentVariant.create({
      data: {
        experimentId: id,
        name: dto.name,
        agentId: dto.agentId ?? null,
        agentVersionId: dto.agentVersionId ?? null,
        configSnapshot: (dto.configSnapshot ?? {}) as never,
        isBaseline,
        trafficPercent: traffic,
      },
    });
    return this.get(organizationId, id);
  }

  private async requireExperiment(organizationId: string, id: string) {
    const experiment = await this.prisma.experiment.findFirst({ where: { id, organizationId } });
    if (!experiment) throw new AppError(ErrorCode.NOT_FOUND, '实验不存在');
    return experiment;
  }

  /**
   * 变体的评测对照事实（读路径聚合；无新表）：
   * 取该 agentVersionId 最近 ≤5 个**已完成**评测 run 的结果聚合——纯事实，绝不含 LLM 解读。
   */
  private async variantEvaluation(organizationId: string, agentVersionId: string | null) {
    if (!agentVersionId) return null;
    const runs = await this.prisma.evaluationRun.findMany({
      where: { organizationId, agentVersionId, status: 'completed' },
      orderBy: { completedAt: 'desc' },
      take: 5,
      select: { id: true, createdAt: true, completedAt: true, datasetId: true, datasetVersion: true },
    });
    if (runs.length === 0) return { runCount: 0, runs: [], scores: null };
    const runIds = runs.map((r) => r.id);
    const [caseRuns, evaluators] = await Promise.all([
      this.prisma.evaluationCaseRun.findMany({ where: { runId: { in: runIds } }, include: { results: true } }),
      this.prisma.evaluator.findMany({ where: { organizationId }, select: { id: true, name: true, type: true } }),
    ]);
    const results = caseRuns.flatMap((c) => c.results);
    return {
      runCount: runs.length,
      runs,
      scores: summarizeScores(
        results.map((r) => ({ caseRunId: r.caseRunId, evaluatorId: r.evaluatorId, score: r.score, passed: r.passed })),
        caseRuns.map((c) => ({ id: c.id, caseId: c.caseId, status: c.status })),
        evaluators,
      ),
    };
  }
}
