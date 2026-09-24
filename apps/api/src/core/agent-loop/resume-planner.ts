/**
 * M6-P4 Resume Planner（纯函数，无 IO）：
 * transcript（AgentRunMessage 顺序行）+ run.currentStep → ResumePlan。
 * 判定规则 = 设计 §8.4：
 *   a. 无 assistant 行 → 全新执行（'llm' 从 currentStep 起）；
 *   b. 最后一条 assistant 携带 tool_calls：
 *      - 所有调用都有对应 tool 结果行 → 该回合已完成 → 下一 LLM 回合（'llm'）；
 *      - 有调用缺 tool 结果 → 继续执行已持久化的 tool decision（'tools'，绝不重打 LLM）；
 *   c. 最后一条 assistant 无 tool_calls → 最终回答已产出但未终态 → 直接补 final（'final'）。
 * loop 检测签名从 transcript 最后一个 tool_calls 回合推导（进程内状态不恢复，窗口自 resume 点重算）。
 */

export interface TranscriptRowLike {
  role: string;
  content: string;
  toolCallId: string | null;
  toolCalls: unknown;
}

export interface PendingToolCall {
  /** LLM 生成的 call id（与 assistant.tool_calls 快照、transcript tool 行配对） */
  llmCallId: string;
  name: string;
  arguments: string;
  /** 在 assistant.tool_calls 快照中的原始下标（idempotency key 稳定性依赖原下标） */
  toolIndex: number;
}

export interface ResumePlan {
  mode: 'llm' | 'tools' | 'final';
  /** 续跑起点 stepIndex（'llm'/'tools' = run.currentStep） */
  startStep: number;
  /** mode='final'：已流式产出但未落终态的回答全文 */
  finalContent?: string;
  /** mode='tools'：需要继续执行的调用（顺序 = 快照顺序；completed 行复用输出不重执行） */
  pendingCalls: PendingToolCall[];
  /** loop 检测续跑签名（transcript 最后一个 tool_calls 回合推导；无则 null） */
  lastToolSignature: string | null;
}

function signatureOf(calls: Array<{ name: string; arguments: string }>): string {
  return calls.map((t) => `${t.name}:${t.arguments}`).sort().join('|');
}

export function planResume(transcript: TranscriptRowLike[], currentStep: number): ResumePlan {
  const base: ResumePlan = {
    mode: 'llm', startStep: Math.max(0, currentStep),
    pendingCalls: [], lastToolSignature: null,
  };

  // 最后一个 assistant 行（决策事实层的最新事实）
  let lastAssistant: TranscriptRowLike | null = null;
  let lastToolCallAssistant: TranscriptRowLike | null = null;
  for (const row of transcript) {
    if (row.role !== 'assistant') continue;
    lastAssistant = row;
    if (row.toolCalls != null) lastToolCallAssistant = row;
  }
  if (lastToolCallAssistant) {
    const calls = (lastToolCallAssistant.toolCalls as Array<{ id: string; name: string; arguments: string }>) ?? [];
    base.lastToolSignature = calls.length ? signatureOf(calls) : null;
  }

  if (!lastAssistant) return base; // 全新执行（含 crash 于首次 LLM 流中）

  const calls = (lastAssistant.toolCalls as Array<{ id: string; name: string; arguments: string }> | null) ?? null;
  if (!calls || calls.length === 0) {
    // 最终回答已产出（crash 于 [I]/[J] 前）→ 补 final，不重打 LLM
    return { ...base, mode: 'final', finalContent: lastAssistant.content };
  }

  // 最后一个 assistant(tool_calls) 回合：其后的 tool 行都属于本回合（append-only 序列）
  const lastAssistantSeq = transcript.indexOf(lastAssistant);
  const toolRowsAfter = transcript
    .slice(lastAssistantSeq + 1)
    .filter((r) => r.role === 'tool' && r.toolCallId != null);
  const resultCallIds = new Set(toolRowsAfter.map((r) => r.toolCallId as string));
  const pending = calls
    .map((call, toolIndex) => ({ call, toolIndex }))
    .filter(({ call }) => !resultCallIds.has(call.id))
    .map(({ call, toolIndex }) => ({ llmCallId: call.id, name: call.name, arguments: call.arguments, toolIndex }));

  if (pending.length > 0) {
    // 已持久化的 tool decision 尚未执行完 → 继续执行（绝不重新调用 LLM，P4-3）
    return { ...base, mode: 'tools', pendingCalls: pending };
  }
  return base; // 回合完整 → 下一 LLM 回合
}
