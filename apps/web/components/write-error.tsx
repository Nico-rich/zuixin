'use client';
import { Badge } from '@/components/ui/badge';
import { ApiError } from '@/lib/api';
import { cn } from '@/lib/utils';

/**
 * WriteError（M13-W10）：写操作的失败呈现——**服务端是唯一裁决方，前端不预判权限**。
 *
 * 口径（与 F1 组件库的 toast 颜色说明同源）：
 *  - 403 类错误码 → 权限徽标（如 evaluation.write 仅 owner/admin、webhook 轮换仅 owner/admin）。
 *    写入口**不隐藏**：权限由服务端裁决，前端隐藏会让有权限的用户看不到入口，也会让越权尝试静默无声。
 *  - 其他错误（400 VALIDATION_ERROR / 404 反枚举 / 409 状态冲突）→ 错误码 + 服务端文案。
 *
 * 刻意不用 `text-red-400` 字面量：e2e 用 `p.text-red-400` 计数判定「页面错误态」，
 * 写失败提示不应被计入页面级错误横幅（与 ui/toast.tsx 的同一约定）。
 */

/**
 * 服务端映射为 HTTP 403 的错误码。
 * 证据：apps/api/src/common/filters/global-exception.filter.ts 的 httpStatusOf
 * （FORBIDDEN / ORG_DISABLED / MESSAGE_EDIT_FORBIDDEN / MESSAGE_DELETE_FORBIDDEN）。
 * ApiError 只携带 code（不带 HTTP 状态）→ 只能按码判定；**未列出的码不在此列**，
 * 一律按普通错误原文渲染（宁可少一枚徽标，也不把非权限失败谎报成权限问题）。
 */
const FORBIDDEN_CODES: ReadonlySet<string> = new Set([
  'FORBIDDEN', 'ORG_DISABLED', 'MESSAGE_EDIT_FORBIDDEN', 'MESSAGE_DELETE_FORBIDDEN',
]);

export function WriteError({ error, forbiddenHint, className }: {
  error: ApiError | null | undefined;
  /** 403 时的权限说明（各端点所需的角色不同，由调用方按端点如实给出） */
  forbiddenHint?: string;
  className?: string;
}) {
  if (!error) return null;
  if (FORBIDDEN_CODES.has(error.code)) {
    return (
      <Badge variant="destructive" data-testid="forbidden-badge" className={className} title={error.message}>
        403 权限不足{forbiddenHint ? ` · ${forbiddenHint}` : ''}
      </Badge>
    );
  }
  return (
    <p className={cn('text-xs text-zinc-400', className)}>
      {error.message}
      {error.code ? `（${error.code}）` : ''}
    </p>
  );
}

/** 把任意抛出物归一化为 ApiError（未知一律按网络故障呈现，绝不吞掉失败） */
export function toApiError(err: unknown, fallback = '网络错误，请重试'): ApiError {
  return err instanceof ApiError ? err : new ApiError('INTERNAL', fallback);
}
