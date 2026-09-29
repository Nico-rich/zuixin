'use client';

import Link from 'next/link';
import { use, useState } from 'react';
import { ApiErrorNotice, NoPermissionBadge } from '@/components/api-error-notice';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableEmpty, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { useToast } from '@/components/ui/toast';
import { useApiMutation, useApiQuery, useApiQueryClient, type ApiError } from '@/lib/api';
import { useCurrentUser } from '@/lib/auth';
import {
  deleteOrganization, disableOrganization, enableOrganization, inviteMember,
  organizationKeys, removeMember, revokeInvitation, updateOrganization,
  type OrganizationInvitation, type OrganizationRole,
} from '@/lib/services/organizations';

/**
 * 组织详情 / 团队管理（M13-W5）。
 *
 * **RBAC 如实呈现**（路线图 §4：LLM/前端都不得决定 RBAC）：角色来自服务端
 * （组织列表里 `members[0].role` 是调用者自己的成员行），页面只据此显隐入口；
 * 服务端拒绝（403 FORBIDDEN / ORG_DISABLED）时按 code 显示「无权限 / 组织已禁用」徽标与原始 message。
 *
 * 后端硬规则（页面照实呈现，不做前端等价实现）：
 *  - PATCH 组织 / 删除 / 禁用启用 = owner（或平台管理员，disable/enable 分支）；
 *  - 成员与邀请的写 = owner|admin；读 = owner|admin|member（viewer 403）；
 *  - 组织必须保留至少一名 owner → owner 行不提供「移除」；
 *  - 个人空间不可删除；个人空间的禁用仅平台管理员可执行。
 *  - 组织被禁用后，除 enable/disable 外的组织级端点全部 403 ORG_DISABLED（故本页在禁用态下只剩启用入口）。
 */

const ROLE_VARIANT: Record<OrganizationRole, 'info' | 'default' | 'secondary' | 'outline'> = {
  owner: 'info', admin: 'default', member: 'secondary', viewer: 'outline',
};

const INVITE_STATUS_VARIANT: Record<OrganizationInvitation['status'], 'warning' | 'success' | 'destructive' | 'secondary'> = {
  pending: 'warning', accepted: 'success', revoked: 'destructive', expired: 'secondary',
};

const INVITE_ROLES: OrganizationRole[] = ['admin', 'member', 'viewer'];
const errText = (e: ApiError): string => `${e.message}（${e.code}）`;
const fmtTime = (value: string | null): string => (value ? new Date(value).toLocaleString() : '—');

export default function OrganizationDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const queryClient = useApiQueryClient();
  const { toast } = useToast();
  const me = useCurrentUser();

  const [nameDraft, setNameDraft] = useState<string | null>(null);
  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteRole, setInviteRole] = useState<OrganizationRole>('member');
  const [createdInvite, setCreatedInvite] = useState<{ email: string; role: OrganizationRole; token: string; expiresAt: string } | null>(null);
  const [confirm, setConfirm] = useState<{ kind: 'disable' | 'enable' | 'delete' | 'remove-member'; userId?: string; label?: string } | null>(null);
  const [actionError, setActionError] = useState('');
  const [notice, setNotice] = useState('');

  // 角色事实源（服务端）：组织列表里的自己的成员行 —— 详情被 403 挡住时仍可判角色
  const orgs = useApiQuery<{ data: Array<{ id: string; name: string; members: Array<{ role: OrganizationRole }> }> }>({
    queryKey: organizationKeys.all, path: '/api/v1/organizations',
  });
  const detail = useApiQuery<{
    data: {
      id: string; name: string; slug: string; isPersonal: boolean; ownerUserId: string;
      status: 'active' | 'disabled'; createdAt: string; updatedAt: string;
      members: Array<{ userId: string; role: OrganizationRole; joinedAt: string }>;
    };
  }>({ queryKey: organizationKeys.detail(id), path: `/api/v1/organizations/${id}` });
  const members = useApiQuery<{ data: Array<{ id: string; userId: string; role: OrganizationRole; joinedAt: string; user?: { id: string; email: string; displayName: string | null } }> }>({
    queryKey: organizationKeys.members(id), path: `/api/v1/organizations/${id}/members`, enabled: detail.isSuccess,
  });
  const invitations = useApiQuery<{ data: OrganizationInvitation[] }>({
    queryKey: organizationKeys.invitations(id), path: `/api/v1/organizations/${id}/invitations`, enabled: detail.isSuccess,
  });

  const org = detail.data?.data ?? null;
  const myRole = orgs.data?.data.find((o) => o.id === id)?.members[0]?.role ?? null;
  const platformAdmin = me.data?.data.user.role === 'admin';
  const canWriteOrg = myRole === 'owner' || platformAdmin;
  const canManageMembers = myRole === 'owner' || myRole === 'admin';
  const nameValue = nameDraft ?? org?.name ?? '';
  const inviteEmailValid = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(inviteEmail.trim());

  const invalidateOrg = () => {
    void queryClient.invalidateQueries({ queryKey: organizationKeys.detail(id) });
    void queryClient.invalidateQueries({ queryKey: organizationKeys.all });
  };
  const invalidateMembers = () => queryClient.invalidateQueries({ queryKey: organizationKeys.members(id) });
  const invalidateInvitations = () => queryClient.invalidateQueries({ queryKey: organizationKeys.invitations(id) });
  const done = (message: string, title: string) => { setActionError(''); setNotice(message); toast({ title, variant: 'success' }); };
  const fail = (prefix: string) => (e: ApiError) => { setNotice(''); setActionError(prefix + errText(e)); };

  const update = useApiMutation((name: string) => updateOrganization(id, { name }), {
    onSuccess: (res) => { done(`组织名称已更新：${res.data.name}`, '已更新组织'); setNameDraft(null); invalidateOrg(); },
    onError: fail('更新组织失败：'),
  });
  const setStatus = useApiMutation<{ data: { id: string; status: 'active' | 'disabled'; unchanged: boolean } }, 'disable' | 'enable'>(
    (action) => (action === 'disable' ? disableOrganization(id) : enableOrganization(id)), {
    onSuccess: (res, action) => {
      done(action === 'disable' ? '组织已禁用（组织级端点对该组织成员一律 403）' : '组织已启用', action === 'disable' ? '已禁用组织' : '已启用组织');
      if (!res.data.unchanged) invalidateOrg(); else toast({ title: '状态未变化', description: '服务端返回 unchanged', variant: 'default' });
      setConfirm(null);
    },
    onError: (e) => { fail('变更组织治理态失败：')(e); setConfirm(null); },
  });
  const remove = useApiMutation((targetUserId: string) => removeMember(id, targetUserId), {
    onSuccess: () => { done('成员已移除', '已移除成员'); setConfirm(null); void invalidateMembers(); },
    onError: (e) => { fail('移除成员失败：')(e); setConfirm(null); },
  });
  const removeOrg = useApiMutation<{ data: { deleted: true } }, void>(() => deleteOrganization(id), {
    onSuccess: () => { done('组织已删除（软删：记录保留，不可再访问）', '已删除组织'); setConfirm(null); invalidateOrg(); },
    onError: (e) => { fail('删除组织失败：')(e); setConfirm(null); },
  });
  const invite = useApiMutation((input: { email: string; role: OrganizationRole }) => inviteMember(id, input), {
    onSuccess: (res) => {
      setActionError('');
      setNotice(`邀请已创建：${res.data.email}（角色 ${res.data.role}），token 见下方「待处理邀请」`);
      setCreatedInvite({ email: res.data.email, role: res.data.role, token: res.data.token, expiresAt: res.data.expiresAt });
      setInviteEmail('');
      void invalidateInvitations();
    },
    onError: fail('创建邀请失败：'),
  });
  const revoke = useApiMutation((token: string) => revokeInvitation(token), {
    onSuccess: () => { done('邀请已撤销', '已撤销邀请'); void invalidateInvitations(); },
    onError: fail('撤销邀请失败：'),
  });

  const title = org?.name ?? orgs.data?.data.find((o) => o.id === id)?.name ?? id;

  return (
    <div className="mx-auto max-w-5xl px-4 py-8">
      <Link href="/organizations" className="text-xs text-zinc-500 hover:text-zinc-300">← 组织团队</Link>

      <div className="mt-4 mb-6 flex flex-wrap items-baseline gap-3">
        <h1 className="text-lg font-semibold text-zinc-100">{title}</h1>
        {org && <Badge variant={org.status === 'active' ? 'success' : 'destructive'}>{org.status}</Badge>}
        {org?.isPersonal && <Badge variant="secondary">个人空间</Badge>}
        {myRole ? <Badge variant={ROLE_VARIANT[myRole]}>我的角色 {myRole}</Badge> : <NoPermissionBadge label="非成员" />}
        {platformAdmin && <Badge variant="info">平台管理员</Badge>}
      </div>

      {notice && <p className="mb-3 text-xs text-emerald-400" role="status">{notice}</p>}
      {actionError && <p className="mb-3 text-xs text-red-400" role="alert">{actionError}</p>}

      {detail.isPending && <Skeleton className="h-40 w-full" />}
      {detail.error && (
        <Card className="mb-6">
          <CardHeader>
            <CardTitle>组织信息不可读</CardTitle>
            <CardDescription>服务端拒绝了本次读取（组织归属/治理态由服务端裁定）。</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <ApiErrorNotice error={detail.error} prefix="加载失败：" />
            {detail.error.code === 'ORG_DISABLED' && canWriteOrg && (
              <Button size="sm" disabled={setStatus.isPending} onClick={() => setConfirm({ kind: 'enable' })}>启用组织</Button>
            )}
          </CardContent>
        </Card>
      )}

      {/* detail.error 时**不渲染过期管理面**：读被服务端拒绝（含禁用态）后，旧数据仍留在 react-query 缓存里，
          若与错误卡同屏会显示已失效的写入口（如对已冻结组织显示「禁用组织」）→ 有错即只呈现错误态 */}
      {org && !detail.error && (
        <>
          <Card className="mb-6">
            <CardHeader>
              <CardTitle>组织信息</CardTitle>
              <CardDescription>标识不可改（服务端无此写入口）；名称更新需 organization.write（owner）。</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <dl className="grid gap-x-6 gap-y-2 text-xs sm:grid-cols-2">
                <div className="flex justify-between gap-2"><dt className="text-zinc-500">标识 slug</dt><dd className="font-mono text-zinc-300">{org.slug}</dd></div>
                <div className="flex justify-between gap-2"><dt className="text-zinc-500">所有者 userId</dt><dd className="font-mono text-zinc-300">{org.ownerUserId}</dd></div>
                <div className="flex justify-between gap-2"><dt className="text-zinc-500">创建时间</dt><dd className="text-zinc-300">{fmtTime(org.createdAt)}</dd></div>
                <div className="flex justify-between gap-2"><dt className="text-zinc-500">更新时间</dt><dd className="text-zinc-300">{fmtTime(org.updatedAt)}</dd></div>
                <div className="flex justify-between gap-2"><dt className="text-zinc-500">成员数（详情投影）</dt><dd className="text-zinc-300">{org.members.length}</dd></div>
              </dl>

              {canWriteOrg ? (
                <form
                  className="flex flex-wrap items-center gap-2"
                  onSubmit={(e) => { e.preventDefault(); if (nameValue.trim()) update.mutate(nameValue.trim()); }}
                >
                  <Input aria-label="组织名称" value={nameValue} onChange={(e) => setNameDraft(e.target.value)} className="h-8 max-w-64" maxLength={100} />
                  <Button type="submit" size="sm" disabled={update.isPending || nameValue.trim().length === 0 || nameValue.trim() === org.name}>
                    {update.isPending ? '提交中…' : '保存名称'}
                  </Button>
                </form>
              ) : (
                <p className="flex items-center gap-2 text-xs text-zinc-500">
                  <NoPermissionBadge />
                  仅组织 owner 可更新组织信息（服务端 organization.write）
                </p>
              )}
            </CardContent>
          </Card>

          <Card className="mb-6">
            <CardHeader>
              <CardTitle>治理态</CardTitle>
              <CardDescription>
                禁用后组织级一切端点（读/写/成员/邀请）对成员返回 403 ORG_DISABLED；仅「启用」自身豁免。
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              {canWriteOrg ? (
                <div className="flex flex-wrap gap-2">
                  {org.status === 'active' ? (
                    org.isPersonal && !platformAdmin ? (
                      <span className="text-xs text-zinc-500">个人空间不可由 owner 自助禁用（平台管理员可执行平台级禁用）</span>
                    ) : (
                      <Button size="sm" variant="outline" disabled={setStatus.isPending} onClick={() => setConfirm({ kind: 'disable' })}>
                        禁用组织
                      </Button>
                    )
                  ) : (
                    <Button size="sm" disabled={setStatus.isPending} onClick={() => setConfirm({ kind: 'enable' })}>启用组织</Button>
                  )}
                </div>
              ) : (
                <p className="flex items-center gap-2 text-xs text-zinc-500">
                  <NoPermissionBadge />
                  仅组织 owner 或平台管理员可变更加治理态
                </p>
              )}

              {canWriteOrg && (
                <div className="border-t border-zinc-800/80 pt-3">
                  {org.isPersonal ? (
                    <p className="text-xs text-zinc-500">个人空间不可删除（服务端硬规则：账号默认工作区）</p>
                  ) : (
                    <Button size="sm" variant="destructive" disabled={removeOrg.isPending} onClick={() => setConfirm({ kind: 'delete' })}>
                      删除组织
                    </Button>
                  )}
                  <p className="mt-1 text-xs text-zinc-600">删除为软删：记录与成员关系保留，组织不再出现在列表/不可访问。</p>
                </div>
              )}
            </CardContent>
          </Card>

          <Card className="mb-6">
            <CardHeader>
              <CardTitle>成员（{members.data?.data.length ?? '—'}）</CardTitle>
              <CardDescription>
                {canManageMembers ? '移除成员需 owner/admin；组织必须至少保留一名 owner。' : '成员读写需 owner/admin（viewer 无权限）。'}
              </CardDescription>
            </CardHeader>
            <CardContent>
              {members.isPending && <Skeleton className="h-24 w-full" />}
              {members.error && <ApiErrorNotice error={members.error} prefix="成员加载失败：" />}
              {members.data && (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>成员</TableHead>
                      <TableHead>角色</TableHead>
                      <TableHead>加入时间</TableHead>
                      <TableHead>操作</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {members.data.data.length === 0 && <TableEmpty colSpan={4}>暂无成员</TableEmpty>}
                    {members.data.data.map((m) => (
                      <TableRow key={m.id}>
                        <TableCell>
                          <span className="block text-zinc-200">
                            {m.user?.displayName ?? m.user?.email ?? m.userId}
                            {me.data?.data.user.id === m.userId && <span className="ml-1 text-xs text-zinc-500">（我）</span>}
                          </span>
                          {m.user?.email && <span className="block font-mono text-xs text-zinc-500">{m.user.email}</span>}
                        </TableCell>
                        <TableCell><Badge variant={ROLE_VARIANT[m.role]}>{m.role}</Badge></TableCell>
                        <TableCell className="text-zinc-500">{fmtTime(m.joinedAt)}</TableCell>
                        <TableCell>
                          {m.role === 'owner' ? (
                            <span className="text-xs text-zinc-600">须保留 owner</span>
                          ) : canManageMembers ? (
                            <Button size="sm" variant="ghost" className="text-red-300 hover:text-red-200"
                              disabled={remove.isPending}
                              onClick={() => setConfirm({ kind: 'remove-member', userId: m.userId, label: m.user?.email ?? m.userId })}>
                              移除
                            </Button>
                          ) : (
                            <NoPermissionBadge />
                          )}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>邀请</CardTitle>
              <CardDescription>
                邀请 token 由邀请方线下转交（平台不发邮件）；接受时服务端比对 token 与账号邮箱。
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              {canManageMembers ? (
                <form
                  className="flex flex-wrap items-end gap-2"
                  onSubmit={(e) => {
                    e.preventDefault();
                    if (inviteEmailValid) invite.mutate({ email: inviteEmail.trim().toLowerCase(), role: inviteRole });
                  }}
                >
                  <div className="min-w-56">
                    <label className="mb-1 block text-xs text-zinc-500" htmlFor="invite-email">被邀请人邮箱</label>
                    <Input id="invite-email" aria-label="被邀请人邮箱" value={inviteEmail} onChange={(e) => setInviteEmail(e.target.value)} className="h-9" />
                  </div>
                  <div className="w-32">
                    <label className="mb-1 block text-xs text-zinc-500" htmlFor="invite-role">角色</label>
                    <Select id="invite-role" aria-label="邀请角色" value={inviteRole} className="h-9"
                      onChange={(e) => setInviteRole(e.target.value as OrganizationRole)}>
                      {INVITE_ROLES.map((r) => <option key={r} value={r}>{r}</option>)}
                    </Select>
                  </div>
                  <Button type="submit" size="sm" disabled={invite.isPending || !inviteEmailValid}>
                    {invite.isPending ? '创建中…' : '创建邀请'}
                  </Button>
                  <span className="pb-2 text-xs text-zinc-600">不能邀请 owner（由所有权转移处理）</span>
                </form>
              ) : (
                <p className="flex items-center gap-2 text-xs text-zinc-500">
                  <NoPermissionBadge />
                  仅 owner/admin 可创建或撤销邀请
                </p>
              )}

              {createdInvite && (
                <div className="rounded-lg border border-emerald-900/60 bg-emerald-950/30 p-3 text-xs">
                  <p className="text-emerald-200">已创建邀请：{createdInvite.email}（{createdInvite.role}）</p>
                  <p className="mt-1 break-all font-mono text-emerald-300">{createdInvite.token}</p>
                  <p className="mt-1 text-emerald-200/70">请转交被邀请人，在其登录后到「组织团队」页粘贴接受；过期时间 {fmtTime(createdInvite.expiresAt)}</p>
                </div>
              )}

              {invitations.isPending && <Skeleton className="h-24 w-full" />}
              {invitations.error && <ApiErrorNotice error={invitations.error} prefix="邀请加载失败：" />}
              {invitations.data && (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>邮箱</TableHead>
                      <TableHead>角色</TableHead>
                      <TableHead>状态</TableHead>
                      <TableHead>过期时间</TableHead>
                      <TableHead>token</TableHead>
                      <TableHead>操作</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {invitations.data.data.length === 0 && <TableEmpty colSpan={6}>暂无邀请</TableEmpty>}
                    {invitations.data.data.map((inv) => (
                      <TableRow key={inv.id}>
                        <TableCell className="text-zinc-200">{inv.email}</TableCell>
                        <TableCell><Badge variant={ROLE_VARIANT[inv.role]}>{inv.role}</Badge></TableCell>
                        <TableCell><Badge variant={INVITE_STATUS_VARIANT[inv.status]}>{inv.status}</Badge></TableCell>
                        <TableCell className="text-zinc-500">{fmtTime(inv.expiresAt)}</TableCell>
                        <TableCell className="break-all font-mono text-xs text-zinc-500">
                          {inv.status === 'pending' ? inv.token : '—'}
                        </TableCell>
                        <TableCell>
                          {inv.status === 'pending' ? (
                            canManageMembers ? (
                              <Button size="sm" variant="ghost" disabled={revoke.isPending} onClick={() => revoke.mutate(inv.token)}>
                                撤销
                              </Button>
                            ) : <NoPermissionBadge />
                          ) : (
                            <span className="text-xs text-zinc-600">已处理</span>
                          )}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>
        </>
      )}

      <ConfirmDialog
        open={confirm?.kind === 'disable'}
        onOpenChange={(open) => { if (!open) setConfirm(null); }}
        title="禁用组织"
        description={`禁用「${title}」后，该组织的一切组织级端点（含成员与邀请）对被禁用方返回 403 ORG_DISABLED，仅可再执行启用。`}
        confirmLabel="确认禁用"
        destructive
        pending={setStatus.isPending}
        onConfirm={() => setStatus.mutate('disable')}
      />
      <ConfirmDialog
        open={confirm?.kind === 'enable'}
        onOpenChange={(open) => { if (!open) setConfirm(null); }}
        title="启用组织"
        description={`恢复「${title}」为 active；若已是 active 服务端会返回 unchanged。`}
        confirmLabel="确认启用"
        pending={setStatus.isPending}
        onConfirm={() => setStatus.mutate('enable')}
      />
      <ConfirmDialog
        open={confirm?.kind === 'delete'}
        onOpenChange={(open) => { if (!open) setConfirm(null); }}
        title="删除组织"
        description={`删除「${title}」为软删：记录与成员关系保留在库中，组织从此不可访问、不再出现在列表。个人空间不可删除。`}
        confirmLabel="确认删除"
        destructive
        pending={removeOrg.isPending}
        onConfirm={() => removeOrg.mutate()}
      />
      <ConfirmDialog
        open={confirm?.kind === 'remove-member'}
        onOpenChange={(open) => { if (!open) setConfirm(null); }}
        title="移除成员"
        description={`将 ${confirm?.label ?? ''} 移出「${title}」；其访问权立即失效（组织必须保留至少一名 owner）。`}
        confirmLabel="确认移除"
        destructive
        pending={remove.isPending}
        onConfirm={() => confirm?.userId && remove.mutate(confirm.userId)}
      />
    </div>
  );
}
