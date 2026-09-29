'use client';

import { useState } from 'react';
import { ProviderView, providerKeys, updateProvider } from '@/lib/services/providers';
import { useApiMutation, useApiQueryClient } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { useToast } from '@/components/ui/toast';

/**
 * Provider 编辑弹窗（M13+ 模型配置页）。
 *
 * 红线对齐（与后端 ProviderPatchSchema 同构）：
 * - apiKey **只写**：密码框、初值恒空、placeholder 明确「留空表示不修改」；
 *   空串提交时 PATCH body **不含** apiKey 键（绝不把空串当明文覆盖服务端密文）；
 * - 不可变面（type/adapter/名称）不提供任何输入——只读展示；
 * - 脏值比对：只提交改动的字段（最小爆炸半径 + 审计 changed 清单干净）。
 */
const TYPE_LABELS: Record<string, string> = { llm: 'LLM', image: '生图', video: '生视频', embedding: 'Embedding' };

export function ProviderEditDialog({
  provider,
  open,
  onOpenChange,
}: {
  provider: ProviderView | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const queryClient = useApiQueryClient();
  const { toast } = useToast();

  // 父组件用 key={provider.id} 重挂载本组件 → 这里以 provider 为初值初始化（无 render 期 setState）
  const [apiKey, setApiKey] = useState('');
  const [enabled, setEnabled] = useState(provider?.enabled ?? true);
  const [priority, setPriority] = useState(String(provider?.priority ?? 100));
  const [baseUrl, setBaseUrl] = useState(provider?.baseUrl ?? '');
  const [timeoutMs, setTimeoutMs] = useState(String(provider?.timeoutMs ?? 60000));
  const [formError, setFormError] = useState('');

  const save = useApiMutation(
    () => {
      if (!provider) throw new Error('未选择 provider');
      const patch: Record<string, unknown> = {};
      const trimmedKey = apiKey.trim();
      if (trimmedKey.length > 0) patch.apiKey = trimmedKey; // 空串 = 不改（只写语义）
      if (enabled !== provider.enabled) patch.enabled = enabled;
      const priorityNum = Number(priority);
      if (!Number.isInteger(priorityNum) || priorityNum < 0) throw new Error('优先级必须是 ≥0 的整数');
      if (priorityNum !== provider.priority) patch.priority = priorityNum;
      if (baseUrl.trim() !== provider.baseUrl) patch.baseUrl = baseUrl.trim();
      const timeoutNum = Number(timeoutMs);
      if (!Number.isInteger(timeoutNum) || timeoutNum < 1000) throw new Error('超时必须是 ≥1000 的整数（毫秒）');
      if (timeoutNum !== provider.timeoutMs) patch.timeoutMs = timeoutNum;
      if (Object.keys(patch).length === 0) throw new Error('没有需要保存的改动');
      return updateProvider(provider.id, patch);
    },
    {
      onSuccess: () => {
        toast({ title: '已保存', description: '配置已生效（服务端热刷新，无需重启）', variant: 'success' });
        queryClient.invalidateQueries({ queryKey: providerKeys.list });
        onOpenChange(false);
      },
      onError: (err) => {
        setFormError(err instanceof Error ? err.message : '保存失败');
      },
    },
  );

  if (!provider) return null;

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) { setFormError(''); onOpenChange(false); } }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>编辑 Provider</DialogTitle>
          <DialogDescription>
            {provider.name}（{TYPE_LABELS[provider.type] ?? provider.type} · {provider.adapter}）
            {provider.managedByExtension && ' · 扩展托管'}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
          <div>
            <label htmlFor="provider-apikey" className="mb-1 block text-xs text-zinc-400">
              API Key（{provider.hasKey ? '已配置，留空保持不变' : '未配置'}）
            </label>
            <Input
              id="provider-apikey"
              type="password"
              autoComplete="new-password"
              placeholder="留空表示不修改"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              data-testid="provider-apikey"
            />
            <p className="mt-1 text-[10px] text-zinc-600">只写不回显：保存后服务端加密落库，任何界面都不会再显示 Key。</p>
          </div>

          <div className="flex items-center gap-2">
            <input
              id="provider-enabled"
              type="checkbox"
              checked={enabled}
              onChange={(e) => setEnabled(e.target.checked)}
              data-testid="provider-enabled"
            />
            <label htmlFor="provider-enabled" className="text-sm text-zinc-300">启用（停用后立即从路由候选中剔除）</label>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label htmlFor="provider-priority" className="mb-1 block text-xs text-zinc-400">优先级（越小越优先）</label>
              <Input id="provider-priority" type="number" min={0} value={priority} onChange={(e) => setPriority(e.target.value)} />
            </div>
            <div>
              <label htmlFor="provider-timeout" className="mb-1 block text-xs text-zinc-400">超时（毫秒）</label>
              <Input id="provider-timeout" type="number" min={1000} value={timeoutMs} onChange={(e) => setTimeoutMs(e.target.value)} />
            </div>
          </div>

          <div>
            <label htmlFor="provider-baseurl" className="mb-1 block text-xs text-zinc-400">Base URL（https；mock adapter 可为空）</label>
            <Input id="provider-baseurl" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="https://api.example.com/v1" />
          </div>

          {provider.degradedReason && (
            <p className="text-xs text-amber-400">加载失败归因：{provider.degradedReason}</p>
          )}
          {formError && <p className="text-sm text-red-400">⚠ {formError}</p>}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => { setFormError(''); onOpenChange(false); }}>取消</Button>
          <Button onClick={() => save.mutate()} disabled={save.isPending}>{save.isPending ? '保存中…' : '保存'}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
