'use client';

import { useState } from 'react';
import { agentKeys, createAgent } from '@/lib/services/agents';
import { useApiMutation, useApiQueryClient } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Dialog, DialogCloseButton, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { useToast } from '@/components/ui/toast';
import { ToolPicker } from './tool-picker';

/**
 * 添加 Agent（M13-W2）——POST /api/v1/agents（仅 admin，403 会由调用页统一呈现）。
 *
 * 表单字段与后端 create 入参一一对应（apps/api/src/modules/agents-admin/agents-admin.controller.ts）：
 *  name/slug/description/systemPrompt/temperature/tools 直接落 Agent 与草稿版本（version=1, status=draft），
 *  maxSteps 落 **`config.maxSteps`**（服务端 agent-runs 读 `version.config.maxSteps`，缺省 8）。
 *
 * kind 固定 `custom`（纯 prompt 配置类 Agent；DB 默认值是 builtin，那是代码内置 Agent 的语义）。
 * 后端没有 DTO 校验层，约束由前端先行拦截（slug 唯一性等仍需服务端裁决，错误如实回显）。
 */
const DEFAULT_TEMPERATURE = 0.7;
const DEFAULT_MAX_STEPS = 8;

export function AgentCreateDialog({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated?: (agentId: string | null) => void;
}) {
  const queryClient = useApiQueryClient();
  const { toast } = useToast();

  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [description, setDescription] = useState('');
  const [systemPrompt, setSystemPrompt] = useState('');
  const [temperature, setTemperature] = useState(String(DEFAULT_TEMPERATURE));
  const [maxSteps, setMaxSteps] = useState(String(DEFAULT_MAX_STEPS));
  const [tools, setTools] = useState<string[]>([]);
  const [formError, setFormError] = useState('');

  const reset = () => {
    setName(''); setSlug(''); setDescription(''); setSystemPrompt('');
    setTemperature(String(DEFAULT_TEMPERATURE)); setMaxSteps(String(DEFAULT_MAX_STEPS));
    setTools([]); setFormError('');
  };

  const create = useApiMutation(
    () => createAgent({
      slug: slug.trim(),
      name: name.trim(),
      description: description.trim() || undefined,
      kind: 'custom',
      systemPrompt,
      tools,
      temperature: Number(temperature),
      config: { maxSteps: Number(maxSteps) },
    }),
    {
      onSuccess: (res) => {
        // 后端 create 的真实载荷是 `{ agent, draftVersion }`（service.create），
        // 而 service 签名声明为 `{ data: Agent }`——两种形状都取一次 id，取不到就只刷新列表（不猜路径）。
        const raw = res.data as unknown as { id?: string; agent?: { id?: string } };
        const createdId = raw?.id ?? raw?.agent?.id ?? null;
        toast({ title: '已添加 Agent（草稿版本 v1）', description: '还需在详情页上线该草稿版本才会生效。', variant: 'success' });
        void queryClient.invalidateQueries({ queryKey: agentKeys.all });
        reset();
        onOpenChange(false);
        onCreated?.(createdId);
      },
      onError: (err) => {
        setFormError(err.message);
        toast({ title: '添加失败', description: err.message, variant: 'error' });
      },
    },
  );

  const submit = () => {
    if (!name.trim() || !slug.trim() || !systemPrompt.trim()) {
      setFormError('名称、slug、systemPrompt 均为必填');
      return;
    }
    if (!/^[a-z0-9][a-z0-9-]*$/.test(slug.trim())) {
      setFormError('slug 只能用小写字母、数字与连字符，且以字母或数字开头');
      return;
    }
    const temp = Number(temperature);
    if (!Number.isFinite(temp) || temp < 0 || temp > 2) {
      setFormError('temperature 需在 0 ~ 2 之间');
      return;
    }
    const steps = Number(maxSteps);
    if (!Number.isInteger(steps) || steps < 1 || steps > 64) {
      setFormError('maxSteps 需为 1 ~ 64 的整数');
      return;
    }
    setFormError('');
    create.mutate();
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange} closeOnOverlayClick={false}>
      <DialogHeader>
        <DialogTitle>添加 Agent</DialogTitle>
        <DialogCloseButton onClose={() => onOpenChange(false)} />
      </DialogHeader>
      <DialogContent className="space-y-3">
        <DialogDescription>
          新 Agent 以草稿版本 v1 落库（kind=custom）；上线前不会进入可用 Agent 列表。
        </DialogDescription>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <label className="block text-xs text-zinc-400" htmlFor="agent-create-name">
            名称
            <Input id="agent-create-name" className="mt-1" value={name} onChange={(e) => setName(e.target.value)} placeholder="例如：市场研究员" />
          </label>
          <label className="block text-xs text-zinc-400" htmlFor="agent-create-slug">
            slug
            <Input id="agent-create-slug" className="mt-1 font-mono" value={slug} onChange={(e) => setSlug(e.target.value)} placeholder="market-researcher" />
          </label>
        </div>

        <label className="block text-xs text-zinc-400" htmlFor="agent-create-description">
          描述
          <Textarea id="agent-create-description" className="mt-1" rows={2} value={description} onChange={(e) => setDescription(e.target.value)} />
        </label>

        <label className="block text-xs text-zinc-400" htmlFor="agent-create-prompt">
          systemPrompt
          <Textarea id="agent-create-prompt" className="mt-1 font-mono" rows={5} value={systemPrompt} onChange={(e) => setSystemPrompt(e.target.value)} />
        </label>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <label className="block text-xs text-zinc-400" htmlFor="agent-create-temperature">
            temperature（0 ~ 2）
            <Input
              id="agent-create-temperature" className="mt-1" type="number" step="0.1" min="0" max="2"
              value={temperature} onChange={(e) => setTemperature(e.target.value)}
            />
          </label>
          <label className="block text-xs text-zinc-400" htmlFor="agent-create-maxsteps">
            maxSteps（单次执行的步数上限）
            <Input
              id="agent-create-maxsteps" className="mt-1" type="number" step="1" min="1" max="64"
              value={maxSteps} onChange={(e) => setMaxSteps(e.target.value)}
            />
          </label>
        </div>

        <div>
          <span className="mb-1 block text-xs text-zinc-400">工具（可多选，可空）</span>
          <ToolPicker
            selected={tools}
            onToggle={(toolName, checked) => setTools((prev) => (checked ? [...prev, toolName] : prev.filter((t) => t !== toolName)))}
          />
        </div>

        {formError && <p className="text-xs text-red-300">{formError}</p>}
      </DialogContent>
      <DialogFooter>
        <Button variant="ghost" onClick={() => onOpenChange(false)}>取消</Button>
        <Button onClick={submit} disabled={create.isPending}>
          {create.isPending ? '处理中…' : '添加'}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}
