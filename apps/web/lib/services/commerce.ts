import { apiFetch } from '@/lib/api';

/**
 * Commerce service（M13-W9 只读展示面）
 * 后端：apps/api/src/modules/commerce/commerce.controller.ts（透传既有 CommerceAnalysisService）
 *
 * 产品口径（页面必须如实标注，不得软化）：**工具即接口**——
 * 电商域的写路径（采集 / 分析 / 建简报）全部由 Agent 工具执行并落在 ToolCall 幂等账本里；
 * 本 service 只有 GET，**没有**建分析 / 改简报的函数（HTTP 面不存在第二条写入路径）。
 *
 * 分层红线：`facts / derived / anomalies = 服务端计算`，`possibleCauses / recommendations = LLM 推测`。
 * 详情响应的 `layering` 是服务端给出的标注，页面据此分别呈现，**绝不把推测渲染成事实**。
 */

export type CommerceAnalysisType =
  | 'sales' | 'traffic' | 'conversion' | 'ads' | 'roas' | 'revenue' | 'inventory' | 'composite';

export interface TimeRange { start?: string; end?: string; days?: number }

export interface CommerceAnalysisListItem {
  analysisId: string;
  analysisType: CommerceAnalysisType | string;
  status: string;
  timeRange: TimeRange | null;
  agentRunId: string | null;
  createdAt: string;
}

/** 服务端分层标注（原样透出：前端不得自行改写/省略） */
export interface CommerceLayering {
  facts?: string;
  derived?: string;
  anomalies?: string;
  possibleCauses?: string;
  recommendations?: string;
  [k: string]: string | undefined;
}

export interface CommerceAnalysisDetail extends CommerceAnalysisListItem {
  facts: unknown;
  derived: unknown;
  anomalies: unknown;
  possibleCauses: unknown;
  recommendations: unknown;
  layering: CommerceLayering;
}

export interface CreativeBriefListItem {
  briefId: string;
  problem: string;
  objective: string;
  platform: string | null;
  status: string;
  /** 简报镜像的制品 id（有则在制品库可见） */
  artifactId: string | null;
  /** 证据来源分析（无证据时为 null） */
  analysisId: string | null;
  createdAt: string;
}

/** 简报详情（后端透传既有行：problem/objective 由人给，创意方向为 LLM 建议，evidence 为事实快照） */
export interface CreativeBriefDetail {
  id: string;
  problem: string;
  target: string | null;
  objective: string;
  creativeAngle: string | null;
  visualDirection: string | null;
  copyDirection: string | null;
  constraints: unknown;
  platform: string | null;
  product: unknown;
  evidence: unknown;
  status: string;
  artifactId: string | null;
  commerceAnalysisId: string | null;
  createdAt: string;
  updatedAt: string;
}

export const commerceKeys = {
  analyses: ['commerce-analyses'] as const,
  briefs: ['commerce-briefs'] as const,
  analysis: (id: string) => ['commerce-analysis', id] as const,
  brief: (id: string) => ['commerce-brief', id] as const,
};

/** GET /api/v1/commerce/analyses（服务端按 JWT 归属过滤；证据体只在详情端点） */
export function listCommerceAnalyses(params: { limit?: number } = {}) {
  const suffix = params.limit ? `?limit=${params.limit}` : '';
  return apiFetch<{ data: CommerceAnalysisListItem[] }>(`/api/v1/commerce/analyses${suffix}`);
}

/** GET /api/v1/commerce/analyses/:id */
export function getCommerceAnalysis(id: string) {
  return apiFetch<{ data: CommerceAnalysisDetail }>(`/api/v1/commerce/analyses/${encodeURIComponent(id)}`);
}

/** GET /api/v1/commerce/briefs */
export function listCreativeBriefs(params: { limit?: number } = {}) {
  const suffix = params.limit ? `?limit=${params.limit}` : '';
  return apiFetch<{ data: CreativeBriefListItem[] }>(`/api/v1/commerce/briefs${suffix}`);
}

/** GET /api/v1/commerce/briefs/:id */
export function getCreativeBrief(id: string) {
  return apiFetch<{ data: CreativeBriefDetail }>(`/api/v1/commerce/briefs/${encodeURIComponent(id)}`);
}
