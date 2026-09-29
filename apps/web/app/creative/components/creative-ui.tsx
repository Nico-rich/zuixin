'use client';

import * as React from 'react';
import Link from 'next/link';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow, TableEmpty } from '@/components/ui/table';
import type { HypothesisStatus } from '@/lib/services/creative';
import {
  HYPOTHESIS_STATUS_LABEL, HYPOTHESIS_STATUS_ORDER, HYPOTHESIS_TRANSITIONS, LAYER_META, POLL_INTERVAL_MS,
  type InsightLayer, type RunStepShape, type VerdictShape,
} from './creative-view';

/**
 * Creative 工作台（M13-W4）展示组件：**只呈现后端事实，不做任何业务判定**。
 *
 * 分层纪律（M13 红线）：facts/derived/interpretation 三层各有独立的分区与标注，
 * 任何一层都不得"美化"成另一层（解读绝不冒充事实；派生绝不冒充原始求和）。
 */

/* --------------------------------- 洞察：分层 --------------------------------- */

export function LayerBadge({ layer, note }: { layer: InsightLayer; note?: string }) {
  const meta = LAYER_META[layer];
  const variant = layer === 'facts' ? 'info' : layer === 'derived' ? 'secondary' : 'warning';
  return <Badge variant={variant}>{note ?? meta.label}</Badge>;
}

/**
 * 分层面板：`<section>` + `<h2>`（页面 h1 之下），头部固定标注该层的**来源**（layering 字段原值）。
 * 三层的来源值一律来自后端 `layering`，页面不自行"推断"来源。
 */
export function LayerSection({
  layer, source, description, children,
}: {
  layer: InsightLayer;
  source?: string;
  description?: string;
  children: React.ReactNode;
}) {
  const meta = LAYER_META[layer];
  return (
    <section data-layer={layer} className="rounded-lg border border-zinc-800/80 bg-zinc-900/40 p-4">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <h2 className="text-sm font-medium text-zinc-300">{meta.label}层</h2>
        <LayerBadge layer={layer} />
        <span className="font-mono text-[11px] text-zinc-500">{source ?? meta.source}</span>
      </div>
      {description && <p className="mb-3 text-xs text-zinc-500">{description}</p>}
      {children}
    </section>
  );
}

/** 文本段落（解读条目 / 判定理由） */
export function TextBlock({ children }: { children: React.ReactNode }) {
  return <p className="whitespace-pre-wrap break-words text-sm text-zinc-200">{children}</p>;
}

export function Hint({ children }: { children: React.ReactNode }) {
  return <p className="text-xs text-zinc-500">{children}</p>;
}

export function FieldRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5 py-1 sm:flex-row sm:gap-3">
      <span className="shrink-0 text-xs text-zinc-500 sm:w-32">{label}</span>
      <span className="min-w-0 flex-1 break-words text-xs text-zinc-300">{children}</span>
    </div>
  );
}

/** factsHash（事实层指纹）：解读写入的条件锚点，页面原样展示（绝不截断断言口径） */
export function FactsHashLine({ hash }: { hash: string }) {
  return (
    <div className="rounded-lg border border-zinc-800/80 bg-zinc-900/40 px-4 py-3">
      <div className="text-xs text-zinc-500">factsHash（事实层指纹：解读写入的条件锚点，事实变化即拒写）</div>
      <code className="mt-1 block break-all font-mono text-[11px] text-zinc-400">{hash}</code>
    </div>
  );
}

/** 键值对展示（事实/派生的标量投影） */
export function KeyValuePairs({ pairs }: { pairs: ReadonlyArray<[string, string]> }) {
  if (pairs.length === 0) return <Hint>该层无标量投影</Hint>;
  return (
    <div className="grid grid-cols-2 gap-x-4 gap-y-1 sm:grid-cols-3">
      {pairs.map(([label, value]) => (
        <div key={label} className="flex items-baseline gap-2">
          <span className="text-xs text-zinc-500">{label}</span>
          <span className="font-mono text-xs text-zinc-200">{value}</span>
        </div>
      ))}
    </div>
  );
}

/**
 * 任意 JSON 形状的如实渲染（后端 facts/derived/verdict.facts 是服务端定义的嵌套对象）。
 * 只做缩进与标点处理，**不做任何取值/计算**；深度上限后回退到 JSON 文本，避免深递归。
 */
export function ValueView({ value, depth = 0 }: { value: unknown; depth?: number }) {
  if (value === null || value === undefined) return <span className="text-zinc-600">—</span>;
  if (typeof value === 'boolean') return <span className="font-mono">{String(value)}</span>;
  if (typeof value === 'number' || typeof value === 'string') return <span className="break-all font-mono">{String(value)}</span>;
  if (depth >= 4) return <code className="break-all font-mono text-[11px] text-zinc-500">{JSON.stringify(value)}</code>;
  if (Array.isArray(value)) {
    if (value.length === 0) return <span className="font-mono text-zinc-600">（空）</span>;
    return (
      <ul className="space-y-1">
        {value.map((item, index) => (
          <li key={index} className="border-l border-zinc-800 pl-2">
            <ValueView value={item} depth={depth + 1} />
          </li>
        ))}
      </ul>
    );
  }
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length === 0) return <span className="font-mono text-zinc-600">（空）</span>;
  return (
    <div className="space-y-1">
      {entries.map(([key, item]) => (
        <div key={key} className="flex flex-col gap-0.5 sm:flex-row sm:gap-2">
          <span className="shrink-0 font-mono text-[11px] text-zinc-500 sm:w-40">{key}</span>
          <span className="min-w-0 flex-1"><ValueView value={item} depth={depth + 1} /></span>
        </div>
      ))}
    </div>
  );
}

/* --------------------------------- 假设：状态 --------------------------------- */

const STATUS_VARIANT: Record<HypothesisStatus, 'secondary' | 'info' | 'warning' | 'success' | 'destructive'> = {
  draft: 'secondary', ready: 'info', running: 'warning', validated: 'success', rejected: 'destructive',
};

export function HypothesisStatusBadge({ status }: { status: HypothesisStatus }) {
  return <Badge variant={STATUS_VARIANT[status]}>{HYPOTHESIS_STATUS_LABEL[status]}</Badge>;
}

/** 状态徽标 + 原值（后端字面量原样展示，便于与 API/日志对齐） */
export function HypothesisStatusCell({ status }: { status: HypothesisStatus }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <HypothesisStatusBadge status={status} />
      <span className="font-mono text-[11px] text-zinc-500">{status}</span>
    </span>
  );
}

/**
 * 状态机展示（draft → ready → running → validated | rejected）。
 * `current` 为当前态：高亮 + `aria-current="step"`；终态显式标注「终态只读」。
 * 可达边来自后端规则镜像（裁决仍在服务端）。
 */
export function StatusMachine({ current }: { current?: HypothesisStatus }) {
  return (
    <div data-testid="status-machine" className="flex flex-wrap items-center gap-1 text-xs">
      {HYPOTHESIS_STATUS_ORDER.map((status, index) => {
        const active = current === status;
        const reachable = current ? HYPOTHESIS_TRANSITIONS[current].includes(status) : false;
        return (
          <React.Fragment key={status}>
            {index > 0 && <span className="text-zinc-700">→</span>}
            <span
              aria-current={active ? 'step' : undefined}
              className={[
                'rounded px-2 py-0.5',
                active ? 'bg-zinc-100 font-medium text-zinc-900'
                  : reachable ? 'border border-zinc-600 text-zinc-200'
                    : 'text-zinc-500',
              ].join(' ')}
            >
              {HYPOTHESIS_STATUS_LABEL[status]}
            </span>
          </React.Fragment>
        );
      })}
      {current && (
        <span className="ml-2 text-[11px] text-zinc-500">
          {current === 'validated' || current === 'rejected'
            ? '终态只读（重跑走新假设行，历史判定事实保留）'
            : `可达：${HYPOTHESIS_TRANSITIONS[current].map((s) => HYPOTHESIS_STATUS_LABEL[s]).join('、') || '无（系统收敛）'}`}
        </span>
      )}
    </div>
  );
}

/** 轮询提示（running 态每 3 秒刷新；终态/未启动停止） */
export function PollingHint({ active }: { active: boolean }) {
  return (
    <span data-testid="polling-hint" className="text-[11px] text-zinc-500">
      {active ? `执行中：每 ${POLL_INTERVAL_MS / 1000} 秒自动刷新，终态停止` : '未轮询（仅执行中态轮询，终态停止）'}
    </span>
  );
}

/* --------------------------------- 假设：执行事实 --------------------------------- */

export function VerdictPanel({ verdict }: { verdict: VerdictShape | null }) {
  if (!verdict) return <Hint>尚无判定（判定由人工/判据/系统收敛产生，LLM 不决定治理判定）</Hint>;
  return (
    <div className="space-y-1">
      <FieldRow label="判定">
        <Badge variant={verdict.decision === 'validated' ? 'success' : 'destructive'}>
          {verdict.decision === 'validated' ? '成立（validated）' : '不成立（rejected）'}
        </Badge>
      </FieldRow>
      <FieldRow label="判定者">
        <span className="font-mono text-[11px] text-zinc-400">{verdict.decidedBy ?? '—'}</span>
        <span className="ml-2 text-[11px] text-zinc-500">
          {verdict.decidedBy === 'manual' ? '人工/Agent 显式判定'
            : verdict.decidedBy === 'criteria' ? '服务端按判据判定'
              : verdict.decidedBy === 'system' ? '系统归因判定（loop 未产出可用结果）' : ''}
        </span>
      </FieldRow>
      <FieldRow label="理由"><TextBlock>{verdict.reason ?? '—'}</TextBlock></FieldRow>
      <FieldRow label="判定时刻">{verdict.decidedAt ? new Date(verdict.decidedAt).toLocaleString() : '—'}</FieldRow>
      {verdict.facts && (
        <FieldRow label="判定依据事实"><ValueView value={verdict.facts} /></FieldRow>
      )}
    </div>
  );
}

/** 运行步骤表（只读投影；run 生命周期归 M7-P6，完整 timeline 在 /workflows/runs/:runId） */
export function RunStepsTable({ steps }: { steps: readonly RunStepShape[] | undefined }) {
  const rows = steps ?? [];
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>#</TableHead>
          <TableHead>步骤</TableHead>
          <TableHead>类型</TableHead>
          <TableHead>状态</TableHead>
          <TableHead>留痕</TableHead>
          <TableHead>完成时刻</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.length === 0 ? (
          <TableEmpty colSpan={6}>暂无可读步骤留痕</TableEmpty>
        ) : rows.map((step, index) => (
          <TableRow key={step.stepId ?? index}>
            <TableCell className="font-mono text-xs text-zinc-500">{step.stepIndex ?? index}</TableCell>
            <TableCell className="font-mono text-xs">{step.stepId ?? '—'}</TableCell>
            <TableCell className="font-mono text-xs text-zinc-400">{step.stepType ?? '—'}</TableCell>
            <TableCell>
              <span className="font-mono text-xs text-zinc-300">{step.status ?? '—'}</span>
              {step.errorCode && <span className="ml-2 font-mono text-[11px] text-red-300">{step.errorCode}</span>}
            </TableCell>
            <TableCell className="font-mono text-[11px] text-zinc-500">
              {step.approvalId ? `approval=${step.approvalId} ` : ''}
              {step.externalActionId ? `action=${step.externalActionId} ` : ''}
              {step.agentRunId ? `agentRun=${step.agentRunId}` : ''}
              {!step.approvalId && !step.externalActionId && !step.agentRunId ? '—' : ''}
            </TableCell>
            <TableCell className="text-[11px] text-zinc-500">
              {step.completedAt ? new Date(step.completedAt).toLocaleString() : '—'}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

/** 引用行（workflow / run / 评测 / 实验 / 洞察） */
export function RefLink({ href, children }: { href: string; children: React.ReactNode }) {
  return <Link href={href} className="font-mono text-xs text-zinc-300 underline decoration-zinc-700 hover:text-zinc-100">{children}</Link>;
}

export function EmptyState({ children }: { children: React.ReactNode }) {
  return <p className="py-6 text-center text-xs text-zinc-500">{children}</p>;
}

/**
 * 受状态机约束的动作按钮：不可用时**禁用 + 常显原因**（`title` 只对指针可见，故同时渲染为文本，
 * 让"为什么不能点"永远可见）。禁用只是防误操作——服务端才是裁决方。
 */
export function GuardedAction({
  label, enabled, hint, onClick, busy, variant = 'outline',
}: {
  label: string;
  enabled: boolean;
  hint: string;
  onClick: () => void;
  busy?: boolean;
  variant?: 'default' | 'outline' | 'ghost' | 'destructive';
}) {
  return (
    <span className="inline-flex flex-col items-start gap-1">
      <Button
        size="sm"
        variant={variant}
        disabled={!enabled || Boolean(busy)}
        title={enabled ? undefined : hint}
        onClick={onClick}
      >
        {busy ? '处理中…' : label}
      </Button>
      {!enabled && <span className="max-w-[11rem] text-[11px] leading-tight text-zinc-600">{hint}</span>}
    </span>
  );
}

export function ActionError({ message }: { message: string }) {
  if (!message) return null;
  // 刻意用 role="alert" + 非 text-red-400 配色：与 toast 同一口径（页面错误横幅另有语义）
  return <p role="alert" className="mt-2 text-xs text-red-300">{message}</p>;
}
