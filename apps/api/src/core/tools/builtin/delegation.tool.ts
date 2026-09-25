import { z } from 'zod';
import { Tool } from '../tool.types';
import { DelegationService } from '../../../modules/agent-delegation/delegation.service';

/**
 * agent.delegate：M7-P7 安全委派。
 * 委派受服务端强制约束（深度/子数/环检测/权限子集）——LLM 只能选择目标与任务，不能扩大任何权限。
 * 父 run 进入 waiting（子 run 终态唤醒）；resume 幂等（同 ToolCall 绝不重开子 run）。
 */
export function createDelegateTool(delegation: DelegationService): Tool {
  return {
    name: 'agent.delegate',
    description: '把子任务委派给另一个 Agent 执行（受深度/数量/环检测/权限约束）。返回子任务结果或等待标记。',
    permission: 'write',
    inputSchema: z.strictObject({
      task: z.string().min(1).max(4000),
      agentId: z.string().uuid().optional(), // 缺省 = general-assistant
    }),
    execute: async (raw, ctx) => {
      const input = raw as { task: string; agentId?: string };
      // 身份/权限边界全部由服务层从 run 行解析（DB 为事实，不信任调用方）
      return delegation.delegate({
        userId: ctx.userId, parentRunId: ctx.agentRunId,
        projectId: ctx.projectId,
        idempotencyKey: ctx.idempotencyKey,
        agentId: input.agentId,
        task: input.task,
      });
    },
  };
}
