import { apiFetch, jsonInit } from '@/lib/api';

/**
 * Approvals service（M13-W9）
 * 后端：apps/api/src/modules/approvals/approvals.controller.ts（既有面，W9 **只消费不新增语义**）
 *
 * 审批是"人决定、LLM 不参与"的治理卡点：
 *  - 决定只能由本人在 Web 上点出（POST approve/reject），**LLM/Agent 无权代决**；
 *  - 判定的对象是**绑定 action**（`payload.__binding = { actionType, payloadHash, boundAt }`）——
 *    页面只展示 actionType + payloadHash 作为摘要，**绝不渲染 payload 的其余内容**
 *    （payload 可能携带上游敏感入参；绑定摘要足以让人确认"我在批哪一类动作"）；
 *  - 服务端是裁决方：重复/过期决定 → 409 APPROVAL_NOT_PENDING / APPROVAL_EXPIRED，
 *    跨用户一律 404（前端不做任何存在性推断）。
 */

export type ApprovalStatus = 'requested' | 'approved' | 'rejected' | 'expired' | 'cancelled';

/** 审批绑定摘要（唯一允许在前端展示的 payload 片段） */
export interface ApprovalBinding {
  actionType?: string;
  payloadHash?: string;
  boundAt?: string;
}

/**
 * 审批行：`payload` 只保留 `__binding` 的类型位——**页面禁止把它整体渲染**。
 * 其余 payload 字段在类型层面就不可见（避免"顺手 JSON.stringify 打屏"）。
 */
export interface ApprovalItem {
  id: string;
  status: ApprovalStatus;
  riskLevel: 'low' | 'medium' | 'high' | string;
  reason: string;
  projectId: string | null;
  agentRunId: string | null;
  toolCallId: string | null;
  expiresAt: string | null;
  approvedAt: string | null;
  rejectedAt: string | null;
  cancelledAt: string | null;
  createdAt: string;
  updatedAt: string;
  payload: { __binding?: ApprovalBinding } | null;
}

export const approvalKeys = {
  list: (status: ApprovalStatus | 'all' = 'all') => ['approvals', status] as const,
};

/** GET /api/v1/approvals（服务端按 JWT 归属过滤；默认最近 50 条） */
export function listApprovals(params: { status?: ApprovalStatus; agentRunId?: string } = {}) {
  const q = new URLSearchParams();
  if (params.status) q.set('status', params.status);
  if (params.agentRunId) q.set('agentRunId', params.agentRunId);
  const suffix = q.toString();
  return apiFetch<{ data: ApprovalItem[] }>(`/api/v1/approvals${suffix ? `?${suffix}` : ''}`);
}

/** POST /api/v1/approvals/:id/approve（唤醒等待中的 run；绑定不可改写） */
export function approveApproval(id: string) {
  return apiFetch<{ data: ApprovalItem }>(`/api/v1/approvals/${encodeURIComponent(id)}/approve`, jsonInit('POST'));
}

/** POST /api/v1/approvals/:id/reject（run 按拒绝结果继续/终止） */
export function rejectApproval(id: string) {
  return apiFetch<{ data: ApprovalItem }>(`/api/v1/approvals/${encodeURIComponent(id)}/reject`, jsonInit('POST'));
}
