import { describe, it, expect, vi } from 'vitest';
import { ExperimentsService } from './experiments.service';

/**
 * 实验单测：断言重点 = 状态机不变量、流量切分校验、单一基线不变量。
 * 实验/变体**绝不参与**任何流量路由/权限判定（本服务无此类依赖——结构上不可能）。
 *
 * M12-P4 增补：受控晋级（平台管理员闸门 + 结论 CAS + 目标白名单 + **流量恒不变**）。
 */
function makeHarness(over: {
  experiment?: Record<string, unknown> | null;
  variants?: Array<Record<string, unknown>>;
  runs?: Array<Record<string, unknown>>;
  version?: Record<string, unknown> | null;
  /** 平台管理员 ID 集合（M12-P4 晋级闸门；缺省仅 'admin1'） */
  admins?: string[];
  /** 受控键白名单裁决桩：返回 Error 表示校验失败 */
  validateError?: Error;
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
    // M10-P15（BUG-3）：变体绑定走**归属谓词**（本组织 ∨ 系统级），不再全局 findUnique。
    // 单测不模拟谓词求值，只回放 `over.version`；谓词本身在下方专门用例中断言。
    agentVersion: { findFirst: vi.fn(async (_args?: unknown) => (over.version === undefined ? { id: 'av1' } : over.version)) },
    evaluationRun: { findMany: vi.fn(async () => over.runs ?? []) },
    evaluationCaseRun: { findMany: vi.fn(async () => []) },
    evaluator: { findMany: vi.fn(async () => []) },
    user: { findUnique: vi.fn(async (args: { where: { id: string } }) => ({ id: args.where.id, role: (over.admins ?? ['admin1']).includes(args.where.id) ? 'admin' : 'user' })) },
  };
  /**
   * SystemSettingsService 桩（M12-P4）：只回放三件事——管理员闸门、受控键校验、写入（含审计 action 透传）。
   * 真实白名单/值校验由 system-settings.service.spec + e2e 锁死；此处只验证**调用契约**。
   */
  const settings = {
    isPlatformAdmin: vi.fn(async (userId: string) => (over.admins ?? ['admin1']).includes(userId)),
    assertPlatformAdmin: vi.fn(async (userId: string) => {
      if (!(over.admins ?? ['admin1']).includes(userId)) {
        throw Object.assign(new Error('系统策略设置仅平台管理员可访问'), { code: 'FORBIDDEN' });
      }
    }),
    validatePatch: vi.fn((_key: string, _value: unknown) => {
      if (over.validateError) throw over.validateError;
    }),
    patch: vi.fn(async (_userId: string, key: string, value: Record<string, unknown>) => ({ key, value })),
  };
  return { service: new ExperimentsService(prisma as never, settings as never), prisma, settings, variants };
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

  it('M10-P15：agentVersionId 查询必须带归属谓词（本组织 ∨ 系统级）——跨租户版本与悬空版本同为 404', async () => {
    const h = makeHarness();
    await h.service.addVariant('org1', 'exp1', { name: 'B', agentVersionId: 'av1' });
    const arg = (h.prisma.agentVersion.findFirst as ReturnType<typeof vi.fn>).mock.calls[0][0] as { where: Record<string, unknown> };
    expect(arg.where).toEqual({ id: 'av1', agent: { OR: [{ organizationId: 'org1' }, { scope: 'system' }] } });
    // 与 EvaluationRunsService 同一可见性口径：系统级版本（平台目录）必须放行
    expect(arg.where.agent).toMatchObject({ OR: expect.arrayContaining([{ scope: 'system' }]) });
  });

  it('M12-P4：声明了晋级目标 → 创建期即按受控键白名单校验（合法则原样落库）', async () => {
    const h = makeHarness();
    await h.service.addVariant('org1', 'exp1', {
      name: 'B',
      configSnapshot: { promotion: { key: 'routingPolicy', value: { confidenceThreshold: 0.5 } } },
    });
    expect(h.settings.validatePatch).toHaveBeenCalledWith('routingPolicy', { confidenceThreshold: 0.5 });
    expect(h.prisma.experimentVariant.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ configSnapshot: { promotion: { key: 'routingPolicy', value: { confidenceThreshold: 0.5 } } } }),
    }));
  });

  it('M12-P4：晋级目标非法（越权键/非法值）→ 400，且**绝不落库**（无效目标绝不进快照等着以后再说）', async () => {
    const h = makeHarness({ validateError: Object.assign(new Error('受控键不存在: quota'), { code: 'VALIDATION_ERROR' }) });
    await expect(h.service.addVariant('org1', 'exp1', {
      name: 'B',
      configSnapshot: { promotion: { key: 'quota', value: { x: 1 } } },
    })).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    expect(h.prisma.experimentVariant.create).not.toHaveBeenCalled();
  });

  it('M12-P4：无 promotion 声明 / 形状不符 → 不触发校验（configSnapshot 是自由备注，绝不猜测语义）', async () => {
    const h = makeHarness();
    await h.service.addVariant('org1', 'exp1', { name: 'B', configSnapshot: { note: '随便记一笔' } });
    expect(h.settings.validatePatch).not.toHaveBeenCalled();
    await h.service.addVariant('org1', 'exp1', { name: 'C', configSnapshot: { promotion: { key: 'routingPolicy' } } });
    expect(h.settings.validatePatch).not.toHaveBeenCalled();
  });
});

/**
 * M12-P4 受控晋级：实验结论 → **平台管理员人工确认** → 受控策略键。
 * 红线：LLM/实验/组织成员无写路径；流量分配绝不因晋级改变（trafficPercent 恒不变）。
 */
describe('ExperimentsService 受控晋级（promotionProposal / promote）', () => {
  /** 变体 + 每变体按 agentVersionId 的事实（run 事实经 summarizeScores 聚合） */
  function promoteHarness(over: { status?: string; winnerIsBaseline?: boolean; withTarget?: boolean; ops?: boolean } = {}) {
    const withTarget = over.withTarget ?? true;
    const variants = [
      { id: 'v-base', name: '基线', isBaseline: true, agentVersionId: 'av-base', trafficPercent: 50, configSnapshot: {} },
      {
        id: 'v-cand',
        name: '候选',
        isBaseline: over.winnerIsBaseline ?? false,
        agentVersionId: 'av-cand',
        trafficPercent: 50,
        configSnapshot: withTarget ? { promotion: { key: 'routingPolicy', value: { confidenceThreshold: 0.42 } } } : { note: '未声明目标' },
      },
    ];
    const h = makeHarness({
      experiment: { id: 'exp1', organizationId: 'org1', name: 'EXP', status: over.status ?? 'completed' },
      variants,
    });
    const scoreRow = (score: number, passed: boolean) => [{ id: 'cr1', caseId: 'c1', status: 'completed', results: [{ caseRunId: 'cr1', evaluatorId: 'ev1', score, passed }] }];
    const runsByVersion: Record<string, Array<Record<string, unknown>>> = over.ops === false
      ? { 'av-base': [], 'av-cand': [] }
      : {
          'av-base': [{ id: 'run-b', createdAt: new Date(0), completedAt: new Date(1), datasetId: 'ds1', datasetVersion: 1 }],
          'av-cand': [{ id: 'run-c', createdAt: new Date(0), completedAt: new Date(2), datasetId: 'ds1', datasetVersion: 1 }],
        };
    (h.prisma.evaluationRun.findMany as ReturnType<typeof vi.fn>)
      .mockImplementation(async (args: { where: { agentVersionId: string } }) => runsByVersion[args.where.agentVersionId] ?? []);
    (h.prisma.evaluationCaseRun.findMany as ReturnType<typeof vi.fn>)
      .mockImplementation(async (args: { where: { runId: { in: string[] } } }) => {
        const runId = args.where.runId.in[0];
        return runId === 'run-c' ? scoreRow(1, true) : scoreRow(0.4, false);
      });
    return h;
  }

  it('无已完成评测事实 → insufficient_evidence（绝不拿零样本当结论），无可确认指纹', async () => {
    const h = promoteHarness({ ops: false });
    const p = await h.service.promotionProposal('org1', 'exp1');
    expect(p).toMatchObject({ status: 'insufficient_evidence', proposalHash: null, winner: null, target: null });
    expect(p.evidence).toHaveLength(2);
    expect(p.evidence.every((e) => e.runCount === 0 && e.evaluated === 0)).toBe(true);
  });

  it('候选胜出 + 声明目标 → candidate：确定性指纹（64 位十六进制）+ 服务端人读结论（无 LLM 文本）', async () => {
    const h = promoteHarness();
    const p = await h.service.promotionProposal('org1', 'exp1');
    expect(p).toMatchObject({
      status: 'candidate',
      winner: { variantId: 'v-cand', name: '候选', agentVersionId: 'av-cand' },
      baseline: { variantId: 'v-base', name: '基线' },
      target: { key: 'routingPolicy', value: { confidenceThreshold: 0.42 } },
    });
    expect(p.proposalHash).toMatch(/^[0-9a-f]{64}$/);
    expect(p.reason).toContain('待平台管理员确认');
    expect(p.evidence.find((e) => e.variantId === 'v-cand')).toMatchObject({ avgScore: 1, passRate: 1, evaluated: 1 });
    // 只读：结论生成绝不写任何行
    expect(h.prisma.experiment.update).not.toHaveBeenCalled();
    expect(h.prisma.experimentVariant.create).not.toHaveBeenCalled();
  });

  it('候选胜出但未声明受控目标 → no_target（绝不臆造写键）', async () => {
    const h = promoteHarness({ withTarget: false });
    const p = await h.service.promotionProposal('org1', 'exp1');
    expect(p).toMatchObject({ status: 'no_target', target: null, proposalHash: null });
    expect(p.winner).toMatchObject({ variantId: 'v-cand' });
  });

  it('非平台管理员确认 → 403 FORBIDDEN，且**零副作用**（不写策略键、不写实验行）', async () => {
    const h = promoteHarness();
    const proposal = await h.service.promotionProposal('org1', 'exp1');
    await expect(h.service.promote('u1', 'org1', 'exp1', { proposalHash: proposal.proposalHash! }))
      .rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(h.settings.patch).not.toHaveBeenCalled();
    expect(h.prisma.experiment.update).not.toHaveBeenCalled();
    expect(h.prisma.experimentVariant.updateMany).not.toHaveBeenCalled();
  });

  it('管理员确认 → 走 SystemSettings.patch（action=experiment.promotion + 审计元数据），流量百分比一行未动', async () => {
    const h = promoteHarness();
    const proposal = await h.service.promotionProposal('org1', 'exp1');
    const out = await h.service.promote('admin1', 'org1', 'exp1', { proposalHash: proposal.proposalHash!, reason: '评测事实胜出' });
    expect(h.settings.patch).toHaveBeenCalledWith('admin1', 'routingPolicy', { confidenceThreshold: 0.42 }, {
      action: 'experiment.promotion',
      metadata: {
        experimentId: 'exp1',
        variantId: 'v-cand',
        proposalHash: proposal.proposalHash,
        reason: '评测事实胜出',
      },
    });
    expect(out).toMatchObject({
      experimentId: 'exp1',
      key: 'routingPolicy',
      value: { confidenceThreshold: 0.42 },
      trafficUnchanged: true,
      proposalHash: proposal.proposalHash,
    });
    // **红线**：晋级绝不写实验/变体表（trafficPercent 恒不变；谁都不自动切流）
    expect(h.prisma.experiment.update).not.toHaveBeenCalled();
    expect(h.prisma.experiment.updateMany).not.toHaveBeenCalled();
    expect(h.prisma.experimentVariant.updateMany).not.toHaveBeenCalled();
    expect(h.prisma.experimentVariant.create).not.toHaveBeenCalled();
  });

  it('陈旧指纹（事实/目标已变）→ 400，绝不写入（CAS 把"看到的结论"与"确认时的事实"钉在一起）', async () => {
    const h = promoteHarness();
    const proposal = await h.service.promotionProposal('org1', 'exp1');
    const stale = `${'0'.repeat(63)}1`;
    expect(stale).not.toBe(proposal.proposalHash);
    await expect(h.service.promote('admin1', 'org1', 'exp1', { proposalHash: stale }))
      .rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    expect(h.settings.patch).not.toHaveBeenCalled();
  });

  it('未完成（draft/running）的实验 → 400（结论未定，绝不提前晋级）', async () => {
    const h = promoteHarness({ status: 'running' });
    const proposal = await h.service.promotionProposal('org1', 'exp1');
    await expect(h.service.promote('admin1', 'org1', 'exp1', { proposalHash: proposal.proposalHash! }))
      .rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    expect(h.settings.patch).not.toHaveBeenCalled();
  });

  it('跨组织/不存在的实验 → 404（晋级面同样防枚举）', async () => {
    const h = makeHarness({ experiment: null });
    await expect(h.service.promotionProposal('org1', 'exp1')).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(h.service.promote('admin1', 'org1', 'exp1', { proposalHash: 'a'.repeat(64) }))
      .rejects.toMatchObject({ code: 'NOT_FOUND' });
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
