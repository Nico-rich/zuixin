import { apiFetch, jsonInit } from '@/lib/api';

/**
 * Creative Loop service（M13-F1）
 * 后端：apps/api/src/modules/creative-loop/creative-loop.controller.ts
 *
 * **路径基是 `creative-loop` 而不是 `creative`**（页面路由 /creative 与之无关）。
 * 视图类型是「文档 + id/createdAt/updatedAt」（InsightView/HypothesisView），不是裸 Prisma 行。
 *
 * 领域红线（页面必须如实呈现，不得软化）：
 *  - `verdict`/`conclude` 的结论由人工/评测给出，**LLM 不决定治理判定**；
 *  - `rollback` 的外部副作用补偿状态必须原样展示（pending/failed 不能被吞掉）；
 *  - 请求体是 strictObject（多余字段会被 400 拒绝）。
 */
export type HypothesisStatus = 'draft' | 'ready' | 'running' | 'validated' | 'rejected';

export interface InsightWindow { start: string; end: string; days: number }

export interface InsightView {
  id: string;
  kind: string;
  organizationId: string;
  projectId: string | null;
  window: InsightWindow;
  filters: unknown;
  facts: unknown;
  derived: unknown;
  factsHash: string;
  interpretation: unknown;
  layering: unknown;
  createdAt: string;
  updatedAt: string;
}

export interface SuccessCriteria {
  metric: 'avg_score' | 'pass_rate' | 'roas' | 'ctr';
  op: 'gte' | 'lte';
  value: number;
}

export interface HypothesisView {
  id: string;
  kind: string;
  organizationId: string;
  projectId: string | null;
  status: HypothesisStatus;
  statement: string;
  rationale: string | null;
  target: string | null;
  platform: string | null;
  insightId: string | null;
  successCriteria: SuccessCriteria | null;
  loop: unknown;
  evaluationRunId: string | null;
  baselineRunId: string | null;
  experimentId: string | null;
  verdict: unknown;
  history: unknown;
  terminal: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface LoopRunSummary {
  id: string;
  status: string;
  startedAt: string | null;
  completedAt: string | null;
  [k: string]: unknown;
}

export interface LoopStatusResult {
  hypothesis: HypothesisView;
  run: LoopRunSummary | null;
  insightId: string | null;
  insightFactsHash: string | null;
  pending: { reason: string | null; detail: string };
  rollback: {
    required: boolean;
    status: 'not-required' | 'pending' | 'completed' | 'failed';
    publishActionId?: string | null;
    compensateStepId?: string | null;
    errorCode?: string | null;
    detail?: string | null;
  };
}

export const creativeKeys = {
  insights: (params: { organizationId?: string; projectId?: string; limit?: number } = {}) => ['creative-insights', params] as const,
  insight: (id: string) => ['creative-insight', id] as const,
  hypotheses: (params: { organizationId?: string; projectId?: string; status?: HypothesisStatus; limit?: number } = {}) => ['creative-hypotheses', params] as const,
  hypothesis: (id: string) => ['creative-hypothesis', id] as const,
  status: (id: string) => ['creative-hypothesis-status', id] as const,
};

/* ------------------------------- Insights ------------------------------- */

/** POST /api/v1/creative-loop/insights（构建洞察；含 facts/derived/layering） */
export const buildInsight = (input: {
  organizationId?: string; projectId?: string; days?: number; artifactId?: string; campaignId?: string; includeEvaluation?: boolean;
}) => apiFetch<{ data: InsightView }>('/api/v1/creative-loop/insights', jsonInit('POST', input));

/** GET /api/v1/creative-loop/insights（注意 data 里还有一层 `insights`） */
export const listInsights = (params: { organizationId?: string; projectId?: string; limit?: number } = {}) => {
  const qs = new URLSearchParams();
  if (params.organizationId) qs.set('organizationId', params.organizationId);
  if (params.projectId) qs.set('projectId', params.projectId);
  if (params.limit) qs.set('limit', String(params.limit));
  const query = qs.toString();
  return apiFetch<{ data: { insights: InsightView[] } }>(`/api/v1/creative-loop/insights${query ? `?${query}` : ''}`);
};

/** GET /api/v1/creative-loop/insights/:id */
export const getInsight = (id: string) => apiFetch<{ data: InsightView }>(`/api/v1/creative-loop/insights/${id}`);

/** POST /api/v1/creative-loop/insights/:id/interpretation（人工输入要点，LLM 只做解读） */
export const interpretInsight = (id: string, input: { items: string[]; model?: string | null }) =>
  apiFetch<{ data: InsightView }>(`/api/v1/creative-loop/insights/${id}/interpretation`, jsonInit('POST', input));

/* ------------------------------ Hypotheses ------------------------------ */

export interface CreateHypothesisInput {
  statement: string;
  rationale?: string | null;
  target?: string | null;
  platform?: string | null;
  insightId?: string | null;
  successCriteria?: SuccessCriteria;
  organizationId?: string;
  projectId?: string;
}

/** POST /api/v1/creative-loop/hypotheses */
export const createHypothesis = (input: CreateHypothesisInput) =>
  apiFetch<{ data: HypothesisView }>('/api/v1/creative-loop/hypotheses', jsonInit('POST', input));

/** GET /api/v1/creative-loop/hypotheses（data 里还有一层 `hypotheses`） */
export const listHypotheses = (params: { organizationId?: string; projectId?: string; status?: HypothesisStatus; limit?: number } = {}) => {
  const qs = new URLSearchParams();
  if (params.organizationId) qs.set('organizationId', params.organizationId);
  if (params.projectId) qs.set('projectId', params.projectId);
  if (params.status) qs.set('status', params.status);
  if (params.limit) qs.set('limit', String(params.limit));
  const query = qs.toString();
  return apiFetch<{ data: { hypotheses: HypothesisView[] } }>(`/api/v1/creative-loop/hypotheses${query ? `?${query}` : ''}`);
};

/** GET /api/v1/creative-loop/hypotheses/:id */
export const getHypothesis = (id: string) => apiFetch<{ data: HypothesisView }>(`/api/v1/creative-loop/hypotheses/${id}`);

/** PATCH /api/v1/creative-loop/hypotheses/:id */
export const updateHypothesis = (id: string, input: Partial<CreateHypothesisInput> & { successCriteria?: SuccessCriteria | null }) =>
  apiFetch<{ data: HypothesisView }>(`/api/v1/creative-loop/hypotheses/${id}`, jsonInit('PATCH', input));

/** POST /api/v1/creative-loop/hypotheses/:id/status（人工确认就绪 / 驳回） */
export const setHypothesisStatus = (id: string, input: { status: 'ready' | 'rejected'; reason?: string }) =>
  apiFetch<{ data: HypothesisView }>(`/api/v1/creative-loop/hypotheses/${id}/status`, jsonInit('POST', input));

/** DELETE /api/v1/creative-loop/hypotheses/:id */
export const deleteHypothesis = (id: string) =>
  apiFetch<{ data: { deleted: true } }>(`/api/v1/creative-loop/hypotheses/${id}`, { method: 'DELETE' });

/** POST /api/v1/creative-loop/hypotheses/:id/start（限流 30/min；外部副作用走审批+补偿） */
export const startHypothesis = (id: string, input: {
  waitMs?: number; platform?: string; actionType?: string; connectionId?: string; agentId?: string;
  riskLevel?: 'low' | 'medium' | 'high'; approvalReason?: string; target?: string;
}) => apiFetch<{ data: LoopStatusResult }>(`/api/v1/creative-loop/hypotheses/${id}/start`, jsonInit('POST', input));

/** GET /api/v1/creative-loop/hypotheses/:id/status */
export const getHypothesisStatus = (id: string) =>
  apiFetch<{ data: LoopStatusResult }>(`/api/v1/creative-loop/hypotheses/${id}/status`);

/** GET /api/v1/creative-loop/hypotheses/:id/run */
export const getHypothesisRun = (id: string) =>
  apiFetch<{ data: { hypothesis: HypothesisView; run: LoopRunSummary | null; pending: unknown; rollback: unknown } }>(
    `/api/v1/creative-loop/hypotheses/${id}/run`,
  );

/** POST /api/v1/creative-loop/hypotheses/:id/conclude（人工判定 validated/rejected） */
export const concludeHypothesis = (id: string, input: { decision?: 'validated' | 'rejected'; reason?: string } = {}) =>
  apiFetch<{ data: LoopStatusResult }>(`/api/v1/creative-loop/hypotheses/${id}/conclude`, jsonInit('POST', input));

/** POST /api/v1/creative-loop/hypotheses/:id/evaluation（绑定评测运行，评测与流量选路严格分离） */
export const attachHypothesisEvaluation = (id: string, evaluationRunId: string) =>
  apiFetch<{ data: LoopStatusResult }>(`/api/v1/creative-loop/hypotheses/${id}/evaluation`, jsonInit('POST', { evaluationRunId }));

/** POST /api/v1/creative-loop/hypotheses/:id/experiment（绑定实验，仅评测对照） */
export const attachHypothesisExperiment = (id: string, experimentId: string) =>
  apiFetch<{ data: LoopStatusResult }>(`/api/v1/creative-loop/hypotheses/${id}/experiment`, jsonInit('POST', { experimentId }));
