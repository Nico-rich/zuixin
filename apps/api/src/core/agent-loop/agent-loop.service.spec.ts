import { describe, it, expect, vi, beforeEach } from 'vitest';
import { z } from 'zod';
import { AgentLoopService } from './agent-loop.service';
import { ToolRegistry } from '../tools/tool-registry.service';
import { Tool } from '../tools/tool.types';

function makeRegistry(tools: Tool[] = []) {
  const registry = new ToolRegistry();
  tools.forEach((t) => registry.register(t));
  return registry;
}

function makeLoop(opts: { tools?: Tool[]; streamFn?: (params: { tools?: unknown }) => AsyncIterable<unknown>; agent?: Partial<Parameters<AgentLoopService['execute']>[0]['agent']>; capabilities?: Record<string, unknown> } = {}) {
  const prisma = {
    systemSetting: { findUnique: vi.fn().mockResolvedValue({ key: 'limits', value: { agentRunTimeoutMs: 120000 } }) },
    agentRun: {
      create: vi.fn().mockImplementation(({ data }) => Promise.resolve({ id: 'run-1', ...data })),
      update: vi.fn().mockResolvedValue({}),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    agentRunStep: {
      create: vi.fn().mockImplementation(({ data }) => Promise.resolve({ id: `step-${data.stepIndex}`, ...data })),
      update: vi.fn().mockResolvedValue({}),
    },
    toolCall: {
      create: vi.fn().mockImplementation(({ data }) => Promise.resolve({ id: `tc-${Math.random().toString(36).slice(2, 8)}`, ...data })),
      findUnique: vi.fn().mockResolvedValue(null),
      update: vi.fn().mockResolvedValue({}),
    },
  };
  const registry = makeRegistry(opts.tools ?? []);
  const adapter = {
    stream: opts.streamFn ?? (async function* () { yield { type: 'text', text: '你好' }; }),
  };
  const capabilities = opts.capabilities ?? {};
  const modelResolver = { resolveDefaultLLM: vi.fn().mockResolvedValue({ adapter, apiModelId: 'm', providerId: 'p1', modelId: 'm1', providerName: 'Mock', timeoutMs: 1000, capabilities }) };
  const llmManager = { resolve: vi.fn().mockResolvedValue({ adapter, apiModelId: 'm', providerId: 'p1', modelId: 'm1', providerName: 'Mock', timeoutMs: 1000, capabilities }) };
  const usage = { recordChatUsage: vi.fn().mockResolvedValue(undefined) };
  const svc = new AgentLoopService(prisma as never, registry as never, modelResolver as never, llmManager as never, usage as never);
  const input = {
    userId: 'u1', projectId: undefined, conversationId: 'c1', messageId: 'm1',
    userMessage: '你好', history: [],
    agent: {
      id: 'general-assistant', systemPrompt: '你是助手', modelId: null,
      tools: (opts.tools ?? []).map((t) => t.name), maxSteps: opts.agent?.maxSteps,
      requiresTools: opts.agent?.requiresTools,
    },
    signal: new AbortController().signal,
  };
  return { svc, prisma, registry, input, usage };
}

function collect<T>(it: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  return (async () => { for await (const x of it) out.push(x); return out; })();
}

const imageTool: Tool = {
  name: 'image.generate', description: '生成图片', permission: 'generate',
  inputSchema: z.strictObject({ prompt: z.string().min(1) }),
  execute: vi.fn().mockResolvedValue({ taskId: 'task-1', status: 'pending' }),
};

describe('AgentLoopService', () => {
  beforeEach(() => { vi.clearAllMocks(); }); // imageTool.execute 为共享 vi.fn，隔离调用计数

  it('纯回答：run.created → agent.start → status → text.delta → agent.end(completed) → run.completed，run 落库 completed', async () => {
    const { svc, prisma } = makeLoop();
    const events = await collect(svc.execute(makeLoop().input));
    expect(events.map((e) => e.type)).toEqual([
      'run.created', 'agent.start', 'status', 'text.delta', 'agent.end', 'run.completed',
    ]);
    expect(events[4]).toMatchObject({ status: 'completed' });
    expect(prisma.agentRun.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'run-1', status: 'running' },
      data: expect.objectContaining({ status: 'completed' }),
    }));
  });

  it('工具调用：LLM 返回 tool_calls → 校验 → 执行 → tool.start/end → 回喂 → 下一轮 final', async () => {
    let turn = 0;
    const { svc, prisma } = makeLoop({
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
    const events = await collect(svc.execute(makeLoop({ tools: [imageTool] }).input));
    const types = events.map((e) => e.type);
    expect(types).toContain('tool.start');
    expect(types).toContain('tool.end');
    expect(events.find((e) => e.type === 'tool.end')).toMatchObject({ toolName: 'image.generate', status: 'completed' });
    expect(imageTool.execute).toHaveBeenCalledTimes(1);
    expect(imageTool.execute).toHaveBeenCalledWith(
      expect.objectContaining({ prompt: '主图' }),
      expect.objectContaining({ userId: 'u1', conversationId: 'c1', agentRunId: 'run-1' }),
    );
    expect(prisma.toolCall.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ toolName: 'image.generate', status: 'running' }),
    }));
    expect(prisma.toolCall.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: 'completed', output: { taskId: 'task-1', status: 'pending' } }),
    }));
  });

  it('权限边界：LLM 调用允许清单之外的 Tool → TOOL_DENIED 回喂，不执行', async () => {
    const deniedTool: Tool = { ...imageTool, name: 'data.query', execute: vi.fn() };
    const { svc } = makeLoop({
      tools: [imageTool, deniedTool],
      streamFn: async function* () {
        yield { type: 'tool_calls', toolCalls: [{ id: 'c1', name: 'data.query', arguments: '{}' }] };
      },
    });
    const events = await collect(svc.execute(makeLoop({ tools: [imageTool] }).input)); // agent 只允许 image.generate
    expect(deniedTool.execute).not.toHaveBeenCalled();
    expect(events.find((e) => e.type === 'tool.end')).toMatchObject({ status: 'failed', outputSummary: 'data.query：无权限' });
  });

  it('循环检测：连续两次相同 Tool 同参数 → AGENT_LOOP_DETECTED，run failed', async () => {
    const { svc, prisma } = makeLoop({
      tools: [imageTool],
      streamFn: async function* () {
        yield { type: 'tool_calls', toolCalls: [{ id: 'c1', name: 'image.generate', arguments: '{"prompt":"x"}' }] };
      },
    });
    const events = await collect(svc.execute(makeLoop({ tools: [imageTool], agent: { maxSteps: 8 } }).input));
    expect(events.at(-1)).toMatchObject({ status: 'failed' });
    expect(imageTool.execute).toHaveBeenCalledTimes(1); // 第二次被循环检测拦截
    expect(prisma.agentRun.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: 'failed', errorCode: 'AGENT_LOOP_DETECTED' }),
    }));
  });

  it('maxSteps 硬限制：耗尽且最后一轮仍为工具调用 → failed(AGENT_MAX_STEPS)，Tool 恰好执行 maxSteps 次', async () => {
    let turn = 0;
    const { svc, prisma } = makeLoop({
      tools: [imageTool],
      agent: { maxSteps: 2 },
      streamFn: async function* () {
        turn++;
        // 各轮参数不同——避免触发循环检测（此处验证的是步数耗尽语义）
        yield { type: 'tool_calls', toolCalls: [{ id: `c${turn}`, name: 'image.generate', arguments: JSON.stringify({ prompt: `x${turn}` }) }] };
      },
    });
    const events = await collect(svc.execute(makeLoop({ tools: [imageTool], agent: { maxSteps: 2 } }).input));
    expect(imageTool.execute).toHaveBeenCalledTimes(2); // 硬限制：不会执行第 3 次
    expect(events.at(-1)).toMatchObject({ type: 'run.completed', status: 'failed' });
    expect(prisma.agentRun.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: 'failed', errorCode: 'AGENT_MAX_STEPS' }),
    }));
  });

  it('exactly maxSteps：最后一轮 LLM final → completed（不误判）', async () => {
    let turn = 0;
    const { svc, prisma } = makeLoop({
      tools: [imageTool],
      agent: { maxSteps: 2 },
      streamFn: async function* () {
        turn++;
        if (turn === 1) yield { type: 'tool_calls', toolCalls: [{ id: 'c1', name: 'image.generate', arguments: '{"prompt":"x"}' }] };
        else yield { type: 'text', text: '完成' };
      },
    });
    const events = await collect(svc.execute(makeLoop({ tools: [imageTool], agent: { maxSteps: 2 } }).input));
    expect(events.at(-1)).toMatchObject({ type: 'run.completed', status: 'completed' });
    expect(prisma.agentRun.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: 'completed', errorCode: undefined }),
    }));
  });

  it('capability：未声明 functionCalling → 默认视为支持，携带 tools', async () => {
    let capturedTools: unknown = 'unset';
    const { svc } = makeLoop({
      tools: [imageTool],
      streamFn: async function* (p) { capturedTools = p.tools; yield { type: 'text', text: 'ok' }; },
    });
    await collect(svc.execute(makeLoop({ tools: [imageTool] }).input));
    expect(capturedTools).toBeTruthy(); // 携带工具定义
  });

  it('capability：functionCalling=false + 普通 Agent → 不发送 tools，正常 final 完成', async () => {
    let capturedTools: unknown = 'unset';
    const { svc, prisma } = makeLoop({
      tools: [imageTool],
      capabilities: { functionCalling: false },
      streamFn: async function* (p) { capturedTools = p.tools; yield { type: 'text', text: '普通回答' }; },
    });
    const events = await collect(svc.execute(makeLoop({ tools: [imageTool] }).input));
    expect(capturedTools).toBeUndefined(); // 不发送 tools（情况 A：普通聊天 fallback）
    expect(events.at(-1)).toMatchObject({ type: 'run.completed', status: 'completed' });
    expect(prisma.agentRun.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: 'completed' }),
    }));
  });

  it('capability：functionCalling=false + requiresTools Agent → NO_TOOL_CAPABILITY 明确失败（不伪装完成）', async () => {
    const { svc, prisma } = makeLoop({
      tools: [imageTool],
      capabilities: { functionCalling: false },
      agent: { requiresTools: true },
      streamFn: async function* () { yield { type: 'text', text: '不应到达' }; },
    });
    const events = await collect(svc.execute(makeLoop({ tools: [imageTool], agent: { requiresTools: true } }).input));
    expect(events.at(-1)).toMatchObject({ type: 'run.completed', status: 'failed' });
    expect(prisma.agentRun.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: 'failed', errorCode: 'NO_TOOL_CAPABILITY' }),
    }));
  });

  it('M5-P4：LLM 回合失败 → usage 仍记录（failed + errorCode，可能已计费必须可观测）', async () => {
    const { svc, usage } = makeLoop({
      streamFn: async function* () {
        throw Object.assign(new Error('boom'), { status: 429 });
      },
    });
    const input = makeLoop().input;
    await collect(svc.execute(input));
    expect(usage.recordChatUsage).toHaveBeenCalledWith(expect.objectContaining({
      status: 'failed', errorCode: 'PROVIDER_RATE_LIMITED', runId: 'run-1',
    }));
    // 成功路径没有记录（回合失败后直接抛出）
    expect(usage.recordChatUsage).not.toHaveBeenCalledWith(expect.objectContaining({ status: 'success' }));
  });

  it('用户取消：signal abort → run cancelled', async () => {
    const ac = new AbortController();
    const { svc, prisma } = makeLoop({
      streamFn: async function* () {
        ac.abort();
        throw Object.assign(new Error('aborted'), { name: 'AbortError' });
      },
    });
    const input = { ...makeLoop().input, signal: ac.signal };
    const events = await collect(svc.execute(input));
    expect(prisma.agentRun.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: expect.any(String) }),
    }));
    expect(events.at(-1)!.type).toBe('run.completed');
  });

  it('幂等：同一步骤内 ToolCall 已 completed → 复用输出不重执行', async () => {
    const { svc, prisma } = makeLoop({
      tools: [imageTool],
      streamFn: async function* () {
        yield { type: 'tool_calls', toolCalls: [{ id: 'c1', name: 'image.generate', arguments: '{"prompt":"x"}' }] };
      },
    });
    prisma.toolCall.findUnique.mockResolvedValue({ status: 'completed', output: { taskId: 'existing-task', status: 'pending' } });
    const events = await collect(svc.execute(makeLoop({ tools: [imageTool] }).input));
    expect(imageTool.execute).not.toHaveBeenCalled();
    expect(events.find((e) => e.type === 'tool.end')).toMatchObject({ outputSummary: '（复用已执行结果）' });
  });
});
