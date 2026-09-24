import { describe, it, expect } from 'vitest';
import { planResume, TranscriptRowLike } from './resume-planner';

const calls = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `call_${i}`, name: 'image.generate', arguments: `{"prompt":"p${i}"}` }));

function row(role: string, content: string, extra: Partial<TranscriptRowLike> = {}): TranscriptRowLike {
  return { role, content, toolCallId: null, toolCalls: null, ...extra };
}

describe('ResumePlanner（M6-P4 §8.4 判定分支）', () => {
  it('transcript 仅 user 行（crash 于首次 LLM 流中）→ llm 从 currentStep 起（全新续跑，重打 LLM）', () => {
    const plan = planResume([row('user', '你好')], 0);
    expect(plan).toMatchObject({ mode: 'llm', startStep: 0, pendingCalls: [] });
  });

  it('无 assistant 行（空/只有 system）→ llm', () => {
    expect(planResume([], 0).mode).toBe('llm');
    expect(planResume([row('system', '你是助手')], 3).mode).toBe('llm');
  });

  it('最后 assistant 无 tool_calls → final（最终回答已产出，不重打 LLM）', () => {
    const plan = planResume([
      row('user', '你好'),
      row('assistant', '这是最终回答'),
    ], 0);
    expect(plan).toMatchObject({ mode: 'final', finalContent: '这是最终回答' });
  });

  it('最后 assistant(tool_calls) 全部有 tool 结果 → llm（下一回合）', () => {
    const cs = calls(2);
    const plan = planResume([
      row('user', '你好'),
      row('assistant', '', { toolCalls: cs }),
      row('tool', '{"taskId":"t1"}', { toolCallId: 'call_0' }),
      row('tool', '{"taskId":"t2"}', { toolCallId: 'call_1' }),
    ], 1);
    expect(plan).toMatchObject({ mode: 'llm', startStep: 1 });
  });

  it('最后 assistant(tool_calls) 部分缺 tool 结果 → tools 模式（只执行缺失项，绝不重打 LLM）', () => {
    const cs = calls(3);
    const plan = planResume([
      row('user', '你好'),
      row('assistant', '', { toolCalls: cs }),
      row('tool', '{"taskId":"t1"}', { toolCallId: 'call_0' }),
    ], 2);
    expect(plan.mode).toBe('tools');
    expect(plan.startStep).toBe(2);
    // 只缺 call_1 / call_2；原始下标保持（idempotency key 稳定）
    expect(plan.pendingCalls).toEqual([
      { llmCallId: 'call_1', name: 'image.generate', arguments: '{"prompt":"p1"}', toolIndex: 1 },
      { llmCallId: 'call_2', name: 'image.generate', arguments: '{"prompt":"p2"}', toolIndex: 2 },
    ]);
    // loop 检测签名由该回合推导（进程内状态不恢复，窗口重算）
    expect(plan.lastToolSignature).toBeTruthy();
  });

  it('全部缺失 → tools 模式包含全部调用（原顺序）', () => {
    const cs = calls(2);
    const plan = planResume([
      row('user', '你好'),
      row('assistant', '', { toolCalls: cs }),
    ], 1);
    expect(plan.mode).toBe('tools');
    expect(plan.pendingCalls.map((c) => c.toolIndex)).toEqual([0, 1]);
  });

  it('tool 行带空 toolCallId 不参与配对（P3 兼容）', () => {
    const cs = calls(1);
    const plan = planResume([
      row('user', '你好'),
      row('assistant', '', { toolCalls: cs }),
      row('tool', 'x', { toolCallId: null }),
    ], 1);
    expect(plan.mode).toBe('tools');
    expect(plan.pendingCalls).toHaveLength(1);
  });

  it('waiting 恢复：等待中的调用缺 tool 结果 → tools 模式（resume 补写任务结果）', () => {
    const cs = calls(1);
    const plan = planResume([
      row('user', '画图'),
      row('assistant', '', { toolCalls: cs }),
      // 进入 waiting 时 tool 结果未写 → resume 时该调用仍在 pendingCalls
    ], 0);
    expect(plan.mode).toBe('tools');
    expect(plan.pendingCalls).toHaveLength(1);
  });

  it('多个 assistant 回合：只按最后一个 assistant 判定（前面的 tool 行不误配）', () => {
    const cs1 = calls(1);
    const cs2 = calls(2);
    const plan = planResume([
      row('user', '你好'),
      row('assistant', '', { toolCalls: cs1 }),
      row('tool', '{"taskId":"t1"}', { toolCallId: 'call_0' }),
      row('assistant', '', { toolCalls: cs2 }),
      row('tool', '{"taskId":"t2"}', { toolCallId: 'call_0' }),
    ], 2);
    // 第二回合缺 call_1
    expect(plan.mode).toBe('tools');
    expect(plan.pendingCalls).toEqual([
      { llmCallId: 'call_1', name: 'image.generate', arguments: '{"prompt":"p1"}', toolIndex: 1 },
    ]);
  });
});
