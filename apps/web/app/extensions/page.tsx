'use client';

import { useState } from 'react';
import Link from 'next/link';
import { ApiError, useApiMutation, useApiQuery, useApiQueryClient } from '@/lib/api';
import {
  archiveExtension, createExtension, deprecateExtension, disableExtension, enableExtension,
  extensionKeys, installExtension, listCatalog, listExtensionSteps, listExtensions, listInstallations,
  publishExtension, uninstallExtension, updateExtension,
  type CatalogEntry, type CreateExtensionInput, type Extension, type ExtensionInstallation, type ExtensionStep,
} from '@/lib/services/extensions';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Skeleton, SkeletonLines } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableEmpty, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useToast } from '@/components/ui/toast';
import {
  ApiErrorBadge, AllowlistPanel, ConfirmDialog, OrgSelect, canArchive, canDeprecate, canInstall,
  canPublish, canUpdate, kindLabel, statusBadgeVariant, useOrganizations,
  type ConfirmSpec,
} from './extension-ui';
import {
  CreateDialog, InstallDialog, UpdateDialog, installTargetOf, installTargetOfCatalog,
  type InstallTarget,
} from './extension-dialogs';

/**
 * 扩展管理（M13-W7）：扩展是**组织维度**资源（organizationId 必填契约）
 * → 先选组织，再按组织 list / catalog / installations / steps。
 *
 * 端点覆盖（18 端点零前端 → 本页 + 详情页）：
 *  读：list / catalog / installations / steps
 *  写：create / update / publish / deprecate / archive / install / uninstall / enable / disable
 *  白名单：allowlist 读 / 加 / 删
 *
 * 红线遵守：本页**不提供任何运行/执行扩展的入口**（扩展链禁止：不执行任意代码、权限绝不提升）；
 * 按钮的启用条件只是后端状态机的前置条件镜像，服务端仍会再判一次（403/400 一律如实呈现为 Badge）。
 */

const EXT = '/api/v1/extensions';
/** organizationId 必填：任何 org 维度查询都显式带上（缺省会被服务端判 VALIDATION_ERROR） */
const orgParam = (organizationId: string) => `organizationId=${encodeURIComponent(organizationId)}`;

type TabValue = 'mine' | 'catalog' | 'installations' | 'steps';

export default function ExtensionsPage() {
  const { query: orgsQuery, organizations, organizationId, setOrganizationId } = useOrganizations();
  const [tab, setTab] = useState<TabValue>('mine');
  const [createOpen, setCreateOpen] = useState(false);
  const [editing, setEditing] = useState<Extension | null>(null);
  const [installTarget, setInstallTarget] = useState<InstallTarget | null>(null);
  const [allowlistTarget, setAllowlistTarget] = useState<Extension | null>(null);
  const [confirmSpec, setConfirmSpec] = useState<ConfirmSpec | null>(null);
  const [writeError, setWriteError] = useState<ApiError | null>(null);

  const { toast } = useToast();
  const qc = useApiQueryClient();
  const selected = Boolean(organizationId);
  // 每个页签按需查询（切到该页签才发请求）——避免进页面对 4 个端点全量打一遍
  const listQuery = useApiQuery<{ data: Extension[] }>({
    queryKey: extensionKeys.all(organizationId), path: `${EXT}?${orgParam(organizationId)}`, enabled: selected && tab === 'mine',
  });
  const catalogQuery = useApiQuery<{ data: CatalogEntry[] }>({
    queryKey: extensionKeys.catalog(organizationId), path: `${EXT}/catalog?${orgParam(organizationId)}`, enabled: selected && tab === 'catalog',
  });
  const installationsQuery = useApiQuery<{ data: ExtensionInstallation[] }>({
    queryKey: extensionKeys.installations(organizationId), path: `${EXT}/installations?${orgParam(organizationId)}`, enabled: selected && tab === 'installations',
  });
  const stepsQuery = useApiQuery<{ data: ExtensionStep[] }>({
    queryKey: extensionKeys.steps(organizationId), path: `${EXT}/steps?${orgParam(organizationId)}`, enabled: selected && tab === 'steps',
  });

  /** 写操作后刷新「扩展」命名空间下的全部读面（键前缀见 lib/services/extensions.ts 的 extensionKeys） */
  const refreshAll = () => {
    for (const key of ['extensions', 'extensions-catalog', 'extensions-installations', 'extensions-steps', 'extension']) {
      void qc.invalidateQueries({ queryKey: [key] });
    }
  };
  const done = (title: string) => { setWriteError(null); toast({ title, variant: 'success' }); refreshAll(); };
  const failed = (title: string, error: ApiError) => {
    setWriteError(error);
    toast({ title, description: error.message, variant: 'error' });
  };

  const createMut = useApiMutation((input: CreateExtensionInput) => createExtension(input), {
    onSuccess: () => { setCreateOpen(false); done('已创建扩展（首版草稿）'); },
    onError: (e) => failed('创建扩展失败', e),
  });
  const updateMut = useApiMutation(
    (vars: { id: string; input: { name?: string; description?: string; manifest?: unknown } }) => updateExtension(vars.id, vars.input),
    { onSuccess: () => { setEditing(null); done('已更新扩展'); }, onError: (e) => failed('更新扩展失败', e) },
  );
  const publishMut = useApiMutation((id: string) => publishExtension(id), {
    onSuccess: () => done('已发布扩展'), onError: (e) => failed('发布失败', e),
  });
  const deprecateMut = useApiMutation((id: string) => deprecateExtension(id), {
    onSuccess: () => { setConfirmSpec(null); done('已废弃扩展（已下线）'); }, onError: (e) => { setConfirmSpec(null); failed('废弃失败', e); },
  });
  const archiveMut = useApiMutation((id: string) => archiveExtension(id), {
    onSuccess: () => { setConfirmSpec(null); done('已归档扩展'); }, onError: (e) => { setConfirmSpec(null); failed('归档失败', e); },
  });
  const installMut = useApiMutation(
    (vars: { id: string; input: { organizationId: string; versionId?: string; config?: Record<string, unknown> } }) =>
      installExtension(vars.id, vars.input),
    { onSuccess: () => { setInstallTarget(null); done('已安装扩展'); }, onError: (e) => failed('安装失败', e) },
  );
  const uninstallMut = useApiMutation((id: string) => uninstallExtension(id, organizationId), {
    onSuccess: () => { setConfirmSpec(null); done('已卸载扩展'); }, onError: (e) => { setConfirmSpec(null); failed('卸载失败', e); },
  });
  const enableMut = useApiMutation((id: string) => enableExtension(id, organizationId), {
    onSuccess: () => done('已启用扩展'), onError: (e) => failed('启用失败', e),
  });
  const disableMut = useApiMutation((id: string) => disableExtension(id, organizationId), {
    onSuccess: () => done('已停用扩展'), onError: (e) => failed('停用失败', e),
  });

  const extensions = listQuery.data?.data ?? [];
  const busy = publishMut.isPending || deprecateMut.isPending || archiveMut.isPending || enableMut.isPending
    || disableMut.isPending || installMut.isPending || uninstallMut.isPending;

  /** 状态机按钮（发布/废弃/归档）——按当前状态启用，与后端前置条件一一对应 */
  const stateButtons = (ext: Extension) => (
    <>
      <Button
        size="sm" variant="outline"
        disabled={!canPublish(ext) || publishMut.isPending}
        title={canPublish(ext) ? '发布最新草稿版本' : '仅未归档且存在草稿版本时可发布'}
        onClick={() => publishMut.mutate(ext.id)}
      >
        发布
      </Button>
      <Button
        size="sm" variant="outline"
        disabled={!canDeprecate(ext) || deprecateMut.isPending}
        title={canDeprecate(ext) ? '标记为 deprecated 并下线' : '仅 published 扩展可废弃'}
        onClick={() => setConfirmSpec({
          title: `废弃扩展 · ${ext.name}`,
          description: '废弃即下线（tool 类扩展会从平台注册表移除）。状态机绝不逆向，之后只能归档。',
          confirmLabel: '确认废弃',
          run: () => deprecateMut.mutate(ext.id),
        })}
      >
        废弃
      </Button>
      <Button
        size="sm" variant="outline"
        disabled={!canArchive(ext) || archiveMut.isPending}
        title={canArchive(ext) ? '归档（终态）' : '仅 published/deprecated 可归档'}
        onClick={() => setConfirmSpec({
          title: `归档扩展 · ${ext.name}`,
          description: '归档是终态：归档后不可再修改或发布，已安装的组织仍锁定原版本。',
          confirmLabel: '确认归档',
          run: () => archiveMut.mutate(ext.id),
        })}
      >
        归档
      </Button>
    </>
  );

  /** 安装/启用/停用/卸载——安装态由服务端安装行决定 */
  const installButtons = (ext: Extension) => (
    ext.installation ? (
      <>
        <Button
          size="sm" variant="outline"
          disabled={(enableMut.isPending || disableMut.isPending)}
          onClick={() => (ext.installation?.status === 'enabled' ? disableMut.mutate(ext.id) : enableMut.mutate(ext.id))}
        >
          {ext.installation.status === 'enabled' ? '停用' : '启用'}
        </Button>
        <Button
          size="sm" variant="destructive"
          disabled={uninstallMut.isPending}
          onClick={() => setConfirmSpec({
            title: `卸载扩展 · ${ext.name}`,
            description: '卸载会删除本组织的安装行并回收物化资源（工具/Agent/供应商）。',
            confirmLabel: '确认卸载',
            run: () => uninstallMut.mutate(ext.id),
          })}
        >
          卸载
        </Button>
      </>
    ) : (
      <Button
        size="sm" variant="outline"
        disabled={!canInstall(ext) || installMut.isPending}
        title={canInstall(ext) ? '安装到当前组织（锁定版本）' : '需要已发布版本'}
        onClick={() => setInstallTarget(installTargetOf(ext))}
      >
        安装
      </Button>
    )
  );

  if (orgsQuery.isPending) {
    return (
      <div className="h-full overflow-y-auto px-4 py-8 lg:px-8">
        <div className="mx-auto w-full max-w-6xl space-y-4">
          <Skeleton className="h-6 w-40" />
          <SkeletonLines lines={4} />
        </div>
      </div>
    );
  }

  if (orgsQuery.isError) {
    return (
      <div className="h-full overflow-y-auto px-4 py-8 lg:px-8">
        <div className="mx-auto w-full max-w-6xl space-y-3">
          <h1 className="text-lg font-semibold text-zinc-100">扩展管理</h1>
          <Card><CardContent><ApiErrorBadge error={orgsQuery.error} /></CardContent></Card>
        </div>
      </div>
    );
  }

  return (
    <div className="h-full overflow-y-auto px-4 py-8 lg:px-8">
      <div className="mx-auto w-full max-w-6xl">
        <div className="mb-4 flex flex-wrap items-center gap-3">
          <h1 className="text-lg font-semibold text-zinc-100">扩展管理</h1>
          <Badge variant="outline">组织维度</Badge>
          <span className="text-xs text-zinc-500">声明式扩展 · 不执行任何清单内容 · 权限由服务端裁定</span>
        </div>

        <div className="mb-4 flex flex-wrap items-center gap-3">
          <label className="text-xs text-zinc-400" htmlFor="ext-org">组织</label>
          <OrgSelect id="ext-org" organizations={organizations} value={organizationId} onChange={setOrganizationId} />
          <Button disabled={!selected} onClick={() => setCreateOpen(true)}>创建扩展</Button>
          {writeError && <ApiErrorBadge error={writeError} className="ml-auto" />}
        </div>

        {organizations.length === 0 ? (
          <Card>
            <CardContent className="text-sm text-zinc-400">
              尚无可用组织：扩展是组织维度资源（organizationId 必填），请先到「组织团队」创建或加入组织。
            </CardContent>
          </Card>
        ) : (
          <Tabs value={tab} onValueChange={(v) => setTab(v as TabValue)}>
            <TabsList>
              <TabsTrigger value="mine">我的扩展</TabsTrigger>
              <TabsTrigger value="catalog">市场目录</TabsTrigger>
              <TabsTrigger value="installations">安装记录</TabsTrigger>
              <TabsTrigger value="steps">步骤模板</TabsTrigger>
            </TabsList>

            <TabsContent value="mine">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>扩展</TableHead>
                    <TableHead>类型</TableHead>
                    <TableHead>状态</TableHead>
                    <TableHead>最新版本</TableHead>
                    <TableHead>安装态</TableHead>
                    <TableHead className="text-right">操作</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {listQuery.isPending ? (
                    <TableEmpty colSpan={6}>正在加载组织扩展…</TableEmpty>
                  ) : listQuery.isError ? (
                    <TableEmpty colSpan={6}><ApiErrorBadge error={listQuery.error} /></TableEmpty>
                  ) : extensions.length === 0 ? (
                    <TableEmpty colSpan={6}>该组织下暂无扩展（本页仅显示平台级与组织私有扩展）</TableEmpty>
                  ) : (
                    extensions.map((ext) => (
                      <TableRow key={ext.id}>
                        <TableCell>
                          <Link href={`/extensions/${ext.id}`} className="font-medium text-zinc-200 hover:text-zinc-100">{ext.name}</Link>
                          <span className="block font-mono text-xs text-zinc-500">{ext.slug}</span>
                        </TableCell>
                        <TableCell><Badge variant="outline">{kindLabel(ext.kind)}</Badge></TableCell>
                        <TableCell><Badge variant={statusBadgeVariant(ext.status)}>{ext.status}</Badge></TableCell>
                        <TableCell className="text-xs text-zinc-400">
                          {ext.versions?.[0] ? `v${ext.versions[0].version}（${ext.versions[0].status}）` : '—'}
                        </TableCell>
                        <TableCell>
                          {ext.installation ? (
                            <Badge variant={ext.installation.status === 'enabled' ? 'success' : 'secondary'}>
                              {ext.installation.status === 'enabled' ? '已启用' : '已停用'}
                            </Badge>
                          ) : (
                            <span className="text-xs text-zinc-500">未安装</span>
                          )}
                        </TableCell>
                        <TableCell>
                          <div className="flex flex-wrap justify-end gap-1">
                            <Button size="sm" variant="ghost" disabled={!canUpdate(ext)} title={canUpdate(ext) ? '修改名称/描述/manifest' : '已归档扩展不可修改'} onClick={() => setEditing(ext)}>编辑</Button>
                            {stateButtons(ext)}
                            {installButtons(ext)}
                            <Button size="sm" variant="ghost" onClick={() => setAllowlistTarget(ext)}>白名单</Button>
                          </div>
                        </TableCell>
                      </TableRow>
                    ))
                  )}
                </TableBody>
              </Table>
            </TabsContent>

            <TabsContent value="catalog">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>扩展</TableHead>
                    <TableHead>类型</TableHead>
                    <TableHead>范围</TableHead>
                    <TableHead>已发布版本</TableHead>
                    <TableHead>安装态</TableHead>
                    <TableHead className="text-right">操作</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {catalogQuery.isPending ? (
                    <TableEmpty colSpan={6}>正在加载市场目录…</TableEmpty>
                  ) : catalogQuery.isError ? (
                    <TableEmpty colSpan={6}><ApiErrorBadge error={catalogQuery.error} /></TableEmpty>
                  ) : (catalogQuery.data?.data ?? []).length === 0 ? (
                    <TableEmpty colSpan={6}>目录为空：仅已发布（published）的平台级与本组织私有扩展会出现在这里</TableEmpty>
                  ) : (
                    (catalogQuery.data?.data ?? []).map((entry) => (
                      <TableRow key={entry.id}>
                        <TableCell>
                          <Link href={`/extensions/${entry.id}`} className="font-medium text-zinc-200 hover:text-zinc-100">{entry.name}</Link>
                          <span className="block font-mono text-xs text-zinc-500">{entry.slug}</span>
                        </TableCell>
                        <TableCell><Badge variant="outline">{kindLabel(entry.kind)}</Badge></TableCell>
                        <TableCell>
                          <Badge variant={entry.scope === 'platform' ? 'info' : 'secondary'}>
                            {entry.scope === 'platform' ? '平台级' : '组织私有'}
                          </Badge>
                        </TableCell>
                        <TableCell className="text-xs text-zinc-400">
                          {entry.publishedVersion ? `v${entry.publishedVersion.version}` : '—'}
                        </TableCell>
                        <TableCell>
                          {entry.installation ? (
                            <Badge variant={entry.installation.status === 'enabled' ? 'success' : 'secondary'}>
                              {entry.installation.status === 'enabled' ? '已启用' : '已停用'}
                            </Badge>
                          ) : (
                            <span className="text-xs text-zinc-500">未安装</span>
                          )}
                        </TableCell>
                        <TableCell className="text-right">
                          <Button
                            size="sm" variant="outline"
                            disabled={!entry.publishedVersion || Boolean(entry.installation) || installMut.isPending}
                            title={entry.installation ? '已安装（可在「我的扩展」启停）' : entry.publishedVersion ? '安装到当前组织' : '没有已发布版本'}
                            onClick={() => setInstallTarget(installTargetOfCatalog(entry))}
                          >
                            安装
                          </Button>
                        </TableCell>
                      </TableRow>
                    ))
                  )}
                </TableBody>
              </Table>
            </TabsContent>

            <TabsContent value="installations">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>扩展</TableHead>
                    <TableHead>锁定版本</TableHead>
                    <TableHead>状态</TableHead>
                    <TableHead>安装时间</TableHead>
                    <TableHead className="text-right">操作</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {installationsQuery.isPending ? (
                    <TableEmpty colSpan={5}>正在加载安装记录…</TableEmpty>
                  ) : installationsQuery.isError ? (
                    <TableEmpty colSpan={5}><ApiErrorBadge error={installationsQuery.error} /></TableEmpty>
                  ) : (installationsQuery.data?.data ?? []).length === 0 ? (
                    <TableEmpty colSpan={5}>该组织暂无安装记录</TableEmpty>
                  ) : (
                    (installationsQuery.data?.data ?? []).map((row) => (
                      <TableRow key={row.id}>
                        <TableCell>
                          <Link href={`/extensions/${row.extensionId}`} className="font-medium text-zinc-200 hover:text-zinc-100">
                            {row.extension?.name ?? row.extensionId}
                          </Link>
                          <span className="block font-mono text-xs text-zinc-500">{row.extension?.slug ?? '—'}</span>
                        </TableCell>
                        <TableCell className="text-xs text-zinc-400">
                          {row.pinnedVersion ? `v${row.pinnedVersion.version}` : '—'}
                          <span className="block text-zinc-500">安装行锁定版本，不跟随最新发布</span>
                        </TableCell>
                        <TableCell>
                          <Badge variant={row.status === 'enabled' ? 'success' : 'secondary'}>
                            {row.status === 'enabled' ? '已启用' : '已停用'}
                          </Badge>
                        </TableCell>
                        <TableCell className="text-xs text-zinc-500">{new Date(row.installedAt).toLocaleString()}</TableCell>
                        <TableCell>
                          <div className="flex flex-wrap justify-end gap-1">
                            <Button
                              size="sm" variant="outline" disabled={enableMut.isPending || disableMut.isPending}
                              onClick={() => (row.status === 'enabled' ? disableMut.mutate(row.extensionId) : enableMut.mutate(row.extensionId))}
                            >
                              {row.status === 'enabled' ? '停用' : '启用'}
                            </Button>
                            <Button
                              size="sm" variant="destructive" disabled={uninstallMut.isPending}
                              onClick={() => setConfirmSpec({
                                title: `卸载扩展 · ${row.extension?.name ?? row.extensionId}`,
                                description: '卸载会删除本组织的安装行并回收物化资源。',
                                confirmLabel: '确认卸载',
                                run: () => uninstallMut.mutate(row.extensionId),
                              })}
                            >
                              卸载
                            </Button>
                          </div>
                        </TableCell>
                      </TableRow>
                    ))
                  )}
                </TableBody>
              </Table>
            </TabsContent>

            <TabsContent value="steps">
              <p className="mb-3 text-xs text-zinc-500">
                这里只列出**已安装且启用**的 workflow_step 类扩展的步骤模板声明；步骤由工作流执行器消费，本页不执行任何扩展内容。
              </p>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>扩展</TableHead>
                    <TableHead>版本</TableHead>
                    <TableHead>步骤</TableHead>
                    <TableHead>类型</TableHead>
                    <TableHead>参数</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {stepsQuery.isPending ? (
                    <TableEmpty colSpan={5}>正在加载步骤模板…</TableEmpty>
                  ) : stepsQuery.isError ? (
                    <TableEmpty colSpan={5}><ApiErrorBadge error={stepsQuery.error} /></TableEmpty>
                  ) : (stepsQuery.data?.data ?? []).length === 0 ? (
                    <TableEmpty colSpan={5}>无可用的步骤模板（先安装并启用 workflow_step 类扩展）</TableEmpty>
                  ) : (
                    (stepsQuery.data?.data ?? []).map((step) => (
                      <TableRow key={`${step.extensionId}-${step.name}`}>
                        <TableCell>
                          <Link href={`/extensions/${step.extensionId}`} className="font-medium text-zinc-200 hover:text-zinc-100">{step.name}</Link>
                          <span className="block font-mono text-xs text-zinc-500">{step.extensionSlug}</span>
                        </TableCell>
                        <TableCell className="text-xs text-zinc-400">v{step.version}</TableCell>
                        <TableCell className="text-sm text-zinc-300">{step.description ?? '—'}</TableCell>
                        <TableCell><Badge variant="outline">{step.stepType}</Badge></TableCell>
                        <TableCell className="font-mono text-xs text-zinc-500">{JSON.stringify(step.params)}</TableCell>
                      </TableRow>
                    ))
                  )}
                </TableBody>
              </Table>
            </TabsContent>
          </Tabs>
        )}
      </div>

      {createOpen && (
        <CreateDialog
          organizations={organizations}
          defaultOrganizationId={organizationId}
          pending={createMut.isPending}
          error={writeError}
          onClose={() => setCreateOpen(false)}
          onSubmit={(input) => createMut.mutate(input)}
        />
      )}

      {editing && (
        <UpdateDialog
          extension={editing}
          pending={updateMut.isPending}
          error={writeError}
          onClose={() => setEditing(null)}
          onSubmit={(input) => updateMut.mutate({ id: editing.id, input })}
        />
      )}

      {installTarget && (
        <InstallDialog
          target={installTarget}
          organizationId={organizationId}
          pending={installMut.isPending}
          error={writeError}
          onClose={() => setInstallTarget(null)}
          onSubmit={(input) => installMut.mutate({ id: installTarget.id, input })}
        />
      )}

      {allowlistTarget && (
        <Dialog open onOpenChange={(open) => { if (!open) setAllowlistTarget(null); }}>
          <DialogHeader>
            <DialogTitle>组织白名单 · {allowlistTarget.name}</DialogTitle>
            <DialogDescription>白名单内的组织才可安装该扩展；白名单只决定可见范围，不提升任何权限。</DialogDescription>
          </DialogHeader>
          <DialogContent>
            <AllowlistPanel extensionId={allowlistTarget.id} organizations={organizations} />
          </DialogContent>
          <DialogFooter>
            <Button variant="outline" onClick={() => setAllowlistTarget(null)}>关闭</Button>
          </DialogFooter>
        </Dialog>
      )}

      <ConfirmDialog
        spec={confirmSpec}
        pending={busy}
        onOpenChange={(open) => { if (!open) setConfirmSpec(null); }}
      />
    </div>
  );
}
