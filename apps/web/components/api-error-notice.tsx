import { Badge } from '@/components/ui/badge';
import type { ApiError } from '@/lib/api';

/**
 * 服务端错误如实呈现（M13-W5）：code + message 原样展示，并按 code 附加状态徽标。
 *
 * RBAC 口径（路线图 §4：身份/权限只从 JWT+DB 裁决）：前端**不做**权限判定，
 * 被服务端拒绝时（403 FORBIDDEN / ORG_DISABLED）就显示「无权限 / 组织已禁用」，
 * 而不是把错误吞掉或改写成「操作失败」。
 */
export function ApiErrorNotice({ error, prefix }: { error: ApiError; prefix?: string }) {
  return (
    <p className="text-xs text-red-400" role="alert">
      {prefix}{error.message}（{error.code}）
      {error.code === 'FORBIDDEN' && <Badge variant="outline" className="ml-2">无权限</Badge>}
      {error.code === 'ORG_DISABLED' && <Badge variant="destructive" className="ml-2">组织已禁用</Badge>}
      {error.code === 'UNAUTHORIZED' && <Badge variant="outline" className="ml-2">会话已失效</Badge>}
    </p>
  );
}

/** 仅按 code 渲染徽标（无错误对象时用；如「角色不足」的静态提示） */
export function NoPermissionBadge({ label = '无权限' }: { label?: string }) {
  return <Badge variant="outline">{label}</Badge>;
}
