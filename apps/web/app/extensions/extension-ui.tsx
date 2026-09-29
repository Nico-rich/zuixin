'use client';

import { useState } from 'react';
import { ApiError, useApiMutation, useApiQuery, useApiQueryClient } from '@/lib/api';
import { organizationKeys, type OrganizationSummary } from '@/lib/services/organizations';
import {
  addToAllowlist, extensionKeys, removeFromAllowlist,
  type Extension,
} from '@/lib/services/extensions';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Select } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableEmpty, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { useToast } from '@/components/ui/toast';
import { cn } from '@/lib/utils';

/**
 * Extensions 管理页共享件（M13-W7）
 *
 * 数据面全部来自 lib/services/extensions.ts（F1 契约，organizationId 必填）；
 * 本文件只做**展示**与**入参拼装**，不做任何授权判定：
 *  - 按钮显隐/禁用只是「按后端状态机的可用性提示」，服务端仍会再判一次（403/400 一律如实呈现）；
 *  - 权限（permissions / materialized）是展示投影，绝不代表授权（授权 = manifest ∩ 平台白名单 ∩ 组织策略）。
 *
 * 外壳纪律：本目录下的页面不使用 `ul > li` / `section` / `group`，列表一律走 F1 的 Table 组件。
 */

/* ------------------------------------------------------------------ *
 * 契约镜像（kind / status 字面量 → 展示文案；不改变后端语义）
 * ------------------------------------------------------------------ */
export const EXTENSION_KIND_OPTIONS = ['tool', 'agent', 'provider', 'workflow_step'] as const;

const KIND_LABEL: Record<string, string> = {
  tool: '工具',
  agent: 'Agent',
  provider: '供应商',
  workflow_step: '工作流步骤',
};

export function kindLabel(kind: string): string {
  return KIND_LABEL[kind] ?? kind;
}

/** 状态徽标色（draft/published/deprecated/archived 四态，与后端状态机一致） */
type BadgeVariantName = 'default' | 'secondary' | 'outline' | 'success' | 'warning' | 'destructive' | 'info';

const STATUS_VARIANT: Record<string, BadgeVariantName> = {
  draft: 'secondary',
  published: 'success',
  deprecated: 'warning',
  archived: 'outline',
};

export function statusBadgeVariant(status: string): BadgeVariantName {
  return STATUS_VARIANT[status] ?? 'default';
}

/* ------------------------------------------------------------------ *
 * 状态机可用性（与 ExtensionsService.publish/deprecate/archive/update 的前置条件一一对应）
 * ------------------------------------------------------------------ */
export function hasVersion(ext: Pick<Extension, 'versions'>, status: string): boolean {
  return (ext.versions ?? []).some((v) => v.status === status);
}

/** 发布：扩展未归档且存在 draft 版本（服务端：status !== archived 且目标版本 status === draft） */
export const canPublish = (ext: Extension): boolean => ext.status !== 'archived' && hasVersion(ext, 'draft');
/** 废弃：仅 published（服务端状态机绝不逆向） */
export const canDeprecate = (ext: Extension): boolean => ext.status === 'published';
/** 归档：published / deprecated */
export const canArchive = (ext: Extension): boolean => ext.status === 'published' || ext.status === 'deprecated';
/** 更新：已归档扩展不可再修改 */
export const canUpdate = (ext: Extension): boolean => ext.status !== 'archived';
/** 安装：存在已发布版本且当前组织未安装 */
export const canInstall = (ext: Extension): boolean => hasVersion(ext, 'published') && !ext.installation;

/* ------------------------------------------------------------------ *
 * 错误如实呈现：错误码 → HTTP 提示 + Badge（403 = RBAC 拒绝）
 * ------------------------------------------------------------------ */
/** 确定性映射（见 api GlobalExceptionFilter.httpStatusOf）；未列出的码只显示码本身 */
const HTTP_STATUS_HINT: Record<string, number> = {
  UNAUTHORIZED: 401, DEVICE_REVOKED: 401,
  FORBIDDEN: 403, ORG_DISABLED: 403, MESSAGE_EDIT_FORBIDDEN: 403, MESSAGE_DELETE_FORBIDDEN: 403,
  NOT_FOUND: 404,
  VALIDATION_ERROR: 400,
};

export function httpStatusOf(code: string): number | null {
  return HTTP_STATUS_HINT[code] ?? null;
}

/**
 * 失败如实呈现：403（FORBIDDEN / ORG_DISABLED，含 viewer 无 agent.write、非白名单组织安装等）
 * 渲染为 destructive Badge，其余错误码渲染为 outline Badge + 服务端原文。
 */
export function ApiErrorBadge({ error, className }: { error: ApiError; className?: string }) {
  const status = httpStatusOf(error.code);
  const denied = status === 403 || status === 401;
  return (
    <span className={cn('inline-flex min-w-0 flex-wrap items-center gap-2', className)}>
      <Badge variant={denied ? 'destructive' : 'outline'}>{status ? `${status} ${error.code}` : error.code}</Badge>
      <span className="text-xs text-zinc-400">{error.message}</span>
    </span>
  );
}

/* ------------------------------------------------------------------ *
 * 组织选择（extensions 全链路 organizationId 必填 → 先选组织再请求）
 * ------------------------------------------------------------------ */
export interface UseOrganizations {
  query: ReturnType<typeof useApiQuery<{ data: OrganizationSummary[] }>>;
  organizations: OrganizationSummary[];
  organizationId: string;
  setOrganizationId: (id: string) => void;
}

/** 组织列表（全站共用 organizations 查询键）+ 选中态；默认选中第一个组织 */
export function useOrganizations(): UseOrganizations {
  const query = useApiQuery<{ data: OrganizationSummary[] }>({
    queryKey: organizationKeys.all,
    path: '/api/v1/organizations',
  });
  const [override, setOverride] = useState<string | null>(null);
  const organizations = query.data?.data ?? [];
  const organizationId = override ?? organizations[0]?.id ?? '';
  return { query, organizations, organizationId, setOrganizationId: setOverride };
}

export function OrgSelect({
  organizations, value, onChange, id, className, disabled,
}: {
  organizations: OrganizationSummary[];
  value: string;
  onChange: (id: string) => void;
  id?: string;
  className?: string;
  disabled?: boolean;
}) {
  return (
    <Select
      id={id}
      aria-label="组织"
      value={value}
      disabled={disabled || organizations.length === 0}
      onChange={(e) => onChange(e.target.value)}
      className={cn('w-64', className)}
    >
      {organizations.length === 0 && <option value="">（暂无组织）</option>}
      {organizations.map((o) => (
        <option key={o.id} value={o.id}>{o.name}{o.isPersonal ? '（个人）' : ''}</option>
      ))}
    </Select>
  );
}

/* ------------------------------------------------------------------ *
 * 写操作确认（卸载/归档/废弃等不可逆动作）
 * ------------------------------------------------------------------ */
export interface ConfirmSpec {
  title: string;
  description?: string;
  confirmLabel: string;
  run: () => void;
}

/**
 * 确认弹窗：`spec === null` 即关闭（调用方用状态驱动）；失败结果由调用方的 Toast + 顶部错误 Badge 呈现。
 */
export function ConfirmDialog({
  spec, onOpenChange, pending,
}: {
  spec: ConfirmSpec | null;
  onOpenChange: (open: boolean) => void;
  pending?: boolean;
}) {
  return (
    <Dialog open={spec !== null} onOpenChange={onOpenChange}>
      {spec && (
        <>
          <DialogHeader>
            <DialogTitle>{spec.title}</DialogTitle>
            {spec.description && <DialogDescription>{spec.description}</DialogDescription>}
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" disabled={pending} onClick={() => onOpenChange(false)}>取消</Button>
            <Button variant="destructive" disabled={pending} onClick={() => spec.run()}>{spec.confirmLabel}</Button>
          </DialogFooter>
        </>
      )}
    </Dialog>
  );
}

/* ------------------------------------------------------------------ *
 * 组织白名单（M10-P14 D16）：读/加/删；白名单是组织可见性治理数据，不提升任何权限
 * ------------------------------------------------------------------ */
interface AllowlistResponse {
  data: { extensionId: string; restricted: boolean; items: Array<{ organizationId: string; createdAt: string }> };
}

export function AllowlistPanel({
  extensionId, organizations, className,
}: {
  extensionId: string;
  organizations: OrganizationSummary[];
  className?: string;
}) {
  const { toast } = useToast();
  const qc = useApiQueryClient();
  const [target, setTarget] = useState('');
  const [error, setError] = useState<ApiError | null>(null);

  // 白名单读面**不带** organizationId（端点契约如此：治理目标而非调用者组织上下文）
  const query = useApiQuery<AllowlistResponse>({
    queryKey: extensionKeys.allowlist(extensionId),
    path: `/api/v1/extensions/${extensionId}/allowlist`,
  });

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: extensionKeys.allowlist(extensionId) });
    void qc.invalidateQueries({ queryKey: ['extensions'] });
  };

  const add = useApiMutation((organizationId: string) => addToAllowlist(extensionId, organizationId), {
    onSuccess: () => { setError(null); toast({ title: '已加入白名单', variant: 'success' }); refresh(); },
    onError: (e) => { setError(e); toast({ title: '加入白名单失败', description: e.message, variant: 'error' }); },
  });
  const remove = useApiMutation((organizationId: string) => removeFromAllowlist(extensionId, organizationId), {
    onSuccess: () => { setError(null); toast({ title: '已移出白名单', variant: 'success' }); refresh(); },
    onError: (e) => { setError(e); toast({ title: '移出白名单失败', description: e.message, variant: 'error' }); },
  });

  const data = query.data?.data;
  const items = data?.items ?? [];

  return (
    <div className={cn('space-y-3', className)}>
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant={data?.restricted ? 'warning' : 'outline'}>
          {query.isPending ? '白名单未知' : data?.restricted ? '受限可见：仅白名单组织可安装' : '未设置白名单：全部组织可安装'}
        </Badge>
        <span className="text-xs text-zinc-500">白名单只决定可见/可安装范围，不提升任何权限</span>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Select
          aria-label="白名单组织"
          value={target}
          onChange={(e) => setTarget(e.target.value)}
          className="w-64"
          disabled={organizations.length === 0}
        >
          <option value="">选择组织…</option>
          {organizations.map((o) => (
            <option key={o.id} value={o.id}>{o.name}{o.isPersonal ? '（个人）' : ''}</option>
          ))}
        </Select>
        <Button size="sm" disabled={!target || add.isPending} onClick={() => add.mutate(target)}>加入白名单</Button>
      </div>

      {error && <ApiErrorBadge error={error} />}

      {query.isPending ? (
        <Skeleton className="h-4 w-48" />
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>组织</TableHead>
              <TableHead>加入时间</TableHead>
              <TableHead className="text-right">操作</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {items.length === 0 ? (
              <TableEmpty colSpan={3}>白名单为空（当前未限制安装范围）</TableEmpty>
            ) : (
              items.map((item) => (
                <TableRow key={item.organizationId}>
                  <TableCell className="font-mono text-xs">{item.organizationId}</TableCell>
                  <TableCell className="text-xs text-zinc-500">{new Date(item.createdAt).toLocaleString()}</TableCell>
                  <TableCell className="text-right">
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={remove.isPending}
                      onClick={() => remove.mutate(item.organizationId)}
                    >
                      移出白名单
                    </Button>
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      )}
    </div>
  );
}
