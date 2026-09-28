import { HttpException, HttpStatus } from '@nestjs/common';
import { ErrorCode } from '../../common/errors/app-error';

/**
 * M10-P3：消息编辑/删除的**越权拒绝**（403 + `MESSAGE_EDIT_FORBIDDEN` / `MESSAGE_DELETE_FORBIDDEN`）。
 *
 * 为什么不是 AppError：全局异常过滤器（`common/filters/global-exception.filter.ts`）的 `httpStatusOf`
 * 尚未收录这两个 M10 错误码——AppError 会落到 `default: 502`（语义错误的网关码）。
 * 该过滤器不在本 Phase 所有权内（M10 §6 热点文件纪律：跨 Phase 单点归属），因此这里显式构造
 * `HttpException`：过滤器对 HttpException 走 `getStatus()` + `payload.code` 路径，产出与 AppError
 * **完全一致**的 `{ error: { code, message, requestId } }` 信封与 403 状态。
 * （集成阶段若把两个码写入 httpStatusOf，可无损改回 AppError——响应契约不变。）
 */
export type MessageMutationOp = 'edit' | 'delete';

export function messageMutationForbidden(op: MessageMutationOp, message: string): HttpException {
  const code = op === 'edit' ? ErrorCode.MESSAGE_EDIT_FORBIDDEN : ErrorCode.MESSAGE_DELETE_FORBIDDEN;
  return new HttpException({ code, message }, HttpStatus.FORBIDDEN);
}
