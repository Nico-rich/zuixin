import { describe, expect, it } from 'vitest';
// 相对路径而非 '@ai-agent/shared'：包入口 main/types 指向 dist（构建产物，仓库忽略），
// 相对导入让本防线在「未构建 shared 的干净 worktree」上也能通过 typecheck（只读 import，不改动 shared）。
import { ChatStreamEventNames, ChatStreamEventSchema } from '../../../packages/shared/src/events';
import * as shared from '../../../packages/shared/src/index';
import type { ChatStreamEventMap } from '@/app/(chat)/chat/components/types';

/**
 * 前端类型漂移防线（Pre-M9 §1）
 *
 * web 侧 `app/(chat)/chat/components/types.ts` 的 `ChatStreamEventMap` 是**手写的后端 SSE 协议拷贝**。
 * 本文件把这份拷贝钉在两处事实源上：
 *   1) 编译期：下面的表用 `{ [K in keyof ChatStreamEventMap]: ... }` 映射类型，少写/写错事件名或字段名直接 typecheck 失败；
 *   2) 运行期：字段名与 `@ai-agent/shared` 的 `ChatStreamEventSchema`（后端 zod 事实源）比对，只允许“声明子集”。
 *
 * 已知的、**有意的**漂移（web 只声明渲染所需字段）由 EXPECTED_SHARED_ONLY 显式列出——后端加必填字段时本用例会失败，
 * 迫使前端做一次明确决策（补字段 or 更新清单），而不是静默腐化。
 *
 * 另有**无法比对**的拷贝（shared 未导出对应类型，见文末清单）：TimelineItem/RunTimeline/RunTimelineUsage（api
 * timeline.types.ts）与各 Workflow DTO（api 各自定义）。这些只能在 api 侧改动时人工同步——清单见测试末尾断言。
 */

/** web 事件 key → 线上事件名（wire name，见 shared ChatStreamEventNames） */
const WEB_TO_WIRE: Record<keyof ChatStreamEventMap, string> = {
  message_start: 'message_start',
  message_delta: 'message_delta',
  message_end: 'message_end',
  status: 'status',
  task_created: 'task.created',
  task_progress: 'task.progress',
  task_completed: 'task.completed',
  error: 'error',
  agent_start: 'agent.start',
  agent_end: 'agent.end',
  tool_start: 'tool.start',
  tool_end: 'tool.end',
  run_created: 'run.created',
  run_progress: 'run.progress',
  run_completed: 'run.completed',
};

type WebFieldMap = { [K in keyof ChatStreamEventMap]: ReadonlyArray<keyof ChatStreamEventMap[K] & string> };

/** web 声明消费的字段（改字段名会 typecheck 失败；新增字段需同步登记） */
const WEB_DECLARED_FIELDS: WebFieldMap = {
  message_start: ['messageId', 'conversationId', 'createdAt'],
  message_delta: ['delta'],
  message_end: ['messageId', 'status'],
  status: ['stage', 'message'],
  task_created: ['taskId', 'kind'],
  task_progress: ['taskId', 'progress', 'message'],
  task_completed: ['taskId'],
  error: ['code', 'message', 'requestId'],
  agent_start: ['agentId', 'runId'],
  agent_end: ['agentId', 'runId', 'status'],
  tool_start: ['toolName', 'runId'],
  tool_end: ['toolName', 'runId', 'status', 'outputSummary'],
  run_created: ['runId', 'agentId'],
  run_progress: ['runId', 'currentStep', 'maxSteps'],
  run_completed: ['runId', 'status'],
};

/** wire 事实源：{ 事件名 → schema 字段名集合 }（含 type 判别字段） */
const SCHEMA_FIELDS: Map<string, string[]> = new Map(
  (ChatStreamEventSchema.options as unknown as Array<{ shape: Record<string, { value?: string }> }>)
    .map((option) => [option.shape.type.value!, Object.keys(option.shape)] as const),
);

/** 预期漂移：schema 有、web 未声明（web 只取渲染需要的字段） */
const EXPECTED_SHARED_ONLY: Record<string, string[]> = {
  message_start: ['role', 'type'],
  message_delta: ['type'],
  message_end: ['type'],
  status: ['type'],
  'task.created': ['type'],
  'task.progress': ['type'],
  'task.completed': ['type', 'artifact'],
  error: ['type'],
  'agent.start': ['type'],
  'agent.end': ['type'],
  'tool.start': ['type'],
  'tool.end': ['type'],
  'run.created': ['type'],
  'run.progress': ['type'],
  'run.completed': ['type'],
};

/** 注册表已锁定、web 尚未消费的线上事件（新增事件时会失败 → 提示前端评估是否需要渲染） */
// M10-P13（ARCH-07）：task.progress / task.completed 已由 web 消费（TaskCard SSE 化）→ 从本清单移出
const REGISTRY_ONLY_EVENTS = ['task.failed', 'artifact.created', 'approval.requested'];

describe('ChatStreamEventMap ↔ shared ChatStreamEventSchema 结构对比', () => {
  it('shared 导出可读（防线有效性前置检查：解析器/注册表存在且能校验真实帧）', () => {
    expect(SCHEMA_FIELDS.size).toBeGreaterThanOrEqual(13);
    const ok = ChatStreamEventSchema.safeParse({ type: 'message_start', messageId: 'm', conversationId: 'c', role: 'assistant', createdAt: 'T' });
    expect(ok.success).toBe(true);
    // 反向：字段缺失的帧会被拒绝（证明 schema 不是空壳）
    expect(ChatStreamEventSchema.safeParse({ type: 'message_start', messageId: 'm' }).success).toBe(false);
    expect(ChatStreamEventSchema.safeParse({ type: 'message_delta' }).success).toBe(false);
  });

  it('web 的每个事件名都已在共享注册表中锁定（防止前端自造/改名线上事件）', () => {
    const locked = new Set<string>(Object.values(ChatStreamEventNames));
    for (const [webKey, wire] of Object.entries(WEB_TO_WIRE)) {
      expect(locked.has(wire), `${webKey} → ${wire} 未在 ChatStreamEventNames 注册`).toBe(true);
    }
  });

  it('web 声明的字段都存在于 shared 对应 schema（防止字段改名/自造字段后静默失效）', () => {
    for (const [webKey, wire] of Object.entries(WEB_TO_WIRE)) {
      const fields = WEB_DECLARED_FIELDS[webKey as keyof ChatStreamEventMap];
      const known = SCHEMA_FIELDS.get(wire);
      expect(known, `shared schema 缺少事件 ${wire}`).toBeDefined();
      const unknown = fields.filter((f) => !known!.includes(f));
      expect(unknown, `${webKey}(${wire}) 声明了 schema 中不存在的字段: ${unknown.join(',')}`).toEqual([]);
    }
  });

  it('漂移清单固定：schema 有而 web 未声明的字段与预期完全一致', () => {
    // 比较前排序：schema 字段顺序不是契约，只有“字段集合”是
    const sorted = (m: Record<string, readonly string[]>) =>
      Object.fromEntries(Object.entries(m).map(([k, v]) => [k, [...v].sort()]));
    const actual: Record<string, string[]> = {};
    for (const [webKey, wire] of Object.entries(WEB_TO_WIRE)) {
      const declared = new Set<string>(WEB_DECLARED_FIELDS[webKey as keyof ChatStreamEventMap]);
      actual[wire] = SCHEMA_FIELDS.get(wire)!.filter((f) => !declared.has(f));
    }
    expect(sorted(actual)).toEqual(sorted(EXPECTED_SHARED_ONLY));
  });

  it('注册表中 web 未消费的事件清单固定（后端新增事件/前端补齐时需显式更新本清单）', () => {
    const consumed = new Set(Object.values(WEB_TO_WIRE));
    const unconsumed = Object.values(ChatStreamEventNames).filter((name) => !consumed.has(name));
    expect(unconsumed.sort()).toEqual([...REGISTRY_ONLY_EVENTS].sort());
  });

  it('shared 未导出 web 复制的后端 DTO 类型 → 这些拷贝只能靠人工同步（漂移清单）', () => {
    // 断言事实：shared 包导出面里没有 Timeline/Workflow/TaskView 级别的 DTO 类型
    const dtoLike = Object.keys(shared).filter((k) => /^(Timeline|Workflow|TaskView|ChatMessage|ConversationItem|ProjectItem)/.test(k));
    expect(dtoLike).toEqual([]);
    // 而事件协议相关导出必须在（否则本防线的比对基线不存在）
    expect(Object.keys(shared)).toEqual(expect.arrayContaining(['ChatStreamEventSchema', 'ChatStreamEventNames', 'AgentEventSchema']));
  });
});

/**
 * 漂移清单（shared 未导出、故无法自动比对；文件见注释）：
 *  - apps/web/app/(chat)/chat/components/types.ts      → TimelineItem / RunTimeline / RunTimelineUsage（对应 apps/api/src/modules/agent-runs/timeline.types.ts，字段一致但 web 把 type 放宽为 string）
 *  - apps/web/app/(chat)/chat/components/task-card.tsx → TaskView（对应 api 任务 DTO）
 *  - apps/web/app/workflows/page.tsx                   → WorkflowSummary
 *  - apps/web/app/workflows/[id]/page.tsx              → WorkflowDetail
 *  - apps/web/app/workflows/[id]/runs/page.tsx         → WorkflowRunSummary
 *  - apps/web/app/workflows/runs/[runId]/page.tsx      → WorkflowTimeline（且与 run-timeline.tsx 的 ICONS 表各自维护）
 *  - apps/web/app/(chat)/chat/components/chat-workspace.tsx → HistoryMessage（api 消息 DTO 子集）
 */
