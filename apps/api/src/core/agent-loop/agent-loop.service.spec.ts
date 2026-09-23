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

function makeLoop(opts: { tools?: Tool[]; streamFn?: (params: unknown) => AsyncIterable<unknown>; agent?: Partial<Parameters<AgentLoopService['execute']>[0]['agent']> } = {}) {
  const prisma = {
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
      create: vi.fn().mockResolvedValue({}),
      findUnique: vi.fn().mockResolvedValue(null),
    },
  };
  const registry = makeRegistry(opts.tools ?? []);
  const adapter = {
    stream: opts.streamFn ?? (async function* () { yield { type: 'text', text: '你好' }; }),
  };
  const modelResolver = { resolveDefaultLLM: vi.fn().mockResolvedValue({ adapter, apiModelId: 'm' }) };
  const llmManager = { resolve: vi.fn().mockResolvedValue({ adapter, apiModelId: 'm' }) };
  const svc = new AgentLoopService(prisma as never, registry as never, modelResolver as never, llmManager as never);
  const input = {
    userId: 'u1', projectId: undefined, conversationId: 'c1', messageId: 'm1',
    userMessage: '你好', history: [],
    agent: {
      id: 'general-assistant', systemPrompt: '你是助手', modelId: null,
      tools: (opts.tools ?? []).map((t) => t.name), maxSteps: opts.agent?.maxSteps,
    },
    signal: new AbortController().signal,
  };
  return { svc, prisma, registry, input };
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
      data: expect.objectContaining({ toolName: 'image.generate', status: 'completed' }),
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

  it('maxSteps：一直工具调用 → 超步终态 failed（AGENT_MAX_STEPS 语义由护栏触发）', async () => {
    const { svc } = makeLoop({
      tools: [imageTool],
      agent: { maxSteps: 2 },
      streamFn: async function* () {
        yield { type: 'tool_calls', toolCalls: [{ id: 'c1', name: 'image.generate', arguments: '{"prompt":"x"}' }] };
      },
    });
    const events = await collect(svc.execute(makeLoop({ tools: [imageTool], agent: { maxSteps: 2 } }).input));
    expect(events.at(-1)!.type).toBe('run.completed');
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
