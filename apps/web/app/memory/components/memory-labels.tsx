import { Badge, type BadgeProps } from '@/components/ui/badge';
import type { MemoryCategory, MemoryScope, MemoryStatus } from '@/lib/services/memories';

/**
 * 记忆枚举的**展示映射**（M13-W3）
 *
 * 只做「后端字面量 → 中文/徽标」投影，不做业务判定。三个口径必须如实呈现：
 *  - `candidate` **尚未生效**（不进入上下文），只有人工提升（PATCH status=active）才生效；
 *  - `rejected` 不会再生效，但保留可查（不是删除）；
 *  - scope=project 的记忆挂在具体项目上，`projectId` 由服务端校验归属。
 */
export const SCOPE_LABEL: Record<MemoryScope, string> = { user: '用户级', project: '项目级' };

export const CATEGORY_LABEL: Record<MemoryCategory, string> = {
  preference: '偏好',
  profile: '个人资料',
  instruction: '指令',
  project_context: '项目背景',
  workflow: '工作流',
  other: '其他',
};

const STATUS_META: Record<MemoryStatus, { label: string; variant: BadgeProps['variant'] }> = {
  candidate: { label: '候选', variant: 'warning' },
  active: { label: '已生效', variant: 'success' },
  rejected: { label: '已拒绝', variant: 'destructive' },
};

export function scopeLabel(scope: MemoryScope): string {
  return SCOPE_LABEL[scope] ?? String(scope);
}

export function categoryLabel(category: MemoryCategory): string {
  return CATEGORY_LABEL[category] ?? String(category);
}

export function statusLabel(status: MemoryStatus): string {
  return STATUS_META[status]?.label ?? String(status);
}

export function MemoryStatusBadge({ status }: { status: MemoryStatus }) {
  const meta = STATUS_META[status] ?? { label: String(status), variant: 'default' as const };
  return <Badge variant={meta.variant}>{meta.label}</Badge>;
}
