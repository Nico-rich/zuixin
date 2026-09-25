'use client';

import { use, useEffect, useState } from 'react';
import Link from 'next/link';
import { apiFetch } from '@/lib/api';

interface WorkflowDetail {
  id: string;
  name: string;
  description: string | null;
  status: string;
  versions: Array<{ id: string; version: number; status: string; createdAt: string }>;
  triggerInfo?: { webhook: { token: string; secret: string | null } | null };
}

/** 最小 Workflow 详情：版本列表 + 发布/归档 + 手动运行 + webhook 凭据（secret 仅发布时展示一次） */
export default function WorkflowDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const [wf, setWf] = useState<WorkflowDetail | null>(null);
  const [payload, setPayload] = useState('{}');
  const [result, setResult] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    apiFetch<{ data: WorkflowDetail }>(`/api/v1/workflows/${id}`)
      .then((res) => setWf(res.data))
      .catch(() => setError('工作流加载失败'));
  }, [id]);

  const act = async (path: string) => {
    setError('');
    try {
      const res = await apiFetch<{ data: WorkflowDetail }>(`/api/v1/workflows/${id}/${path}`, { method: 'POST' });
      setWf(res.data);
    } catch {
      setError('操作失败');
    }
  };

  const triggerRun = async () => {
    setError(''); setResult('');
    try {
      let parsed: unknown = {};
      try { parsed = JSON.parse(payload); } catch { throw new Error('payload 必须是 JSON'); }
      const res = await apiFetch<{ data: { id: string; status: string } }>(`/api/v1/workflows/${id}/runs`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ payload: parsed as Record<string, unknown> }),
      });
      setResult(`已触发运行 ${res.data.id}（${res.data.status}）`);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  if (error && !wf) return <p className="p-8 text-sm text-red-400">{error}</p>;
  if (!wf) return <p className="p-8 text-sm text-zinc-500">加载中…</p>;

  return (
    <div className="mx-auto max-w-4xl px-4 py-8">
      <div className="mb-6 flex items-center gap-4">
        <h1 className="text-lg font-semibold text-zinc-100">{wf.name}</h1>
        <span className="rounded bg-zinc-800 px-2 py-0.5 text-xs text-zinc-400">{wf.status}</span>
        <Link href={`/workflows/${id}/runs`} className="ml-auto text-xs text-zinc-400 hover:text-zinc-200">运行历史 →</Link>
      </div>
      {wf.description && <p className="mb-6 text-sm text-zinc-500">{wf.description}</p>}

      <section className="mb-6 rounded-lg border border-zinc-800/80 bg-zinc-900/40 p-4">
        <h2 className="mb-2 text-sm font-medium text-zinc-300">版本（不可变快照；运行锁定发布版本）</h2>
        <ul className="space-y-1">
          {wf.versions.map((v) => (
            <li key={v.id} className="flex items-center gap-3 text-xs text-zinc-400">
              <span className="font-mono">v{v.version}</span>
              <span>{v.status}</span>
              <span className="ml-auto text-zinc-600">{new Date(v.createdAt).toLocaleString()}</span>
            </li>
          ))}
        </ul>
        <div className="mt-3 flex gap-2">
          <button onClick={() => void act('publish')} disabled={wf.status === 'published'}
            className="rounded bg-emerald-800/60 px-3 py-1.5 text-xs text-emerald-200 transition hover:bg-emerald-700/60 disabled:opacity-40">
            发布最新版本
          </button>
          <button onClick={() => void act('archive')} disabled={wf.status === 'archived'}
            className="rounded bg-zinc-800 px-3 py-1.5 text-xs text-zinc-300 transition hover:bg-zinc-700 disabled:opacity-40">
            归档
          </button>
        </div>
      </section>

      {wf.status === 'published' && (
        <section className="mb-6 rounded-lg border border-zinc-800/80 bg-zinc-900/40 p-4">
          <h2 className="mb-2 text-sm font-medium text-zinc-300">手动触发运行</h2>
          <textarea value={payload} onChange={(e) => setPayload(e.target.value)}
            className="w-full rounded border border-zinc-800 bg-zinc-950 px-3 py-2 font-mono text-xs text-zinc-300" rows={3} />
          <button onClick={() => void triggerRun()} className="mt-2 rounded bg-zinc-200 px-3 py-1.5 text-xs font-medium text-zinc-900 transition hover:bg-white">
            触发运行
          </button>
          {result && <p className="mt-2 text-xs text-emerald-300">{result}</p>}
        </section>
      )}

      {wf.triggerInfo?.webhook?.secret && (
        <section className="rounded-lg border border-amber-800/60 bg-amber-950/30 p-4">
          <h2 className="mb-2 text-sm font-medium text-amber-200">Webhook 凭据（secret 仅显示这一次，请立即保存）</h2>
          <p className="text-xs text-zinc-300">端点：<code className="text-amber-200">POST /api/v1/hooks/workflows/{wf.triggerInfo.webhook.token}</code></p>
          <p className="mt-1 text-xs text-zinc-300">签名：<code className="text-amber-200">HMAC-SHA256(raw body) → hex</code>，头 <code>X-Hook-Signature</code> / <code>X-Hook-Timestamp</code>(ms) / <code>X-Hook-Event-Id</code></p>
          <p className="mt-1 break-all font-mono text-xs text-amber-100">{wf.triggerInfo.webhook.secret}</p>
        </section>
      )}
      {error && <p className="mt-4 text-xs text-red-400">{error}</p>}
    </div>
  );
}
