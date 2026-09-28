'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { apiFetch } from '@/lib/api';

interface CategoryCount { category: string; publishedCount: number }

interface PublicationListItem {
  id: string;
  status: 'draft' | 'published' | 'rejected';
  category: string;
  description: string;
  publisher: { organizationId: string; organizationName: string | null; displayName: string | null };
  extension: { id: string; name: string; slug: string; kind: string; scope: 'platform' | 'organization' } | null;
  publishedVersion: { id: string; version: number; checksum: string; createdAt: string } | null;
  rating: { average: number | null; count: number };
  installCount: number;
}

interface SearchResult { items: PublicationListItem[]; total: number; page: number; totalPages: number }

const LIMIT = 20;
const STATUS_STYLE: Record<string, string> = {
  draft: 'bg-zinc-800 text-zinc-400',
  published: 'bg-emerald-900/60 text-emerald-300',
  rejected: 'bg-red-900/60 text-red-300',
};

/**
 * M9-P6 Marketplace 列表（公开目录；搜索 + 分类过滤）。
 * **只读展示**：评分/安装量/权限披露都只是投影，绝不代表授权（授权见扩展详情页的权限披露口径）。
 */
export default function MarketplacePage() {
  const [items, setItems] = useState<PublicationListItem[] | null>(null);
  const [categories, setCategories] = useState<CategoryCount[]>([]);
  const [keyword, setKeyword] = useState('');
  const [category, setCategory] = useState('');
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(0);
  const [total, setTotal] = useState(0);
  const [error, setError] = useState('');

  useEffect(() => {
    apiFetch<{ data: CategoryCount[] }>('/api/v1/marketplace/categories')
      .then((res) => setCategories(res.data))
      .catch(() => undefined);
  }, []);

  const load = useCallback(async (nextPage: number, q: string, cat: string) => {
    const params = new URLSearchParams({ page: String(nextPage), limit: String(LIMIT) });
    if (q) params.set('q', q);
    if (cat) params.set('category', cat);
    try {
      const res = await apiFetch<{ data: SearchResult }>(`/api/v1/marketplace/publications?${params.toString()}`);
      setItems(res.data.items);
      setTotal(res.data.total);
      setTotalPages(res.data.totalPages);
      setPage(res.data.page);
      setError('');
    } catch {
      setError('市场目录加载失败');
    }
  }, []);

  useEffect(() => { void load(1, '', ''); }, [load]);

  if (error) return <p className="p-8 text-sm text-red-400">{error}</p>;
  if (items === null) return <p className="p-8 text-sm text-zinc-500">加载中…</p>;

  return (
    <div className="mx-auto max-w-4xl px-4 py-8">
      <div className="mb-6 flex items-baseline justify-between">
        <h1 className="text-lg font-semibold text-zinc-100">扩展市场</h1>
        <div className="flex items-center gap-4">
          <Link href="/marketplace/manage" className="text-xs text-zinc-400 hover:text-zinc-100">发布管理</Link>
          <span className="text-xs text-zinc-500">声明式扩展 · 评分只展示不授权</span>
        </div>
      </div>

      <form
        className="mb-6 flex flex-wrap items-center gap-2"
        onSubmit={(e) => { e.preventDefault(); void load(1, keyword, category); }}
      >
        <input
          aria-label="关键词"
          value={keyword}
          onChange={(e) => setKeyword(e.target.value)}
          placeholder="搜索扩展名称 / 描述"
          className="min-w-0 flex-1 rounded-lg border border-zinc-800 bg-zinc-900/60 px-3 py-2 text-sm text-zinc-200 outline-none focus:border-zinc-600"
        />
        <select
          aria-label="分类"
          value={category}
          onChange={(e) => { setCategory(e.target.value); void load(1, keyword, e.target.value); }}
          className="rounded-lg border border-zinc-800 bg-zinc-900/60 px-3 py-2 text-sm text-zinc-300 outline-none focus:border-zinc-600"
        >
          <option value="">全部分类</option>
          {categories.map((c) => (
            <option key={c.category} value={c.category}>{c.category}（{c.publishedCount}）</option>
          ))}
        </select>
        <button type="submit" className="rounded-lg border border-zinc-700 px-3 py-2 text-sm text-zinc-200 hover:border-zinc-500">
          搜索
        </button>
      </form>

      <p className="mb-3 text-xs text-zinc-500">共 {total} 个已上架条目</p>
      {items.length === 0 && <p className="py-8 text-center text-sm text-zinc-500">没有匹配的扩展</p>}

      <ul className="space-y-2">
        {items.map((p) => (
          <li key={p.id}>
            <Link
              href={`/marketplace/${p.id}`}
              className="flex items-center gap-4 rounded-lg border border-zinc-800/80 bg-zinc-900/40 px-4 py-3 text-sm transition hover:border-zinc-700"
            >
              <span className="min-w-0 flex-1">
                <span className="block truncate font-medium text-zinc-200">
                  {p.extension?.name ?? '（扩展已移除）'}
                </span>
                <span className="block truncate text-xs text-zinc-500">{p.description}</span>
              </span>
              <span className="shrink-0 text-right text-xs text-zinc-500">
                <span className="block">{p.publisher.organizationName ?? '未知发布者'}</span>
                <span className="block">{p.extension?.scope === 'platform' ? '平台级' : '组织私有'} · 安装 {p.installCount}</span>
              </span>
              <span className="w-20 shrink-0 text-right text-xs text-zinc-400">
                {p.rating.average === null ? '暂无评分' : `★ ${p.rating.average.toFixed(2)}（${p.rating.count}）`}
              </span>
              <span className={`shrink-0 rounded px-2 py-0.5 text-xs ${STATUS_STYLE[p.status] ?? STATUS_STYLE.draft}`}>{p.status}</span>
            </Link>
          </li>
        ))}
      </ul>

      {totalPages > 1 && (
        <div className="mt-6 flex items-center justify-center gap-3 text-xs text-zinc-400">
          <button
            type="button"
            disabled={page <= 1}
            onClick={() => void load(page - 1, keyword, category)}
            className="rounded border border-zinc-800 px-3 py-1 disabled:opacity-40"
          >
            上一页
          </button>
          <span>{page} / {totalPages}</span>
          <button
            type="button"
            disabled={page >= totalPages}
            onClick={() => void load(page + 1, keyword, category)}
            className="rounded border border-zinc-800 px-3 py-1 disabled:opacity-40"
          >
            下一页
          </button>
        </div>
      )}
    </div>
  );
}
