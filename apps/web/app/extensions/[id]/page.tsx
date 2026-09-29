'use client';

import { use, useState } from 'react';
import Link from 'next/link';
import { ApiError, useApiMutation, useApiQuery, useApiQueryClient } from '@/lib/api';
import {
  archiveExtension, deprecateExtension, disableExtension, enableExtension, extensionKeys,
  installExtension, listExtensionSteps, publishExtension, uninstallExtension, updateExtension,
  type Extension, type ExtensionStep,
} from '@/lib/services/extensions';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { SkeletonLines } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableEmpty, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { useToast } from '@/components/ui/toast';
import {
  AllowlistPanel, ApiErrorBadge, ConfirmDialog, OrgSelect, canArchive, canDeprecate, canInstall,
  canPublish, canUpdate, kindLabel, statusBadgeVariant, useOrganizations,
  type ConfirmSpec,
} from '../extension-ui';
import { InstallDialog, UpdateDialog, installTargetOf, type InstallTarget } from '../extension-dialogs';

/**
 * 扩展详情（M13-W7）：信息 / 版本（不可变快照 + 每版本发布）/ 步骤清单 / 安装态 / 状态机 / 组织白名单。
 *
 * 与列表页共用状态机谓词与弹窗（app/extensions/extension-ui.tsx 与 extension-dialogs.tsx），
 * 保证两处对「什么状态能做什么」只有一份口径；服务端仍是唯一裁决方。
 * 主题红线：不提供任何执行扩展清单的入口（扩展链禁止），步骤清单只读展示。
 */

const EXT = '/api/v1/extensions';
const orgParam = (organizationId: string) => `organizationId=${encodeURIComponent(organizationId)}`;

export default function ExtensionDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const { query: orgsQuery, organizations, organizationId, setOrganizationId } = useOrganizations();
  const [editing, setEditing] = useState(false);
  const [installTarget, setInstallTarget] = useState<InstallTarget | null>(null);
  const [confirmSpec, setConfirmSpec] = useState<ConfirmSpec | null>(null);
  const [writeError, setWriteError] = useState<ApiError | null>(null);

  const { toast } = useToast();
  const qc = useApiQueryClient();
  const selected = Boolean(organizationId);

  const detailQuery = useApiQuery<{ data: Extension }>({
    queryKey: extensionKeys.detail(id, organizationId),
    path: `${EXT}/${id}?${orgParam(organizationId)}`,
    enabled: selected,
  });
  const ext = detailQuery.data?.data ?? null;
  // 步骤模板端点按组织返回已启用安装的清单；只有 workflow_step 类扩展才需要（其他 kind 不请求）
  const stepsQuery = useApiQuery<{ data: ExtensionStep[] }>({
    queryKey: extensionKeys.steps(organizationId),
    path: `${EXT}/steps?${orgParam(organizationId)}`,
    enabled: selected && ext?.kind === 'workflow_step',
  });

  const refresh = () => {
    for (const key of ['extensions', 'extensions-catalog', 'extensions-installations', 'extensions-steps', 'extension']) {
      void qc.invalidateQueries({ queryKey: [key] });
    }
  };
  const done = (title: string) => { setWriteError(null); toast({ title, variant: 'success' }); refresh(); };
  const failed = (title: string, error: ApiError) => {
    setWriteError(error);
    toast({ title, description: error.message, variant: 'error' });
  };
  const runConfirmed = (title: string) => ({
    onSuccess: () => { setConfirmSpec(null); done(title); },
    onError: (e: ApiError) => { setConfirmSpec(null); failed('操作失败', e); },
  });

  const updateMut = useApiMutation(
    (input: { name?: string; description?: string; manifest?: unknown }) => updateExtension(id, input),
    { onSuccess: () => { setEditing(false); done('已更新扩展'); }, onError: (e) => failed('更新扩展失败', e) },
  );
  const publishMut = useApiMutation((versionId?: string) => publishExtension(id, versionId ? { versionId } : {}), {
    onSuccess: () => done('已发布版本'), onError: (e) => failed('发布失败', e),
  });
  const deprecateMut = useApiMutation(() => deprecateExtension(id), runConfirmed('已废弃扩展（已下线）'));
  const archiveMut = useApiMutation(() => archiveExtension(id), runConfirmed('已归档扩展'));
  const installMut = useApiMutation(
    (input: { organizationId: string; versionId?: string; config?: Record<string, unknown> }) => installExtension(id, input),
    { onSuccess: () => { setInstallTarget(null); done('已安装扩展'); }, onError: (e) => failed('安装失败', e) },
  );
  const uninstallMut = useApiMutation(() => uninstallExtension(id, organizationId), runConfirmed('已卸载扩展'));
  const enableMut = useApiMutation(() => enableExtension(id, organizationId), {
    onSuccess: () => done('已启用扩展'), onError: (e) => failed('启用失败', e),
  });
  const disableMut = useApiMutation(() => disableExtension(id, organizationId), {
    onSuccess: () => done('已停用扩展'), onError: (e) => failed('停用失败', e),
  });

  const busy = publishMut.isPending || deprecateMut.isPending || archiveMut.isPending || installMut.isPending
    || uninstallMut.isPending || enableMut.isPending || disableMut.isPending;

  if (orgsQuery.isPending || (selected && detailQuery.isPending)) {
    return (
      <div className="h-full overflow-y-auto px-4 py-8 lg:px-8">
        <div className="mx-auto w-full max-w-4xl space-y-4">
          <SkeletonLines lines={6} />
        </div>
      </div>
    );
  }

  if (!organizationId) {
    return (
      <div className="h-full overflow-y-auto px-4 py-8 lg:px-8">
        <div className="mx-auto w-full max-w-4xl space-y-3">
          <h1 className="text-lg font-semibold text-zinc-100">扩展详情</h1>
          <Card><CardContent className="text-sm text-zinc-400">尚无可用组织：扩展是组织维度资源（organizationId 必填）。</CardContent></Card>
        </div>
      </div>
    );
  }

  if (detailQuery.isError) {
    return (
      <div className="h-full overflow-y-auto px-4 py-8 lg:px-8">
        <div className="mx-auto w-full max-w-4xl space-y-3">
          <Link href="/extensions" className="text-xs text-zinc-500 hover:text-zinc-300">← 扩展管理</Link>
          <Card><CardContent><ApiErrorBadge error={detailQuery.error} /></CardContent></Card>
        </div>
      </div>
    );
  }

  if (!ext) return null;

  const versions = ext.versions ?? [];
  const installedVersion = ext.installation ? versions.find((v) => v.id === ext.installation?.versionId) ?? null : null;
  const steps = (stepsQuery.data?.data ?? []).filter((s) => s.extensionId === id);

  return (
    <div className="h-full overflow-y-auto px-4 py-8 lg:px-8">
      <div className="mx-auto w-full max-w-4xl">
        <Link href="/extensions" className="text-xs text-zinc-500 hover:text-zinc-300">← 扩展管理</Link>

        <div className="mt-3 mb-4 flex flex-wrap items-center gap-3">
          <h1 className="text-lg font-semibold text-zinc-100">{ext.name}</h1>
          <Badge variant={statusBadgeVariant(ext.status)}>{ext.status}</Badge>
          <Badge variant="outline">{kindLabel(ext.kind)}</Badge>
          <Badge variant={ext.organizationId ? 'secondary' : 'info'}>{ext.organizationId ? '组织私有' : '平台级'}</Badge>
          <span className="font-mono text-xs text-zinc-500">{ext.slug}</span>
        </div>

        <div className="mb-4 flex flex-wrap items-center gap-3">
          <label className="text-xs text-zinc-400" htmlFor="ext-detail-org">组织</label>
          <OrgSelect id="ext-detail-org" organizations={organizations} value={organizationId} onChange={setOrganizationId} />
          <Button variant="outline" disabled={!canUpdate(ext)} title={canUpdate(ext) ? '修改名称/描述/manifest' : '已归档扩展不可修改'} onClick={() => setEditing(true)}>编辑</Button>
          {writeError && <ApiErrorBadge error={writeError} className="ml-auto" />}
        </div>

        <Card className="mb-4">
          <CardHeader>
            <CardTitle>概览</CardTitle>
            <CardDescription>扩展是声明式数据；下方一切信息都不代表授权（授权 = 清单 ∩ 平台白名单 ∩ 组织策略）</CardDescription>
          </CardHeader>
          <CardContent className="space-y-1 text-sm text-zinc-300">
            <p>{ext.description ?? '（无描述）'}</p>
            <p className="font-mono text-xs text-zinc-500">id: {ext.id}</p>
            <p className="text-xs text-zinc-500">归属组织：{ext.organizationId ?? '平台级（所有组织可见）'} · 创建于 {new Date(ext.createdAt).toLocaleString()} · 更新于 {new Date(ext.updatedAt).toLocaleString()}</p>
          </CardContent>
        </Card>

        <Card className="mb-4">
          <CardHeader>
            <CardTitle>状态机与版本</CardTitle>
            <CardDescription>版本是不可变快照：发布把 draft 置为 published 并签名，旧 published 版本自动转 archived；状态机绝不逆向</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex flex-wrap gap-2">
              <Button
                variant="outline" disabled={!canPublish(ext) || publishMut.isPending}
                title={canPublish(ext) ? '发布最新草稿版本' : '仅未归档且存在草稿版本时可发布'}
                onClick={() => publishMut.mutate(undefined)}
              >
                发布最新草稿
              </Button>
              <Button
                variant="outline" disabled={!canDeprecate(ext) || deprecateMut.isPending}
                title={canDeprecate(ext) ? '标记为 deprecated 并下线' : '仅 published 扩展可废弃'}
                onClick={() => setConfirmSpec({
                  title: `废弃扩展 · ${ext.name}`,
                  description: '废弃即下线（tool 类扩展会从平台注册表移除）。状态机绝不逆向，之后只能归档。',
                  confirmLabel: '确认废弃',
                  run: () => deprecateMut.mutate(),
                })}
              >
                废弃
              </Button>
              <Button
                variant="outline" disabled={!canArchive(ext) || archiveMut.isPending}
                title={canArchive(ext) ? '归档（终态）' : '仅 published/deprecated 可归档'}
                onClick={() => setConfirmSpec({
                  title: `归档扩展 · ${ext.name}`,
                  description: '归档是终态：归档后不可再修改或发布。',
                  confirmLabel: '确认归档',
                  run: () => archiveMut.mutate(),
                })}
              >
                归档
              </Button>
            </div>

            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>版本</TableHead>
                  <TableHead>状态</TableHead>
                  <TableHead>权限（声明投影）</TableHead>
                  <TableHead>checksum</TableHead>
                  <TableHead>签名</TableHead>
                  <TableHead>创建时间</TableHead>
                  <TableHead className="text-right">操作</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {versions.length === 0 ? (
                  <TableEmpty colSpan={7}>该扩展没有版本</TableEmpty>
                ) : (
                  versions.map((v) => (
                    <TableRow key={v.id}>
                      <TableCell className="text-zinc-200">v{v.version}</TableCell>
                      <TableCell><Badge variant={statusBadgeVariant(v.status)}>{v.status}</Badge></TableCell>
                      <TableCell>
                        <span className="flex flex-wrap gap-1">
                          {(v.permissions ?? []).length === 0
                            ? <span className="text-xs text-zinc-500">—</span>
                            : (v.permissions ?? []).map((p) => <Badge key={p.id} variant="outline">{p.name}</Badge>)}
                        </span>
                      </TableCell>
                      <TableCell className="font-mono text-xs text-zinc-500">{v.checksum.slice(0, 12)}…</TableCell>
                      <TableCell className="text-xs text-zinc-500">{v.signature ? '已签名' : '未签名'}</TableCell>
                      <TableCell className="text-xs text-zinc-500">{new Date(v.createdAt).toLocaleString()}</TableCell>
                      <TableCell className="text-right">
                        <Button
                          size="sm" variant="outline"
                          disabled={v.status !== 'draft' || ext.status === 'archived' || publishMut.isPending}
                          title={v.status === 'draft' ? '发布该草稿版本' : '仅 draft 版本可发布'}
                          onClick={() => publishMut.mutate(v.id)}
                        >
                          发布该版本
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </CardContent>
        </Card>

        <Card className="mb-4">
          <CardHeader>
            <CardTitle>安装（当前组织）</CardTitle>
            <CardDescription>安装行锁定版本并物化资源；启用/停用只影响本组织，绝不修改扩展本身</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {ext.installation ? (
              <>
                <div className="flex flex-wrap items-center gap-2 text-sm text-zinc-300">
                  <Badge variant={ext.installation.status === 'enabled' ? 'success' : 'secondary'}>
                    {ext.installation.status === 'enabled' ? '已启用' : '已停用'}
                  </Badge>
                  <span className="text-xs text-zinc-400">
                    锁定版本 {installedVersion ? `v${installedVersion.version}` : ext.installation.versionId}
                  </span>
                  <span className="text-xs text-zinc-500">安装于 {new Date(ext.installation.installedAt).toLocaleString()}</span>
                </div>
                <p className="font-mono text-xs text-zinc-500">config: {JSON.stringify(ext.installation.config ?? {})}</p>
                <div className="flex flex-wrap gap-2">
                  <Button
                    variant="outline"
                    disabled={enableMut.isPending || disableMut.isPending}
                    onClick={() => (ext.installation?.status === 'enabled' ? disableMut.mutate() : enableMut.mutate())}
                  >
                    {ext.installation.status === 'enabled' ? '停用' : '启用'}
                  </Button>
                  <Button
                    variant="destructive" disabled={uninstallMut.isPending}
                    onClick={() => setConfirmSpec({
                      title: `卸载扩展 · ${ext.name}`,
                      description: '卸载会删除本组织的安装行并回收物化资源（工具/Agent/供应商）。',
                      confirmLabel: '确认卸载',
                      run: () => uninstallMut.mutate(),
                    })}
                  >
                    卸载
                  </Button>
                </div>
              </>
            ) : (
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-sm text-zinc-400">当前组织未安装该扩展</span>
                <Button
                  variant="outline" disabled={!canInstall(ext) || installMut.isPending}
                  title={canInstall(ext) ? '安装到当前组织（锁定版本）' : '需要已发布版本'}
                  onClick={() => setInstallTarget(installTargetOf(ext))}
                >
                  安装
                </Button>
              </div>
            )}
          </CardContent>
        </Card>

        {ext.kind === 'workflow_step' && (
          <Card className="mb-4">
            <CardHeader>
              <CardTitle>步骤清单</CardTitle>
              <CardDescription>
                workflow_step 类扩展在**已安装且启用**时对外暴露的步骤模板（只声明）；步骤由工作流执行器消费，本页不执行任何扩展内容
              </CardDescription>
            </CardHeader>
            <CardContent>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>步骤</TableHead>
                    <TableHead>版本</TableHead>
                    <TableHead>类型</TableHead>
                    <TableHead>参数</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {stepsQuery.isPending ? (
                    <TableEmpty colSpan={4}>正在加载步骤模板…</TableEmpty>
                  ) : stepsQuery.isError ? (
                    <TableEmpty colSpan={4}><ApiErrorBadge error={stepsQuery.error} /></TableEmpty>
                  ) : steps.length === 0 ? (
                    <TableEmpty colSpan={4}>暂无步骤模板（安装并启用后才会出现在这里）</TableEmpty>
                  ) : (
                    steps.map((s) => (
                      <TableRow key={s.versionId}>
                        <TableCell className="text-zinc-200">
                          {s.name}
                          {s.description && <span className="block text-xs text-zinc-500">{s.description}</span>}
                        </TableCell>
                        <TableCell className="text-xs text-zinc-400">v{s.version}</TableCell>
                        <TableCell><Badge variant="outline">{s.stepType}</Badge></TableCell>
                        <TableCell className="font-mono text-xs text-zinc-500">{JSON.stringify(s.params)}</TableCell>
                      </TableRow>
                    ))
                  )}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        )}

        <Card>
          <CardHeader>
            <CardTitle>组织白名单</CardTitle>
            <CardDescription>白名单是可见性治理面：只有白名单内的组织可安装该扩展（不提升任何权限）</CardDescription>
          </CardHeader>
          <CardContent>
            <AllowlistPanel extensionId={id} organizations={organizations} />
          </CardContent>
        </Card>
      </div>

      {editing && (
        <UpdateDialog
          extension={ext}
          pending={updateMut.isPending}
          error={writeError}
          onClose={() => setEditing(false)}
          onSubmit={(input) => updateMut.mutate(input)}
        />
      )}

      {installTarget && (
        <InstallDialog
          target={installTarget}
          organizationId={organizationId}
          pending={installMut.isPending}
          error={writeError}
          onClose={() => setInstallTarget(null)}
          onSubmit={(input) => installMut.mutate(input)}
        />
      )}

      <ConfirmDialog
        spec={confirmSpec}
        pending={busy}
        onOpenChange={(open) => { if (!open) setConfirmSpec(null); }}
      />
    </div>
  );
}
