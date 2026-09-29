'use client';
import { useState } from 'react';
import { ApiError, useApiMutation } from '@/lib/api';
import {
  createMemory, updateMemory,
  type Memory, type MemoryCategory, type MemoryScope, type MemoryStatus,
} from '@/lib/services/memories';
import type { Project } from '@/lib/services/projects';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { CATEGORY_LABEL, SCOPE_LABEL } from './memory-labels';

/**
 * 新建 / 编辑记忆（M13-W3）
 *
 * 两个**服务端口径约束**直接决定表单形态（不是前端偏好）：
 *  1. `POST /memories` 在 scope=project 时**必须**带 projectId（且项目必须属于当前用户）→ 项目选择器为条件必填；
 *  2. `PATCH /memories/:id` 只接受 content/category/importance/confidence/status →
 *     编辑态下 scope/project **不可改**，如实呈现为只读。
 *
 * 内容按不可信数据处理：只做纯文本编辑与展示，绝不解析 Markdown/HTML。
 * 后端 z.string().min(1).max(2000) / importance 0-100 整数 → 前端同口径先拦一次。
 */
export const MEMORY_CATEGORIES: MemoryCategory[] = ['preference', 'profile', 'instruction', 'project_context', 'workflow', 'other'];
export const MEMORY_STATUSES: MemoryStatus[] = ['candidate', 'active', 'rejected'];
export const MEMORY_STATUS_LABEL: Record<MemoryStatus, string> = {
  candidate: '候选（尚未生效）',
  active: '已生效',
  rejected: '已拒绝',
};
export const MEMORY_CONTENT_MAX = 2000;

export interface MemoryFormDialogProps {
  /** 传入 = 编辑；null = 新建 */
  memory: Memory | null;
  /** 项目候选（新建 scope=project 时必填；服务端会复核归属） */
  projects: Project[];
  onClose: () => void;
  onSaved: (memory: Memory, mode: 'create' | 'edit') => void;
}

export function MemoryFormDialog({ memory, projects, onClose, onSaved }: MemoryFormDialogProps) {
  const editing = memory !== null;
  const [content, setContent] = useState(memory?.content ?? '');
  const [category, setCategory] = useState<MemoryCategory>(memory?.category ?? 'preference');
  const [scope, setScope] = useState<MemoryScope>(memory?.scope ?? 'user');
  const [projectId, setProjectId] = useState(memory?.projectId ?? '');
  const [importance, setImportance] = useState(String(memory?.importance ?? 50));
  const [status, setStatus] = useState<MemoryStatus>(memory?.status ?? 'candidate');
  const [error, setError] = useState<string | null>(null);

  const mutation = useApiMutation(
    async (): Promise<Memory> => {
      const trimmed = content.trim();
      const importanceValue = Number(importance);
      if (editing) {
        const res = await updateMemory(memory.id, { content: trimmed, category, importance: importanceValue, status });
        return res.data;
      }
      const res = await createMemory({
        scope, content: trimmed, category, importance: importanceValue,
        // user 级绝不上送 projectId（后端会以「用户级记忆不能挂载项目」拒绝）
        ...(scope === 'project' ? { projectId } : {}),
      });
      return res.data;
    },
    {
      onSuccess: (saved) => onSaved(saved, editing ? 'edit' : 'create'),
      onError: (e) => setError(e instanceof ApiError ? e.message : '保存失败，请重试'),
    },
  );

  const submit = () => {
    const trimmed = content.trim();
    if (!trimmed) { setError('请填写记忆内容'); return; }
    if (trimmed.length > MEMORY_CONTENT_MAX) { setError(`内容不能超过 ${MEMORY_CONTENT_MAX} 字`); return; }
    const importanceValue = Number(importance);
    if (!Number.isInteger(importanceValue) || importanceValue < 0 || importanceValue > 100) {
      setError('重要度需为 0-100 的整数');
      return;
    }
    if (!editing && scope === 'project' && !projectId) { setError('项目级记忆必须选择项目'); return; }
    setError(null);
    mutation.mutate();
  };

  const pending = mutation.isPending;

  return (
    <Dialog open onOpenChange={(next) => { if (!next && !pending) onClose(); }}>
      <DialogHeader>
        <DialogTitle>{editing ? '编辑记忆' : '新建记忆'}</DialogTitle>
        <DialogDescription>
          {editing
            ? '所属范围与项目不可更改；提升/降级通过状态字段完成'
            : '新建的记忆默认为「候选」——尚未生效，需在编辑中提升为「已生效」'}
        </DialogDescription>
      </DialogHeader>

      <DialogContent className="space-y-4">
        <div>
          <label htmlFor="memory-content" className="mb-1 block text-xs text-zinc-400">记忆内容</label>
          <Textarea
            id="memory-content"
            rows={5}
            maxLength={MEMORY_CONTENT_MAX}
            value={content}
            onChange={(e) => setContent(e.target.value)}
            placeholder="例如：用户偏好简体中文、结论先行的回复风格"
          />
          <p className="mt-1 text-right text-xs text-zinc-600">{content.length} / {MEMORY_CONTENT_MAX}</p>
        </div>

        <div className="grid grid-cols-2 gap-4">
          <div>
            <label htmlFor="memory-category" className="mb-1 block text-xs text-zinc-400">分类</label>
            <Select id="memory-category" value={category} onChange={(e) => setCategory(e.target.value as MemoryCategory)}>
              {MEMORY_CATEGORIES.map((c) => <option key={c} value={c}>{CATEGORY_LABEL[c]}</option>)}
            </Select>
          </div>

          <div>
            <label htmlFor="memory-importance" className="mb-1 block text-xs text-zinc-400">重要度（0-100）</label>
            <Input
              id="memory-importance"
              type="number"
              min={0}
              max={100}
              step={1}
              value={importance}
              onChange={(e) => setImportance(e.target.value)}
            />
          </div>

          <div>
            <label htmlFor="memory-scope" className="mb-1 block text-xs text-zinc-400">范围</label>
            {editing ? (
              <p id="memory-scope" className="flex h-10 items-center text-sm text-zinc-400">
                {SCOPE_LABEL[memory.scope]}{memory.projectId ? `（${memory.projectId}）` : ''}
              </p>
            ) : (
              <Select id="memory-scope" value={scope} onChange={(e) => { setScope(e.target.value as MemoryScope); setError(null); }}>
                <option value="user">用户级</option>
                <option value="project">项目级</option>
              </Select>
            )}
          </div>

          {editing ? (
            <div>
              <label htmlFor="memory-status" className="mb-1 block text-xs text-zinc-400">状态</label>
              <Select id="memory-status" value={status} onChange={(e) => setStatus(e.target.value as MemoryStatus)}>
                {MEMORY_STATUSES.map((s) => <option key={s} value={s}>{MEMORY_STATUS_LABEL[s]}</option>)}
              </Select>
            </div>
          ) : scope === 'project' ? (
            <div>
              <label htmlFor="memory-project" className="mb-1 block text-xs text-zinc-400">项目</label>
              <Select id="memory-project" value={projectId} onChange={(e) => { setProjectId(e.target.value); setError(null); }}>
                <option value="">请选择项目</option>
                {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </Select>
            </div>
          ) : (
            <div>
              <label htmlFor="memory-status-new" className="mb-1 block text-xs text-zinc-400">状态</label>
              <p id="memory-status-new" className="flex h-10 items-center text-sm text-zinc-500">候选（尚未生效）</p>
            </div>
          )}
        </div>

        {error && <p role="alert" className="text-xs text-red-300">{error}</p>}
      </DialogContent>

      <DialogFooter>
        <Button variant="ghost" onClick={onClose} disabled={pending}>取消</Button>
        <Button onClick={submit} disabled={pending}>{pending ? '保存中…' : '保存'}</Button>
      </DialogFooter>
    </Dialog>
  );
}
