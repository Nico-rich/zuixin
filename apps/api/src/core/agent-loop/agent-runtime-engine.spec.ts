import { describe, it, expect, vi, beforeEach } from 'vitest';
import { z } from 'zod';
import { AgentRuntimeEngine, AgentRuntimeContext, AgentRunOutcome } from './agent-runtime-engine';
import { ToolRegistry } from '../tools/tool-registry.service';
import { Tool } from '../tools/tool.types';
import { AgentRuntimePersistence } from './runtime-persistence';

function makeRegistry(tools: Tool[] = []) {
  const registry = new ToolRegistry();
  tools.forEach((t) => registry.register(t));
  return registry;
}

/** 内存持久化替身：记录全部 durable 原语调用（transcript/toolCall/finalize/usage） */
function makePersistence() {
  const state = {
    messages: [] as Array<{ role: string; content: string; toolCallId?: string; toolCalls?: unknown }>,
    steps: [] as Array<{ runId: string; stepIndex: number; type: string; status?: string; output?: unknown }>,
    toolCallCreates: [] as Array<Record<string, unknown>>,
    toolCallUpdates: [] as Array<{ id: string; data: Record<string, unknown> }>,
    usage: [] as Array<Record<string, unknown>>,
    finalize: [] as Array<Record<string, unknown>>,
  };
  const persistence: AgentRuntimePersistence = {
    createRun: vi.fn(async () => ({ id: 'run-1' })),
    createStep: vi.fn(async (data) => { state.steps.push({ ...data }); return { id: `step-${data.stepIndex}` }; }),
    updateStep: vi.fn(async () => undefined),
    createToolCall: vi.fn(async (data) => { state.toolCallCreates.push({ ...data }); return { id: `tc-${state.toolCallCreates.length}` }; }),
    findToolCall: vi.fn(async () => null),
    updateToolCall: vi.fn(async (id, data) => { state.toolCallUpdates.push({ id, data: { ...data } }); }),
    appendMessage: vi.fn(async (_u, _r, m) => { state.messages.push({ ...m }); }),
    getSystemSetting: vi.fn(async () => ({ agentRunTimeoutMs: 120000 })),
    recordChatUsage: vi.fn(async (i) => { state.usage.push({ ...i }); }),
    finalizeRun: vi.fn(async (_id, data) => { state.finalize.push({ ...data }); return { count: 1 }; }),
    updateCurrentStep: vi.fn(async () => undefined),
    findStep: vi.fn(async () => null),
  };
  return { persistence, state };
}

function makeEngine(opts: {
  tools?: Tool[];
  streamFn?: (params: { tools?: unknown; messages?: Array<{ role: string; content: string; tool_calls?: unknown[] }> }) => AsyncIterable<unknown>;
  agent?: Partial<AgentRuntimeContext['agent']>;
  capabilities?: Record<string, unknown>;
  deadlineMs?: number;
  history?: Array<{ role: 'user' | 'assistant'; content: string }>;
} = {}) {
  const { persistence, state } = makePersistence();
  const registry = makeRegistry(opts.tools ?? []);
  const adapter = {
    stream: opts.streamFn ?? (async function* () { yield { type: 'text', text: '你好' }; }),
  };
  const capabilities = opts.capabilities ?? {};
  const modelResolver = { resolveDefaultLLM: vi.fn().mockResolvedValue({ adapter, apiModelId: 'm', providerId: 'p1', modelId: 'm1', providerName: 'Mock', timeoutMs: 1000, capabilities }) };
  const llmManager = { resolve: vi.fn().mockResolvedValue({ adapter, apiModelId: 'm', providerId: 'p1', modelId: 'm1', providerName: 'Mock', timeoutMs: 1000, capabilities }) };
  const engine = new AgentRuntimeEngine(persistence, registry as never, modelResolver as never, llmManager as never);
  const input: AgentRuntimeContext = {
    userId: 'u1', projectId: undefined, conversationId: 'c1', messageId: 'm1',
    userMessage: '你好', history: opts.history ?? [],
    agent: {
      id: 'general-assistant', systemPrompt: '你是助手', modelId: null,
      tools: (opts.tools ?? []).map((t) => t.name), maxSteps: opts.agent?.maxSteps,
      requiresTools: opts.agent?.requiresTools,
    },
    deadlineMs: opts.deadlineMs,
    signal: new AbortController().signal,
  };
  return { engine, persistence, state, input };
}

async function run(engine: AgentRuntimeEngine, input: AgentRuntimeContext): Promise<{ events: Array<{ type: string; [k: string]: unknown }>; outcome: AgentRunOutcome }> {
  const it = engine.run(input);
  const events: Array<{ type: string; [k: string]: unknown }> = [];
  let outcome: AgentRunOutcome = undefined as never;
  while (true) {
    const { done, value } = await it.next();
    if (done) { outcome = value; break; }
    events.push(value as { type: string; [k: string]: unknown });
  }
  return { events, outcome };
}

const imageTool: Tool = {
  name: 'image.generate', description: '生成图片', permission: 'generate',
  inputSchema: z.strictObject({ prompt: z.string().min(1) }),
  execute: vi.fn().mockResolvedValue({ taskId: 'task-1', status: 'pending' }),
};

describe('AgentRuntimeEngine（M6-P2 抽取后行为冻结 + transcript checkpoint）', () => {
  beforeEach(() => { vi.clearAllMocks(); }); // imageTool.execute 为共享 vi.fn，隔离调用计数

  it('纯回答：run.created → agent.start → status → text.delta → agent.end(completed) → run.completed，run 落库 completed', async () => {
    const { engine, state, input } = makeEngine();
    const { events, outcome } = await run(engine, input);
    expect(events.map((e) => e.type)).toEqual([
      'run.created', 'agent.start', 'status', 'text.delta', 'agent.end', 'run.completed',
    ]);
    expect(events[4]).toMatchObject({ status: 'completed' });
    expect(state.finalize[0]).toMatchObject({ status: 'completed' });
    expect(outcome).toMatchObject({ runId: 'run-1', status: 'completed', content: '你好' });
  });

  it('工具调用：LLM 返回 tool_calls → 校验 → 执行 → tool.start/end → 回喂 → 下一轮 final', async () => {
    let turn = 0;
    const { engine, state } = makeEngine({
      tools: [imageTool],
      streamFn: async function* () {
        turn++;
        if (turn === 1) {
          yield { type: 'tool_calls', toolCalls: [{ id: 'call_1', name: 'image.generate', arguments: JSON.stringify({ prompt: '主图' }) }] };
        } else {
          yield { type: 'text', text: '已为你创建任务' };
        }
      },
    });
    const { events } = await run(engine, makeEngine({ tools: [imageTool] }).input);
    const types = events.map((e) => e.type);
    expect(types).toContain('tool.start');
    expect(types).toContain('tool.end');
    expect(events.find((e) => e.type === 'tool.end')).toMatchObject({ toolName: 'image.generate', status: 'completed' });
    expect(imageTool.execute).toHaveBeenCalledTimes(1);
    expect(imageTool.execute).toHaveBeenCalledWith(
      expect.objectContaining({ prompt: '主图' }),
      expect.objectContaining({ userId: 'u1', conversationId: 'c1', agentRunId: 'run-1' }),
    );
    // ToolCall 生命周期：先建行 running → 执行 → 终态更新（M5 顺序冻结）
    expect(state.toolCallCreates[0]).toMatchObject({ toolName: 'image.generate', status: 'running' });
    expect(state.toolCallUpdates[0]).toMatchObject({ data: { status: 'completed', output: { taskId: 'task-1', status: 'pending' } } });
  });

  it('权限边界：LLM 调用允许清单之外的 Tool → TOOL_DENIED 回喂，不执行', async () => {
    const deniedTool: Tool = { ...imageTool, name: 'data.query', execute: vi.fn() };
    const { engine } = makeEngine({
      tools: [imageTool, deniedTool],
      streamFn: async function* () {
        yield { type: 'tool_calls', toolCalls: [{ id: 'c1', name: 'data.query', arguments: '{}' }] };
      },
    });
    const { events } = await run(engine, makeEngine({ tools: [imageTool] }).input); // agent 只允许 image.generate
    expect(deniedTool.execute).not.toHaveBeenCalled();
    expect(events.find((e) => e.type === 'tool.end')).toMatchObject({ status: 'failed', outputSummary: 'data.query：无权限' });
  });

  it('循环检测：连续两次相同 Tool 同参数 → AGENT_LOOP_DETECTED，run failed', async () => {
    const { engine, state } = makeEngine({
      tools: [imageTool],
      streamFn: async function* () {
        yield { type: 'tool_calls', toolCalls: [{ id: 'c1', name: 'image.generate', arguments: '{"prompt":"x"}' }] };
      },
    });
    const { events } = await run(engine, makeEngine({ tools: [imageTool], agent: { maxSteps: 8 } }).input);
    expect(events.at(-1)).toMatchObject({ status: 'failed' });
    expect(imageTool.execute).toHaveBeenCalledTimes(1); // 第二次被循环检测拦截
    expect(state.finalize[0]).toMatchObject({ status: 'failed', errorCode: 'AGENT_LOOP_DETECTED' });
  });

  it('maxSteps 硬限制：耗尽且最后一轮仍为工具调用 → failed(AGENT_MAX_STEPS)，Tool 恰好执行 maxSteps 次', async () => {
    let turn = 0;
    const { engine, state } = makeEngine({
      tools: [imageTool],
      agent: { maxSteps: 2 },
      streamFn: async function* () {
        turn++;
        yield { type: 'tool_calls', toolCalls: [{ id: `c${turn}`, name: 'image.generate', arguments: JSON.stringify({ prompt: `x${turn}` }) }] };
      },
    });
    const { events } = await run(engine, makeEngine({ tools: [imageTool], agent: { maxSteps: 2 } }).input);
    expect(imageTool.execute).toHaveBeenCalledTimes(2);
    expect(events.at(-1)).toMatchObject({ type: 'run.completed', status: 'failed' });
    expect(state.finalize[0]).toMatchObject({ status: 'failed', errorCode: 'AGENT_MAX_STEPS' });
  });

  it('exactly maxSteps：最后一轮 LLM final → completed（不误判）', async () => {
    let turn = 0;
    const { engine, state } = makeEngine({
      tools: [imageTool],
      agent: { maxSteps: 2 },
      streamFn: async function* () {
        turn++;
        if (turn === 1) yield { type: 'tool_calls', toolCalls: [{ id: 'c1', name: 'image.generate', arguments: '{"prompt":"x"}' }] };
        else yield { type: 'text', text: '完成' };
      },
    });
    const { events } = await run(engine, makeEngine({ tools: [imageTool], agent: { maxSteps: 2 } }).input);
    expect(events.at(-1)).toMatchObject({ type: 'run.completed', status: 'completed' });
    expect(state.finalize[0]).toMatchObject({ status: 'completed' });
  });

  it('M5-P6：超大 Tool Result → 确定性截断（消息配对完整，tool_call_id 保留）', async () => {
    const bigOutput = { result: 'x'.repeat(6000) };
    const bigTool: Tool = {
      name: 'big.tool', description: 'x', permission: 'read',
      inputSchema: z.strictObject({ v: z.string() }),
      execute: vi.fn().mockResolvedValue(bigOutput),
    };
    let capturedToolMsg: { content: string; tool_call_id?: string; role: string } | undefined;
    const { engine } = makeEngine({
      tools: [bigTool],
      streamFn: async function* (p) {
        const msgs = (p as { messages: Array<{ role: string; content: string; tool_call_id?: string }> }).messages;
        if (msgs.some((m) => m.role === 'tool')) {
          capturedToolMsg = msgs.find((m) => m.role === 'tool');
          yield { type: 'text', text: 'done' };
        } else {
          yield { type: 'tool_calls', toolCalls: [{ id: 'c1', name: 'big.tool', arguments: '{"v":"x"}' }] };
        }
      },
    });
    const input = { ...makeEngine().input, agent: { ...makeEngine().input.agent, tools: ['big.tool'] } };
    await run(engine, input);
    expect(capturedToolMsg).toBeTruthy();
    expect(capturedToolMsg!.role).toBe('tool');
    expect(capturedToolMsg!.tool_call_id).toBe('c1');
    expect(capturedToolMsg!.content.length).toBeLessThanOrEqual(4200);
  });

  it('capability：未声明 functionCalling → 默认视为支持，携带 tools', async () => {
    let capturedTools: unknown = 'unset';
    const { engine } = makeEngine({
      tools: [imageTool],
      streamFn: async function* (p) { capturedTools = p.tools; yield { type: 'text', text: 'ok' }; },
    });
    await run(engine, makeEngine({ tools: [imageTool] }).input);
    expect(capturedTools).toBeTruthy();
  });

  it('capability：functionCalling=false + 普通 Agent → 不发送 tools，正常 final 完成', async () => {
    let capturedTools: unknown = 'unset';
    const { engine, state } = makeEngine({
      tools: [imageTool],
      capabilities: { functionCalling: false },
      streamFn: async function* (p) { capturedTools = p.tools; yield { type: 'text', text: '普通回答' }; },
    });
    const { events } = await run(engine, makeEngine({ tools: [imageTool] }).input);
    expect(capturedTools).toBeUndefined();
    expect(events.at(-1)).toMatchObject({ type: 'run.completed', status: 'completed' });
    expect(state.finalize[0]).toMatchObject({ status: 'completed' });
  });

  it('capability：functionCalling=false + requiresTools Agent → NO_TOOL_CAPABILITY 明确失败（不伪装完成）', async () => {
    const { engine, state } = makeEngine({
      tools: [imageTool],
      capabilities: { functionCalling: false },
      agent: { requiresTools: true },
      streamFn: async function* () { yield { type: 'text', text: '不应到达' }; },
    });
    const { events } = await run(engine, makeEngine({ tools: [imageTool], agent: { requiresTools: true } }).input);
    expect(events.at(-1)).toMatchObject({ type: 'run.completed', status: 'failed' });
    expect(state.finalize[0]).toMatchObject({ status: 'failed', errorCode: 'NO_TOOL_CAPABILITY' });
  });

  it('M5-P4：LLM 回合失败 → usage 仍记录（failed + errorCode，可能已计费必须可观测）', async () => {
    const { engine, state } = makeEngine({
      streamFn: async function* () {
        throw Object.assign(new Error('boom'), { status: 429 });
      },
    });
    await run(engine, makeEngine().input);
    expect(state.usage[0]).toMatchObject({ status: 'failed', errorCode: 'PROVIDER_RATE_LIMITED', runId: 'run-1' });
    expect(state.usage.some((u) => u.status === 'success')).toBe(false);
  });

  it('M6-A8：用户取消（stream 中 abort）→ run cancelled，且中断回合记 AGENT_CANCELLED usage（不伪装 provider failure）', async () => {
    const ac = new AbortController();
    const { engine, state } = makeEngine({
      streamFn: async function* () {
        ac.abort();
        throw Object.assign(new Error('aborted'), { name: 'AbortError' });
      },
    });
    const input = { ...makeEngine().input, signal: ac.signal };
    const { events, outcome } = await run(engine, input);
    expect(events.at(-1)).toMatchObject({ type: 'run.completed', status: 'cancelled' });
    expect(state.finalize[0]).toMatchObject({ status: 'cancelled', errorCode: null });
    expect(state.usage[0]).toMatchObject({ status: 'failed', errorCode: 'AGENT_CANCELLED' });
    expect(outcome.status).toBe('cancelled');
  });

  it('步首检测取消：loop 起始 signal 已 abort → cancelled（无 LLM 调用）', async () => {
    const ac = new AbortController();
    ac.abort();
    const { engine, state } = makeEngine({ streamFn: async function* () { yield { type: 'text', text: '不应到达' }; } });
    const input = { ...makeEngine().input, signal: ac.signal };
    const { outcome } = await run(engine, input);
    expect(outcome.status).toBe('cancelled');
    expect(state.finalize[0]).toMatchObject({ status: 'cancelled' });
    expect(state.usage).toHaveLength(0);
  });

  it('timeout：deadline 已过 → timeout(AGENT_RUN_TIMEOUT)，不调 LLM', async () => {
    const { engine, state } = makeEngine({
      deadlineMs: -1,
      streamFn: async function* () { yield { type: 'text', text: '不应到达' }; },
    });
    const { events, outcome } = await run(engine, makeEngine({ deadlineMs: -1 }).input);
    expect(events.at(-1)).toMatchObject({ type: 'run.completed', status: 'timeout' });
    expect(state.finalize[0]).toMatchObject({ status: 'timeout', errorCode: 'AGENT_RUN_TIMEOUT' });
    expect(outcome).toMatchObject({ status: 'timeout', errorCode: 'AGENT_RUN_TIMEOUT' });
  });

  it('Tool 执行失败 → tool.failed 回喂模型 → 模型修正 → 下一轮 final（run 不终态）', async () => {
    const failTool: Tool = {
      name: 'flaky.tool', description: 'x', permission: 'read',
      inputSchema: z.strictObject({ v: z.string() }),
      execute: vi.fn().mockRejectedValue(new Error('down')),
    };
    let turn = 0;
    const { engine, state } = makeEngine({
      tools: [failTool],
      streamFn: async function* (p) {
        turn++;
        const msgs = (p as { messages: Array<{ role: string }> }).messages;
        if (msgs.some((m) => m.role === 'tool')) yield { type: 'text', text: '任务失败，我已说明原因' };
        else yield { type: 'tool_calls', toolCalls: [{ id: 'c1', name: 'flaky.tool', arguments: '{"v":"x"}' }] };
      },
    });
    const { events, outcome } = await run(engine, makeEngine({ tools: [failTool] }).input);
    expect(events.find((e) => e.type === 'tool.end')).toMatchObject({ status: 'failed' });
    expect(outcome.status).toBe('completed'); // 回喂后模型修正 → 正常完成
    expect(state.finalize[0]).toMatchObject({ status: 'completed' });
  });

  it('幂等：同一步骤内 ToolCall 已 completed → 复用输出不重执行', async () => {
    const { engine, persistence } = makeEngine({
      tools: [imageTool],
      streamFn: async function* () {
        yield { type: 'tool_calls', toolCalls: [{ id: 'c1', name: 'image.generate', arguments: '{"prompt":"x"}' }] };
      },
    });
    (persistence.findToolCall as ReturnType<typeof vi.fn>).mockResolvedValue({ id: 'tc-old', status: 'completed', output: { taskId: 'existing-task', status: 'pending' } });
    const { events } = await run(engine, makeEngine({ tools: [imageTool] }).input);
    expect(imageTool.execute).not.toHaveBeenCalled();
    expect(events.find((e) => e.type === 'tool.end')).toMatchObject({ outputSummary: '（复用已执行结果）' });
  });

  it('transcript checkpoint：seed(system+history+user) → assistant 快照 → tool 结果 → final assistant（顺序完整）', async () => {
    let turn = 0;
    const ctx = makeEngine({
      tools: [imageTool],
      history: [{ role: 'user', content: '上一轮：你好' }, { role: 'assistant', content: '上一轮：在的' }],
      streamFn: async function* () {
        turn++;
        if (turn === 1) yield { type: 'tool_calls', toolCalls: [{ id: 'call_1', name: 'image.generate', arguments: '{"prompt":"主图"}' }] };
        else yield { type: 'text', text: '已为你创建任务' };
      },
    });
    const { engine, state } = ctx;
    await run(engine, ctx.input);
    const roles = state.messages.map((m) => m.role);
    // seed: system + history(user/assistant) + 当前 user → 回合快照 assistant → tool → final assistant
    expect(roles).toEqual(['system', 'user', 'assistant', 'user', 'assistant', 'tool', 'assistant']);
    // assistant 快照携带 tool_calls 决策事实（resume 不重打 LLM）
    expect(state.messages[4]).toMatchObject({ role: 'assistant' });
    expect(state.messages[4].toolCalls).toEqual([{ id: 'call_1', name: 'image.generate', arguments: '{"prompt":"主图"}' }]);
    // tool 结果与 LLM call id 配对
    expect(state.messages[5]).toMatchObject({ role: 'tool', toolCallId: 'call_1' });
    expect(state.messages[5].content).toContain('task-1');
    // final assistant 无 tool_calls
    expect(state.messages[6]).toMatchObject({ role: 'assistant', content: '已为你创建任务' });
    expect(state.messages[6].toolCalls).toBeUndefined();
  });

  it('B1 修复：同一回合多个 tool_calls → assistant tool_calls 消息只 push 一次（消息序列合法）', async () => {
    let turn = 0;
    let capturedRound2: Array<{ role: string; tool_calls?: unknown[] }> = [];
    const multiTool: Tool = {
      name: 'memory.create_candidate', description: 'x', permission: 'write',
      inputSchema: z.strictObject({ content: z.string() }),
      execute: vi.fn().mockResolvedValue({ memoryId: 'mem-1' }),
    };
    const { engine } = makeEngine({
      tools: [imageTool, multiTool],
      streamFn: async function* (p) {
        turn++;
        if (turn === 1) {
          yield {
            type: 'tool_calls',
            toolCalls: [
              { id: 'c1', name: 'image.generate', arguments: '{"prompt":"a"}' },
              { id: 'c2', name: 'memory.create_candidate', arguments: '{"content":"记住x"}' },
            ],
          };
        } else {
          capturedRound2 = (p as { messages: Array<{ role: string; tool_calls?: unknown[] }> }).messages;
          yield { type: 'text', text: 'done' };
        }
      },
    });
    await run(engine, makeEngine({ tools: [imageTool, multiTool] }).input);
    const assistantWithToolCalls = capturedRound2.filter((m) => m.role === 'assistant' && m.tool_calls?.length);
    expect(assistantWithToolCalls).toHaveLength(1); // 恰好一条（修复前为 N 条重复）
  });

  it('M6-P3 异步模式：runId 提供时跳过 createRun，且 seed 不含用户消息（API 已持久化）', async () => {
    const { engine, persistence, state } = makeEngine({ streamFn: async function* () { yield { type: 'text', text: '异步回答' }; } });
    const input = { ...makeEngine().input, runId: 'run-existing', workerId: 'worker-A' };
    const { events } = await run(engine, input);
    expect(persistence.createRun).not.toHaveBeenCalled();
    expect(events[0]).toMatchObject({ type: 'run.created', runId: 'run-existing' });
    // seed = system（末尾用户消息被跳过——已由 API 持久化为 seq 0）；随后只有 final assistant 追加
    expect(state.messages.map((m) => m.role)).toEqual(['system', 'assistant']);
    expect(state.messages.some((m) => m.role === 'user')).toBe(false);
    // fencing：终态与 currentStep 携带 workerId
    expect(state.finalize[0]).toMatchObject({ status: 'completed', workerId: 'worker-A' });
  });

  it('M6-P3 最小续跑：startStep 起点 + 崩溃残留 step 行 P2002 → 复用原行 id（幂等键稳定）', async () => {
    const { engine, persistence, state } = makeEngine({
      tools: [imageTool],
      streamFn: async function* () {
        yield { type: 'tool_calls', toolCalls: [{ id: 'c1', name: 'image.generate', arguments: '{"prompt":"x"}' }] };
      },
    });
    (persistence.createStep as ReturnType<typeof vi.fn>).mockRejectedValueOnce(Object.assign(new Error('dup'), { code: 'P2002' }));
    (persistence.findStep as ReturnType<typeof vi.fn>).mockResolvedValue({ id: 'step-existing' });
    const input = { ...makeEngine({ tools: [imageTool] }).input, runId: 'run-existing', startStep: 2, seedTranscript: false };
    await run(engine, input);
    expect(persistence.createStep).toHaveBeenCalledWith(expect.objectContaining({ stepIndex: 2 }));
    // ToolCall 行挂在复用的 step 行上（runStepId=step-existing）
    expect(state.toolCallCreates[0]).toMatchObject({ runStepId: 'step-existing' });
  });

  it('M6-P3 shutdown：controls.active=false → Engine 跳过终态写入与 agent.end/run.completed（不伪造终态）', async () => {
    const { engine, state } = makeEngine();
    const controls = { active: false };
    const input = { ...makeEngine().input, controls };
    const it = engine.run(input);
    const events: Array<{ type: string }> = [];
    while (true) {
      const { done, value } = await it.next();
      if (done) break;
      events.push(value as { type: string });
    }
    expect(events.map((e) => e.type)).not.toContain('agent.end');
    expect(events.map((e) => e.type)).not.toContain('run.completed');
    expect(state.finalize).toHaveLength(0);
  });

  it('result mapping：outcome 携带 runId/content/status/taskRefs（生成任务引用）', async () => {
    let turn = 0;
    const { engine } = makeEngine({
      tools: [imageTool],
      streamFn: async function* () {
        turn++;
        if (turn === 1) yield { type: 'tool_calls', toolCalls: [{ id: 'c1', name: 'image.generate', arguments: '{"prompt":"x"}' }] };
        else yield { type: 'text', text: '已提交生成任务' };
      },
    });
    const { outcome, events } = await run(engine, makeEngine({ tools: [imageTool] }).input);
    expect(outcome).toMatchObject({
      runId: 'run-1', status: 'completed', content: '已提交生成任务', taskRefs: ['task-1'],
    });
    expect(events.find((e) => e.type === 'task.created')).toMatchObject({ taskId: 'task-1', kind: 'image' });
  });
});
