'use client';

import { use, useEffect, useState } from 'react';
import Link from 'next/link';
import { apiFetch } from '@/lib/api';

interface EvaluationResultRow {
  evaluatorId: string;
  score: number;
  passed: boolean;
  evidence: Record<string, unknown> | null;
}

interface CaseRunRow {
  id: string;
  caseId: string;
  status: string;
  input: unknown;
  output: { text?: string } | null;
  latencyMs: number | null;
  promptTokens: number;
  completionTokens: number;
  cost: number;
  toolCalls: unknown;
  errorCode: string | null;
  case: { id: string; input: unknown; expected: unknown } | null;
  results: EvaluationResultRow[];
}

interface EvaluatorScoreRow {
  evaluatorId: string;
  name: string;
  type: string;
  evaluated: number;
  passed: number;
  failed: number;
  avgScore: number;
  passRate: number;
}

interface RunDetail {
  run: {
    id: string;
    datasetId: string;
    datasetVersion: number;
    agentId: string;
    agentVersionId: string;
    status: string;
    totalCases: number;
    completedCases: number;
    baselineRunId: string | null;
    configSnapshot: Record<string, unknown>;
    createdAt: string;
    completedAt: string | null;
  };
  cases: CaseRunRow[];
  scores: {
    evaluators: EvaluatorScoreRow[];
    overall: { evaluated: number; passed: number; failed: number; avgScore: number; passRate: number };
    caseRuns: { total: number; completed: number; failed: number; pending: number; skipped: number };
  };
}

interface Comparison {
  candidateRunId: string;
  baselineRunId: string;
  comparable: boolean;
  summary: Record<string, number>;
  cases: Array<{ caseId: string; outcome: string; baseline: { score: number; passed: boolean } | null; candidate: { score: number; passed: boolean } | null }>;
  evaluators: Array<{ evaluatorId: string; name: string; type: string; delta: { avgScore: number; passRate: number } }>;
}

const OUTCOME_STYLE: Record<string, string> = {
  unchanged_pass: 'bg-emerald-900/60 text-emerald-300',
  unchanged_fail: 'bg-zinc-800 text-zinc-400',
  improved: 'bg-sky-900/60 text-sky-300',
  regressed: 'bg-red-900/60 text-red-300',
  added: 'bg-zinc-800 text-zinc-400',
  removed: 'bg-zinc-800 text-zinc-500',
};

const asText = (value: unknown): string => {
  if (value === null || value === undefined) return '';
  return typeof value === 'string' ? value : JSON.stringify(value);
};

const pct = (value: number): string => `${Math.round(value * 10000) / 100}%`;

/** 评测运行详情（只读）：run 快照 + 每评测器分数 + case 事实/结果 + baseline 对照 */
export default function EvaluationRunPage({ params }: { params: Promise<{ runId: string }> }) {
  const { runId } = use(params);
  const [detail, setDetail] = useState<RunDetail | null>(null);
  const [comparison, setComparison] = useState<Comparison | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    Promise.all([
      apiFetch<{ data: RunDetail }>(`/api/v1/evaluation/runs/${runId}`),
      apiFetch<{ data: { comparison: Comparison | null } }>(`/api/v1/evaluation/runs/${runId}/comparison`),
    ])
      .then(([d, c]) => {
        setDetail(d.data);
        setComparison(c.data.comparison);
      })
      .catch(() => setError('评测运行加载失败'));
  }, [runId]);

  if (error) return <p className="p-8 text-sm text-red-400">{error}</p>;
  if (!detail) return <p className="p-8 text-sm text-zinc-500">加载中…</p>;

  const snap = detail.run.configSnapshot;
  const evaluatorName = (id: string) => detail.scores.evaluators.find((e) => e.evaluatorId === id)?.name ?? id.slice(0, 8);

  return (
    <div className="mx-auto max-w-4xl px-4 py-8">
      <div className="mb-6 flex items-center gap-3">
        <h1 className="text-lg font-semibold text-zinc-100">评测运行</h1>
        <span className="rounded bg-zinc-800 px-2 py-0.5 text-xs text-zinc-300">{detail.run.status}</span>
        <Link href="/evaluation" className="ml-auto text-xs text-zinc-500 hover:text-zinc-300">← 评测</Link>
      </div>

      <section className="mb-6 rounded-lg border border-zinc-800/80 bg-zinc-900/40 p-4 text-xs text-zinc-400">
        <div className="mb-2 flex flex-wrap gap-x-6 gap-y-1">
          <span>数据集：<Link href={`/evaluation/datasets/${detail.run.datasetId}`} className="font-mono text-zinc-300 hover:text-zinc-100">v{detail.run.datasetVersion}</Link></span>
          <span>case：{detail.run.completedCases}/{detail.run.totalCases}（failed {detail.scores.caseRuns.failed} · pending {detail.scores.caseRuns.pending}）</span>
          <span>模型：{asText(snap.modelId) || '（版本默认）'}</span>
          <span>temperature：{asText(snap.temperature)}</span>
          <span>开始：{new Date(detail.run.createdAt).toLocaleString()}</span>
          {detail.run.completedAt && <span>结束：{new Date(detail.run.completedAt).toLocaleString()}</span>}
        </div>
        <p className="text-zinc-600">
          run <span className="font-mono">{detail.run.id}</span> · 配置在创建时冻结（{asText(snap.schema) ? `schema ${asText(snap.schema)}` : '快照'}），
          数据集后续编辑不会改变本次结果
          {detail.run.baselineRunId && <> · 基线 <Link href={`/evaluation/runs/${detail.run.baselineRunId}`} className="font-mono text-zinc-400 hover:text-zinc-200">{detail.run.baselineRunId}</Link></>}
        </p>
      </section>

      <section className="mb-6 rounded-lg border border-zinc-800/80 bg-zinc-900/40 p-4">
        <h2 className="mb-3 text-sm font-medium text-zinc-300">分数</h2>
        <table className="w-full text-left text-xs">
          <thead className="text-zinc-500">
            <tr>
              <th className="py-1 font-normal">评测器</th>
              <th className="py-1 font-normal">类型</th>
              <th className="py-1 font-normal">已评</th>
              <th className="py-1 font-normal">通过</th>
              <th className="py-1 font-normal">均分</th>
              <th className="py-1 font-normal">通过率</th>
            </tr>
          </thead>
          <tbody className="text-zinc-300">
            {detail.scores.evaluators.map((e) => (
              <tr key={e.evaluatorId} className="border-t border-zinc-800/60">
                <td className="py-1.5">{e.name}</td>
                <td className="py-1.5 font-mono text-zinc-500">{e.type}</td>
                <td className="py-1.5">{e.evaluated}</td>
                <td className="py-1.5">{e.passed}</td>
                <td className="py-1.5">{e.avgScore}</td>
                <td className="py-1.5">{pct(e.passRate)}</td>
              </tr>
            ))}
            <tr className="border-t border-zinc-700 text-zinc-200">
              <td className="py-1.5 font-medium" colSpan={2}>总体</td>
              <td className="py-1.5">{detail.scores.overall.evaluated}</td>
              <td className="py-1.5">{detail.scores.overall.passed}</td>
              <td className="py-1.5">{detail.scores.overall.avgScore}</td>
              <td className="py-1.5">{pct(detail.scores.overall.passRate)}</td>
            </tr>
          </tbody>
        </table>
        <p className="mt-2 text-xs text-zinc-600">分母只计已出结果的 case（失败/未跑的 case 不产生结果，绝不用 0 分冒充未评测）</p>
      </section>

      {comparison && (
        <section className="mb-6 rounded-lg border border-zinc-800/80 bg-zinc-900/40 p-4">
          <h2 className="mb-3 text-sm font-medium text-zinc-300">基线对照</h2>
          {!comparison.comparable && (
            <p className="mb-2 text-xs text-amber-300">两侧数据集版本不同 → 不可比（只展示逐 case 事实，绝不伪造可比性）</p>
          )}
          <div className="mb-3 flex flex-wrap gap-2 text-xs">
            {Object.entries(comparison.summary).map(([key, value]) => (
              <span key={key} className={`rounded px-2 py-0.5 ${OUTCOME_STYLE[key.replace(/([A-Z])/g, '_$1').toLowerCase()] ?? 'bg-zinc-800 text-zinc-400'}`}>
                {key} {value}
              </span>
            ))}
          </div>
          <ul className="space-y-1 text-xs text-zinc-400">
            {comparison.cases.map((c, index) => (
              <li key={c.caseId} className="flex items-center gap-2">
                <span className="font-mono text-zinc-600">#{index + 1}</span>
                <span className="text-zinc-500">基线 {c.baseline ? `${c.baseline.passed ? '通过' : '未通过'}（${c.baseline.score}）` : '无'}</span>
                <span className="text-zinc-500">→ 本次 {c.candidate ? `${c.candidate.passed ? '通过' : '未通过'}（${c.candidate.score}）` : '无'}</span>
                <span className={`ml-auto rounded px-2 py-0.5 ${OUTCOME_STYLE[c.outcome] ?? 'bg-zinc-800 text-zinc-400'}`}>{c.outcome}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="rounded-lg border border-zinc-800/80 bg-zinc-900/40 p-4">
        <h2 className="mb-3 text-sm font-medium text-zinc-300">用例结果（{detail.cases.length}）</h2>
        <ul className="space-y-3">
          {detail.cases.map((c, index) => (
            <li key={c.id} className="rounded border border-zinc-800/60 bg-zinc-950/40 p-3 text-xs">
              <div className="mb-1 flex items-center gap-2">
                <span className="font-mono text-zinc-500">#{index + 1}</span>
                <span className={`rounded px-2 py-0.5 ${c.status === 'completed' ? 'bg-zinc-800 text-zinc-400' : 'bg-red-900/60 text-red-300'}`}>{c.status}</span>
                {c.errorCode && <span className="text-red-400">{c.errorCode}</span>}
                <span className="ml-auto text-zinc-600">
                  {c.latencyMs ?? 0}ms · {c.promptTokens}+{c.completionTokens} tokens · {c.cost}
                </span>
              </div>
              <p className="whitespace-pre-wrap break-words text-zinc-400">输入：{asText(c.case?.input ?? c.input)}</p>
              {c.case?.expected !== null && c.case?.expected !== undefined && (
                <p className="whitespace-pre-wrap break-words text-zinc-500">期望：{asText(c.case.expected)}</p>
              )}
              <p className="mt-1 whitespace-pre-wrap break-words text-zinc-200">输出：{asText(c.output?.text)}</p>
              <ul className="mt-2 space-y-1">
                {c.results.map((r) => (
                  <li key={r.evaluatorId} className="flex flex-wrap items-center gap-2 text-zinc-500">
                    <span className={`rounded px-2 py-0.5 ${r.passed ? 'bg-emerald-900/60 text-emerald-300' : 'bg-zinc-800 text-zinc-400'}`}>{r.passed ? '通过' : '未通过'}</span>
                    <span className="text-zinc-400">{evaluatorName(r.evaluatorId)}</span>
                    <span>score {r.score}</span>
                    {r.evidence && (
                      <details className="w-full">
                        <summary className="cursor-pointer text-zinc-600 hover:text-zinc-400">证据</summary>
                        <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap break-words rounded bg-zinc-950/60 p-2 text-[11px] text-zinc-500">{JSON.stringify(r.evidence, null, 2)}</pre>
                      </details>
                    )}
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
