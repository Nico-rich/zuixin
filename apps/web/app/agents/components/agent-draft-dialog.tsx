'use client';

import { useState } from 'react';
import { agentKeys, updateAgentDraft, type AgentVersion } from '@/lib/services/agents';
import { useApiMutation, useApiQueryClient } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Dialog, DialogCloseButton, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { useToast } from '@/components/ui/toast';
import { toStringArray } from '../tool-catalog';
import { ToolPicker } from './tool-picker';

/**
 * 编辑草稿（M13-W2）——PATCH /api/v1/agents/:id/draft。
 *
 * 后端语义（agents-admin.service.editDraft）：没有 draft 就基于 activeVersion 复制出 n+1 号草稿；
 * **published/archived 不可变**，所以这里编辑的永远是草稿版本——界面上必须写清这一点，
 * 否则用户会以为改的是线上版本。
 *
 * config 是**整体替换**：这里保留既有 config 的其它键（requiresTools/knowledge/contextBudgetTokens 等），
 * 只覆盖 maxSteps；tools 同理由 ToolPicker 原样保留未登记工具（见 tool-picker.tsx 注释）。
 */
function configObject(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? { ...(value as Record<string, unknown>) } : {};
}

function DraftForm({
  agentId,
  version,
  isDraft,
  onClose,
  onSaved,
}: {
  agentId: string;
  version: AgentVersion;
  /** true = 正在编辑既有草稿；false = 无草稿，用当前生效版本作模板（后端会复制出 n+1 号草稿） */
  isDraft: boolean;
  onClose: () => void;
  onSaved: () => void;
}) {
  const queryClient = useApiQueryClient();
  const { toast } = useToast();

  const existingConfig = configObject(version.config);
  const [systemPrompt, setSystemPrompt] = useState(version.systemPrompt);
  const [temperature, setTemperature] = useState(String(version.temperature));
  const [maxTokens, setMaxTokens] = useState(version.maxTokens == null ? '' : String(version.maxTokens));
  const [maxSteps, setMaxSteps] = useState(String(typeof existingConfig.maxSteps === 'number' ? existingConfig.maxSteps : 8));
  const [tools, setTools] = useState<string[]>(toStringArray(version.tools));
  const [formError, setFormError] = useState('');

  const save = useApiMutation(
    () => updateAgentDraft(agentId, {
      systemPrompt,
      tools,
      temperature: Number(temperature),
      maxTokens: maxTokens.trim() === '' ? null : Number(maxTokens),
      config: { ...existingConfig, maxSteps: Number(maxSteps) },
    }),
    {
      onSuccess: () => {
        toast({ title: `已存入草稿 v${version.version}`, description: '草稿需上线后才生效。', variant: 'success' });
        void queryClient.invalidateQueries({ queryKey: agentKeys.all });
        void queryClient.invalidateQueries({ queryKey: agentKeys.detail(agentId) });
        void queryClient.invalidateQueries({ queryKey: agentKeys.versions(agentId) });
        onSaved();
        onClose();
      },
      onError: (err) => {
        setFormError(err.message);
        toast({ title: '存入草稿失败', description: err.message, variant: 'error' });
      },
    },
  );

  const submit = () => {
    if (!systemPrompt.trim()) { setFormError('systemPrompt 不能为空'); return; }
    const temp = Number(temperature);
    if (!Number.isFinite(temp) || temp < 0 || temp > 2) { setFormError('temperature 需在 0 ~ 2 之间'); return; }
    const steps = Number(maxSteps);
    if (!Number.isInteger(steps) || steps < 1 || steps > 64) { setFormError('maxSteps 需为 1 ~ 64 的整数'); return; }
    if (maxTokens.trim() !== '' && (!Number.isInteger(Number(maxTokens)) || Number(maxTokens) < 1)) {
      setFormError('maxTokens 需为正整数或留空');
      return;
    }
    setFormError('');
    save.mutate();
  };

  return (
    <>
      <DialogHeader>
        <DialogTitle>{isDraft ? `编辑草稿 v${version.version}` : `基于 v${version.version} 新建草稿`}</DialogTitle>
        <DialogCloseButton onClose={onClose} />
      </DialogHeader>
      <DialogContent className="space-y-3">
        <DialogDescription>
          {isDraft
            ? '改动只写入草稿版本（published/archived 不可变）；上线后成为新的生效版本。'
            : '当前没有草稿：后端会基于该版本复制出新草稿（版本号 +1），改动只落在草稿上。'}
        </DialogDescription>

        <label className="block text-xs text-zinc-400" htmlFor="agent-draft-prompt">
          systemPrompt
          <Textarea id="agent-draft-prompt" className="mt-1 font-mono" rows={6} value={systemPrompt} onChange={(e) => setSystemPrompt(e.target.value)} />
        </label>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <label className="block text-xs text-zinc-400" htmlFor="agent-draft-temperature">
            temperature（0 ~ 2）
            <Input
              id="agent-draft-temperature" className="mt-1" type="number" step="0.1" min="0" max="2"
              value={temperature} onChange={(e) => setTemperature(e.target.value)}
            />
          </label>
          <label className="block text-xs text-zinc-400" htmlFor="agent-draft-maxtokens">
            maxTokens（可留空）
            <Input
              id="agent-draft-maxtokens" className="mt-1" type="number" step="1" min="1" placeholder="留空 = 不限制"
              value={maxTokens} onChange={(e) => setMaxTokens(e.target.value)}
            />
          </label>
          <label className="block text-xs text-zinc-400" htmlFor="agent-draft-maxsteps">
            maxSteps（1 ~ 64）
            <Input
              id="agent-draft-maxsteps" className="mt-1" type="number" step="1" min="1" max="64"
              value={maxSteps} onChange={(e) => setMaxSteps(e.target.value)}
            />
          </label>
        </div>

        <div>
          <span className="mb-1 block text-xs text-zinc-400">工具</span>
          <ToolPicker
            selected={tools}
            onToggle={(toolName, checked) => setTools((prev) => (checked ? [...prev, toolName] : prev.filter((t) => t !== toolName)))}
          />
        </div>

        {formError && <p className="text-xs text-red-300">{formError}</p>}
      </DialogContent>
      <DialogFooter>
        <Button variant="ghost" onClick={onClose}>取消</Button>
        <Button onClick={submit} disabled={save.isPending}>{save.isPending ? '处理中…' : '存为草稿'}</Button>
      </DialogFooter>
    </>
  );
}

export function AgentDraftDialog({
  open,
  onOpenChange,
  agentId,
  version,
  isDraft,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  agentId: string;
  /** 要编辑的草稿版本（没有草稿时由页面传入当前生效版本作为模板） */
  version: AgentVersion | null;
  /** true = version 是既有草稿；false = version 只是模板（新建草稿语义） */
  isDraft: boolean;
  onSaved?: () => void;
}) {
  return (
    <Dialog open={open && version !== null} onOpenChange={onOpenChange} closeOnOverlayClick={false}>
      {version && (
        <DraftForm
          key={version.id}
          agentId={agentId}
          version={version}
          isDraft={isDraft}
          onClose={() => onOpenChange(false)}
          onSaved={() => onSaved?.()}
        />
      )}
    </Dialog>
  );
}
