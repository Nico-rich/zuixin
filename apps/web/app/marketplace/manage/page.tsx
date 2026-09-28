'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { apiFetch } from '@/lib/api';

interface OrganizationRow {
  id: string;
  name: string;
  slug: string;
  isPersonal: boolean;
  members: Array<{ role: string }>;
}
interface CategoryCount { category: string; publishedCount: number }
interface ManageItem {
  id: string;
  status: 'draft' | 'published' | 'rejected';
  category: string;
  description: string;
  extension: { id: string; name: string; slug: string; kind: string } | null;
  publishedVersion: { version: number } | null;
  installCount: number;
}
interface ManageResult { items: ManageItem[]; total: number }

const STATUSES = ['all', 'draft', 'published', 'rejected'] as const;
const STATUS_STYLE: Record<string, string> = {
  draft: 'bg-zinc-800 text-zinc-400',
  published: 'bg-emerald-900/60 text-emerald-300',
  rejected: 'bg-red-900/60 text-red-300',
};
/** 与平台 RBAC 一致：owner/admin/member 具 agent.write（可管理条目）；viewer 只读 */
const WRITABLE_ROLES = ['owner', 'admin', 'member'];

/**
 * M9-P6 发布管理（最小后台页）：按组织列出**全部状态**的市场条目（draft/rejected 属私有面，
 * 服务端要求显式 organizationId + 成员身份），并提供建条目 / 上架 / 撤回 / 修订。
 * 上架门禁在服务端（扩展须已通过 M8-P6 平台发布校验），本页不做任何权限判定。
 */
export default function MarketplaceManagePage() {
  const [orgs, setOrgs] = useState<OrganizationRow[] | null>(null);
  const [orgId, setOrgId] = useState('');
  const [status, setStatus] = useState<(typeof STATUSES)[number]>('all');
  const [categories, setCategories] = useState<CategoryCount[]>([]);
  const [items, setItems] = useState<ManageItem[]>([]);
  const [extensionId, setExtensionId] = useState('');
  const [category, setCategory] = useState('knowledge');
  const [description, setDescription] = useState('');
  const [error, setError] = useState('');
  const [actionError, setActionError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    apiFetch<{ data: OrganizationRow[] }>('/api/v1/organizations')
      .then((res) => {
        setOrgs(res.data);
        if (res.data.length > 0) setOrgId(res.data[0].id);
      })
      .catch(() => setError('组织列表加载失败'));
    apiFetch<{ data: CategoryCount[] }>('/api/v1/marketplace/categories')
      .then((res) => setCategories(res.data))
      .catch(() => undefined);
  }, []);

  const load = useCallback(async (organizationId: string, nextStatus: string) => {
    if (!organizationId) return;
    try {
      const res = await apiFetch<{ data: ManageResult }>(
        `/api/v1/marketplace/publications?status=${nextStatus}&organizationId=${encodeURIComponent(organizationId)}`,
      );
      setItems(res.data.items);
      setError('');
    } catch (err) {
      setItems([]);
      setError((err as Error).message || '条目加载失败（需要该组织成员身份）');
    }
  }, []);

  useEffect(() => { void load(orgId, status); }, [load, orgId, status]);

  const act = async (path: string, body?: Record<string, unknown>) => {
    setBusy(true);
    setActionError('');
    try {
      await apiFetch(path, { method: 'POST', ...(body ? { body: JSON.stringify(body) } : {}) });
      await load(orgId, status);
    } catch (err) {
      setActionError((err as Error).message || '操作失败');
    } finally {
      setBusy(false);
    }
  };

  if (orgs === null) return <p className="p-8 text-sm text-zinc-500">加载中…</p>;

  const role = orgs.find((o) => o.id === orgId)?.members[0]?.role ?? null;
  const canWrite = role !== null && WRITABLE_ROLES.includes(role);

  return (
    <div className="mx-auto max-w-4xl px-4 py-8">
      <Link href="/marketplace" className="text-xs text-zinc-500 hover:text-zinc-300">← 扩展市场</Link>

      <div className="mt-4 mb-6 flex items-baseline justify-between">
        <h1 className="text-lg font-semibold text-zinc-100">发布管理</h1>
        <span className="text-xs text-zinc-500">上架门禁在服务端 · 未通过平台校验的扩展无法上架</span>
      </div>

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <select
          aria-label="组织"
          value={orgId}
          onChange={(e) => setOrgId(e.target.value)}
          className="rounded-lg border border-zinc-800 bg-zinc-900/60 px-3 py-2 text-sm text-zinc-300"
        >
          {orgs.map((o) => (
            <option key={o.id} value={o.id}>{o.name}{o.isPersonal ? '（个人）' : ''}</option>
          ))}
        </select>
        <select
          aria-label="状态"
          value={status}
          onChange={(e) => setStatus(e.target.value as (typeof STATUSES)[number])}
          className="rounded-lg border border-zinc-800 bg-zinc-900/60 px-3 py-2 text-sm text-zinc-300"
        >
          {STATUSES.map((s) => <option key={s} value={s}>{s === 'all' ? '全部状态' : s}</option>)}
        </select>
        {role && <span className="text-xs text-zinc-500">我的角色：{role}{canWrite ? '' : '（只读）'}</span>}
      </div>

      {canWrite && (
        <form
          className="mb-6 flex flex-wrap items-center gap-2 rounded-lg border border-zinc-800/80 bg-zinc-900/40 p-3"
          onSubmit={(e) => {
            e.preventDefault();
            void act('/api/v1/marketplace/publications', {
              extensionId: extensionId.trim(), category, description: description.trim(),
            });
          }}
        >
          <input
            aria-label="扩展 ID"
            value={extensionId}
            onChange={(e) => setExtensionId(e.target.value)}
            placeholder="已发布扩展 id"
            className="min-w-0 flex-1 rounded-lg border border-zinc-800 bg-zinc-900/60 px-3 py-1.5 text-sm text-zinc-200 outline-none focus:border-zinc-600"
          />
          <select
            aria-label="分类"
            value={category}
            onChange={(e) => setCategory(e.target.value)}
            className="rounded-lg border border-zinc-800 bg-zinc-900/60 px-2 py-1.5 text-sm text-zinc-300"
          >
            {categories.map((c) => <option key={c.category} value={c.category}>{c.category}</option>)}
          </select>
          <input
            aria-label="条目简介"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="条目简介（至少 10 字）"
            className="min-w-0 flex-1 rounded-lg border border-zinc-800 bg-zinc-900/60 px-3 py-1.5 text-sm text-zinc-200 outline-none focus:border-zinc-600"
          />
          <button
            type="submit"
            disabled={busy || extensionId.trim().length === 0 || description.trim().length < 10}
            className="rounded-lg border border-zinc-700 px-3 py-1.5 text-sm text-zinc-200 hover:border-zinc-500 disabled:opacity-40"
          >
            建草稿条目
          </button>
        </form>
      )}

      {actionError && <p className="mb-3 text-xs text-red-400">{actionError}</p>}
      {error && <p className="mb-3 text-xs text-red-400">{error}</p>}
      {items.length === 0 && !error && <p className="py-8 text-center text-sm text-zinc-500">该组织暂无市场条目</p>}

      <ul className="space-y-2">
        {items.map((p) => (
          <li key={p.id} className="flex items-center gap-3 rounded-lg border border-zinc-800/80 bg-zinc-900/40 px-4 py-3 text-sm">
            <Link href={`/marketplace/${p.id}`} className="min-w-0 flex-1">
              <span className="block truncate font-medium text-zinc-200">{p.extension?.name ?? '（扩展已移除）'}</span>
              <span className="block truncate text-xs text-zinc-500">{p.category} · 安装 {p.installCount}{p.publishedVersion ? ` · v${p.publishedVersion.version}` : ''}</span>
            </Link>
            <span className={`shrink-0 rounded px-2 py-0.5 text-xs ${STATUS_STYLE[p.status] ?? STATUS_STYLE.draft}`}>{p.status}</span>
            {canWrite && p.status === 'draft' && (
              <button type="button" disabled={busy} onClick={() => void act(`/api/v1/marketplace/publications/${p.id}/publish`)}
                className="shrink-0 rounded border border-emerald-800 px-2 py-0.5 text-xs text-emerald-300 disabled:opacity-40">
                上架
              </button>
            )}
            {canWrite && p.status === 'published' && (
              <button type="button" disabled={busy} onClick={() => void act(`/api/v1/marketplace/publications/${p.id}/withdraw`)}
                className="shrink-0 rounded border border-zinc-700 px-2 py-0.5 text-xs text-zinc-200 disabled:opacity-40">
                撤回
              </button>
            )}
            {canWrite && p.status === 'rejected' && (
              <button type="button" disabled={busy} onClick={() => void act(`/api/v1/marketplace/publications/${p.id}/revise`)}
                className="shrink-0 rounded border border-zinc-700 px-2 py-0.5 text-xs text-zinc-200 disabled:opacity-40">
                修订
              </button>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
