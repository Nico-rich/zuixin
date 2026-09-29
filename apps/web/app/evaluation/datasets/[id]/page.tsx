'use client';

import { use, useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { Plus } from 'lucide-react';
import { apiFetch, jsonInit, ApiError } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { WriteError, toApiError } from '@/components/write-error';
import { useToast } from '@/components/ui/toast';

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

/** 与服务端 evaluation.dto.ts 的 MAX_CASES_PER_DATASET 一致 */
const MAX_CASES = 500;

/**
 * 把库里读到的 case 原样回写成 PUT /cases 接受的输入形状（strictObject：多余字段会被拒绝）。
 * 无法忠实回写（input 不是 string 也不是 {message}）时返回 null —— 调用方**阻止写入**，
 * 绝不用 JSON.stringify 把 {message:"x"} 改写成字符串（那会静默改变用例语义 / 破坏历史事实）。
 */
function toCaseInput(c: CaseRow): { input: string | { message: string }; expected?: unknown; tags?: string[] } | null {
  let input: string | { message: string };
  if (typeof c.input === 'string') {
    input = c.input;
  } else if (c.input && typeof c.input === 'object' && typeof (c.input as { message?: unknown }).message === 'string') {
    input = { message: (c.input as { message: string }).message };
  } else {
    return null;
  }
  const out: { input: string | { message: string }; expected?: unknown; tags?: string[] } = { input };
  // expected 允许 string | object | array | number | boolean | null；DB 缺省即 null（如实回写，不编造）
  const expected = c.expected === undefined ? null : c.expected;
  if (expected === null || typeof expected === 'string' || typeof expected === 'number'
    || typeof expected === 'boolean' || typeof expected === 'object') {
    out.expected = expected;
  }
  if (Array.isArray(c.tags) && c.tags.length > 0) out.tags = c.tags.map((t) => String(t)).slice(0, 20);
  return out;
}

/** 数据集详情：当前版本用例 + 版本清单（历史版本行永不删除 → 历史 run 永远可复现）+ 用例写入（M13-W10） */
export default function EvaluationDatasetPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const { toast } = useToast();
  const [dataset, setDataset] = useState<DatasetDetail | null>(null);
  const [versions, setVersions] = useState<VersionRow[]>([]);
  const [error, setError] = useState('');
  const [open, setOpen] = useState(false);
  const [input, setInput] = useState('');
  const [expected, setExpected] = useState('');
  const [localError, setLocalError] = useState('');
  const [writeError, setWriteError] = useState<ApiError | null>(null);
  const [pending, setPending] = useState(false);

  const load = useCallback(async () => {
    try {
      const [d, v] = await Promise.all([
        apiFetch<{ data: DatasetDetail }>(`/api/v1/evaluation/datasets/${id}`),
        apiFetch<{ data: { versions: VersionRow[] } }>(`/api/v1/evaluation/datasets/${id}/versions`),
      ]);
      setDataset(d.data);
      setVersions(v.data.versions);
      setError('');
    } catch {
      setError('数据集加载失败');
    }
  }, [id]);

  useEffect(() => { void load(); }, [load]);

  const openDialog = () => { setInput(''); setExpected(''); setLocalError(''); setWriteError(null); setOpen(true); };

  const addCase = async () => {
    const text = input.trim();
    if (!text || pending || !dataset) return;
    // 既有用例原样回写（服务端是整批替换语义，不是增量追加）——无法忠实回写则拒绝发请求
    const existing = dataset.cases.map(toCaseInput);
    if (existing.some((c) => c === null)) {
      setLocalError('存在无法原样回写的用例（input 结构不在 string / {message} 形状内）；为避免改写历史用例，已阻止本次写入。');
      return;
    }
    const cases = [
      ...(existing as Array<{ input: string | { message: string } }>),
      { input: text, ...(expected.trim() ? { expected: expected.trim() } : {}) },
    ];
    if (cases.length > MAX_CASES) {
      setLocalError(`用例数上限 ${MAX_CASES}（当前 ${dataset.cases.length} + 新增 1 超限）；请先精简既有用例。`);
      return;
    }
    setLocalError(''); setWriteError(null); setPending(true);
    try {
      const res = await apiFetch<{ data: DatasetDetail }>(`/api/v1/evaluation/datasets/${id}/cases`, jsonInit('PUT', { cases }));
      setDataset(res.data);
      setOpen(false);
      toast({
        title: '用例已写入',
        description: `整批替换为 v${res.data.version}（copy-on-write；历史版本行保留）`,
        variant: 'success',
      });
      await load();
    } catch (err) {
      setWriteError(toApiError(err, '写入失败，请重试'));
    } finally { setPending(false); }
  };

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
        <div className="mb-3 flex items-center justify-between gap-3">
          <h2 className="text-sm font-medium text-zinc-300">当前版本用例（{dataset.cases.length}）</h2>
          <Button size="sm" variant="outline" onClick={openDialog}><Plus /> 写入用例</Button>
        </div>
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

      <Dialog open={open} onOpenChange={(next) => { if (!next) { setOpen(false); setWriteError(null); } }}>
        <form onSubmit={(e) => { e.preventDefault(); void addCase(); }}>
          <DialogHeader>
            <div className="min-w-0">
              <DialogTitle>写入用例</DialogTitle>
              <DialogDescription>
                服务端口径是「整批替换」（copy-on-write）：本次会提交既有 {dataset.cases.length} 条 + 新增 1 条，
                数据集版本 → v{dataset.version + 1}；历史版本行保留，历史 run 仍指向旧版本。
              </DialogDescription>
            </div>
          </DialogHeader>
          <DialogContent className="space-y-3">
            <div className="space-y-1">
              <label htmlFor="case-input" className="block text-xs text-zinc-400">输入（必填，≤20000 字）</label>
              <Textarea id="case-input" value={input} rows={4} maxLength={20_000} autoFocus
                placeholder="发给 Agent 的用户消息" onChange={(e) => setInput(e.target.value)} />
            </div>
            <div className="space-y-1">
              <label htmlFor="case-expected" className="block text-xs text-zinc-400">期望（可选，纯文本精确比较）</label>
              <Textarea id="case-expected" value={expected} rows={3} maxLength={20_000}
                placeholder="留空 = 该用例不设期望值（打分器行为由评测器类型决定）" onChange={(e) => setExpected(e.target.value)} />
            </div>
            {localError && <p className="text-xs text-zinc-400">{localError}</p>}
            <WriteError error={writeError} forbiddenHint="需要组织 owner/admin 权限（evaluation.write）" />
          </DialogContent>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => setOpen(false)} disabled={pending}>取消</Button>
            <Button type="submit" disabled={pending || !input.trim()}>{pending ? '写入中…' : '写入'}</Button>
          </DialogFooter>
        </form>
      </Dialog>
    </div>
  );
}
