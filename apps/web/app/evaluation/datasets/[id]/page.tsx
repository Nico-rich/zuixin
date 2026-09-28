'use client';

import { use, useEffect, useState } from 'react';
import Link from 'next/link';
import { apiFetch } from '@/lib/api';

interface CaseRow {
  id: string;
  version: number;
  input: unknown;
  expected: unknown;
  tags: unknown;
  createdAt: string;
}

interface DatasetDetail {
  id: string;
  name: string;
  description: string | null;
  version: number;
  cases: CaseRow[];
}

interface VersionRow {
  version: number;
  caseCount: number;
}

const asText = (value: unknown): string => {
  if (value === null || value === undefined) return '';
  return typeof value === 'string' ? value : JSON.stringify(value);
};

/** 数据集详情（只读）：当前版本用例 + 版本清单（历史版本行永不删除 → 历史 run 永远可复现） */
export default function EvaluationDatasetPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const [dataset, setDataset] = useState<DatasetDetail | null>(null);
  const [versions, setVersions] = useState<VersionRow[]>([]);
  const [error, setError] = useState('');

  useEffect(() => {
    Promise.all([
      apiFetch<{ data: DatasetDetail }>(`/api/v1/evaluation/datasets/${id}`),
      apiFetch<{ data: { versions: VersionRow[] } }>(`/api/v1/evaluation/datasets/${id}/versions`),
    ])
      .then(([d, v]) => {
        setDataset(d.data);
        setVersions(v.data.versions);
      })
      .catch(() => setError('数据集加载失败'));
  }, [id]);

  if (error) return <p className="p-8 text-sm text-red-400">{error}</p>;
  if (!dataset) return <p className="p-8 text-sm text-zinc-500">加载中…</p>;

  return (
    <div className="mx-auto max-w-4xl px-4 py-8">
      <div className="mb-6 flex items-center gap-4">
        <h1 className="text-lg font-semibold text-zinc-100">{dataset.name}</h1>
        <span className="rounded bg-zinc-800 px-2 py-0.5 text-xs text-zinc-400">v{dataset.version}</span>
        <Link href="/evaluation" className="ml-auto text-xs text-zinc-500 hover:text-zinc-300">← 评测</Link>
      </div>
      {dataset.description && <p className="mb-6 text-sm text-zinc-500">{dataset.description}</p>}

      <section className="mb-6 rounded-lg border border-zinc-800/80 bg-zinc-900/40 p-4">
        <h2 className="mb-2 text-sm font-medium text-zinc-300">版本（copy-on-write；旧版本行保留）</h2>
        <ul className="flex flex-wrap gap-3 text-xs text-zinc-400">
          {versions.map((v) => (
            <li key={v.version} className={`rounded px-2 py-0.5 ${v.version === dataset.version ? 'bg-zinc-700 text-zinc-100' : 'bg-zinc-900 text-zinc-500'}`}>
              v{v.version} · {v.caseCount} 用例
            </li>
          ))}
        </ul>
      </section>

      <section className="rounded-lg border border-zinc-800/80 bg-zinc-900/40 p-4">
        <h2 className="mb-3 text-sm font-medium text-zinc-300">当前版本用例（{dataset.cases.length}）</h2>
        <ul className="space-y-3">
          {dataset.cases.map((c, index) => (
            <li key={c.id} className="rounded border border-zinc-800/60 bg-zinc-950/40 p-3 text-xs">
              <div className="mb-1 flex items-center gap-2 text-zinc-500">
                <span className="font-mono">#{index + 1}</span>
                {Array.isArray(c.tags) && c.tags.length > 0 && <span>{c.tags.map((t) => String(t)).join(' · ')}</span>}
                <span className="ml-auto text-zinc-600">{new Date(c.createdAt).toLocaleString()}</span>
              </div>
              <p className="whitespace-pre-wrap break-words text-zinc-300">{asText(c.input)}</p>
              {c.expected !== null && c.expected !== undefined && (
                <p className="mt-1 whitespace-pre-wrap break-words text-zinc-500">期望：{asText(c.expected)}</p>
              )}
            </li>
          ))}
        </ul>
        {dataset.cases.length === 0 && <p className="py-4 text-center text-xs text-zinc-500">当前版本暂无用例</p>}
      </section>
    </div>
  );
}
