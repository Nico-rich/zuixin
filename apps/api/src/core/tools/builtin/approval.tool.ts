import { z } from 'zod';
import { Tool } from '../tool.types';
import { ArtifactService } from '../../../modules/artifacts/artifact.service';

/**
 * external_action.demo：M7-P1 审批链路的真实入口工具（P3 起由 ExternalActionService 家族接替）。
 * permission='external_action' + requiresApproval → Engine 审批门：waiting → 人工 approve/reject → resume 执行/回喂。
 * 执行体为本地制品写入（无真实外部副作用），e2e 可全链路断言。
 */
export function createExternalActionDemoTool(artifacts: ArtifactService): Tool {
  return {
    name: 'external_action.demo',
    description: '执行外部操作（演示）。执行前必须获得人工审批；审批通过后记录制品作为执行证据。',
    permission: 'external_action',
    requiresApproval: true,
    inputSchema: z.strictObject({
      title: z.string().min(1).max(200),
      content: z.string().max(2000).optional(),
    }),
    execute: async (raw, ctx) => {
      const input = raw as { title: string; content?: string };
      const artifact = await artifacts.create(ctx.userId, {
        type: 'other', title: input.title, summary: input.content,
        projectId: ctx.projectId, conversationId: ctx.conversationId, messageId: ctx.messageId,
        runId: ctx.agentRunId, toolCallId: ctx.toolCallId,
        idempotencyKey: ctx.idempotencyKey, // resume 重放去重：同一 ToolCall 绝不产生第二个执行证据
      });
      return { artifactId: artifact.id, executed: true };
    },
  };
}
