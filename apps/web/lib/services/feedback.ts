import { apiFetch, jsonInit } from '@/lib/api';

/**
 * Feedback / Creative Performance service（M13-F1）
 * 后端：apps/api/src/modules/feedback/feedback.controller.ts（JwtAuthGuard；写端点限流 30/min）
 *
 * 口径：`POST /feedback/performance` 是**外部绩效数据入口**——正文数据一律视为 UNTRUSTED，
 * 仅做事实展示与派生展示（ctr/cvr/roas/cpc 由服务端计算，前端不得自算或改写）。
 * 该入口与 CreativeLoop 的来源判别强相关（external-only 谓词），页面必须如实标注来源。
 */
export type FeedbackSubjectType =
  | 'artifact' | 'creativeBrief' | 'product' | 'campaign' | 'ad' | 'generationTask' | 'agentRun' | 'analysis';

export interface Feedback {
  id: string;
  userId: string;
  projectId: string | null;
  subjectType: FeedbackSubjectType;
  subjectId: string;
  rating: number;
  comment: string | null;
  createdAt: string;
}

export interface CreateFeedbackInput {
  subjectType: FeedbackSubjectType;
  subjectId: string;
  rating: number;
  projectId?: string | null;
  comment?: string;
}

export interface PerformanceMetrics {
  impressions: number;
  clicks: number;
  spend: number;
  conversions: number;
  revenue: number;
  orders: number;
}

export interface CapturePerformanceInput {
  metrics: PerformanceMetrics;
  projectId?: string | null;
  artifactId?: string;
  campaignId?: string;
  adId?: string;
  platform?: string;
  periodStart?: string;
  periodEnd?: string;
}

export interface CapturePerformanceResult {
  performanceId: string;
  facts: PerformanceMetrics;
  derived: { ctr: number; cvr: number; roas: number; cpc: number };
  layering: unknown;
}

export interface CreativePerformance {
  id: string;
  userId: string;
  projectId: string | null;
  artifactId: string | null;
  campaignId: string | null;
  adId: string | null;
  platform: string | null;
  periodStart: string | null;
  periodEnd: string | null;
  impressions: number;
  clicks: number;
  spend: number;
  conversions: number;
  revenue: number;
  orders: number;
  capturedAt: string;
}

export interface PerformanceInsights {
  performanceMemory: Array<{ id: string; content: string; status: string; source: string | null }>;
  recentPerformance: Array<{ performanceId: string; subject: unknown; facts: unknown; derived: unknown; source: string }>;
  layering: unknown;
}

export const feedbackKeys = {
  list: (params: { subjectType?: FeedbackSubjectType; subjectId?: string } = {}) => ['feedback', params] as const,
  performance: (params: { artifactId?: string; campaignId?: string } = {}) => ['feedback-performance', params] as const,
  performanceInsights: (limit?: number) => ['feedback-performance-insights', limit ?? 10] as const,
};

/** POST /api/v1/feedback（评分 1–5） */
export const createFeedback = (input: CreateFeedbackInput) => apiFetch<{ data: Feedback }>('/api/v1/feedback', jsonInit('POST', input));

/** GET /api/v1/feedback（createdAt desc，take 50） */
export const listFeedback = (params: { subjectType?: FeedbackSubjectType; subjectId?: string } = {}) => {
  const qs = new URLSearchParams();
  if (params.subjectType) qs.set('subjectType', params.subjectType);
  if (params.subjectId) qs.set('subjectId', params.subjectId);
  const query = qs.toString();
  return apiFetch<{ data: Feedback[] }>(`/api/v1/feedback${query ? `?${query}` : ''}`);
};

/** POST /api/v1/feedback/performance（外部绩效事实入口；限流 30/min） */
export const capturePerformance = (input: CapturePerformanceInput) =>
  apiFetch<{ data: CapturePerformanceResult }>('/api/v1/feedback/performance', jsonInit('POST', input));

/** GET /api/v1/feedback/performance（capturedAt desc，take 50） */
export const listPerformance = (params: { artifactId?: string; campaignId?: string } = {}) => {
  const qs = new URLSearchParams();
  if (params.artifactId) qs.set('artifactId', params.artifactId);
  if (params.campaignId) qs.set('campaignId', params.campaignId);
  const query = qs.toString();
  return apiFetch<{ data: CreativePerformance[] }>(`/api/v1/feedback/performance${query ? `?${query}` : ''}`);
};

/** GET /api/v1/feedback/performance/insights（绩效记忆 + 近期绩效，含来源标注） */
export const getPerformanceInsights = (limit = 10) =>
  apiFetch<{ data: PerformanceInsights }>(`/api/v1/feedback/performance/insights?limit=${limit}`);
