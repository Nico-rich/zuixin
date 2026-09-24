import { z } from 'zod';
import { Tool } from '../tool.types';
import { ExternalActionsService } from '../../../modules/external-actions/external-actions.service';
import { ErrorCode } from '../../../common/errors/app-error';

/**
 * external_action.execute：M7-P3 外部副作用统一入口工具。
 * 审批链（Engine P1 审批门）→ resume 执行 → ExternalActionService（审批复核 + 幂等 + 连接 + Adapter）。
 * connectionId 可缺省（= 用户该 provider 的第一个 active 连接）；provider 缺省 mock。
 * retryPolicy 只对瞬时故障（PROVIDER_TIMEOUT）重试——幂等键 + externalRequestId 保证不重复副作用。
 */
export function createExternalActionExecuteTool(actions: ExternalActionsService): Tool {
  return {
    name: 'external_action.execute',
    description: '执行外部操作（发布内容/更新商品等）。需要人工审批；执行前校验审批与连接，幂等键防止重复执行。',
    permission: 'external_action',
    requiresApproval: true,
    timeoutMs: 30_000,
    retryPolicy: { maxRetries: 1, retryableCodes: [ErrorCode.PROVIDER_TIMEOUT] },
    inputSchema: z.strictObject({
      actionType: z.string().min(1).max(100),
      payload: z.record(z.string(), z.unknown()).optional(),
      provider: z.string().min(1).max(40).optional(),
      connectionId: z.string().uuid().optional(),
    }),
    execute: async (raw, ctx) => {
      const input = raw as { actionType: string; payload?: Record<string, unknown>; provider?: string; connectionId?: string };
      return actions.execute({
        userId: ctx.userId, projectId: ctx.projectId, agentRunId: ctx.agentRunId, toolCallId: ctx.toolCallId,
        connectionId: input.connectionId, provider: input.provider ?? 'mock',
        actionType: input.actionType, payload: input.payload ?? {},
        permission: 'external_action',
        idempotencyKey: ctx.idempotencyKey, signal: ctx.signal,
      });
    },
  };
}
