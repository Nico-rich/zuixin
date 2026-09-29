import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EvaluationRunnerService, buildUserContent } from './evaluation-runner.service';
import { LLMChunk } from '../../../providers/llm/llm.types';

/**
 * Runner 单测（离线）：LLM 抽象以假 adapter 注入——绝不联网、绝不落库。
 * 断言重点：幂等 claim / 单 case 失败隔离 / judge 只进 EvaluationResult / 用量 best-effort。
 */

const SNAPSHOT = {
  schema: 1, lockedAt: '2026-09-28T00:00:00.000Z', agentId: 'ag1', agentVersionId: 'av1',
  agentVersion: 1, agentSlug: 'a', modelId: 'model-1', providerId: 'p1', providerName: 'mock',
  temperature: 0.2, maxTokens: 128, systemPrompt: '你是助手', tools: [],
  evaluatorIds: ['ev1'], datasetId: 'ds1', datasetVersion: 1,
};

interface Harness {
  runner: EvaluationRunnerService;
  state: {
    runStatus: string;
    caseStatus: Map<string, string>;
    upserts: Array<Record<string, unknown>>;
    caseUpdates: Array<Record<string, unknown>>;
    runUpdates: Array<Record<string, unknown>>;
    usage: Array<Record<string, unknown>>;
  };
  prisma: Record<string, unknown>;
  streamCalls: Array<Record<string, unknown>>;
  chatCalls: Array<Record<string, unknown>>;
  adapter: { chat: ReturnType<typeof vi.fn> };
}

function harness(opts: {
  caseRuns?: Array<{ id: string; caseId: string; input: unknown }>;
  cases?: Array<{ id: string; input: unknown; expected: unknown }>;
  evaluators?: Array<{ id: string; name: string; type: string; config: unknown }>;
  chunks?: (userContent: string, index: number) => LLMChunk[];
  judgeReply?: string;
  streamError?: Error | null;
  claimRun?: boolean;
  caseClaim?: boolean;
  usageRejects?: boolean;
  onStream?: (userContent: string, index: number) => void;
  /** M12-P4：快照附加字段（如 evaluationTools/toolDefinitions——冻结的工具声明） */
  snapshotExtra?: Record<string, unknown>;
  /** M12-P4：目标模型声明的能力（能力闸门用） */
  capabilities?: Record<string, unknown>;
} = {}): Harness {
  const caseRuns = opts.caseRuns ?? [
    { id: 'cr1', caseId: 'c1', input: '问题一' },
    { id: 'cr2', caseId: 'c2', input: '问题二' },
  ];
  const cases = opts.cases ?? [
    { id: 'c1', input: '问题一', expected: '答案' },
    { id: 'c2', input: '问题二', expected: '答案' },
  ];
  const state = {
    runStatus: 'pending',
    caseStatus: new Map<string, string>(caseRuns.map((c) => [c.id, 'pending'])),
    upserts: [] as Array<Record<string, unknown>>,
    caseUpdates: [] as Array<Record<string, unknown>>,
    runUpdates: [] as Array<Record<string, unknown>>,
    usage: [] as Array<Record<string, unknown>>,
  };
  const streamCalls: Array<Record<string, unknown>> = [];
  const chatCalls: Array<Record<string, unknown>> = [];

  const prisma = {
    evaluationRun: {
      findUnique: vi.fn(async (args: { include?: unknown; select?: unknown }) => {
        if (!args?.include) return { status: state.runStatus };
        return {
          id: 'run1', organizationId: 'org1', userId: 'u1', datasetId: 'ds1', datasetVersion: 1,
          status: state.runStatus, configSnapshot: { ...SNAPSHOT, ...opts.snapshotExtra }, caseRuns,
        };
      }),
      updateMany: vi.fn(async (args: { where: { status?: string }; data: Record<string, unknown> }) => {
        if (opts.claimRun === false && args.data.status === 'running') return { count: 0 };
        if (args.where.status && state.runStatus !== args.where.status) return { count: 0 };
        state.runUpdates.push(args.data);
        if (typeof args.data.status === 'string') state.runStatus = args.data.status;
        return { count: 1 };
      }),
      update: vi.fn(async () => ({})),
    },
    evaluationCaseRun: {
      findMany: vi.fn(async () => caseRuns),
      updateMany: vi.fn(async (args: { where: { id?: string; status?: unknown }; data: Record<string, unknown> }) => {
        state.caseUpdates.push({ ...args.where, ...args.data });
        const wanted = (status: unknown): ((s: string) => boolean) => {
          if (status === undefined) return () => true;
          if (typeof status === 'string') return (s) => s === status;
          const inList = (status as { in?: string[] }).in ?? [];
          return (s) => inList.includes(s);
        };
        const match = wanted(args.where.status);
        const targets = args.where.id ? [args.where.id] : [...state.caseStatus.keys()];
        let count = 0;
        for (const id of targets) {
          if (!match(state.caseStatus.get(id) ?? '')) continue;
          if (opts.caseClaim === false && args.data.status === 'running') continue;
          if (typeof args.data.status === 'string') state.caseStatus.set(id, args.data.status);
          count++;
        }
        return { count };
      }),
      count: vi.fn(async (args: { where: { status?: { in?: string[] } } }) => {
        const wanted = args.where.status?.in ?? [...new Set(state.caseStatus.values())];
        return [...state.caseStatus.values()].filter((s) => wanted.includes(s)).length;
      }),
    },
    evaluationResult: {
      count: vi.fn(async () => state.upserts.length),
      upsert: vi.fn(async (args: { create: Record<string, unknown> }) => {
        const existing = state.upserts.find((u) => u.caseRunId === args.create.caseRunId && u.evaluatorId === args.create.evaluatorId);
        if (existing) return Object.assign(existing, args.create);
        state.upserts.push(args.create);
        return args.create;
      }),
    },
    evaluationCase: { findMany: vi.fn(async () => cases) },
    evaluator: { findMany: vi.fn(async () => opts.evaluators ?? [{ id: 'ev1', name: '精确匹配', type: 'exact_match', config: {} }]) },
    model: { findUnique: vi.fn(async () => ({ inputPrice: 1, outputPrice: 2 })) },
  };

  let callIndex = 0;
  const adapter = {
    async *stream(params: Record<string, unknown>) {
      streamCalls.push(params);
      const userContent = String((params.messages as Array<{ content: string }>).at(-1)?.content ?? '');
      const index = callIndex++;
      opts.onStream?.(userContent, index);
      if (opts.streamError) throw opts.streamError;
      const chunks = opts.chunks?.(userContent, index)
        ?? [{ type: 'text', text: '答案' }, { type: 'usage', usage: { inputTokens: 10, outputTokens: 20 } }];
      for (const c of chunks as LLMChunk[]) yield c;
    },
    chat: vi.fn(async (params: Record<string, unknown>) => {
      chatCalls.push(params);
      return { content: opts.judgeReply ?? '{"score": 0.9}' };
    }),
  };
  const resolved = {
    providerId: 'p1', providerName: 'mock', modelId: 'model-1', apiModelId: 'mock-echo',
    adapter, timeoutMs: 1000, capabilities: { ...(opts.capabilities ?? {}) },
  };
  const runner = new EvaluationRunnerService(
    prisma as never,
    { resolve: vi.fn(async () => resolved) } as never,
    { resolveDefaultLLM: vi.fn(async () => resolved) } as never,
    {
      recordChatUsage: vi.fn(async (input: Record<string, unknown>) => {
        state.usage.push(input);
        if (opts.usageRejects) throw new Error('billing down');
        return input;
      }),
    } as never,
  );
  return { runner, state, prisma, streamCalls, chatCalls, adapter };
}

let warn: ReturnType<typeof vi.spyOn>;
beforeEach(() => { warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined); });
afterEach(() => { warn.mockRestore(); });

describe('EvaluationRunnerService.executeRun（幂等与终态）', () => {
  it('run 不存在 → 不 claim、不写任何行', async () => {
    const h = harness();
    (h.prisma.evaluationRun as { findUnique: unknown }).findUnique = vi.fn(async () => null);
    const outcome = await h.runner.executeRun('nope');
    expect(outcome).toMatchObject({ claimed: false, status: 'missing', completedCases: 0, results: 0 });
    expect(h.state.runUpdates).toHaveLength(0);
  });

  it('并发/重复投递：run 已被 claim（pending→running count=0）→ 只读返回，绝不复跑 case', async () => {
    const h = harness({ claimRun: false });
    const outcome = await h.runner.executeRun('run1');
    expect(outcome.claimed).toBe(false);
    expect(h.streamCalls).toHaveLength(0);
    expect(h.state.upserts).toHaveLength(0);
  });

  it('happy path：逐 case 执行 → 采集 output/tokens/cost → 评测落结果 → run completed', async () => {
    const h = harness();
    const outcome = await h.runner.executeRun('run1');
    expect(outcome).toMatchObject({ claimed: true, status: 'completed', completedCases: 2, failedCases: 0, results: 2 });
    expect(h.streamCalls).toHaveLength(2);
    // 锁定参数如实下传；且绝不传 tools（评测不产生副作用）
    expect(h.streamCalls[0]).toMatchObject({ model: 'mock-echo', temperature: 0.2, maxTokens: 128 });
    expect(h.streamCalls[0].tools).toBeUndefined();
    // case 事实落库：output/latency/tokens/cost（cost 经既有唯一计价点）
    const completed = h.state.caseUpdates.filter((u) => u.status === 'completed');
    expect(completed).toHaveLength(2);
    expect(completed[0]).toMatchObject({ promptTokens: 10, completionTokens: 20, cost: 0.00005, output: { text: '答案' } });
    // 结果行：唯一键 upsert，score/passed 来自 evaluator
    expect(h.state.upserts).toHaveLength(2);
    expect(h.state.upserts[0]).toMatchObject({ caseRunId: 'cr1', evaluatorId: 'ev1', passed: true, score: 1 });
    expect(h.state.runStatus).toBe('completed');
    expect(h.state.runUpdates.at(-1)).toHaveProperty('completedAt');
  });

  it('系统提示词按快照下发；user 消息由 case.input 归一', async () => {
    const h = harness();
    await h.runner.executeRun('run1');
    expect(h.streamCalls[0].messages).toEqual([
      { role: 'system', content: '你是助手' },
      { role: 'user', content: '问题一' },
    ]);
  });

  it('目标模型解析失败 → 未完成 case 标 failed，run failed（绝不静默"完成零结果"）', async () => {
    const h = harness();
    const failing = new EvaluationRunnerService(
      h.prisma as never,
      { resolve: vi.fn(async () => { throw Object.assign(new Error('no provider'), { code: 'PROVIDER_NOT_FOUND' }); }) } as never,
      { resolveDefaultLLM: vi.fn(async () => { throw new Error('no provider'); }) } as never,
      { recordChatUsage: vi.fn() } as never,
    );
    const outcome = await failing.executeRun('run1');
    expect(outcome).toMatchObject({ claimed: true, status: 'failed', results: 0 });
    expect([...h.state.caseStatus.values()]).toEqual(['failed', 'failed']);
    expect(h.state.caseUpdates[0].errorCode).toBe('PROVIDER_NOT_FOUND');
    expect(h.state.runStatus).toBe('failed');
  });

  it('case 级 claim 失败（已被处理过）→ 跳过，不重复执行、不重复写事实', async () => {
    const h = harness({ caseClaim: false });
    const outcome = await h.runner.executeRun('run1');
    expect(outcome).toMatchObject({ completedCases: 0, results: 0 });
    expect(h.streamCalls).toHaveLength(0);
    expect(h.state.upserts).toHaveLength(0);
  });

  it('单 case 执行失败 → 该 case 标 failed（含 errorCode），其余 case 继续（失败隔离）', async () => {
    const h = harness({ streamError: Object.assign(new Error('boom'), { code: 'UPSTREAM_ERROR' }) });
    const outcome = await h.runner.executeRun('run1');
    expect(outcome).toMatchObject({ completedCases: 0, failedCases: 2, results: 0 });
    const failed = h.state.caseUpdates.filter((u) => u.status === 'failed');
    expect(failed).toHaveLength(2);
    expect(failed[0]).toMatchObject({ errorCode: 'UPSTREAM_ERROR', promptTokens: 0, completionTokens: 0 });
    // 无任何结果 + 无剩余 → run failed（绝不把"零结果"记为 completed）
    expect(h.state.runStatus).toBe('failed');
  });

  it('信号已 abort → 不执行任何 case，run 回到 pending 等待重投（绝不记 completed）', async () => {
    const h = harness();
    const ac = new AbortController();
    ac.abort();
    const outcome = await h.runner.executeRun('run1', ac.signal);
    expect(h.streamCalls).toHaveLength(0);
    expect(outcome).toMatchObject({ claimed: true, status: 'pending', results: 0 });
    expect(h.state.runStatus).toBe('pending');
  });

  it('运行中 run 被取消（DB 状态非 running）→ 停止后续 case，已完成事实保留，终态绝不被改写', async () => {
    let h: Harness;
    h = harness({ onStream: () => { h.state.runStatus = 'cancelled'; } });
    const outcome = await h.runner.executeRun('run1');
    expect(h.streamCalls).toHaveLength(1); // 仅第一个 case 执行
    expect(h.state.caseStatus.get('cr1')).toBe('completed');
    expect(h.state.caseStatus.get('cr2')).toBe('pending'); // 取消后不写新事实
    expect(h.state.upserts).toHaveLength(1);
    expect(outcome.status).toBe('cancelled'); // 如实返回，绝不改写终态
    expect(h.state.runStatus).toBe('cancelled');
  });

  it('续跑（重投）：已完成的 case 跳过，仅执行未完成 case（幂等续跑）', async () => {
    const h = harness();
    h.state.caseStatus.set('cr1', 'completed'); // 上一轮已跑完第一个 case
    const outcome = await h.runner.executeRun('run1');
    expect(h.streamCalls).toHaveLength(1);
    expect((h.streamCalls[0].messages as Array<{ role: string; content: string }>)[1]).toEqual({ role: 'user', content: '问题二' });
    expect(outcome).toMatchObject({ completedCases: 1, results: 1, status: 'completed' });
  });
});

describe('EvaluationRunnerService 评测器（含 llm_judge）', () => {
  it('多个评测器全部落结果（每 case 每评测器一行，唯一键 upsert）', async () => {
    const h = harness({
      evaluators: [
        { id: 'ev1', name: '精确匹配', type: 'exact_match', config: {} },
        { id: 'ev2', name: '规则', type: 'rule', config: { rules: [{ type: 'contains', value: '答案' }] } },
      ],
    });
    const outcome = await h.runner.executeRun('run1');
    expect(outcome.results).toBe(4);
    expect(h.state.upserts.map((u) => `${u.caseRunId}:${u.evaluatorId}`)).toEqual(['cr1:ev1', 'cr1:ev2', 'cr2:ev1', 'cr2:ev2']);
  });

  it('评测器类型未注册 → 记为未通过 + 错误证据，绝不默认通过，run 不中断', async () => {
    const h = harness({ evaluators: [{ id: 'evX', name: '怪类型', type: 'vibes', config: {} }] });
    const outcome = await h.runner.executeRun('run1');
    expect(outcome.results).toBe(2);
    expect(h.state.upserts[0]).toMatchObject({ passed: false, score: 0 });
    expect(String((h.state.upserts[0].evidence as Record<string, unknown>).evaluatorError)).toContain('vibes');
    expect(h.state.runStatus).toBe('completed');
  });

  it('llm_judge：judge 走既有 LLM 抽象（adapter.chat，temperature=0），结论只进 score/passed/evidence', async () => {
    const h = harness({ evaluators: [{ id: 'evJ', name: '裁判', type: 'llm_judge', config: { prompt: '评审：{{output}}', judgeModelId: 'model-judge' } }] });
    const outcome = await h.runner.executeRun('run1');
    expect(outcome.results).toBe(2);
    expect(h.chatCalls).toHaveLength(2);
    expect(h.chatCalls[0]).toMatchObject({ temperature: 0, maxTokens: 512 });
    expect(h.state.upserts[0]).toMatchObject({ passed: true, score: 0.9 });
    // 写库字段集固定：绝不产生任何系统判定字段（权限/quota/RBAC 越权面为零）
    expect(Object.keys(h.state.upserts[0]).sort()).toEqual(['caseRunId', 'evaluatorId', 'evidence', 'passed', 'score']);
  });

  it('llm_judge：judge 输出不可解析 → 未通过 + 原文证据（绝不重试、绝不猜测分数）', async () => {
    const h = harness({
      evaluators: [{ id: 'evJ', name: '裁判', type: 'llm_judge', config: { prompt: '评审：{{output}}' } }],
      judgeReply: '我觉得还行吧，给个好评',
    });
    await h.runner.executeRun('run1');
    expect(h.adapter.chat).toHaveBeenCalledTimes(2); // 每 case 一次，绝无重试
    expect(h.state.upserts[0]).toMatchObject({ passed: false, score: 0 });
    const evidence = h.state.upserts[0].evidence as Record<string, unknown>;
    expect(String(evidence.parseError)).toBeTruthy();
    expect(String(evidence.raw)).toContain('好评');
  });

  it('llm_judge：judge 调用抛错 → 未通过 + judgeError（绝不默认通过）', async () => {
    const h = harness({ evaluators: [{ id: 'evJ', name: '裁判', type: 'llm_judge', config: { prompt: '评审：{{output}}' } }] });
    h.adapter.chat.mockRejectedValue(new Error('provider 429'));
    const outcome = await h.runner.executeRun('run1');
    expect(outcome.status).toBe('completed');
    expect(h.state.upserts[0]).toMatchObject({ passed: false, score: 0 });
    expect(String((h.state.upserts[0].evidence as Record<string, unknown>).judgeError)).toContain('429');
  });

  it('工具调用只作为事实记录（output 恒为 null），评测绝不执行工具', async () => {
    const h = harness({
      evaluators: [{ id: 'evT', name: '工具', type: 'rule', config: { rules: [{ type: 'tool_called', value: 'search' }] } }],
      chunks: () => [
        { type: 'tool_calls', toolCalls: [{ id: 't1', name: 'search', arguments: '{"q":"x"}' }] },
        { type: 'text', text: '搜完了' },
        { type: 'usage', usage: { inputTokens: 3, outputTokens: 4 } },
      ],
    });
    const outcome = await h.runner.executeRun('run1');
    expect(outcome.results).toBe(2);
    expect(h.state.upserts[0]).toMatchObject({ passed: true, score: 1 });
    const caseRun = h.state.caseUpdates.filter((u) => u.status === 'completed')[0];
    expect(caseRun.toolCalls).toEqual([{ name: 'search', arguments: '{"q":"x"}', output: null }]);
  });
});

/**
 * M12-P4 评测工具声明（快照 → stream；**只声明不执行**）。
 * 缺省行为 = M9（不传 tools）；能力不支持时**显式失败**（绝不静默不下发——那等于评测结论失真）。
 */
describe('EvaluationRunnerService M12-P4 工具声明（只声明不执行）', () => {
  const TOOL_DEFS = [{
    type: 'function',
    function: { name: 'search', description: '检索', parameters: { type: 'object', properties: { q: { type: 'string' } } } },
  }];

  it('快照含冻结的 toolDefinitions → 原样下传 stream（模型因此知道有哪些工具，tool_called 规则才可能成立）', async () => {
    const h = harness({ snapshotExtra: { tools: ['search'], evaluationTools: ['search'], toolDefinitions: TOOL_DEFS } });
    await h.runner.executeRun('run1');
    expect(h.streamCalls).toHaveLength(2);
    expect(h.streamCalls[0].tools).toEqual(TOOL_DEFS);
    // 定义来自快照（**创建即锁定**）：执行期无任何"再解析/再补全"路径
    expect(h.streamCalls[0]).toMatchObject({ model: 'mock-echo', temperature: 0.2 });
  });

  it('快照无 toolDefinitions（缺省/旧快照）→ 不下发工具（M9 行为逐字节保持）', async () => {
    const h = harness();
    await h.runner.executeRun('run1');
    expect(h.streamCalls[0].tools).toBeUndefined();
  });

  it('模型声明 functionCalling=false 且快照带工具 → case 显式失败（绝不静默不下发后照跑），零 LLM 调用', async () => {
    const h = harness({
      snapshotExtra: { tools: ['search'], evaluationTools: ['search'], toolDefinitions: TOOL_DEFS },
      capabilities: { functionCalling: false },
    });
    const outcome = await h.runner.executeRun('run1');
    expect(outcome).toMatchObject({ claimed: true, failedCases: 2, results: 0 });
    expect(h.streamCalls).toHaveLength(0); // 连一次上游调用都没发起
    const failed = h.state.caseUpdates.filter((u) => u.status === 'failed');
    expect(failed).toHaveLength(2);
    expect(failed[0]).toMatchObject({ errorCode: 'NO_TOOL_CAPABILITY', promptTokens: 0, completionTokens: 0 });
    expect(h.state.runStatus).toBe('failed');
  });

  it('能力未声明（capabilities 缺 functionCalling 键）→ 放行（不阻断：未知 ≠ 不支持）', async () => {
    const h = harness({ snapshotExtra: { toolDefinitions: TOOL_DEFS } });
    const outcome = await h.runner.executeRun('run1');
    expect(outcome.status).toBe('completed');
    expect(h.streamCalls[0].tools).toEqual(TOOL_DEFS);
  });

  it('结构性红线：runner 构造函数不含任何工具执行依赖（无 ToolRegistry/执行器 → 结构上不可能执行工具）', () => {
    // 声明工具 ≠ 获得执行能力：工具执行只在 agent-run 面；评测面工具调用恒为事实（output: null）
    expect(EvaluationRunnerService.length).toBe(4);
    const deps = String(EvaluationRunnerService.toString());
    expect(deps).not.toContain('ToolRegistry');
    expect(deps).not.toContain('ToolExecutor');
  });
});

describe('EvaluationRunnerService 用量记账（best-effort）', () => {
  it('成功 case 记 usage（含 organizationId，与既有唯一计价点同源）', async () => {
    const h = harness();
    await h.runner.executeRun('run1');
    expect(h.state.usage).toHaveLength(2);
    expect(h.state.usage[0]).toMatchObject({
      userId: 'u1', organizationId: 'org1', providerId: 'p1', modelId: 'model-1',
      inputTokens: 10, outputTokens: 20, status: 'success',
    });
  });

  it('失败 case 也记 usage（status=failed + errorCode）——账务事实不因评测失败而丢失', async () => {
    const h = harness({ streamError: Object.assign(new Error('boom'), { code: 'UPSTREAM_ERROR' }) });
    await h.runner.executeRun('run1');
    expect(h.state.usage[0]).toMatchObject({ status: 'failed', errorCode: 'UPSTREAM_ERROR' });
  });

  it('记账抛错绝不影响评测 run（best-effort）', async () => {
    const h = harness({ usageRejects: true });
    const outcome = await h.runner.executeRun('run1');
    expect(outcome.status).toBe('completed');
    expect(h.state.runStatus).toBe('completed');
  });
});

describe('buildUserContent', () => {
  it('string 原样；{message} 取 message；其它 → 稳定 JSON 文本', () => {
    expect(buildUserContent('你好')).toBe('你好');
    expect(buildUserContent({ message: '你好' })).toBe('你好');
    expect(buildUserContent({ a: 1 })).toBe('{"a":1}');
    expect(buildUserContent(42)).toBe('42');
    expect(buildUserContent(null)).toBe('null');
  });
});
