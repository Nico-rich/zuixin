import { describe, it, expect, vi } from 'vitest';
import { ExperimentsService } from './experiments.service';

/**
 * 实验单测：断言重点 = 状态机不变量、流量切分校验、单一基线不变量。
 * 实验/变体**绝不参与**任何流量路由/权限判定（本服务无此类依赖——结构上不可能）。
 */
function makeHarness(over: {
  experiment?: Record<string, unknown> | null;
  variants?: Array<Record<string, unknown>>;
  runs?: Array<Record<string, unknown>>;
  version?: Record<string, unknown> | null;
} = {}) {
  const experiment = over.experiment === undefined
    ? { id: 'exp1', organizationId: 'org1', name: 'EXP', status: 'draft', hypothesis: null }
    : over.experiment;
  const variants = over.variants ?? [];
  const prisma = {
    experiment: {
      create: vi.fn(async (args: { data: Record<string, unknown> }) => ({ id: 'exp-new', ...args.data })),
      findFirst: vi.fn(async () => (experiment ? { ...experiment, variants } : null)),
      findMany: vi.fn(async () => (experiment ? [{ ...experiment, _count: { variants: variants.length } }] : [])),
      update: vi.fn(async (args: { data: Record<string, unknown> }) => ({ ...experiment, ...args.data })),
      updateMany: vi.fn(async () => ({ count: 1 })),
    },
    experimentVariant: {
      findMany: vi.fn(async () => variants),
      create: vi.fn(async (args: { data: Record<string, unknown> }) => ({ id: 'var-new', ...args.data })),
      updateMany: vi.fn(async () => ({ count: 1 })),
    },
    agentVersion: { findUnique: vi.fn(async () => (over.version === undefined ? { id: 'av1' } : over.version)) },
    evaluationRun: { findMany: vi.fn(async () => over.runs ?? []) },
    evaluationCaseRun: { findMany: vi.fn(async () => []) },
    evaluator: { findMany: vi.fn(async () => []) },
  };
  return { service: new ExperimentsService(prisma as never), prisma, variants };
}

describe('ExperimentsService 状态机', () => {
  it('create → draft；list 返回 variantCount', async () => {
    const h = makeHarness();
    expect(await h.service.create('u1', 'org1', { name: 'EXP' })).toMatchObject({ status: 'draft', organizationId: 'org1', userId: 'u1' });
    const rows = await h.service.list('org1');
    expect(rows[0]).toMatchObject({ id: 'exp1', variantCount: 0 });
  });

  it('合法迁移：draft→running→completed→archived（条件更新携带来源态）', async () => {
    const draft = makeHarness({ experiment: { id: 'exp1', organizationId: 'org1', status: 'draft' } });
    await draft.service.transition('org1', 'exp1', 'running');
    expect(draft.prisma.experiment.updateMany).toHaveBeenCalledWith({ where: { id: 'exp1', organizationId: 'org1', status: 'draft' }, data: { status: 'running' } });

    const running = makeHarness({ experiment: { id: 'exp1', organizationId: 'org1', status: 'running' } });
    await running.service.transition('org1', 'exp1', 'completed');
    expect(running.prisma.experiment.updateMany).toHaveBeenCalledTimes(1);
  });

  it('非法迁移 → 400，且绝不落库（archived 终态不可迁出；draft 不可直接 completed）', async () => {
    const archived = makeHarness({ experiment: { id: 'exp1', organizationId: 'org1', status: 'archived' } });
    await expect(archived.service.transition('org1', 'exp1', 'running')).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    expect(archived.prisma.experiment.updateMany).not.toHaveBeenCalled();

    const draft = makeHarness({ experiment: { id: 'exp1', organizationId: 'org1', status: 'draft' } });
    await expect(draft.service.transition('org1', 'exp1', 'completed')).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    expect(draft.prisma.experiment.updateMany).not.toHaveBeenCalled();
  });

  it('并发迁移（count=0）→ 400（绝不部分改写状态）', async () => {
    const h = makeHarness({ experiment: { id: 'exp1', organizationId: 'org1', status: 'draft' } });
    (h.prisma.experiment.updateMany as ReturnType<typeof vi.fn>).mockResolvedValue({ count: 0 });
    await expect(h.service.transition('org1', 'exp1', 'running')).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });

  it('跨组织/不存在 → 404', async () => {
    const h = makeHarness({ experiment: null });
    await expect(h.service.transition('org1', 'exp1', 'running')).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(h.service.get('org1', 'exp1')).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});

describe('ExperimentsService.addVariant（流量与基线不变量）', () => {
  it('首个变体自动成为基线', async () => {
    const h = makeHarness();
    await h.service.addVariant('org1', 'exp1', { name: 'A', trafficPercent: 50 });
    expect(h.prisma.experimentVariant.create).toHaveBeenCalledWith({
      data: { experimentId: 'exp1', name: 'A', agentId: null, agentVersionId: null, configSnapshot: {}, isBaseline: true, trafficPercent: 50 },
    });
  });

  it('流量之和 > 100% → 400，且不写任何变体', async () => {
    const h = makeHarness({ variants: [{ id: 'v1', isBaseline: true, trafficPercent: 80 }] });
    await expect(h.service.addVariant('org1', 'exp1', { name: 'B', trafficPercent: 30 })).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    expect(h.prisma.experimentVariant.create).not.toHaveBeenCalled();
  });

  it('新增基线变体 → 清除旧基线（单一基线不变量）', async () => {
    const h = makeHarness({ variants: [{ id: 'v1', isBaseline: true, trafficPercent: 10 }] });
    await h.service.addVariant('org1', 'exp1', { name: 'B', isBaseline: true, trafficPercent: 10 });
    expect(h.prisma.experimentVariant.updateMany).toHaveBeenCalledWith({ where: { experimentId: 'exp1', isBaseline: true }, data: { isBaseline: false } });
  });

  it('指定不存在的 Agent 版本 → 404（绝不绑定悬空版本）', async () => {
    const h = makeHarness({ version: null });
    await expect(h.service.addVariant('org1', 'exp1', { name: 'B', agentVersionId: 'av-missing' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(h.prisma.experimentVariant.create).not.toHaveBeenCalled();
  });
});

describe('ExperimentsService.get：变体评测事实（读路径派生）', () => {
  it('按 agentVersionId 聚合最近 ≤5 个已完成 run；无 run → scores=null（不虚构）', async () => {
    const h = makeHarness({
      variants: [
        { id: 'v1', agentVersionId: 'av1', isBaseline: true, trafficPercent: 100, createdAt: new Date(0) },
        { id: 'v2', agentVersionId: null, isBaseline: false, trafficPercent: 0, createdAt: new Date(1) },
      ],
      runs: [{ id: 'run1', createdAt: new Date(0), completedAt: new Date(1), datasetId: 'ds1', datasetVersion: 1 }],
    });
    (h.prisma.evaluationCaseRun.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
      { id: 'cr1', caseId: 'c1', status: 'completed', results: [{ caseRunId: 'cr1', evaluatorId: 'ev1', score: 1, passed: true }] },
    ]);
    const detail = await h.service.get('org1', 'exp1');
    expect(h.prisma.evaluationRun.findMany).toHaveBeenCalledWith({
      where: { organizationId: 'org1', agentVersionId: 'av1', status: 'completed' },
      orderBy: { completedAt: 'desc' },
      take: 5,
      select: { id: true, createdAt: true, completedAt: true, datasetId: true, datasetVersion: true },
    });
    const v1 = detail.variants.find((v) => v.id === 'v1') as { evaluation: { runCount: number; scores: { overall: { passRate: number } } } };
    expect(v1.evaluation.runCount).toBe(1);
    expect(v1.evaluation.scores.overall.passRate).toBe(1);
    // 未绑定 agentVersionId 的变体 → evaluation=null（绝不猜一个版本给它）
    expect((detail.variants.find((v) => v.id === 'v2') as { evaluation: unknown }).evaluation).toBeNull();
  });

  it('无已完成 run → runCount=0 且 scores=null（零事实就说零事实）', async () => {
    const h = makeHarness({ variants: [{ id: 'v1', agentVersionId: 'av1', isBaseline: true, trafficPercent: 0, createdAt: new Date(0) }], runs: [] });
    const detail = await h.service.get('org1', 'exp1');
    expect((detail.variants[0] as unknown as { evaluation: unknown }).evaluation).toEqual({ runCount: 0, runs: [], scores: null });
  });
});
