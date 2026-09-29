'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { KeyRound, LogOut, MonitorSmartphone, UserRound } from 'lucide-react';
import { useApiMutation, useApiQuery, useApiQueryClient } from '@/lib/api';
import { useCurrentUser } from '@/lib/auth';
import {
  SessionSummary, listSessions, logoutAll, revokeDeviceSessions, revokeSession, rotateSession, settingsKeys,
} from '@/lib/services/settings';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { SkeletonLines } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableEmpty, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { useToast } from '@/components/ui/toast';

/**
 * /settings —— 设置页（M13-W9）
 *
 * 后端**没有** settings 控制器（SystemSetting 只被运行时内部读取），所以本页只做两件真实可达的事：
 *  ① 账号信息：`GET /auth/me`（`useCurrentUser`，全站同一 queryKey，不额外发请求）；
 *  ② 会话/设备管理：`GET /auth/sessions` 列表 + 单会话下线 + 按设备下线 + 全部下线 + 轮换当前令牌。
 *
 * 安全口径（页面不得软化）：
 *  - 会话归属由服务端按 JWT 判定（列表只含本人会话）；前端不做任何"跨用户可见性"推断；
 *  - "全部下线" 与 "轮换令牌" 会立刻改变本机凭据状态：前者清掉本机 cookie → 跳登录页；
 *    两者都先经 Dialog 明示后果，不做静默提交。
 */

const fmt = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleString() : '—');

/** 设备展示名：优先 UA，其次 deviceId，最后"未知设备"（不做任何客户端指纹推断） */
function deviceLabel(s: SessionSummary): string {
  return s.userAgent?.trim() || s.deviceId || '未知设备';
}

type ConfirmKind = 'logoutAll' | { kind: 'revoke'; session: SessionSummary } | { kind: 'device'; session: SessionSummary };

export default function SettingsPage() {
  const router = useRouter();
  const queryClient = useApiQueryClient();
  const { toast } = useToast();
  const me = useCurrentUser();
  const [confirm, setConfirm] = useState<ConfirmKind | null>(null);

  const sessions = useApiQuery<{ data: { sessions: SessionSummary[] } }>({
    queryKey: settingsKeys.sessions,
    path: '/api/v1/auth/sessions',
  });

  const done = (title: string, description?: string) => {
    toast({ title, description, variant: 'success' });
    void queryClient.invalidateQueries({ queryKey: settingsKeys.sessions });
    void queryClient.invalidateQueries({ queryKey: ['me'] });
  };
  const failed = (error: { message: string }) => {
    toast({ title: '操作未生效', description: error.message, variant: 'error' });
  };

  const revokeOne = useApiMutation(
    (session: SessionSummary) => revokeSession(session.id),
    {
      onSuccess: (_r, session) => {
        setConfirm(null);
        if (session.current) {
          toast({ title: '当前会话已下线', description: '正在跳转登录页…', variant: 'success' });
          router.replace('/login');
          return;
        }
        done('已下线该会话');
      },
      onError: failed,
    },
  );

  const revokeDevice = useApiMutation(
    (session: SessionSummary) => revokeDeviceSessions(session.deviceId!),
    {
      onSuccess: (_r, session) => {
        setConfirm(null);
        if (session.current) {
          toast({ title: '该设备全部会话已下线', description: '正在跳转登录页…', variant: 'success' });
          router.replace('/login');
          return;
        }
        done('已下线该设备的全部会话');
      },
      onError: failed,
    },
  );

  const all = useApiMutation(() => logoutAll(), {
    onSuccess: () => {
      setConfirm(null);
      toast({ title: '全部会话已下线', description: '正在跳转登录页…', variant: 'success' });
      queryClient.clear();
      router.replace('/login');
    },
    onError: failed,
  });

  const rotate = useApiMutation(() => rotateSession(), {
    onSuccess: () => done('已轮换当前会话令牌', '旧令牌立即失效，其它设备不受影响'),
    onError: failed,
  });

  const rows = sessions.data?.data.sessions ?? [];
  const busy = revokeOne.isPending || revokeDevice.isPending || all.isPending || rotate.isPending;

  return (
    <div className="mx-auto max-w-3xl space-y-6 px-4 py-8">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h1 className="text-lg font-semibold text-zinc-100">设置</h1>
        <span className="text-xs text-zinc-500">会话与设备 · 凭据由服务端裁决</span>
      </div>

      <Card>
        <CardHeader className="flex-row items-center gap-2">
          <UserRound className="size-4 text-zinc-400" aria-hidden />
          <CardTitle>账号信息</CardTitle>
        </CardHeader>
        <CardContent>
          {me.isPending && <SkeletonLines lines={2} />}
          {me.isError && <p className="text-sm text-red-400">账号信息加载失败：{me.error.message}</p>}
          {me.data && (
            <dl className="grid grid-cols-1 gap-x-6 gap-y-1 text-sm sm:grid-cols-2">
              <div className="flex gap-2">
                <dt className="w-20 shrink-0 text-xs text-zinc-500">邮箱</dt>
                <dd className="min-w-0 break-all text-zinc-200">{me.data.data.user.email}</dd>
              </div>
              <div className="flex gap-2">
                <dt className="w-20 shrink-0 text-xs text-zinc-500">显示名</dt>
                <dd className="min-w-0 text-zinc-200">{me.data.data.user.displayName ?? '—'}</dd>
              </div>
              <div className="flex gap-2">
                <dt className="w-20 shrink-0 text-xs text-zinc-500">角色</dt>
                <dd><Badge variant="secondary">{me.data.data.user.role}</Badge></dd>
              </div>
            </dl>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex-row items-center justify-between gap-2">
          <span className="flex items-center gap-2">
            <MonitorSmartphone className="size-4 text-zinc-400" aria-hidden />
            <CardTitle>登录会话</CardTitle>
          </span>
          <span className="flex items-center gap-2">
            <Button size="sm" variant="outline" disabled={busy} onClick={() => rotate.mutate()}>
              <KeyRound className="size-3.5" aria-hidden />轮换当前令牌
            </Button>
            <Button size="sm" variant="destructive" disabled={busy} onClick={() => setConfirm('logoutAll')}>
              <LogOut className="size-3.5" aria-hidden />全部下线
            </Button>
          </span>
        </CardHeader>
        <CardDescription className="px-4 pt-3">
          会话由服务端按登录凭据记录；下线立即生效（不必等令牌过期）。
        </CardDescription>
        <CardContent>
          {sessions.isPending && <SkeletonLines lines={3} />}
          {sessions.isError && <p className="text-sm text-red-400">会话列表加载失败：{sessions.error.message}</p>}
          {sessions.data && (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>设备</TableHead>
                  <TableHead>来源 IP</TableHead>
                  <TableHead>登录时间</TableHead>
                  <TableHead>过期时间</TableHead>
                  <TableHead>操作</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.length === 0 && <TableEmpty colSpan={5}>当前没有已登录会话</TableEmpty>}
                {rows.map((s) => (
                  <TableRow key={s.id} data-testid={`session-${s.id}`}>
                    <TableCell className="max-w-[16rem]">
                      <span className="block truncate" title={deviceLabel(s)}>{deviceLabel(s)}</span>
                      {s.current && <Badge variant="success" className="mt-1">当前会话</Badge>}
                    </TableCell>
                    <TableCell className="font-mono text-xs">{s.ip ?? '—'}</TableCell>
                    <TableCell className="text-xs">{fmt(s.createdAt)}</TableCell>
                    <TableCell className="text-xs">{fmt(s.expiresAt)}</TableCell>
                    <TableCell>
                      <span className="flex items-center gap-2">
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={busy}
                          aria-label={`下线会话：${deviceLabel(s)}`}
                          onClick={() => setConfirm({ kind: 'revoke', session: s })}
                        >
                          下线
                        </Button>
                        {s.deviceId && (
                          <Button
                            size="sm"
                            variant="ghost"
                            disabled={busy}
                            aria-label={`下线设备全部会话：${deviceLabel(s)}`}
                            onClick={() => setConfirm({ kind: 'device', session: s })}
                          >
                            下线该设备
                          </Button>
                        )}
                      </span>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <Dialog open={confirm !== null} onOpenChange={(open) => { if (!open) setConfirm(null); }}>
        <DialogHeader>
          <DialogTitle>
            {confirm === 'logoutAll' ? '确认下线全部会话？'
              : confirm?.kind === 'device' ? '确认下线该设备的全部会话？'
                : '确认下线该会话？'}
          </DialogTitle>
          <DialogDescription>
            {confirm === 'logoutAll'
              ? '包括本机在内的所有已登录会话都会立即失效，随后需要重新登录。'
              : '该会话的令牌立即失效；若为当前会话，你需要重新登录。'}
          </DialogDescription>
        </DialogHeader>
        <DialogContent>
          {confirm !== 'logoutAll' && confirm && (
            <p className="text-xs text-zinc-400">
              设备：{deviceLabel(confirm.session)}
              {confirm.kind === 'device' ? '（该设备的全部会话）' : ''}
            </p>
          )}
        </DialogContent>
        <DialogFooter>
          <Button variant="ghost" onClick={() => setConfirm(null)}>取消</Button>
          <Button
            variant="destructive"
            disabled={busy}
            onClick={() => {
              if (confirm === 'logoutAll') { all.mutate(); return; }
              if (!confirm) return;
              if (confirm.kind === 'device') { revokeDevice.mutate(confirm.session); return; }
              revokeOne.mutate(confirm.session);
            }}
          >
            {busy ? '处理中…' : '确认下线'}
          </Button>
        </DialogFooter>
      </Dialog>
    </div>
  );
}
