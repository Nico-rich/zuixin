/**
 * Creative 工作台（M13-W4）视图层：**纯函数 + 类型收窄，无 React、无请求**。
 *
 * 为什么需要这一层：F1 契约（lib/services/creative.ts）刻意把 `facts/derived/interpretation/loop/verdict/history`
 * 标成 `unknown`（服务层不为「人肉形状」编码）。页面侧按后端真实形状收窄：
 *  - 洞察形状 → `insight-rules.ts` / `insight.service.ts` 的 build() 产出；
 *  - 假设形状 → `creative-loop-store.ts` 的 HypothesisDoc / HypothesisVerdict / HypothesisLoopRef；
 *  - loop 状态 → `loop-orchestrator.service.ts` 的 LoopStatusResult / LoopRunSummary / LoopPending / LoopRollback。
 *
 * 红线（页面侧只读纪律）：
 *  - facts / derived **只做展示**，页面从不计算、从不改写任何指标（计算一律在服务端 insight-rules.ts）；
 *  - 所有状态可见性判断（能否编辑/删除/启动/判定/挂接）都镜像后端规则，且**服务端才是裁决方**——
 *    前端禁用只是防误操作，绝不替代 RBAC/状态机校验；
 *  - 缺失字段如实留空（绝不臆造默认值），rollback 状态原样呈现（pending/failed 绝不被吞掉）。
 */

import type { HypothesisStatus, SuccessCriteria } from '@/lib/services/creative';

/** 后端视图的 unknown 字段 → 页面视图的显式收窄（唯一收窄入口，避免散落的 as any） */
export function asView<T>(value: unknown): T {
  return value as T;
}

/* ------------------------------ 洞察（三层） ------------------------------ */

export interface InsightFactsShape {
  window?: { start: string; end: string; days: number };
  performance?: {
    current?: Record<string, number>;
    previous?: Record<string, number>;
    sources?: { current?: number; previous?: number };
    rule?: string;
  };
  ratings?: {
    count?: number; avgRating?: number; distribution?: Record<string, number>;
    positiveRate?: number; negativeRate?: number; rule?: string;
  };
  evaluation?: { runs?: Array<Record<string, unknown>>; rule?: string };
}

export interface InsightComparisonEntry {
  metric: string; base: number; compare: number; changePct: number;
  direction: 'up' | 'down' | 'flat'; beyondThreshold: boolean; rule?: string;
}

export interface InsightDerivedShape {
  metrics?: Record<string, number>;
  baseline?: Record<string, number>;
  comparison?: InsightComparisonEntry[];
  ratingSummary?: { avgRating?: number; positiveRate?: number; negativeRate?: number };
  evaluation?: { runs?: number; avgScore?: number; passRate?: number; rule?: string } | null;
  rule?: string;
}

export interface InsightInterpretationShape {
  source?: string;
  items?: string[];
  model?: string | null;
  attachedAt?: string;
}

export interface InsightLayeringShape { facts?: string; derived?: string; interpretation?: string }

/** 分层标注（与后端 layering 字段同口径；页面据此如实标注每一层） */
export type InsightLayer = 'facts' | 'derived' | 'interpretation';

export const LAYER_META: Record<InsightLayer, {
  label: string;
  /** 后端 layering 字段中的来源值（如实展示，不美化） */
  source: string;
  hint: string;
}> = {
  facts: { label: '事实', source: 'service-computed', hint: '服务端对回流原始行的求和（只读聚合）' },
  derived: { label: '派生', source: 'service-computed', hint: '服务端按公式派生，绝不含 LLM 文本' },
  interpretation: { label: 'LLM 解读', source: 'llm-interpretation', hint: 'LLM 文本，独立字段与写入路径，绝不改写事实层' },
};

/** 事实层指标展示（只展示 facts 中真实存在的数值——缺失即不展示，绝不补零） */
export function perfFactPairs(facts?: InsightFactsShape | null): Array<[string, string]> {
  const current = facts?.performance?.current;
  if (!current) return [];
  const labels: Array<[string, keyof typeof current]> = [
    ['曝光', 'impressions'], ['点击', 'clicks'], ['花费', 'spend'],
    ['转化', 'conversions'], ['营收', 'revenue'], ['订单', 'orders'],
  ];
  return labels
    .filter(([, key]) => typeof current[key] === 'number')
    .map(([label, key]) => [label, String(current[key])]);
}

export function ratingFactPairs(facts?: InsightFactsShape | null): Array<[string, string]> {
  const ratings = facts?.ratings;
  if (!ratings) return [];
  const pairs: Array<[string, string]> = [];
  if (typeof ratings.count === 'number') pairs.push(['评分条数', String(ratings.count)]);
  if (typeof ratings.avgRating === 'number') pairs.push(['平均分', String(ratings.avgRating)]);
  if (typeof ratings.positiveRate === 'number') pairs.push(['好评率', String(ratings.positiveRate)]);
  if (typeof ratings.negativeRate === 'number') pairs.push(['差评率', String(ratings.negativeRate)]);
  return pairs;
}

/* ------------------------------ 假设（状态机） ------------------------------ */

/**
 * 假设状态机推进边（**展示用镜像**；唯一事实源 = 后端 `hypothesis-status.ts` 的 TRANSITIONS，
 * 裁决一律在服务端——本表只用来画状态机与禁用提示，绝不用于放行写操作）。
 */
export const HYPOTHESIS_TRANSITIONS: Record<HypothesisStatus, readonly HypothesisStatus[]> = {
  draft: ['ready', 'rejected'],
  ready: ['running', 'rejected'],
  running: ['validated', 'rejected'],
  validated: [],
  rejected: [],
};

export const HYPOTHESIS_STATUS_ORDER: readonly HypothesisStatus[] = ['draft', 'ready', 'running', 'validated', 'rejected'];

export const HYPOTHESIS_STATUS_LABEL: Record<HypothesisStatus, string> = {
  draft: '草稿', ready: '就绪', running: '执行中', validated: '已验证', rejected: '已驳回',
};

export function isTerminalStatus(status: HypothesisStatus): boolean {
  return status === 'validated' || status === 'rejected';
}

/* -- 操作可达性（镜像后端 HypothesesService / CreativeLoopOrchestrator 的判定；服务端仍是裁决方） -- */

/** 可编辑（后端 EDITABLE_STATUSES = draft|ready；running 起陈述已固化进 loop 定义与审批理由） */
export function canEditHypothesis(status: HypothesisStatus): boolean {
  return status === 'draft' || status === 'ready';
}
/** 可删除（后端 remove 仅允许 draft|rejected：已启动/已验证的假设行是历史事实，绝不删除） */
export function canDeleteHypothesis(status: HypothesisStatus): boolean {
  return status === 'draft' || status === 'rejected';
}
/** 人工提交就绪（draft → ready） */
export function canSubmitHypothesis(status: HypothesisStatus): boolean {
  return status === 'draft';
}
/** 人工放弃（draft|ready → rejected；running 需先等 run 结束或取消 run） */
export function canRejectHypothesis(status: HypothesisStatus): boolean {
  return status === 'draft' || status === 'ready';
}
/** 启动 loop（ready → running；running 时后端幂等返回现状，前端不再给入口） */
export function canStartHypothesis(status: HypothesisStatus): boolean {
  return status === 'ready';
}
/**
 * 判定（conclude）：draft/ready 仅 rejected 可达；running 需 run 已终态。
 * 服务端在「running 且 run 未终态」时一律 400——页面据 run 状态进一步禁用。
 */
export function canConcludeHypothesis(status: HypothesisStatus): boolean {
  return status === 'running' || status === 'draft' || status === 'ready';
}
/** 挂接评测/实验（后端仅允许 ready|running） */
export function canAttachHypothesis(status: HypothesisStatus): boolean {
  return status === 'ready' || status === 'running';
}

/**
 * 判定方式可达性（镜像后端语义，**不是**前端自创规则）：
 *  - `criteria`（无 decision = 服务端按判据 + 事实判定）只在 **running** 且声明了判据时可选——
 *    因为判据收敛可能产出 validated，而 draft/ready → validated 是非法边（服务端 400）；
 *  - `validated` 仅 running 可达（状态机无 draft/ready→validated 边）；
 *  - `rejected` 在 draft/ready/running 均可达（人工放弃/驳回）。
 */
export function concludeDecisionOptions(
  status: HypothesisStatus,
  hasCriteria: boolean,
): ReadonlyArray<'criteria' | 'validated' | 'rejected'> {
  const options: Array<'criteria' | 'validated' | 'rejected'> = [];
  if (status === 'running' && hasCriteria) options.push('criteria');
  if (HYPOTHESIS_TRANSITIONS[status].includes('validated')) options.push('validated');
  if (HYPOTHESIS_TRANSITIONS[status].includes('rejected')) options.push('rejected');
  return options;
}

/** run 终态（与后端 loop-orchestrator RUN_TERMINAL 同口径；cancelled 需人工判定） */
export const RUN_TERMINAL_STATUSES: readonly string[] = ['completed', 'failed', 'cancelled', 'timeout'];

export function isRunTerminal(status: string | null | undefined): boolean {
  return typeof status === 'string' && RUN_TERMINAL_STATUSES.includes(status);
}

/**
 * 判定是否被未终态的 run 挡住（后端 `conclude`：running 且 run 未终态 → 400）。
 * 无 run 时不算挡住（状态机允许 draft/ready→rejected，或按判据收敛）。
 */
export function concludeBlockedByRun(hypothesisStatus: HypothesisStatus, runStatus: string | null | undefined): boolean {
  if (hypothesisStatus !== 'running') return false;
  if (!runStatus) return false;
  return !isRunTerminal(runStatus);
}

/* ------------------------------ 格式化 ------------------------------ */

export function formatDateTime(value: string | null | undefined): string {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString();
}

export function shortId(value: string | null | undefined): string {
  if (!value) return '—';
  return value.length <= 12 ? value : `${value.slice(0, 8)}…`;
}

/** 判据文本（如 `avg_score ≥ 0.8`）；无判据 → null（绝不臆造判据） */
export function criteriaText(criteria: SuccessCriteria | null | undefined): string | null {
  if (!criteria) return null;
  return `${criteria.metric} ${criteria.op === 'gte' ? '≥' : '≤'} ${criteria.value}`;
}

export function windowLabel(window: { start: string; end: string; days: number } | undefined | null): string {
  if (!window) return '窗口未知';
  return `${window.days} 天（${formatDateTime(window.start)} → ${formatDateTime(window.end)}）`;
}

/* ------------------------------ 轮询策略 ------------------------------ */

/** 轮询间隔（ms）：仅「执行中（running）」态轮询；终态/未启动一律停止（终态只读，无新事实产生） */
export const POLL_INTERVAL_MS = 3000;

export function pollIntervalFor(status: HypothesisStatus | null | undefined): number | false {
  return status === 'running' ? POLL_INTERVAL_MS : false;
}

/* ------------------------------ loop / 判定 / 回滚视图 ------------------------------ */

export interface VerdictShape {
  decision?: 'validated' | 'rejected';
  decidedBy?: 'criteria' | 'manual' | 'system';
  reason?: string;
  criteria?: SuccessCriteria | null;
  facts?: Record<string, unknown> | null;
  evaluationRunId?: string | null;
  experimentId?: string | null;
  decidedAt?: string;
}

export interface HistoryEntryShape { from?: HypothesisStatus; to?: HypothesisStatus; at?: string; by?: string }
export interface LoopRefShape { workflowId?: string; runId?: string; attempts?: number; startedAt?: string }

export interface RunStepShape {
  stepId?: string; stepIndex?: number; stepType?: string; status?: string; attempt?: number;
  approvalId?: string | null; externalActionId?: string | null; agentRunId?: string | null;
  startedAt?: string | null; completedAt?: string | null; errorCode?: string | null;
}

export interface RunViewShape {
  runId?: string; workflowId?: string; versionId?: string; version?: number;
  status?: string; attempt?: number; currentStep?: number; waitingOnApprovalId?: string | null;
  startedAt?: string | null; completedAt?: string | null; errorCode?: string | null;
  output?: unknown; steps?: RunStepShape[];
}

export interface PendingShape { reason?: string | null; detail?: string }

export interface RollbackShape {
  required?: boolean;
  status?: 'not-required' | 'pending' | 'completed' | 'failed';
  publishActionId?: string | null;
  compensateStepId?: string | null;
  errorCode?: string | null;
  detail?: string | null;
}

/** 待办原因的中文标注（reason 字面量来自后端 LoopPending.reason，原样保留在括号中） */
export const PENDING_LABEL: Record<string, string> = {
  'awaiting-approval': '待人工审批',
  observing: '绩效观察窗',
  'awaiting-facts': '等待回流事实满足判据',
  'awaiting-criteria': '待显式判定',
  'cancelled-needs-verdict': 'run 已取消，需人工判定',
  'run-failed-needs-verdict': 'run 失败，需人工判定',
};

/** 回滚状态标注（**pending/failed 必须被看见**——补偿失败绝不重试，需人工兜底） */
export const ROLLBACK_LABEL: Record<string, string> = {
  'not-required': '无需回滚（平台写操作未执行）',
  pending: '待回滚（已发布但未见补偿链留痕）',
  completed: '已回滚（补偿链已完成）',
  failed: '回滚失败（需人工处理）',
};
