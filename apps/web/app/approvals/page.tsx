'use client';

import { useState } from 'react';
import { ShieldCheck } from 'lucide-react';
import { useApiMutation, useApiQuery, useApiQueryClient } from '@/lib/api';
import {
  ApprovalItem, ApprovalStatus, approvalKeys, approveApproval, rejectApproval,
} from '@/lib/services/approvals';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Select } from '@/components/ui/select';
import { SkeletonLines } from '@/components/ui/skeleton';
import { useToast } from '@/components/ui/toast';

/**
 * /approvals —— 审批页（M13-W9）
 *
 * 补的是**闭环断裂之一**的下游半环：run 卡在 `waiting_approval` 时，事件流已由
 * `chat.service.ts` 白名单透传（approval.requested / delegation.waiting），但用户此前**无处可批**。
 * 本页是审批决定的唯一 UI 入口，并且：
 *  - 决定由**人**做出：`approve`/`reject` 是显式点击 + Dialog 二次确认，LLM/Agent 无权代决；
 *  - 判定对象是**绑定 action**：页面只展示 `payload.__binding` 摘要（actionType + payloadHash + boundAt），
 *    **绝不渲染 payload 其余内容**（可能含上游敏感入参），也不允许在页面上改写绑定；
 *  - 服务端是裁决方：重复/过期决定会以 409 返回，页面据此刷新列表（不做本地乐观改状态）。
 */

const STATUS_OPTIONS: Array<{ value: ApprovalStatus | 'all'; label: string }> = [
  { value: 'requested', label: '待审批' },
  { value: 'approved', label: '已通过' },
  { value: 'rejected', label: '已拒绝' },
  { value: 'cancelled', label: '已撤销' },
  { value: 'expired', label: '已过期' },
  { value: 'all', label: '全部' },
];

const STATUS_VARIANT: Record<string, 'success' | 'destructive' | 'warning' | 'secondary' | 'default'> = {
  requested: 'warning',
  approved: 'success',
  rejected: 'destructive',
  cancelled: 'secondary',
  expired: 'default',
};

const RISK_VARIANT: Record<string, 'destructive' | 'warning' | 'secondary'> = {
  high: 'destructive',
  medium: 'warning',
  low: 'secondary',
};

const fmt = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleString() : '—');

interface Decision { item: ApprovalItem; action: 'approve' | 'reject' }

export default function ApprovalsPage() {
  const [status, setStatus] = useState<ApprovalStatus | 'all'>('requested');
  const [decision, setDecision] = useState<Decision | null>(null);
  const queryClient = useApiQueryClient();
  const { toast } = useToast();

  const query = useApiQuery<{ data: ApprovalItem[] }>({
    queryKey: approvalKeys.list(status),
    path: `/api/v1/approvals${status === 'all' ? '' : `?status=${status}`}`,
  });

  const decide = useApiMutation(
    ({ item, action }: Decision) => (action === 'approve' ? approveApproval(item.id) : rejectApproval(item.id)),
    {
      onSuccess: (_res, vars) => {
        setDecision(null);
        toast({
          title: vars.action === 'approve' ? '已通过' : '已拒绝',
          description: '服务端将唤醒等待中的运行（本页不做本地状态改写）',
          variant: 'success',
        });
        void queryClient.invalidateQueries({ queryKey: ['approvals'] });
      },
      onError: (error) => {
        setDecision(null);
        toast({
          title: '决定未生效',
          description: error.code === 'APPROVAL_NOT_PENDING' || error.code === 'APPROVAL_EXPIRED'
            ? '该审批已被处理或已过期，列表已刷新'
            : error.message,
          variant: 'error',
        });
        void queryClient.invalidateQueries({ queryKey: ['approvals'] });
      },
    },
  );

  const items = query.data?.data ?? [];
  const binding = decision?.item.payload?.__binding;

  return (
    <div className="mx-auto max-w-3xl px-4 py-8">
      <div className="mb-6 flex flex-wrap items-baseline justify-between gap-2">
        <h1 className="text-lg font-semibold text-zinc-100">审批</h1>
        <span className="text-xs text-zinc-500">
          决定由人做出 · 绑定到固定 action · LLM 不参与判定
        </span>
      </div>

      <div className="mb-4 flex items-center gap-2">
        <label htmlFor="approval-status" className="text-xs text-zinc-500">状态</label>
        <Select
          id="approval-status"
          aria-label="审批状态"
          className="h-9 w-40"
          value={status}
          onChange={(e) => { setStatus(e.target.value as ApprovalStatus | 'all'); }}
        >
          {STATUS_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </Select>
      </div>

      {query.isPending && <SkeletonLines lines={4} />}
      {query.isError && <p className="p-4 text-sm text-red-400">审批列表加载失败：{query.error.message}</p>}
      {!query.isPending && !query.isError && items.length === 0 && (
        <p className="py-12 text-center text-sm text-zinc-500">没有符合该状态的审批请求</p>
      )}

      <ul className="space-y-2">
        {items.map((item) => {
          const b = item.payload?.__binding;
          return (
            <li key={item.id}>
              <Card data-testid={`approval-${item.id}`}>
                <CardHeader className="flex-row items-center justify-between gap-3">
                  <CardTitle className="min-w-0 flex-1 truncate" title={item.reason}>{item.reason}</CardTitle>
                  <span className="flex shrink-0 items-center gap-2">
                    <Badge variant={RISK_VARIANT[item.riskLevel] ?? 'secondary'}>风险 {item.riskLevel}</Badge>
                    <Badge variant={STATUS_VARIANT[item.status] ?? 'default'}>{item.status}</Badge>
                  </span>
                </CardHeader>
                <CardContent className="space-y-3">
                  <dl className="grid grid-cols-1 gap-x-6 gap-y-1 text-xs text-zinc-400 sm:grid-cols-2">
                    <div className="flex gap-2">
                      <dt className="shrink-0 text-zinc-500">绑定 action</dt>
                      <dd className="min-w-0 break-all font-mono text-zinc-300">
                        {b?.actionType ?? '（无绑定信息）'}
                      </dd>
                    </div>
                    <div className="flex gap-2">
                      <dt className="shrink-0 text-zinc-500">payload 指纹</dt>
                      <dd className="min-w-0 break-all font-mono text-zinc-300">{b?.payloadHash ?? '—'}</dd>
                    </div>
                    <div className="flex gap-2">
                      <dt className="shrink-0 text-zinc-500">发起时间</dt>
                      <dd>{fmt(item.createdAt)}</dd>
                    </div>
                    <div className="flex gap-2">
                      <dt className="shrink-0 text-zinc-500">失效时间</dt>
                      <dd>{fmt(item.expiresAt)}</dd>
                    </div>
                    <div className="flex gap-2">
                      <dt className="shrink-0 text-zinc-500">关联运行</dt>
                      <dd className="min-w-0 break-all font-mono">{item.agentRunId ?? '—'}</dd>
                    </div>
                    <div className="flex gap-2">
                      <dt className="shrink-0 text-zinc-500">工具调用</dt>
                      <dd className="min-w-0 break-all font-mono">{item.toolCallId ?? '—'}</dd>
                    </div>
                  </dl>

                  {item.status === 'requested' ? (
                    <div className="flex items-center gap-2">
                      <Button
                        size="sm"
                        disabled={decide.isPending}
                        aria-label={`通过审批：${item.reason}`}
                        onClick={() => setDecision({ item, action: 'approve' })}
                      >
                        通过
                      </Button>
                      <Button
                        size="sm"
                        variant="destructive"
                        disabled={decide.isPending}
                        aria-label={`拒绝审批：${item.reason}`}
                        onClick={() => setDecision({ item, action: 'reject' })}
                      >
                        拒绝
                      </Button>
                      <span className="text-xs text-zinc-500">决定一经提交不可改写</span>
                    </div>
                  ) : (
                    <p className="text-xs text-zinc-500">
                      已处理：{item.status}
                      {item.approvedAt ? `（${fmt(item.approvedAt)}）` : ''}
                      {item.rejectedAt ? `（${fmt(item.rejectedAt)}）` : ''}
                      {item.cancelledAt ? `（${fmt(item.cancelledAt)}）` : ''}
                    </p>
                  )}
                </CardContent>
              </Card>
            </li>
          );
        })}
      </ul>

      <Dialog open={decision !== null} onOpenChange={(open) => { if (!open) setDecision(null); }}>
        <DialogHeader>
          <DialogTitle>{decision?.action === 'approve' ? '确认通过该审批？' : '确认拒绝该审批？'}</DialogTitle>
          <DialogDescription>
            决定绑定到下方固定 action，提交后不可改写；LLM 不参与该判定。
          </DialogDescription>
        </DialogHeader>
        <DialogContent>
          <dl className="space-y-2 text-xs">
            <div className="flex gap-2">
              <dt className="w-24 shrink-0 text-zinc-500">理由</dt>
              <dd className="min-w-0 flex-1 text-zinc-200">{decision?.item.reason}</dd>
            </div>
            <div className="flex gap-2">
              <dt className="w-24 shrink-0 text-zinc-500">风险等级</dt>
              <dd className="min-w-0 flex-1 text-zinc-200">{decision?.item.riskLevel}</dd>
            </div>
            <div className="flex gap-2">
              <dt className="w-24 shrink-0 text-zinc-500">绑定 action</dt>
              <dd className="min-w-0 flex-1 break-all font-mono text-zinc-200">
                {binding?.actionType ?? '（无绑定信息）'}
              </dd>
            </div>
            <div className="flex gap-2">
              <dt className="w-24 shrink-0 text-zinc-500">payload 指纹</dt>
              <dd className="min-w-0 flex-1 break-all font-mono text-zinc-200">{binding?.payloadHash ?? '—'}</dd>
            </div>
            <div className="flex gap-2">
              <dt className="w-24 shrink-0 text-zinc-500">绑定时间</dt>
              <dd className="min-w-0 flex-1 text-zinc-200">{fmt(binding?.boundAt)}</dd>
            </div>
          </dl>
          <p className="mt-3 flex items-start gap-2 text-xs text-zinc-500">
            <ShieldCheck className="mt-0.5 size-3.5 shrink-0" aria-hidden />
            <span>
              敏感 payload 不在页面展示（可能含上游入参）——判定依据就是上面的绑定摘要。
              通过后由服务端唤醒等待中的运行；拒绝会让运行按失败结果继续。
            </span>
          </p>
        </DialogContent>
        <DialogFooter>
          <Button variant="ghost" onClick={() => setDecision(null)}>取消</Button>
          <Button
            variant={decision?.action === 'reject' ? 'destructive' : 'default'}
            disabled={decide.isPending}
            onClick={() => { if (decision) decide.mutate(decision); }}
          >
            {decide.isPending ? '提交中…' : decision?.action === 'approve' ? '确认通过' : '确认拒绝'}
          </Button>
        </DialogFooter>
      </Dialog>
    </div>
  );
}
