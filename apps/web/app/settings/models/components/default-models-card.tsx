'use client';

import { useState } from 'react';
import { ProviderView } from '@/lib/services/providers';
import { patchSystemSetting, systemSettingKeys } from '@/lib/services/settings';
import { useApiMutation, useApiQuery, useApiQueryClient } from '@/lib/api';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Select } from '@/components/ui/select';
import { useToast } from '@/components/ui/toast';

/**
 * 各能力默认模型选择（M13+ 模型配置页）。
 *
 * 事实：routingPolicy.defaults 只是**排序偏好**（preferredModelIds），绝不构成硬门禁——
 * 默认模型停用后路由自动落到其他可用 provider。因此本卡片允许选择任意已启用模型；
 * 后端会在写入时做存在性/类型/启用校验（400 如实回显）。
 */
const CAPABILITIES = [
  { key: 'llm', label: 'LLM（对话/Agent）', badge: 'info' },
  { key: 'image', label: '生图', badge: 'success' },
  { key: 'video', label: '生视频', badge: 'warning' },
  { key: 'embedding', label: 'Embedding（检索/记忆）', badge: 'secondary' },
] as const;

interface RoutingDefaults { defaults?: Record<string, string | null> }

export function DefaultModelsCard({ providers, enabled }: { providers: ProviderView[] | undefined; enabled: boolean }) {
  const queryClient = useApiQueryClient();
  const { toast } = useToast();
  const [pending, setPending] = useState<Record<string, string>>({});

  const policy = useApiQuery<{ data: { value: RoutingDefaults } }>({
    queryKey: systemSettingKeys.detail('routingPolicy'),
    path: '/api/v1/system-settings/routingPolicy',
    enabled,
  });
  const defaults = policy.data?.data.value?.defaults ?? {};

  const save = useApiMutation(
    (cap: string) => patchSystemSetting('routingPolicy', { defaults: { [cap]: pending[cap] ?? null } }),
    {
      onSuccess: (_data, cap) => {
        toast({ title: '默认模型已更新', variant: 'success' });
        queryClient.invalidateQueries({ queryKey: systemSettingKeys.detail('routingPolicy') });
        setPending((p) => { const n = { ...p }; delete n[cap]; return n; });
      },
      onError: (err) => toast({ title: '操作未生效', description: err instanceof Error ? err.message : '保存失败', variant: 'error' }),
    },
  );

  const modelsOf = (cap: string) =>
    (providers ?? [])
      .flatMap((p) => p.models.filter((m) => m.type === cap && m.enabled).map((m) => ({ ...m, providerName: p.name })));

  return (
    <Card>
      <CardHeader>
        <CardTitle>默认模型（优先级偏好）</CardTitle>
        <CardDescription>
          同一能力启用多家厂商时，决定优先用哪家（只影响排序与兜底，不做硬过滤）；只启用一家时无实际影响。
          停用的厂商/模型会被路由自动跳过，落到下一个可用厂商。
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {CAPABILITIES.map((cap) => {
          const models = modelsOf(cap.key);
          const current = defaults[cap.key] ?? '';
          const value = pending[cap.key] ?? current;
          return (
            <div key={cap.key} className="flex items-center gap-3">
              <span className="flex w-44 shrink-0 items-center gap-2 text-sm text-zinc-400">
                <Badge variant={cap.badge as 'info' | 'success' | 'warning' | 'secondary'} className="w-14 justify-center">{cap.label.split('（')[0]}</Badge>
                {cap.label}
              </span>
              <Select
                className="min-w-0 flex-1"
                aria-label={`${cap.label} 默认模型`}
                value={value}
                onChange={(e) => setPending((p) => ({ ...p, [cap.key]: e.target.value }))}
              >
                <option value="">未指定（路由自由选择）</option>
                {models.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.providerName} · {m.name}{m.isDefault ? '（默认）' : ''} · {m.apiModelId}
                  </option>
                ))}
              </Select>
              <Button
                size="sm"
                variant="outline"
                disabled={!pending[cap.key] || save.isPending}
                onClick={() => save.mutate(cap.key)}
              >
                保存
              </Button>
            </div>
          );
        })}
        {policy.isError && <p className="text-sm text-red-400">默认模型读取失败（请确认管理员权限）</p>}
      </CardContent>
    </Card>
  );
}
