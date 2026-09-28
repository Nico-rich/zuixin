/**
 * M9-P5 创意假设状态机（**纯逻辑，无 IO**）。
 *
 * 状态：draft（草稿）→ ready（可执行）→ running（loop 执行中）→ validated | rejected（终态）。
 * - 推进唯一事实源：本文件的 TRANSITIONS（服务层一律经 `assertTransition` 校验 + 条件更新落库）；
 * - 终态只读（绝不复活：重跑 loop 走新假设行，历史假设的判定事实保留）；
 * - `running` 是"loop 已启动、等待评测/实验事实"的等待态（**不是**终态）。
 *
 * 与既有状态机的边界：M9-P1 Experiment 的 draft/running/completed/archived 是**实验生命周期**，
 * M7-P6 WorkflowRun 的 queued/running/waiting/... 是**编排执行生命周期**——本机是"创意假设"这一
 * 独立业务实体的生命周期，三者互不冒充（假设行只引用 workflowRunId / evaluationRunId / experimentId）。
 */

import { AppError, ErrorCode } from '../../common/errors/app-error';

export type HypothesisStatus = 'draft' | 'ready' | 'running' | 'validated' | 'rejected';

export const HYPOTHESIS_STATUSES: readonly HypothesisStatus[] = ['draft', 'ready', 'running', 'validated', 'rejected'];

/** 终态（判定已落地；不可再推进） */
export const TERMINAL_HYPOTHESIS_STATUSES: readonly HypothesisStatus[] = ['validated', 'rejected'];

/** 允许的推进边（未列出的边一律拒绝——deny-by-default） */
const TRANSITIONS: Record<HypothesisStatus, readonly HypothesisStatus[]> = {
  draft: ['ready', 'rejected'],
  ready: ['running', 'rejected'],
  running: ['validated', 'rejected'],
  validated: [],
  rejected: [],
};

export function isHypothesisStatus(value: unknown): value is HypothesisStatus {
  return typeof value === 'string' && (HYPOTHESIS_STATUSES as readonly string[]).includes(value);
}

export function canTransition(from: HypothesisStatus, to: HypothesisStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

export function isTerminal(status: HypothesisStatus): boolean {
  return TERMINAL_HYPOTHESIS_STATUSES.includes(status);
}

/** 非法推进 → VALIDATION_ERROR（消息含 from → to，便于定位） */
export function assertTransition(from: HypothesisStatus, to: HypothesisStatus): void {
  if (!canTransition(from, to)) {
    throw new AppError(ErrorCode.VALIDATION_ERROR, `假设状态不允许该推进: ${from} → ${to}`);
  }
}

/** 该状态下 loop 是否处于"执行中"（启动/评测触发的前置条件） */
export function isLoopActive(status: HypothesisStatus): boolean {
  return status === 'running';
}
