import { describe, it, expect, vi } from 'vitest';
import { z } from 'zod';
import { EvaluationRunsService, EVALUATION_RUN_CANCEL_CHANNEL } from './evaluation-runs.service';

/**
 * 评测运行服务单测（离线）：断言重点 = **创建即锁定**（datasetVersion/agentVersionId/configSnapshot）、
 * 身份字段全部服务端解析（客户端只能给 id）、排队 payload 仅 {runId}、取消的条件更新语义。
 */

const VERSION = {
  id: 'av1', version: 3, modelId: 'model-1', temperature: 0.7, maxTokens: 256,
  systemPrompt: '系统提示', tools: ['search'],
  agent: { id: 'ag1', slug: 'my-agent', enabled: true, scope: 'organization', organizationId: 'org1' },
};

function makeHarness(over: {
  dataset?: Record<string, unknown>;
  version?: Record<string, unknown> | null;
  baseline?: Record<string, unknown> | null;
  evaluators?: Array<Record<string, unknown>>;
  /** M12-P4：已注册工具名（缺省 = 仅 'search' 注册；用于工具白名单闸门用例） */
  registeredTools?: string[];
} = {}) {
  const dataset = over.dataset ?? { id: 'ds1', organizationId: 'org1', version: 2, cases: [{ id: 'c1', input: '问题一' }, { id: 'c2', input: '问题二' }] };
  const version = over.version === undefined ? VERSION : over.version;
  const registered = over.registeredTools ?? ['search'];
  const prisma = {
    agentVersion: { findUnique: vi.fn(async () => version) },
    evaluationRun: {
      create: vi.fn(async (args: { data: Record<string, unknown> }) => ({ id: 'run1', status: 'pending', totalCases: 2, datasetVersion: 2, ...args.data })),
      findFirst: vi.fn(async (args: { where?: { id?: string } } = {}) => (
        args?.where?.id === 'base1' ? (over.baseline === undefined ? { id: 'base1' } : over.baseline) : { id: 'run1', organizationId: 'org1' }
      )),
      findMany: vi.fn(async () => []),
      findUnique: vi.fn(async () => ({ id: 'run1', organizationId: 'org1' })),
      updateMany: vi.fn(async () => ({ count: 1 })),
    },
    evaluationCaseRun: { createMany: vi.fn(async () => ({ count: 2 })), findMany: vi.fn(async () => []) },
    evaluationResult: { count: vi.fn(async () => 0) },
    evaluator: { findMany: vi.fn(async () => over.evaluators ?? [{ id: 'ev1', name: 'EV', type: 'exact_match' }]) },
  };
  const datasets = { get: vi.fn(async () => dataset), casesOfVersion: vi.fn(async () => []) };
  const evaluators = {
    requireByIds: vi.fn(async (_org: string, ids: string[]) => (over.evaluators === undefined ? ids.map((id) => ({ id, name: 'EV', type: 'exact_match', config: {} })) : over.evaluators)),
  };
  const queue = { name: 'evaluation', add: vi.fn(async () => ({ id: 'job1' })) };
  const events = { publish: vi.fn(async () => undefined) };
  const llmManager = {
    resolve: vi.fn(async () => ({ providerId: 'p1', providerName: 'mock', capabilities: { functionCalling: true } })),
  };
  /**
   * M12-P4 工具注册表桩：只实现评测面用到的两个只读方法（has / listForAgent）。
   * `listForAgent` 只回放已注册工具（**绝不补全**）——与真实 registry 的"未注册即不存在"同口径。
   */
  const TOOL_SCHEMAS: Record<string, z.ZodTypeAny> = {
    search: z.object({ query: z.string() }),
    fetch: z.object({ url: z.string() }),
  };
  const tools = {
    has: vi.fn((name: string) => registered.includes(name)),
    listForAgent: vi.fn((names: string[]) => names
      .filter((n) => registered.includes(n))
      .map((n) => ({ name: n, description: `${n} 工具`, inputSchema: TOOL_SCHEMAS[n] ?? z.object({}) }))),
  };
  const service = new EvaluationRunsService(
    prisma as never, datasets as never, evaluators as never, llmManager as never, tools as never, events as never, queue as never,
  );
  return { service, prisma, datasets, evaluators, queue, events, llmManager, tools };
}

describe('EvaluationRunsService.create（创建即锁定）', () => {
  it('冻结 datasetVersion/agentVersionId/configSnapshot，预建 caseRuns 并入队', async () => {
    const h = makeHarness();
    const out = await h.service.create('u1', 'org1', { datasetId: 'ds1', agentVersionId: 'av1', evaluatorIds: ['ev1'] });
    expect(out).toMatchObject({ runId: 'run1', status: 'pending', totalCases: 2, datasetVersion: 2 });

    const data = (h.prisma.evaluationRun.create.mock.calls[0][0] as { data: Record<string, unknown> }).data;
    const snap = data.configSnapshot as Record<string, unknown>;
    expect(data).toMatchObject({ organizationId: 'org1', userId: 'u1', datasetId: 'ds1', datasetVersion: 2, agentId: 'ag1', agentVersionId: 'av1', status: 'pending', totalCases: 2, completedCases: 0 });
    expect(snap).toMatchObject({
      schema: 1, agentId: 'ag1', agentVersionId: 'av1', agentVersion: 3, agentSlug: 'my-agent',
      modelId: 'model-1', providerId: 'p1', temperature: 0.7, maxTokens: 256,
      systemPrompt: '系统提示', tools: ['search'], evaluatorIds: ['ev1'], datasetId: 'ds1', datasetVersion: 2,
    });
    expect(typeof snap.lockedAt).toBe('string');
    expect(snap).not.toHaveProperty('overrides'); // 未覆盖版本参数 → 不写 overrides 键

    const caseRows = ((h.prisma.evaluationCaseRun.createMany.mock.calls[0] as unknown as [{ data: Array<Record<string, unknown>> }])[0]).data;
    expect(caseRows).toEqual([
      { runId: 'run1', caseId: 'c1', status: 'pending', input: '问题一' },
      { runId: 'run1', caseId: 'c2', status: 'pending', input: '问题二' },
    ]);
  });

  it('排队 payload 仅 {runId}（身份/参数一律由 DB 快照裁决），jobId 不含冒号', async () => {
    const h = makeHarness();
    await h.service.create('u1', 'org1', { datasetId: 'ds1', agentVersionId: 'av1' });
    expect(h.queue.add).toHaveBeenCalledTimes(1);
    const [name, payload, opts] = h.queue.add.mock.calls[0] as unknown as [string, Record<string, unknown>, Record<string, unknown>];
    expect(name).toBe('execute');
    expect(payload).toEqual({ runId: 'run1' });
    expect(String(opts.jobId)).toBe('eval-run1');
    expect(String(opts.jobId)).not.toContain(':');
    expect(opts.attempts).toBe(2);
  });

  it('显式覆盖参数（modelId/temperature/maxTokens）→ 记入 overrides（审计可见"这次为什么和版本不同"）', async () => {
    const h = makeHarness();
    await h.service.create('u1', 'org1', { datasetId: 'ds1', agentVersionId: 'av1', modelId: 'model-9', temperature: 0, maxTokens: 64 });
    const snap = (h.prisma.evaluationRun.create.mock.calls[0][0] as { data: { configSnapshot: Record<string, unknown> } }).data.configSnapshot;
    expect(snap).toMatchObject({ modelId: 'model-9', temperature: 0, maxTokens: 64, overrides: { modelId: 'model-9', temperature: 0, maxTokens: 64 } });
  });

  it('数据集当前版本无用例 → 400，绝不创建空 run、绝不入队', async () => {
    const h = makeHarness({ dataset: { id: 'ds1', organizationId: 'org1', version: 1, cases: [] } });
    await expect(h.service.create('u1', 'org1', { datasetId: 'ds1', agentVersionId: 'av1' })).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    expect(h.prisma.evaluationRun.create).not.toHaveBeenCalled();
    expect(h.queue.add).not.toHaveBeenCalled();
  });

  it('Agent 版本不存在 / 已停用 / 跨组织 → 404（防枚举，绝不透露存在性）', async () => {
    await expect(makeHarness({ version: null }).service.create('u1', 'org1', { datasetId: 'ds1', agentVersionId: 'av1' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    const disabled = makeHarness({ version: { ...VERSION, agent: { ...VERSION.agent, enabled: false } } });
    await expect(disabled.service.create('u1', 'org1', { datasetId: 'ds1', agentVersionId: 'av1' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    const crossOrg = makeHarness({ version: { ...VERSION, agent: { ...VERSION.agent, organizationId: 'org-other' } } });
    await expect(crossOrg.service.create('u1', 'org1', { datasetId: 'ds1', agentVersionId: 'av1' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(crossOrg.queue.add).not.toHaveBeenCalled();
  });

  it('不可评测的 Agent 作用域（如 personal）→ 400 拒绝', async () => {
    const h = makeHarness({ version: { ...VERSION, agent: { ...VERSION.agent, scope: 'personal' } } });
    await expect(h.service.create('u1', 'org1', { datasetId: 'ds1', agentVersionId: 'av1' })).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });

  it('评测器绑定：跨组织/不存在 → 404，绝不静默丢弃', async () => {
    const h = makeHarness();
    h.evaluators.requireByIds.mockRejectedValueOnce(Object.assign(new Error('评测器不存在或不属于该组织'), { code: 'NOT_FOUND' }));
    await expect(h.service.create('u1', 'org1', { datasetId: 'ds1', agentVersionId: 'av1', evaluatorIds: ['ev-x'] })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(h.prisma.evaluationRun.create).not.toHaveBeenCalled();
  });

  it('基线 run 必须同组织存在（跨组织 → 404）', async () => {
    const h = makeHarness({ baseline: null });
    await expect(h.service.create('u1', 'org1', { datasetId: 'ds1', agentVersionId: 'av1', baselineRunId: 'base1' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(h.prisma.evaluationRun.findFirst).toHaveBeenCalledWith({ where: { id: 'base1', organizationId: 'org1' }, select: { id: true } });
  });

  it('provider 解析失败不阻断创建（快照 provider 记 null；执行期显式失败）', async () => {
    const h = makeHarness();
    h.llmManager.resolve.mockRejectedValueOnce(new Error('no provider'));
    await h.service.create('u1', 'org1', { datasetId: 'ds1', agentVersionId: 'av1' });
    const snap = (h.prisma.evaluationRun.create.mock.calls[0][0] as { data: { configSnapshot: Record<string, unknown> } }).data.configSnapshot;
    expect(snap).toMatchObject({ modelId: 'model-1', providerId: null, providerName: null });
  });
});

/**
 * M12-P4 评测工具能力（创建期裁决 + 快照冻结）。
 * 红线：工具**只声明不执行**（runner 无 ToolRegistry——结构上不可能执行）；缺省 `[]` = M9 行为逐字节不变；
 * 三条闸门任一不过 → 400，**绝不静默降级**（降级 = 评测结论失真）。
 */
describe('EvaluationRunsService.create：M12-P4 工具白名单（只声明不执行）', () => {
  const snapOf = (h: ReturnType<typeof makeHarness>) =>
    (h.prisma.evaluationRun.create.mock.calls[0][0] as { data: { configSnapshot: Record<string, unknown> } }).data.configSnapshot;

  it('缺省（不传 tools）→ evaluationTools=[] 且**不写** toolDefinitions 键（M9 行为逐字节不变）', async () => {
    const h = makeHarness();
    await h.service.create('u1', 'org1', { datasetId: 'ds1', agentVersionId: 'av1' });
    const snap = snapOf(h);
    expect(snap).toMatchObject({ tools: ['search'], evaluationTools: [] });
    expect(snap).not.toHaveProperty('toolDefinitions');
  });

  it('合法子集 → 冻结 wire 定义（type/function.name/parameters）到快照，evaluationTools ⊆ 版本 tools', async () => {
    const h = makeHarness({ version: { ...VERSION, tools: ['search', 'fetch'] } });
    await h.service.create('u1', 'org1', { datasetId: 'ds1', agentVersionId: 'av1', tools: ['search'] });
    const snap = snapOf(h);
    expect(snap).toMatchObject({ tools: ['search', 'fetch'], evaluationTools: ['search'] });
    const defs = snap.toolDefinitions as Array<Record<string, unknown>>;
    expect(defs).toHaveLength(1);
    expect(defs[0]).toMatchObject({ type: 'function', function: { name: 'search', description: 'search 工具', parameters: { type: 'object' } } });
  });

  it('重复声明去重（同一工具只下发一次）', async () => {
    const h = makeHarness();
    await h.service.create('u1', 'org1', { datasetId: 'ds1', agentVersionId: 'av1', tools: ['search', 'search'] });
    expect(snapOf(h)).toMatchObject({ evaluationTools: ['search'] });
    expect((snapOf(h).toolDefinitions as unknown[])).toHaveLength(1);
  });

  it('越权工具（不在 AgentVersion.tools 内）→ 400，绝不创建 run、绝不入队', async () => {
    const h = makeHarness({ version: { ...VERSION, tools: ['search'] } });
    await expect(h.service.create('u1', 'org1', { datasetId: 'ds1', agentVersionId: 'av1', tools: ['fetch'] }))
      .rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    expect(h.prisma.evaluationRun.create).not.toHaveBeenCalled();
    expect(h.queue.add).not.toHaveBeenCalled();
  });

  it('未注册工具（在版本清单内但 registry 无此注册）→ 400（绝不"丢弃后照样跑"）', async () => {
    const h = makeHarness({ version: { ...VERSION, tools: ['search', 'fetch'] }, registeredTools: ['search'] });
    await expect(h.service.create('u1', 'org1', { datasetId: 'ds1', agentVersionId: 'av1', tools: ['fetch'] }))
      .rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    expect(h.prisma.evaluationRun.create).not.toHaveBeenCalled();
  });

  it('模型声明 functionCalling=false → 400 UNSUPPORTED_PARAMETER（悄悄不下发 = 评测失真，故显式拒绝）', async () => {
    const h = makeHarness();
    h.llmManager.resolve.mockResolvedValueOnce({ providerId: 'p1', providerName: 'mock', capabilities: { functionCalling: false } } as never);
    await expect(h.service.create('u1', 'org1', { datasetId: 'ds1', agentVersionId: 'av1', tools: ['search'] }))
      .rejects.toMatchObject({ code: 'UNSUPPORTED_PARAMETER' });
    expect(h.prisma.evaluationRun.create).not.toHaveBeenCalled();
  });

  it('能力声明缺失（provider 解析失败）→ 创建期放行，交执行期能力闸门兜底', async () => {
    const h = makeHarness();
    h.llmManager.resolve.mockRejectedValueOnce(new Error('no provider'));
    await h.service.create('u1', 'org1', { datasetId: 'ds1', agentVersionId: 'av1', tools: ['search'] });
    expect(snapOf(h)).toMatchObject({ providerId: null, evaluationTools: ['search'] });
  });

  it('AgentVersion.tools 为空（null）→ 任何工具声明都是越权 → 400', async () => {
    const h = makeHarness({ version: { ...VERSION, tools: null } });
    await expect(h.service.create('u1', 'org1', { datasetId: 'ds1', agentVersionId: 'av1', tools: ['search'] }))
      .rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });
});

describe('EvaluationRunsService.cancel / 读路径', () => {
  it('cancel：条件更新 pending|running → cancelled，并发布 fast-path 提示', async () => {
    const h = makeHarness();
    expect(await h.service.cancel('org1', 'run1')).toEqual({ runId: 'run1', status: 'cancelled' });
    expect(h.prisma.evaluationRun.updateMany).toHaveBeenCalledWith({
      where: { id: 'run1', organizationId: 'org1', status: { in: ['pending', 'running'] } },
      data: { status: 'cancelled', completedAt: expect.any(Date) },
    });
    expect(h.events.publish).toHaveBeenCalledWith(EVALUATION_RUN_CANCEL_CHANNEL, { runId: 'run1' });
  });

  it('cancel：已终态（count=0）→ 409 RUN_NOT_CANCELLABLE，且不发提示（终态绝不重开）', async () => {
    const h = makeHarness();
    (h.prisma.evaluationRun.updateMany as ReturnType<typeof vi.fn>).mockResolvedValue({ count: 0 });
    await expect(h.service.cancel('org1', 'run1')).rejects.toMatchObject({ code: 'RUN_NOT_CANCELLABLE' });
    expect(h.events.publish).not.toHaveBeenCalled();
  });

  it('cancel：跨组织 → 404（既不取消也不发提示）', async () => {
    const h = makeHarness();
    (h.prisma.evaluationRun.findFirst as ReturnType<typeof vi.fn>).mockResolvedValueOnce(null);
    await expect(h.service.cancel('org-other', 'run1')).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(h.prisma.evaluationRun.updateMany).not.toHaveBeenCalled();
  });

  it('comparison：无基线 → null（不伪造对照）', async () => {
    const h = makeHarness();
    (h.prisma.evaluationRun.findFirst as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ id: 'run1', organizationId: 'org1', baselineRunId: null });
    expect(await h.service.comparison('org1', 'run1')).toBeNull();
  });

  it('comparison：数据集版本不同 → comparable=false（绝不伪造可比性），case 取两侧并集', async () => {
    const h = makeHarness();
    (h.prisma.evaluationRun.findFirst as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({ id: 'run2', organizationId: 'org1', baselineRunId: 'base1', datasetVersion: 2, configSnapshot: { evaluatorIds: ['ev1'] } })
      .mockResolvedValueOnce({ id: 'base1', datasetId: 'ds1', datasetVersion: 1 });
    (h.prisma.evaluationCaseRun.findMany as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce([{ id: 'b1', caseId: 'c1', status: 'completed', results: [{ caseRunId: 'b1', evaluatorId: 'ev1', score: 1, passed: true }] }])
      .mockResolvedValueOnce([
        { id: 'k1', caseId: 'c1', status: 'completed', results: [{ caseRunId: 'k1', evaluatorId: 'ev1', score: 0, passed: false }] },
        { id: 'k2', caseId: 'c2', status: 'completed', results: [{ caseRunId: 'k2', evaluatorId: 'ev1', score: 1, passed: true }] },
      ]);
    const cmp = await h.service.comparison('org1', 'run2');
    expect(cmp).toMatchObject({ candidateRunId: 'run2', baselineRunId: 'base1', comparable: false });
    expect(cmp!.summary).toMatchObject({ regressed: 1, added: 1 });
  });
});
