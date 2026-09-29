'use client';

import { useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableEmpty, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { useToast } from '@/components/ui/toast';
import { useApiMutation, useApiQuery, useApiQueryClient, type ApiError } from '@/lib/api';
import { redirectTo } from '@/lib/redirect';
import {
  connectionKeys, deleteConnection, refreshConnection, revokeConnection, startConnection,
  type ConnectionView,
} from '@/lib/services/connections';

/**
 * 连接（M13-W5）：外部平台 OAuth 连接的列表与生命周期操作。
 *
 * **凭证红线（路线图 §4）**：连接视图（后端 CONNECTION_SELECT）永不含 access token / refresh token /
 * secret；OAuth 授权只走 `start` 下发的 authorizeUrl（前端只做跳转，绝不接触授权码或凭证）。
 * 本页在渲染侧再收一次口：`toRow()` 只挑白名单字段，绝不 `{...connection}` 展开、
 * 绝不 JSON.stringify 连接对象 —— 单测用「响应里注入 accessToken/refreshToken/credentials」钉死该行为。
 *
 * 错误口径：409（已吊销/不可刷新）、404（provider 未注册）、429（发起限流 30/min）一律如实展示
 * 服务端 code + message，不做前端猜测。
 */

const STATUS_VARIANT: Record<ConnectionView['status'], 'success' | 'warning' | 'destructive'> = {
  active: 'success',
  expired: 'warning',
  revoked: 'destructive',
};

/** 行投影（白名单）：页面渲染只认这个结构，任何凭证字段都不可能进来 */
interface ConnectionRow {
  id: string;
  provider: string;
  providerAccountId: string | null;
  status: ConnectionView['status'];
  /** 授权范围**条目数**（scope 是 provider 原始 JSON，只计数不回显内容） */
  scopeCount: number | null;
  expiresAt: string | null;
  lastSyncedAt: string | null;
  createdAt: string;
}

function toRow(c: ConnectionView): ConnectionRow {
  return {
    id: c.id,
    provider: c.provider,
    providerAccountId: c.providerAccountId,
    status: c.status,
    scopeCount: Array.isArray(c.scope) ? c.scope.length : null,
    expiresAt: c.expiresAt,
    lastSyncedAt: c.lastSyncedAt,
    createdAt: c.createdAt,
  };
}

const fmtTime = (value: string | null): string => (value ? new Date(value).toLocaleString() : '—');
const errText = (e: ApiError): string => `${e.message}（${e.code}）`;

type PendingAction = { kind: 'revoke' | 'delete'; row: ConnectionRow };

export default function ConnectionsPage() {
  const queryClient = useApiQueryClient();
  const { toast } = useToast();
  const [provider, setProvider] = useState('mock');
  const [pending, setPending] = useState<PendingAction | null>(null);
  const [actionError, setActionError] = useState('');
  const [notice, setNotice] = useState('');

  const list = useApiQuery<{ data: ConnectionView[] }>({
    queryKey: connectionKeys.list(),
    path: '/api/v1/connections',
  });

  const invalidate = () => queryClient.invalidateQueries({ queryKey: connectionKeys.all });
  const fail = (e: ApiError) => { setNotice(''); setActionError(errText(e)); };

  const start = useApiMutation<{ data: { authorizeUrl: string; state: string } }, void>(
    () => startConnection(provider.trim(), {}),
    {
      onSuccess: (res) => {
        setActionError('');
        setNotice(`已发起 ${provider.trim()} 授权，正在跳转到授权页…`);
        toast({ title: '已发起授权', description: '跳转到外部平台完成授权后返回本页刷新', variant: 'success' });
        redirectTo(res.data.authorizeUrl);
      },
      onError: (e) => { setActionError(errText(e)); setNotice(''); },
    },
  );

  const refresh = useApiMutation((id: string) => refreshConnection(id), {
    onSuccess: (res) => {
      setActionError('');
      setNotice(`连接 ${res.data.provider} 已刷新（状态 ${res.data.status}）`);
      toast({ title: '已刷新连接', variant: 'success' });
      void invalidate();
    },
    onError: fail,
  });

  const revoke = useApiMutation((id: string) => revokeConnection(id), {
    onSuccess: () => {
      setActionError('');
      setNotice('连接已吊销（需重新授权才能继续使用）');
      toast({ title: '已吊销连接', variant: 'success' });
      setPending(null);
      void invalidate();
    },
    onError: (e) => { fail(e); setPending(null); },
  });

  const remove = useApiMutation((id: string) => deleteConnection(id), {
    onSuccess: () => {
      setActionError('');
      setNotice('连接已删除（凭证一并移除）');
      toast({ title: '已删除连接', variant: 'success' });
      setPending(null);
      void invalidate();
    },
    onError: (e) => { fail(e); setPending(null); },
  });

  const rows = (list.data?.data ?? []).map(toRow);

  return (
    <div className="mx-auto max-w-5xl px-4 py-8">
      <div className="mb-6 flex items-baseline justify-between gap-4">
        <h1 className="text-lg font-semibold text-zinc-100">连接</h1>
        <span className="text-xs text-zinc-500">连接视图永不含凭证 · 授权由外部平台页面完成</span>
      </div>

      {notice && <p className="mb-3 text-xs text-emerald-400" role="status">{notice}</p>}
      {actionError && <p className="mb-3 text-xs text-red-400" role="alert">{actionError}</p>}

      <Card className="mb-6">
        <CardHeader>
          <CardTitle>发起连接</CardTitle>
          <CardDescription>
            服务端会返回一次性 state 与 authorizeUrl，浏览器跳转到授权页；授权码交换与凭证加密入库都在服务端完成。
            后端 provider 注册表当前只有 <code className="text-zinc-400">mock</code>，其他名称会返回 PROVIDER_UNSUPPORTED（404）。
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form
            className="flex flex-wrap items-center gap-2"
            onSubmit={(e) => { e.preventDefault(); if (provider.trim()) start.mutate(); }}
          >
            <label className="text-xs text-zinc-500" htmlFor="connection-provider">服务商</label>
            <Input
              id="connection-provider"
              aria-label="服务商"
              value={provider}
              onChange={(e) => setProvider(e.target.value)}
              placeholder="mock"
              className="h-8 max-w-52"
            />
            <Button type="submit" size="sm" disabled={start.isPending || provider.trim().length === 0}>
              {start.isPending ? '发起中…' : '发起连接'}
            </Button>
            <span className="text-xs text-zinc-600">发起受限流约束（30 次/分钟）</span>
          </form>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>我的连接（{rows.length}）</CardTitle>
          <CardDescription>只展示 provider / 状态 / 过期时间等元数据；凭证从不下发到浏览器。</CardDescription>
        </CardHeader>
        <CardContent>
          {list.isPending && <Skeleton className="h-32 w-full" />}
          {list.error && (
            <p className="text-xs text-red-400" role="alert">
              连接列表加载失败：{errText(list.error)}
              {list.error.code === 'FORBIDDEN' && <Badge variant="outline" className="ml-2">无权限</Badge>}
            </p>
          )}
          {!list.isPending && !list.error && (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>服务商</TableHead>
                  <TableHead>状态</TableHead>
                  <TableHead>授权范围</TableHead>
                  <TableHead>过期时间</TableHead>
                  <TableHead>最近同步</TableHead>
                  <TableHead>创建时间</TableHead>
                  <TableHead>操作</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.length === 0 && <TableEmpty colSpan={7}>暂无连接 · 用上方「发起连接」开始授权</TableEmpty>}
                {rows.map((row) => {
                  const busy = (m: { isPending: boolean; variables: string | undefined }) => m.isPending && m.variables === row.id;
                  return (
                    <TableRow key={row.id}>
                      <TableCell>
                        <span className="block font-medium text-zinc-200">{row.provider}</span>
                        {row.providerAccountId && (
                          <span className="block truncate font-mono text-xs text-zinc-500">{row.providerAccountId}</span>
                        )}
                      </TableCell>
                      <TableCell><Badge variant={STATUS_VARIANT[row.status]}>{row.status}</Badge></TableCell>
                      <TableCell className="text-zinc-400">{row.scopeCount === null ? '—' : `${row.scopeCount} 项`}</TableCell>
                      <TableCell className="text-zinc-400">{fmtTime(row.expiresAt)}</TableCell>
                      <TableCell className="text-zinc-400">{fmtTime(row.lastSyncedAt)}</TableCell>
                      <TableCell className="text-zinc-500">{fmtTime(row.createdAt)}</TableCell>
                      <TableCell>
                        <div className="flex flex-wrap gap-1">
                          <Button size="sm" variant="outline" disabled={busy(refresh) || row.status === 'revoked'}
                            onClick={() => refresh.mutate(row.id)}>
                            {busy(refresh) ? '刷新中…' : '刷新'}
                          </Button>
                          <Button size="sm" variant="ghost" disabled={busy(revoke) || row.status === 'revoked'}
                            onClick={() => setPending({ kind: 'revoke', row })}>
                            吊销
                          </Button>
                          <Button size="sm" variant="ghost" className="text-red-300 hover:text-red-200"
                            disabled={busy(remove)} onClick={() => setPending({ kind: 'delete', row })}>
                            删除
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <ConfirmDialog
        open={pending?.kind === 'revoke'}
        onOpenChange={(open) => { if (!open) setPending(null); }}
        title="吊销连接"
        description={pending ? `吊销后 ${pending.row.provider} 的凭证将被撤销，需要重新授权才能继续使用。已吊销的连接不能刷新。` : ''}
        confirmLabel="确认吊销"
        destructive
        pending={revoke.isPending}
        onConfirm={() => pending && revoke.mutate(pending.row.id)}
      />

      <ConfirmDialog
        open={pending?.kind === 'delete'}
        onOpenChange={(open) => { if (!open) setPending(null); }}
        title="删除连接"
        description={pending ? `删除 ${pending.row.provider} 连接记录，其加密凭证一并移除；需要重新授权才能再次使用。` : ''}
        confirmLabel="确认删除"
        destructive
        pending={remove.isPending}
        onConfirm={() => pending && remove.mutate(pending.row.id)}
      />
    </div>
  );
}
