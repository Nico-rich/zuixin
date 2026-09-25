import { describe, it, expect, vi } from 'vitest';
import { AsyncAgentRunDriver } from './async-agent-run.driver';
import { ContextAssembler } from '../../core/context/context-assembler';
import { ContextBudgetService } from '../../core/context/context-budget.service';
import { SimpleTokenEstimator } from '../../core/context/token-estimator';
import { ChatMessage } from '../../providers/llm/llm.types';

const row = (role: string, content: string, extra: Record<string, unknown> = {}) => ({ role, content, toolCallId: null, toolCalls: null, ...extra });

/** 长 transcript：每回合 assistant(tool_calls) + tool 结果；末回合 c9 有结果、c10 未执行（resume 'tools'） */
function longTranscript(turns = 12): Array<ReturnType<typeof row>> {
  const rows = [row('user', '初始需求'), row('system', 'SYS')];
  for (let i = 0; i < turns; i++) {
    rows.push(row('assistant', `回合${i}`.repeat(20), { toolCalls: [{ id: `c${i}`, name: 'web.search', arguments: `{"q":"${'x'.repeat(40)}"}` }] }));
    rows.push(row('tool', `结果${i}`.repeat(30), { toolCallId: `c${i}` }));
  }
  // 末回合：两个调用，仅第一个有结果 → planResume = 'tools' 且 pendingCalls = [c-last-2]
  rows.push(row('assistant', '', { toolCalls: [{ id: 'c-last-1', name: 'image.generate', arguments: '{"prompt":"a"}' }, { id: 'c-last-2', name: 'image.generate', arguments: '{"prompt":"b"}' }] }));
  rows.push(row('tool', '{"taskId":"t1"}', { toolCallId: 'c-last-1' }));
  return rows;
}

function makeDriver(
  transcript: Array<ReturnType<typeof row>>,
  budgetTokens: number,
  outcomeStatus: 'completed' | 'waiting' = 'completed',
  engineError?: Error,
) {
  const prisma = {
    agentRun: {
      findUnique: vi.fn(async () => ({
        id: 'run-1', status: 'running', currentStep: 4, userId: 'u1', projectId: null, conversationId: 'conv-1',
        workerId: 'w1', startedAt: new Date(Date.now() - 1000), metadata: { assistantMessageId: 'am-1' },
        agentVersion: {
          id: 'ver-1', systemPrompt: 'SYS-PROMPT', modelId: 'mock-1', tools: ['web.search'], temperature: 0.7, maxTokens: null,
          config: { contextBudgetTokens: budgetTokens, maxSteps: 8 },
        },
      })),
    },
    agentRunMessage: { findMany: vi.fn(async () => transcript) },
    message: { update: vi.fn(async () => ({})) },
  };
  let captured: Record<string, unknown> | null = null;
  const engine = {
    run: (ctx: Record<string, unknown>) => {
      captured = ctx;
      return (async function* () {
        if (engineError) throw engineError;
        yield { type: 'agent.step' } as never;
        return {
          runId: 'run-1', status: outcomeStatus, content: '最终回答',
          taskRefs: outcomeStatus === 'waiting' ? ['task-1'] : [], approvalRefs: [], delegationRefs: [],
        } as never;
      })();
    },
  };
  const budget = new ContextBudgetService(new SimpleTokenEstimator());
  const assembler = new ContextAssembler(prisma as never, budget);
  const events = { publish: vi.fn(async () => undefined), flush: vi.fn(async () => undefined) };
  const driver = new AsyncAgentRunDriver(
    prisma as never,
    engine as never,
    assembler,
    budget,
    { runDeadlineMs: async () => 60_000 } as never,
    events as never,
    { organizationFor: async () => 'org-1', recordUsage: async () => undefined } as never,
    { release: async () => undefined } as never,
  );
  return {
    driver, events,
    captured: () => captured as { history: ChatMessage[]; resume: { mode: string; pendingCalls: Array<{ llmCallId: string }> }; userMessage: string; startStep: number },
  };
}

const estimate = (text: string) => new SimpleTokenEstimator().estimate(text);

describe('AsyncAgentRunDriver（P3 续跑上下文预算）', () => {
  it('超长 transcript：发给 LLM 的 history 被裁剪（预算内），且绝不出现无主 tool 消息', async () => {
    const transcript = longTranscript();
    const { driver, captured } = makeDriver(transcript, 120);
    await driver.execute('run-1', new AbortController().signal, { active: true });
    const ctx = captured();

    const fullReplayLength = transcript.filter((r) => r.role !== 'user' && r.role !== 'system').length; // 25
    expect(fullReplayLength).toBeGreaterThan(10);
    expect(ctx.history.length).toBeGreaterThan(0);
    expect(ctx.history.length).toBeLessThan(fullReplayLength); // 裁剪生效

    // 配对完整：首条绝非 tool 结果；每条 tool 结果都有前置 assistant.tool_calls 认领
    expect(ctx.history[0].role).not.toBe('tool');
    const seen = new Set<string>();
    for (const message of ctx.history) {
      if (message.role === 'assistant' && message.tool_calls) for (const call of message.tool_calls) seen.add(call.id);
      if (message.role === 'tool') expect(seen.has(message.tool_call_id as string)).toBe(true);
    }
    // 预算内（与首跑同一估算器：ContextBudgetService 的 TOKEN_ESTIMATOR）
    const tokens = ctx.history.reduce((sum, m) => sum + estimate(typeof m.content === 'string' ? m.content : ''), 0);
    expect(tokens).toBeLessThanOrEqual(120);
  });

  it('planResume 行为不变：续跑计划仍按**全量** transcript 计算（被裁剪的回合照样列出 pending 调用）', async () => {
    const transcript = longTranscript();
    const { driver, captured } = makeDriver(transcript, 120);
    await driver.execute('run-1', new AbortController().signal, { active: true });
    const ctx = captured();

    expect(ctx.resume.mode).toBe('tools'); // 末回合 c-last-2 未执行 → 继续执行已持久化 tool decision
    expect(ctx.resume.pendingCalls.map((c) => c.llmCallId)).toEqual(['c-last-2']);
    expect(ctx.startStep).toBe(4);
    // 早期回合（c0）已被裁剪出 history，但 resume 计划仍完整（transcript 事实层未被裁剪）
    expect(ctx.history.some((m) => m.role === 'tool' && m.tool_call_id === 'c0')).toBe(false);
    expect(JSON.stringify(ctx.history)).not.toContain('回合0'); // 最旧回合已出预算
  });

  it('user 消息恒在（engine 单独追加）：history 绝不含 user 行，userMessage 原样透传', async () => {
    const { driver, captured } = makeDriver(longTranscript(), 120);
    await driver.execute('run-1', new AbortController().signal, { active: true });
    const ctx = captured();
    expect(ctx.history.some((m) => m.role === 'user')).toBe(false);
    expect(ctx.userMessage).toBe('初始需求');
  });

  it('预算充足：history 与全量重放逐条一致（裁剪为无操作，绝不改写内容/顺序）', async () => {
    const transcript = longTranscript(3);
    const { driver, captured } = makeDriver(transcript, 8000);
    await driver.execute('run-1', new AbortController().signal, { active: true });
    const expected = transcript.filter((r) => r.role !== 'user' && r.role !== 'system')
      .map((r) => ({ role: r.role, content: r.content, tool_call_id: r.toolCallId ?? undefined, tool_calls: r.toolCalls ?? undefined }));
    expect(captured().history).toEqual(expected);
  });

  it('waiting 终态：裁剪后仍按 outcome 透传（等待分支不写终态计量）', async () => {
    const { driver, captured } = makeDriver(longTranscript(), 120, 'waiting');
    const outcome = await driver.execute('run-1', new AbortController().signal, { active: true });
    expect(outcome.status).toBe('waiting');
    expect(captured().history.length).toBeGreaterThan(0);
  });

  it('P5：流结束强制 flush（缓冲的观察事件不因 10ms 窗口未到而滞留）', async () => {
    const transcript = longTranscript(2);
    const { driver, events } = makeDriver(transcript, 8000);
    await driver.execute('run-1', new AbortController().signal, { active: true });
    expect(events.publish).toHaveBeenCalledTimes(1); // 引擎 yield 的观察事件已入缓冲（未等到窗口）
    expect(events.flush).toHaveBeenCalledTimes(1); // 退出前冲刷（SSE 客户端可立即收到终态）
  });

  it('P5：引擎异常路径同样强制 flush（finally 兜底，绝不吞掉已产生事件）', async () => {
    const { driver, events } = makeDriver(longTranscript(2), 8000, 'completed', new Error('engine boom'));
    await expect(driver.execute('run-1', new AbortController().signal, { active: true })).rejects.toThrow('engine boom');
    expect(events.flush).toHaveBeenCalledTimes(1);
  });
});
