'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { Plus } from 'lucide-react';
import { apiFetch, jsonInit, ApiError } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { WriteError, toApiError } from '@/components/write-error';
import { useToast } from '@/components/ui/toast';

interface WorkflowSummary {
  id: string;
  name: string;
  description: string | null;
  status: 'draft' | 'published' | 'archived';
  updatedAt: string;
  versions: Array<{ version: number; status: string }>;
  _count: { runs: number };
}

const STATUS_STYLE: Record<string, string> = {
  draft: 'bg-zinc-800 text-zinc-400', published: 'bg-emerald-900/60 text-emerald-300', archived: 'bg-zinc-800 text-zinc-500',
};

/**
 * definition 模板（M13-W10）：`POST /workflows` 的 definition 是**必填**且 steps 至少 1 条
 * （apps/api/src/modules/workflows/workflows.dto.ts 的 WorkflowDefinitionSchema）——
 * 给一个能直接通过校验的最小定义，用户在此基础上改，而不是对着空文本域猜结构。
 */
const DEFINITION_TEMPLATE = JSON.stringify({
  triggers: [{ type: 'manual' }],
  steps: [{ id: 'step-1', type: 'output', output: { text: 'hello' } }],
}, null, 2);

/** 最小 Workflow 列表（M7-P6；不做 React Flow IDE）+ 新建入口（M13-W10） */
export default function WorkflowsPage() {
  const { toast } = useToast();
  const [items, setItems] = useState<WorkflowSummary[] | null>(null);
  const [error, setError] = useState('');

  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [definitionText, setDefinitionText] = useState(DEFINITION_TEMPLATE);
  const [localError, setLocalError] = useState('');
  const [writeError, setWriteError] = useState<ApiError | null>(null);
  const [pending, setPending] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await apiFetch<{ data: WorkflowSummary[] }>('/api/v1/workflows');
      setItems(res.data);
      setError('');
    } catch {
      setError('工作流列表加载失败');
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const openDialog = () => {
    setName(''); setDescription(''); setDefinitionText(DEFINITION_TEMPLATE);
    setLocalError(''); setWriteError(null); setOpen(true);
  };

  const createWorkflow = async () => {
    const trimmedName = name.trim();
    if (!trimmedName || pending) return;
    let definition: unknown;
    try {
      definition = JSON.parse(definitionText);
    } catch {
      // 与详情页手动触发运行同一口径：非法 JSON 本地拦截，不发请求
      setLocalError('definition 必须是合法 JSON');
      return;
    }
    setLocalError(''); setWriteError(null); setPending(true);
    try {
      const res = await apiFetch<{ data: WorkflowSummary }>('/api/v1/workflows', jsonInit('POST', {
        name: trimmedName,
        ...(description.trim() ? { description: description.trim() } : {}),
        definition,
      }));
      setOpen(false);
      toast({ title: '工作流已创建', description: `${res.data.name}（v1 草稿）`, variant: 'success' });
      await load();
    } catch (err) {
      setWriteError(toApiError(err, '创建失败，请重试'));
    } finally {
      setPending(false);
    }
  };

  if (error) return <p className="p-8 text-sm text-red-400">{error}</p>;
  if (items === null) return <p className="p-8 text-sm text-zinc-500">加载中…</p>;

  return (
    <div className="mx-auto max-w-4xl px-4 py-8">
      <div className="mb-6 flex items-center justify-between gap-3">
        <h1 className="text-lg font-semibold text-zinc-100">工作流</h1>
        <div className="flex items-center gap-3">
          <span className="text-xs text-zinc-500">确定性编排 · 版本锁定执行</span>
          <Button size="sm" onClick={openDialog}><Plus /> 新建工作流</Button>
        </div>
      </div>
      {items.length === 0 && <p className="py-8 text-center text-sm text-zinc-500">暂无工作流</p>}
      <ul className="space-y-2">
        {items.map((w) => (
          <li key={w.id}>
            <Link
              href={`/workflows/${w.id}`}
              className="flex items-center gap-3 rounded-lg border border-zinc-800/80 bg-zinc-900/40 px-4 py-3 text-sm transition hover:border-zinc-700"
            >
              <span className="min-w-0 flex-1">
                <span className="block truncate font-medium text-zinc-200">{w.name}</span>
                {w.description && <span className="block truncate text-xs text-zinc-500">{w.description}</span>}
              </span>
              <span className="text-xs text-zinc-600">v{w.versions[0]?.version ?? 1} · {w._count.runs} 次运行</span>
              <span className={`rounded px-2 py-0.5 text-xs ${STATUS_STYLE[w.status] ?? STATUS_STYLE.draft}`}>{w.status}</span>
            </Link>
          </li>
        ))}
      </ul>

      <Dialog open={open} onOpenChange={(next) => { if (!next) setOpen(false); }}>
        <form onSubmit={(e) => { e.preventDefault(); void createWorkflow(); }}>
          <DialogHeader>
            <div className="min-w-0">
              <DialogTitle>新建工作流</DialogTitle>
              <DialogDescription>创建 v1 草稿版本；definition 结构见模板（steps 至少 1 条）。</DialogDescription>
            </div>
          </DialogHeader>
          <DialogContent className="space-y-3">
            <div className="space-y-1">
              <label htmlFor="wf-name" className="block text-xs text-zinc-400">名称</label>
              <Input id="wf-name" value={name} maxLength={100} autoFocus placeholder="例如：素材生产流"
                onChange={(e) => setName(e.target.value)} />
            </div>
            <div className="space-y-1">
              <label htmlFor="wf-desc" className="block text-xs text-zinc-400">描述（可选）</label>
              <Input id="wf-desc" value={description} maxLength={2000} placeholder="这条工作流做什么"
                onChange={(e) => setDescription(e.target.value)} />
            </div>
            <div className="space-y-1">
              <label htmlFor="wf-def" className="block text-xs text-zinc-400">definition（JSON）</label>
              <Textarea id="wf-def" value={definitionText} rows={10} spellCheck={false}
                className="font-mono text-xs" onChange={(e) => setDefinitionText(e.target.value)} />
            </div>
            {localError && <p className="text-xs text-zinc-400">{localError}</p>}
            <WriteError error={writeError} forbiddenHint="需要 workflow.write 权限" />
          </DialogContent>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => setOpen(false)} disabled={pending}>取消</Button>
            <Button type="submit" disabled={pending || !name.trim()}>{pending ? '创建中…' : '创建'}</Button>
          </DialogFooter>
        </form>
      </Dialog>
    </div>
  );
}
