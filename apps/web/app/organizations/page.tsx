'use client';

import Link from 'next/link';
import { useState } from 'react';
import { ApiErrorNotice } from '@/components/api-error-notice';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableEmpty, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { useToast } from '@/components/ui/toast';
import { useApiMutation, useApiQuery, useApiQueryClient, type ApiError } from '@/lib/api';

import {
  acceptInvitation, createOrganization, organizationKeys, type OrganizationRole, type OrganizationSummary,
} from '@/lib/services/organizations';

/**
 * 组织 / 团队（M13-W5）：我所属的组织列表 + 建组织 + 用邀请 token 加入。
 *
 * 归属纪律（路线图 §4：org 归属 + server-side scope）：列表只来自 `GET /organizations`
 * （服务端按「调用者是成员」过滤），**角色也来自服务端**（`members[0].role` 是调用者自己的成员行）；
 * 页面只按它显隐入口，绝不把它当授权——所有写路径服务端都会用 RBAC 再判一次。
 *
 * 邀请接受：token 由邀请方线下转交（后端不发邮件）；email 由服务端从 JWT 档案解析，客户端不可指定。
 */

const ROLE_VARIANT: Record<OrganizationRole, 'info' | 'default' | 'secondary' | 'outline'> = {
  owner: 'info', admin: 'default', member: 'secondary', viewer: 'outline',
};

const SLUG_RE = /^[a-z0-9-]{3,50}$/;
const errText = (e: ApiError): string => `${e.message}（${e.code}）`;

export default function OrganizationsPage() {
  const queryClient = useApiQueryClient();
  const { toast } = useToast();
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [token, setToken] = useState('');
  const [actionError, setActionError] = useState('');
  const [notice, setNotice] = useState('');

  const orgs = useApiQuery<{ data: OrganizationSummary[] }>({
    queryKey: organizationKeys.all, path: '/api/v1/organizations',
  });

  const invalidate = () => queryClient.invalidateQueries({ queryKey: organizationKeys.all });
  const slugInvalid = slug.trim().length > 0 && !SLUG_RE.test(slug.trim());

  const create = useApiMutation((input: { name: string; slug?: string }) => createOrganization(input), {
    onSuccess: (res) => {
      setActionError('');
      setNotice(`组织已创建：${res.data.name}（${res.data.slug}）`);
      toast({ title: '组织已创建', variant: 'success' });
      setName(''); setSlug('');
      void invalidate();
    },
    onError: (e) => { setNotice(''); setActionError(`创建组织失败：${errText(e)}`); },
  });

  const accept = useApiMutation((t: string) => acceptInvitation(t), {
    onSuccess: (res) => {
      setActionError('');
      setNotice(`已加入组织 ${res.data.organizationId}（角色 ${res.data.role}）`);
      toast({ title: '已加入组织', description: `角色 ${res.data.role}`, variant: 'success' });
      setToken('');
      void invalidate();
    },
    onError: (e) => { setNotice(''); setActionError(`接受邀请失败：${errText(e)}`); },
  });

  const rows = orgs.data?.data ?? [];

  return (
    <div className="mx-auto max-w-5xl px-4 py-8">
      <div className="mb-6 flex items-baseline justify-between gap-4">
        <h1 className="text-lg font-semibold text-zinc-100">组织团队</h1>
        <span className="text-xs text-zinc-500">角色由服务端 RBAC 裁决 · 本页只按返回的角色显隐入口</span>
      </div>

      {notice && <p className="mb-3 text-xs text-emerald-400" role="status">{notice}</p>}
      {actionError && <p className="mb-3 text-xs text-red-400" role="alert">{actionError}</p>}

      <div className="mb-6 grid gap-4 sm:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>创建组织</CardTitle>
            <CardDescription>任一登录用户可建组织；标识留空则由服务端生成。</CardDescription>
          </CardHeader>
          <CardContent>
            <form
              className="space-y-2"
              onSubmit={(e) => {
                e.preventDefault();
                if (!name.trim() || slugInvalid) return;
                create.mutate({ name: name.trim(), ...(slug.trim() ? { slug: slug.trim() } : {}) });
              }}
            >
              <Input aria-label="组织名称" value={name} onChange={(e) => setName(e.target.value)} placeholder="组织名称" maxLength={100} />
              <Input aria-label="组织标识" value={slug} onChange={(e) => setSlug(e.target.value)} placeholder="标识（可选，小写字母/数字/短横线）" />
              {slugInvalid && <p className="text-xs text-amber-400">标识需匹配 ^[a-z0-9-]&#123;3,50&#125;</p>}
              <Button type="submit" size="sm" disabled={create.isPending || name.trim().length === 0 || slugInvalid}>
                {create.isPending ? '创建中…' : '创建组织'}
              </Button>
            </form>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>接受邀请</CardTitle>
            <CardDescription>粘贴邀请 token（由邀请方转交）；服务端会校验 token 与你的账号邮箱一致。</CardDescription>
          </CardHeader>
          <CardContent>
            <form
              className="space-y-2"
              onSubmit={(e) => { e.preventDefault(); if (token.trim()) accept.mutate(token.trim()); }}
            >
              <Input aria-label="邀请 token" value={token} onChange={(e) => setToken(e.target.value)} placeholder="邀请 token" />
              <Button type="submit" size="sm" disabled={accept.isPending || token.trim().length === 0}>
                {accept.isPending ? '处理中…' : '接受邀请'}
              </Button>
            </form>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>我的组织（{rows.length}）</CardTitle>
          <CardDescription>含个人空间；成员/项目数为服务端投影。</CardDescription>
        </CardHeader>
        <CardContent>
          {orgs.isPending && <Skeleton className="h-32 w-full" />}
          {orgs.error && <ApiErrorNotice error={orgs.error} prefix="组织列表加载失败：" />}
          {orgs.data && (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>名称</TableHead>
                  <TableHead>标识</TableHead>
                  <TableHead>类型</TableHead>
                  <TableHead>我的角色</TableHead>
                  <TableHead>成员</TableHead>
                  <TableHead>项目</TableHead>
                  <TableHead>创建时间</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.length === 0 && <TableEmpty colSpan={7}>暂无组织</TableEmpty>}
                {rows.map((org) => {
                  const role = org.members[0]?.role ?? null;
                  return (
                    <TableRow key={org.id}>
                      <TableCell>
                        <Link href={`/organizations/${org.id}`} className="font-medium text-zinc-200 hover:text-zinc-50">
                          {org.name}
                        </Link>
                      </TableCell>
                      <TableCell className="font-mono text-xs text-zinc-500">{org.slug}</TableCell>
                      <TableCell>
                        <Badge variant={org.isPersonal ? 'secondary' : 'default'}>{org.isPersonal ? '个人' : '团队'}</Badge>
                      </TableCell>
                      <TableCell>{role ? <Badge variant={ROLE_VARIANT[role]}>{role}</Badge> : <Badge variant="outline">非成员</Badge>}</TableCell>
                      <TableCell>{org._count.members}</TableCell>
                      <TableCell>{org._count.projects}</TableCell>
                      <TableCell className="text-zinc-500">{new Date(org.createdAt).toLocaleString()}</TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
