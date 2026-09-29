/**
 * M12-P3 记忆**来源可信度闸门**（审计风险 2）。
 *
 * 风险本体：记忆一旦落 `Memory.status='active'` 就会被 ContextAssembler 注入每一次对话/Agent 上下文。
 * 因此"**谁能把内容推进 active**"等价于"谁能把文本持久化进未来的系统提示词"——这是一条**提示注入
 * 持久化通道**。改造前的实际口径是"摄取期按 LLM 自报 confidence/importance 提升"：
 * `feedback.submit` / `performance.capture`（都是 **Agent 可调用的写副作用工具**）派生的记忆候选
 * confidence 恒为 0.9（服务端写死），只要有"自动提升"路径，LLM 就能借自己的评分把自己的话写进上下文。
 *
 * 闸门口径（**默认拒绝**，只有正向证据才放行）：
 * - `user`      ：人工经 HTTP 面产生的来源（`source='manual'`，或 `feedback`/`performance` 由**无
 *                 toolCallId 的 HTTP 直调**路径写入时显式标注 `metadata.origin='user'`）→ **可自动提升**；
 * - `extractor` ：对话提炼（M9-P2）。它虽有 LLM 参与，但输入**只来自真实 Message 行**（防循环污染硬约束），
 *                 且提升另有 confidence/importance 阈值闸门 → **可自动提升**（既有语义不变）；
 * - `agent`     ：LLM/Agent 经工具调用产生的来源（`memory.create_candidate` 的 `source='agent'`，
 *                 以及 `feedback.*`/`performance.capture` 带 toolCallId 的派生行）→ **绝不自动提升**，
 *                 只进 `candidate` 等人工裁决（`MemoryCandidateService.decide` / PATCH memories 三态）；
 * - `unknown`   ：无法证明来源（本次改造前落库的 `source='feedback'|'assistant'` 老行、无 source 的自建行）
 *                 → 同样按最低信任处理（**默认拒绝**；放宽谓词即等于重开注入通道）。
 *
 * 本模块是**纯函数**（无 IO、无 Nest 依赖）：闸门只有一处实现，所有"自动提升"路径
 * （`MemoryCandidateService` 摄取期提升、`MemoryLifecycleService` 结果驱动提升）都必须经 `canAutoPromote`，
 * 避免各写一份口径漂移。
 */
import type { Prisma } from '@prisma/client';

/** 来源可信度分类（`unknown` = 无正向证据 → 最低信任） */
export const MEMORY_ORIGINS = ['user', 'agent', 'extractor', 'unknown'] as const;
export type MemoryOrigin = (typeof MEMORY_ORIGINS)[number];

/** `metadata.origin`：写入方**显式**来源标注（新写入路径必须带） */
export const MEMORY_ORIGIN_KEY = 'origin';
/** `metadata.lifecycle`：服务端生命周期簿记（衰减/验证/人工确认），绝不承载内容语义 */
export const MEMORY_LIFECYCLE_KEY = 'lifecycle';

/**
 * `Memory.source` → 缺省来源分类（仅在 `metadata.origin` 缺失时兜底）。
 * 口径保守：凡不能证明"人写的"一律不给 user——`feedback`/`assistant` 是 M7-P8 起的两条**工具**派生来源，
 * 历史上无法区分"Agent 打分"与"用户打分"，故按 agent 处理（默认拒绝自动提升）。
 */
const SOURCE_ORIGIN: Record<string, MemoryOrigin> = {
  manual: 'user',
  extractor: 'extractor',
  agent: 'agent',
  feedback: 'agent',
  assistant: 'agent',
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

/** 判定一条记忆/候选的来源分类（显式标注优先；否则按 source 兜底；再否则 unknown） */
export function memoryOrigin(input: { source?: string | null; metadata?: unknown }): MemoryOrigin {
  const declared = asRecord(input.metadata)?.[MEMORY_ORIGIN_KEY];
  if (declared === 'user' || declared === 'agent' || declared === 'extractor') return declared;
  const mapped = input.source ? SOURCE_ORIGIN[input.source] : undefined;
  return mapped ?? 'unknown';
}

/**
 * 自动提升闸门：**唯一**允许"不经人工裁决"进入 active 的来源集合。
 * 任何新增的自动提升路径都必须调用本函数（红线：LLM 不得决定治理判定）。
 */
export function canAutoPromote(input: { source?: string | null; metadata?: unknown }): boolean {
  const origin = memoryOrigin(input);
  return origin === 'user' || origin === 'extractor';
}

/** 读 `metadata.lifecycle` 子对象（非对象/缺失 → 空对象） */
export function lifecycleOf(metadata: unknown): Record<string, unknown> {
  return asRecord(asRecord(metadata)?.[MEMORY_LIFECYCLE_KEY]) ?? {};
}

/**
 * 读生命周期时间戳（ISO 字符串 / Date / epoch ms 都接受；非法 → null）。
 * 统一按 ISO 字符串落库（Prisma JSON 序列化口径），比较用 `Date.getTime()`，绝不字符串比大小。
 */
export function metaTime(metadata: unknown, key: string): Date | null {
  const raw = lifecycleOf(metadata)[key];
  if (raw instanceof Date) return Number.isNaN(raw.getTime()) ? null : raw;
  if (typeof raw === 'string' || typeof raw === 'number') {
    const d = new Date(raw);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  return null;
}

/**
 * 合并 `metadata`（浅合并 + `lifecycle` 子对象浅合并）：生命周期簿记与既有语义键（`kind`/`subjectId`
 * 等幂等判定锚）**绝不互相覆盖**。undefined 值被丢弃（便于"只写本次真正要落的键"）。
 */
export function mergeMemoryMetadata(
  current: unknown,
  patch: Record<string, unknown>,
): Prisma.InputJsonValue {
  const base = asRecord(current) ?? {};
  const clean = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined));
  const merged: Record<string, unknown> = { ...base, ...clean };
  const lifecyclePatch = asRecord(clean[MEMORY_LIFECYCLE_KEY]);
  if (lifecyclePatch) {
    merged[MEMORY_LIFECYCLE_KEY] = {
      ...lifecycleOf(current),
      ...Object.fromEntries(Object.entries(lifecyclePatch).filter(([, v]) => v !== undefined)),
    };
  }
  return merged as Prisma.InputJsonValue;
}
