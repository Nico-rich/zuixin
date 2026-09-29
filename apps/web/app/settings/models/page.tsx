'use client';

import { useState } from 'react';
import { useCurrentUser } from '@/lib/auth';
import { useApiQuery } from '@/lib/api';
import { ProviderView, providerKeys } from '@/lib/services/providers';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { SkeletonLines } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableEmpty, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { ProviderEditDialog } from './components/provider-edit-dialog';
import { DefaultModelsCard } from './components/default-models-card';

/**
 * /settings/models —— 模型配置页（M13+，**平台管理员**）。
 *
 * 边界：
 * - 前端不做权限裁决：非 admin 不发 /api/v1/providers 请求（enabled 门），直接呈现权限提示；
 *   服务端 403 仍是权威（agents 页同口径）；
 * - apiKey 只写不回显（编辑弹窗只显示「已配置/未配置」）；
 * - 改动经 PATCH 落库后由服务端热刷新 manager——保存即生效，无需重启。
 */
const TYPE_LABELS: Record<string, string> = { llm: 'LLM', image: '生图', video: '生视频', embedding: 'Embedding' };

export default function ModelsSettingsPage() {
  const { data: me } = useCurrentUser();
  const isAdmin = me?.data.user.role === 'admin';
  const [editing, setEditing] = useState<ProviderView | null>(null);

  const providers = useApiQuery<{ data: { providers: ProviderView[] } }>({
    queryKey: providerKeys.list,
    path: '/api/v1/providers',
    enabled: isAdmin,
  });
  const rows = providers.data?.data.providers ?? [];

  if (me && !isAdmin) {
    return (
      <div className="mx-auto max-w-2xl p-6">
        <h1 className="mb-4 text-lg font-semibold text-zinc-100">模型配置</h1>
        <Card>
          <CardContent className="py-8 text-center">
            <Badge variant="warning">需要管理员权限</Badge>
            <p className="mt-3 text-sm text-zinc-400">模型配置仅平台管理员可访问（服务端 403 是权威裁决）。</p>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-5xl space-y-6 p-6">
      <div>
        <h1 className="text-lg font-semibold text-zinc-100">模型配置</h1>
        <p className="mt-1 text-sm text-zinc-400">
          接入并启停 LLM / 生图 / 生视频厂商。保存即生效（服务端热刷新）；API Key 只写不回显、加密落库。
        </p>
      </div>

      <DefaultModelsCard providers={rows} enabled={isAdmin} />

      <Card>
        <CardHeader>
          <CardTitle>Provider 厂商</CardTitle>
          <CardDescription>
            已注册 14 家厂商；真实厂商默认停用、未配 Key——勾选启用并填入 Key 即可使用。mock 替身为开发/测试回显。
          </CardDescription>
        </CardHeader>
        <CardContent>
          {providers.isPending && <SkeletonLines lines={5} />}
          {providers.isError && <p className="text-sm text-red-400">Provider 列表加载失败（请确认管理员权限）</p>}
          {!providers.isPending && !providers.isError && (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>名称</TableHead>
                  <TableHead>类型</TableHead>
                  <TableHead>状态</TableHead>
                  <TableHead>Key</TableHead>
                  <TableHead>优先级</TableHead>
                  <TableHead>健康</TableHead>
                  <TableHead>模型数</TableHead>
                  <TableHead><span className="sr-only">操作</span></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.length === 0 && <TableEmpty colSpan={8}>暂无 Provider</TableEmpty>}
                {rows.map((p) => (
                  <TableRow key={p.id}>
                    <TableCell>
                      <div className="font-medium text-zinc-200">{p.name}</div>
                      <div className="text-xs text-zinc-500">{p.adapter}{p.managedByExtension ? ' · 扩展托管' : ''}</div>
                    </TableCell>
                    <TableCell>{TYPE_LABELS[p.type] ?? p.type}</TableCell>
                    <TableCell>
                      <Badge variant={p.enabled ? 'success' : 'secondary'}>{p.enabled ? '已启用' : '已停用'}</Badge>
                      {p.enabled && !p.loaded && <Badge variant="warning" className="ml-1">未加载</Badge>}
                    </TableCell>
                    <TableCell>
                      <Badge variant={p.hasKey ? 'success' : 'outline'}>{p.hasKey ? '已配置' : '无 Key'}</Badge>
                    </TableCell>
                    <TableCell>{p.priority}</TableCell>
                    <TableCell>
                      {p.healthStatus}
                      {p.degradedReason && (
                        <span className="block text-xs text-amber-400" title={p.degradedReason}>配置异常</span>
                      )}
                    </TableCell>
                    <TableCell>{p.models.length}</TableCell>
                    <TableCell>
                      <Button size="sm" variant="outline" onClick={() => setEditing(p)}>编辑</Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {/* key 重挂载：不同 provider 的编辑表单互不串态 */}
      <ProviderEditDialog
        key={editing?.id ?? 'none'}
        provider={editing}
        open={editing !== null}
        onOpenChange={(open) => { if (!open) setEditing(null); }}
      />
    </div>
  );
}
