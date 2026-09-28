'use client';

import { use, useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { apiFetch } from '@/lib/api';

interface DeclaredPermission { name: string; scope: string; description: string | null }
interface DroppedTool { name: string; reason: string; detail: string }
interface PermissionDisclosure {
  readOnly: true;
  kind: string;
  policy: string;
  declaredPermissions: DeclaredPermission[];
  requestedTools: string[];
  effectiveTools: string[];
  droppedTools: DroppedTool[];
  wrappedTool: { name: string; baseTool: string; baseToolPermission: string | null; wrappable: boolean } | null;
}
interface ReviewRow {
  id: string;
  userId: string;
  rating: number;
  body: string | null;
  moderationStatus: 'pending' | 'approved' | 'rejected';
  createdAt: string;
  reviewer: { userId: string; displayName: string | null };
}
interface PublicationDetail {
  id: string;
  status: 'draft' | 'published' | 'rejected';
  category: string;
  description: string;
  changelog: Array<{ version: string; notes: string }> | null;
  compatibility: { minPlatformVersion?: string; maxPlatformVersion?: string; notes?: string } | null;
  publisher: { organizationId: string; organizationName: string | null; displayName: string | null };
  extension: { id: string; name: string; slug: string; kind: string; scope: 'platform' | 'organization'; status: string } | null;
  publishedVersion: { id: string; version: number; checksum: string; createdAt: string } | null;
  rating: { average: number | null; count: number; distribution: Record<string, number> };
  installCount: number;
  permissionDisclosure: PermissionDisclosure | null;
  reviews: ReviewRow[];
  viewer: { role: string | null; platformAdmin: boolean; canManage: boolean; canModerate: boolean; myReview: ReviewRow | null };
}

const STATUS_STYLE: Record<string, string> = {
  draft: 'bg-zinc-800 text-zinc-400',
  published: 'bg-emerald-900/60 text-emerald-300',
  rejected: 'bg-red-900/60 text-red-300',
};

/**
 * M9-P6 Marketplace 详情（公开面）。
 * 展示评分 / 安装量 / **权限披露**（manifest 声明 ∩ 平台白名单 ∩ 平台工具注册表 ∩ 组织策略）与 changelog；
 * 管理动作（发布/撤回/修订/驳回/评分审核）由服务端 RBAC 裁决，本页只按 viewer 能力显隐入口。
 */
export default function MarketplaceDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const [detail, setDetail] = useState<PublicationDetail | null>(null);
  const [error, setError] = useState('');
  const [actionError, setActionError] = useState('');
  const [busy, setBusy] = useState(false);
  const [rejectReason, setRejectReason] = useState('');
  const [rating, setRating] = useState(5);
  const [reviewBody, setReviewBody] = useState('');
  const [pending, setPending] = useState<ReviewRow[]>([]);

  const load = useCallback(async () => {
    try {
      const res = await apiFetch<{ data: PublicationDetail }>(`/api/v1/marketplace/publications/${id}`);
      setDetail(res.data);
      setError('');
    } catch (err) {
      setError((err as Error).message || '条目不存在或不可见');
    }
  }, [id]);

  useEffect(() => { void load(); }, [load]);

  // 待审队列仅对审核者（组织 owner/admin 或平台管理员）可读；服务端对无权限者返回 403
  useEffect(() => {
    if (!detail?.viewer.canModerate) return;
    apiFetch<{ data: ReviewRow[] }>(`/api/v1/marketplace/publications/${id}/reviews?moderationStatus=pending`)
      .then((res) => setPending(res.data))
      .catch(() => undefined);
  }, [detail, id]);

  const act = async (path: string, body?: Record<string, unknown>) => {
    setBusy(true);
    setActionError('');
    try {
      await apiFetch(path, { method: 'POST', ...(body ? { body: JSON.stringify(body) } : {}) });
      await load();
    } catch (err) {
      setActionError((err as Error).message || '操作失败');
    } finally {
      setBusy(false);
    }
  };

  if (error) return <p className="p-8 text-sm text-red-400">{error}</p>;
  if (!detail) return <p className="p-8 text-sm text-zinc-500">加载中…</p>;

  const disclosure = detail.permissionDisclosure;
  const { viewer } = detail;

  return (
    <div className="mx-auto max-w-4xl px-4 py-8">
      <Link href="/marketplace" className="text-xs text-zinc-500 hover:text-zinc-300">← 扩展市场</Link>

      <div className="mt-4 mb-6 flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h1 className="text-lg font-semibold text-zinc-100">{detail.extension?.name ?? '（扩展已移除）'}</h1>
          <p className="mt-1 text-xs text-zinc-500">
            {detail.extension?.scope === 'platform' ? '平台级扩展' : '组织私有扩展'} · {detail.extension?.kind ?? '-'} · 分类 {detail.category}
            {detail.publishedVersion && ` · 上架版本 v${detail.publishedVersion.version}`}
          </p>
          <p className="mt-1 text-xs text-zinc-500">
            发布者：{detail.publisher.organizationName ?? '未知组织'}
            {detail.publisher.displayName ? ` / ${detail.publisher.displayName}` : ''}
          </p>
        </div>
        <span className={`shrink-0 rounded px-2 py-0.5 text-xs ${STATUS_STYLE[detail.status] ?? STATUS_STYLE.draft}`}>{detail.status}</span>
      </div>

      <div className="mb-6 grid grid-cols-2 gap-3 text-sm sm:grid-cols-3">
        <div className="rounded-lg border border-zinc-800/80 bg-zinc-900/40 px-4 py-3">
          <div className="text-xs text-zinc-500">评分</div>
          <div className="mt-1 text-zinc-200">
            {detail.rating.average === null ? '暂无评分' : `★ ${detail.rating.average.toFixed(2)}`}
            <span className="ml-1 text-xs text-zinc-500">（{detail.rating.count} 条通过审核）</span>
          </div>
          <div className="mt-2 space-y-0.5">
            {[5, 4, 3, 2, 1].map((star) => (
              <div key={star} className="flex items-center gap-2 text-[11px] text-zinc-500">
                <span className="w-6">{star} 星</span>
                <span className="h-1.5 flex-1 rounded bg-zinc-800">
                  <span
                    className="block h-1.5 rounded bg-amber-500/70"
                    style={{ width: detail.rating.count ? `${((detail.rating.distribution?.[star] ?? 0) / detail.rating.count) * 100}%` : '0%' }}
                  />
                </span>
                <span className="w-6 text-right">{detail.rating.distribution?.[star] ?? 0}</span>
              </div>
            ))}
          </div>
        </div>
        <div className="rounded-lg border border-zinc-800/80 bg-zinc-900/40 px-4 py-3">
          <div className="text-xs text-zinc-500">安装量</div>
          <div className="mt-1 text-zinc-200">{detail.installCount}</div>
          <div className="mt-2 text-[11px] text-zinc-500">按组织安装计数（不随启停变化）</div>
        </div>
        <div className="rounded-lg border border-zinc-800/80 bg-zinc-900/40 px-4 py-3">
          <div className="text-xs text-zinc-500">上架版本校验和</div>
          <div className="mt-1 truncate font-mono text-xs text-zinc-300">{detail.publishedVersion?.checksum.slice(0, 16) ?? '-'}…</div>
          <div className="mt-2 text-[11px] text-zinc-500">上架时锁定（manifest 内容不整体回显）</div>
        </div>
      </div>

      <section className="mb-6">
        <h2 className="mb-2 text-sm font-medium text-zinc-200">简介</h2>
        <p className="whitespace-pre-wrap text-sm text-zinc-400">{detail.description}</p>
      </section>

      <section className="mb-6">
        <h2 className="mb-2 text-sm font-medium text-zinc-200">权限披露</h2>
        {!disclosure ? (
          <p className="text-xs text-zinc-500">无版本信息，无法披露</p>
        ) : (
          <div className="rounded-lg border border-zinc-800/80 bg-zinc-900/40 px-4 py-3 text-sm">
            <p className="text-xs text-amber-300/80">{disclosure.policy}</p>
            <p className="mt-2 text-xs text-zinc-500">
              声明权限（{disclosure.kind}）：
              {disclosure.declaredPermissions.length === 0
                ? ' 无'
                : disclosure.declaredPermissions.map((p) => (
                  <span key={p.name} className="ml-1 rounded bg-zinc-800 px-1.5 py-0.5 font-mono text-[11px] text-zinc-300">{p.name}</span>
                ))}
            </p>
            {disclosure.wrappedTool && (
              <p className="mt-2 text-xs text-zinc-500">
                包装工具：<span className="font-mono text-zinc-300">{disclosure.wrappedTool.name}</span>
                {' → '}<span className="font-mono text-zinc-300">{disclosure.wrappedTool.baseTool}</span>
                （权限 {disclosure.wrappedTool.baseToolPermission ?? '未注册'}，
                {disclosure.wrappedTool.wrappable ? '可包装' : '平台不允许包装'}）
              </p>
            )}
            {disclosure.requestedTools.length > 0 && (
              <div className="mt-2 text-xs text-zinc-500">
                <div>
                  清单请求的工具：{disclosure.requestedTools.map((t) => (
                    <span key={t} className="ml-1 font-mono text-zinc-400">{t}</span>
                  ))}
                </div>
                <div className="mt-1">
                  平台实际授予：{disclosure.effectiveTools.length === 0
                    ? ' 无'
                    : disclosure.effectiveTools.map((t) => (
                      <span key={t} className="ml-1 rounded bg-emerald-900/40 px-1.5 py-0.5 font-mono text-[11px] text-emerald-300">{t}</span>
                    ))}
                </div>
                {disclosure.droppedTools.length > 0 && (
                  <ul className="mt-1 space-y-0.5">
                    {disclosure.droppedTools.map((d) => (
                      <li key={d.name}>
                        被剔除：<span className="font-mono text-zinc-400">{d.name}</span>
                        <span className="ml-1 text-zinc-600">（{d.reason}）</span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
          </div>
        )}
      </section>

      <section className="mb-6">
        <h2 className="mb-2 text-sm font-medium text-zinc-200">更新日志 / 兼容性</h2>
        {detail.changelog?.length ? (
          <ul className="space-y-1 text-sm text-zinc-400">
            {detail.changelog.map((c) => (
              <li key={c.version}>
                <span className="font-mono text-xs text-zinc-300">v{c.version}</span>
                <span className="ml-2">{c.notes}</span>
              </li>
            ))}
          </ul>
        ) : <p className="text-xs text-zinc-500">未提供更新日志</p>}
        {detail.compatibility && (
          <p className="mt-2 text-xs text-zinc-500">
            兼容性：{[
              detail.compatibility.minPlatformVersion ? `平台 ≥ ${detail.compatibility.minPlatformVersion}` : '',
              detail.compatibility.maxPlatformVersion ? `平台 ≤ ${detail.compatibility.maxPlatformVersion}` : '',
              detail.compatibility.notes ?? '',
            ].filter(Boolean).join(' · ') || '仅声明，无区间'}
          </p>
        )}
      </section>

      <section className="mb-6">
        <h2 className="mb-2 text-sm font-medium text-zinc-200">评审（{detail.reviews.length}）</h2>
        {detail.reviews.length === 0 && <p className="text-xs text-zinc-500">暂无通过审核的评审</p>}
        <ul className="space-y-2">
          {detail.reviews.map((r) => (
            <li key={r.id} className="rounded-lg border border-zinc-800/80 bg-zinc-900/40 px-4 py-2 text-sm">
              <div className="flex items-center gap-2 text-xs text-zinc-500">
                <span className="text-zinc-300">{r.reviewer.displayName ?? '匿名用户'}</span>
                <span className="text-amber-400">{'★'.repeat(r.rating)}{'☆'.repeat(5 - r.rating)}</span>
                <span>{new Date(r.createdAt).toLocaleString()}</span>
              </div>
              {r.body && <p className="mt-1 text-zinc-400">{r.body}</p>}
            </li>
          ))}
        </ul>

        {detail.viewer.myReview && (
          <p className="mt-3 text-xs text-zinc-500">
            我的评分：{detail.viewer.myReview.rating} 星 · 状态 {detail.viewer.myReview.moderationStatus}
          </p>
        )}

        {detail.status === 'published' && (
          <form
            className="mt-3 flex flex-wrap items-center gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              void act(`/api/v1/marketplace/publications/${id}/reviews`, { rating, ...(reviewBody ? { body: reviewBody } : {}) });
            }}
          >
            <select
              aria-label="评分"
              value={rating}
              onChange={(e) => setRating(Number(e.target.value))}
              className="rounded-lg border border-zinc-800 bg-zinc-900/60 px-2 py-1.5 text-sm text-zinc-300"
            >
              {[5, 4, 3, 2, 1].map((n) => <option key={n} value={n}>{n} 星</option>)}
            </select>
            <input
              aria-label="评审内容"
              value={reviewBody}
              onChange={(e) => setReviewBody(e.target.value)}
              placeholder="用后评价（可选）"
              className="min-w-0 flex-1 rounded-lg border border-zinc-800 bg-zinc-900/60 px-3 py-1.5 text-sm text-zinc-200 outline-none focus:border-zinc-600"
            />
            <button type="submit" disabled={busy} className="rounded-lg border border-zinc-700 px-3 py-1.5 text-sm text-zinc-200 hover:border-zinc-500 disabled:opacity-40">
              提交评分
            </button>
          </form>
        )}
      </section>

      {(viewer.canManage || viewer.canModerate) && (
        <section className="mb-6">
          <h2 className="mb-2 text-sm font-medium text-zinc-200">管理</h2>
          <div className="flex flex-wrap items-center gap-2">
            {viewer.canManage && detail.status === 'draft' && (
              <button type="button" disabled={busy} onClick={() => void act(`/api/v1/marketplace/publications/${id}/publish`)}
                className="rounded-lg border border-emerald-800 px-3 py-1.5 text-sm text-emerald-300 disabled:opacity-40">
                上架
              </button>
            )}
            {viewer.canManage && detail.status === 'published' && (
              <button type="button" disabled={busy} onClick={() => void act(`/api/v1/marketplace/publications/${id}/withdraw`)}
                className="rounded-lg border border-zinc-700 px-3 py-1.5 text-sm text-zinc-200 disabled:opacity-40">
                撤回
              </button>
            )}
            {viewer.canManage && detail.status === 'rejected' && (
              <button type="button" disabled={busy} onClick={() => void act(`/api/v1/marketplace/publications/${id}/revise`)}
                className="rounded-lg border border-zinc-700 px-3 py-1.5 text-sm text-zinc-200 disabled:opacity-40">
                修订（回草稿）
              </button>
            )}
            {viewer.canModerate && detail.status === 'published' && (
              <span className="flex items-center gap-2">
                <input
                  aria-label="驳回理由"
                  value={rejectReason}
                  onChange={(e) => setRejectReason(e.target.value)}
                  placeholder="驳回理由（必填）"
                  className="rounded-lg border border-zinc-800 bg-zinc-900/60 px-3 py-1.5 text-sm text-zinc-200 outline-none focus:border-zinc-600"
                />
                <button
                  type="button"
                  disabled={busy || rejectReason.trim().length < 4}
                  onClick={() => void act(`/api/v1/marketplace/publications/${id}/reject`, { reason: rejectReason.trim() })}
                  className="rounded-lg border border-red-900 px-3 py-1.5 text-sm text-red-300 disabled:opacity-40"
                >
                  驳回下架
                </button>
              </span>
            )}
          </div>
          {actionError && <p className="mt-2 text-xs text-red-400">{actionError}</p>}
          {viewer.canModerate && (
            <div className="mt-4">
              <h3 className="text-xs text-zinc-400">评审审核 · 待审（{pending.length}）</h3>
              {pending.length === 0
                ? <p className="mt-1 text-xs text-zinc-600">暂无待审评审</p>
                : (
                  <ul className="mt-1 space-y-1">
                    {pending.map((r) => (
                      <li key={r.id} className="flex items-center gap-2 text-xs text-zinc-400">
                        <span className="text-zinc-300">{r.reviewer.displayName ?? '匿名用户'}</span>
                        <span className="text-amber-400">{r.rating} 星</span>
                        <span className="min-w-0 flex-1 truncate">{r.body ?? ''}</span>
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => void act(`/api/v1/marketplace/reviews/${r.id}/moderation`, { status: 'approved' })}
                          className="rounded border border-emerald-800 px-2 py-0.5 text-emerald-300 disabled:opacity-40"
                        >
                          通过
                        </button>
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => void act(`/api/v1/marketplace/reviews/${r.id}/moderation`, { status: 'rejected', reason: '内容不符合社区规范' })}
                          className="rounded border border-red-900 px-2 py-0.5 text-red-300 disabled:opacity-40"
                        >
                          驳回
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
            </div>
          )}
        </section>
      )}
    </div>
  );
}
