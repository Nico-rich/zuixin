'use client';

import { use, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { Pencil, RefreshCw, Trash2 } from 'lucide-react';
import { apiFetch, jsonInit, ApiError } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { WriteError, toApiError } from '@/components/write-error';
import { useToast } from '@/components/ui/toast';

interface WorkflowVersion {
  id: string;
  version: number;
  status: string;
  createdAt: string;
  /** GET /workflows/:id 的 versions 含 definition（最新版本在最前） */
  definition?: unknown;
}

interface WorkflowDetail {
  id: string;
  name: string;
  description: string | null;
  status: string;
  versions: WorkflowVersion[];
  triggerInfo?: { webhook: { token: string; secret: string | null } | null };
}

/** 最小 Workflow 详情：版本列表 + 发布/归档 + 手动运行 + webhook 凭据（secret 仅发布时展示一次）
 *  M13-W10 补齐写面：编辑(PATCH) / 删除(DELETE) / webhook 密钥轮换(POST webhook/rotate)。 */
export default function WorkflowDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const router = useRouter();
  const { toast } = useToast();
  const [wf, setWf] = useState<WorkflowDetail | null>(null);
  const [payload, setPayload] = useState('{}');
  const [result, setResult] = useState('');
  const [error, setError] = useState('');
  /** 写失败按操作各自持有：同一份状态在多处渲染会导致同一错误在同一屏出现两次 */
  const [editError, setEditError] = useState<ApiError | null>(null);
  const [deleteError, setDeleteError] = useState<ApiError | null>(null);
  const [rotateError, setRotateError] = useState<ApiError | null>(null);
  const [pending, setPending] = useState(false);

  // 编辑弹窗
  const [editing, setEditing] = useState(false);
  const [editName, setEditName] = useState('');
  const [editDescription, setEditDescription] = useState('');
  const [editDefinition, setEditDefinition] = useState('');
  const [localError, setLocalError] = useState('');
  // 删除确认
  const [deleting, setDeleting] = useState(false);
  // 轮换后的一次性明文（服务端只存密文信封，刷新即不可再读）
  const [rotatedSecret, setRotatedSecret] = useState<string | null>(null);

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

  const latestVersion = wf?.versions[0];
  const latestPublished = latestVersion?.status === 'published';

  const openEdit = () => {
    if (!wf) return;
    setEditName(wf.name);
    setEditDescription(wf.description ?? '');
    setEditDefinition(latestVersion?.definition ? JSON.stringify(latestVersion.definition, null, 2) : '');
    setLocalError(''); setEditError(null); setEditing(true);
  };

  const submitEdit = async () => {
    const name = editName.trim();
    if (!name || pending) return;
    let definition: unknown;
    if (editDefinition.trim()) {
      try {
        definition = JSON.parse(editDefinition);
      } catch {
        setLocalError('definition 必须是合法 JSON（留空表示不改定义）');
        return;
      }
    }
    setLocalError(''); setEditError(null); setPending(true);
    try {
      const res = await apiFetch<{ data: WorkflowDetail }>(`/api/v1/workflows/${id}`, jsonInit('PATCH', {
        name,
        description: editDescription.trim() ? editDescription.trim() : null,
        ...(definition === undefined ? {} : { definition }),
      }));
      // PATCH 响应不含 triggerInfo（那是发布/轮换的返回）→ 保留本地已展示的凭据，避免凭空消失
      setWf((prev) => ({ ...res.data, triggerInfo: prev?.triggerInfo }));
      setEditing(false);
      toast({ title: '工作流已更新', description: latestPublished && definition !== undefined ? 'definition 已写入新草稿版本' : res.data.name, variant: 'success' });
    } catch (err) {
      setEditError(toApiError(err, '更新失败，请重试'));
    } finally {
      setPending(false);
    }
  };

  const confirmDelete = async () => {
    if (pending) return;
    setDeleteError(null); setPending(true);
    try {
      await apiFetch(`/api/v1/workflows/${id}`, { method: 'DELETE' });
      setDeleting(false);
      toast({ title: '工作流已删除', variant: 'success' });
      router.push('/workflows');
    } catch (err) {
      setDeleteError(toApiError(err, '删除失败，请重试'));
    } finally {
      setPending(false);
    }
  };

  const rotateSecret = async () => {
    if (pending) return;
    setRotateError(null); setPending(true);
    try {
      const res = await apiFetch<{ data: { token: string; secret: string; previousSecretExpiresAt: string | null } }>(
        `/api/v1/workflows/${id}/webhook/rotate`, jsonInit('POST'));
      setRotatedSecret(res.data.secret);
      setWf((prev) => (prev ? { ...prev, triggerInfo: { webhook: { token: res.data.token, secret: null } } } : prev));
      toast({
        title: 'webhook 密钥已轮换',
        description: res.data.previousSecretExpiresAt ? `旧密钥 ${new Date(res.data.previousSecretExpiresAt).toLocaleString()} 前仍可用` : '旧密钥已失效',
        variant: 'success',
      });
    } catch (err) {
      setRotateError(toApiError(err, '轮换失败，请重试'));
    } finally {
      setPending(false);
    }
  };

  if (error && !wf) return <p className="p-8 text-sm text-red-400">{error}</p>;
  if (!wf) return <p className="p-8 text-sm text-zinc-500">加载中…</p>;

  const webhook = wf.triggerInfo?.webhook ?? null;
  const shownSecret = rotatedSecret ?? webhook?.secret ?? null;

  return (
    <div className="mx-auto max-w-4xl px-4 py-8">
      <div className="mb-6 flex items-center gap-3">
        <h1 className="text-lg font-semibold text-zinc-100">{wf.name}</h1>
        <span className="rounded bg-zinc-800 px-2 py-0.5 text-xs text-zinc-400">{wf.status}</span>
        <div className="ml-auto flex items-center gap-2">
          <Button size="sm" variant="outline" onClick={openEdit}><Pencil /> 编辑</Button>
          <Button size="sm" variant="ghost" onClick={() => { setDeleteError(null); setDeleting(true); }}><Trash2 /> 删除</Button>
          <Link href={`/workflows/${id}/runs`} className="text-xs text-zinc-400 hover:text-zinc-200">运行历史 →</Link>
        </div>
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

      {webhook && (
        <section className="rounded-lg border border-amber-800/60 bg-amber-950/30 p-4">
          <div className="mb-2 flex items-center gap-3">
            <h2 className="text-sm font-medium text-amber-200">
              {shownSecret ? 'Webhook 凭据（secret 仅显示这一次，请立即保存）' : 'Webhook 凭据'}
            </h2>
            <Button size="sm" variant="outline" className="ml-auto" onClick={() => void rotateSecret()} disabled={pending}>
              <RefreshCw /> 轮换密钥
            </Button>
          </div>
          <p className="text-xs text-zinc-300">端点：<code className="text-amber-200">POST /api/v1/hooks/workflows/{webhook.token}</code></p>
          <p className="mt-1 text-xs text-zinc-300">签名：<code className="text-amber-200">HMAC-SHA256(raw body) → hex</code>，头 <code>X-Hook-Signature</code> / <code>X-Hook-Timestamp</code>(ms) / <code>X-Hook-Event-Id</code></p>
          {shownSecret ? (
            <p className="mt-1 break-all font-mono text-xs text-amber-100">{shownSecret}</p>
          ) : (
            <p className="mt-1 text-xs text-amber-200/80">服务端只保存密文信封，明文无法再次读出；未保存或疑似泄漏请直接轮换。</p>
          )}
          <WriteError error={rotateError} forbiddenHint="需要组织 owner/admin 权限" className="mt-2" />
        </section>
      )}

      {error && <p className="mt-4 text-xs text-red-400">{error}</p>}

      <Dialog open={editing} onOpenChange={(open) => { if (!open) { setEditing(false); setEditError(null); } }}>
        <form onSubmit={(e) => { e.preventDefault(); void submitEdit(); }}>
          <DialogHeader>
            <div className="min-w-0">
              <DialogTitle>编辑工作流</DialogTitle>
              <DialogDescription>
                {latestPublished
                  ? '最新版本已发布 → 提交 definition 会创建新的草稿版本（历史版本不可变）。'
                  : '最新版本仍是草稿 → definition 会就地覆盖（不产生新版本）。'}
              </DialogDescription>
            </div>
          </DialogHeader>
          <DialogContent className="space-y-3">
            <div className="space-y-1">
              <label htmlFor="wf-edit-name" className="block text-xs text-zinc-400">名称</label>
              <Input id="wf-edit-name" value={editName} maxLength={100} autoFocus onChange={(e) => setEditName(e.target.value)} />
            </div>
            <div className="space-y-1">
              <label htmlFor="wf-edit-desc" className="block text-xs text-zinc-400">描述（留空 = 清除）</label>
              <Input id="wf-edit-desc" value={editDescription} maxLength={2000} onChange={(e) => setEditDescription(e.target.value)} />
            </div>
            <div className="space-y-1">
              <label htmlFor="wf-edit-def" className="block text-xs text-zinc-400">definition（JSON，留空 = 不改定义）</label>
              <Textarea id="wf-edit-def" value={editDefinition} rows={10} spellCheck={false}
                className="font-mono text-xs" onChange={(e) => setEditDefinition(e.target.value)} />
            </div>
            {localError && <p className="text-xs text-zinc-400">{localError}</p>}
            <WriteError error={editError} forbiddenHint="需要 workflow.write 权限" />
          </DialogContent>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => setEditing(false)} disabled={pending}>取消</Button>
            <Button type="submit" disabled={pending || !editName.trim()}>{pending ? '保存中…' : '保存'}</Button>
          </DialogFooter>
        </form>
      </Dialog>

      <ConfirmDialog
        open={deleting}
        onOpenChange={(open) => { if (!open) { setDeleting(false); setDeleteError(null); } }}
        title="删除工作流"
        description={`将硬删除「${wf.name}」及其版本与运行历史（不可恢复）。`}
        confirmLabel="删除"
        destructive
        pending={pending}
        error={deleteError}
        forbiddenHint="需要 workflow.write 权限"
        onConfirm={() => void confirmDelete()}
      />
    </div>
  );
}
