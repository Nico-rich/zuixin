import { z } from 'zod';
import { Tool } from '../tool.types';
import { CommerceAnalysisService } from '../../../modules/commerce/commerce-analysis.service';

/**
 * M7-P5 分析决策环工具：
 * - commerce.analysis.generate：服务端计算 facts/derived/anomalies（规则阈值），LLM 只提供
 *   possibleCauses/recommendations（独立存储并标注 interpretation——绝不混入事实）；
 * - creativeBrief.create：problem/objective 必填；evidence 自动快照最新/指定分析的事实层；
 *   LLM 创意方向标注 llm-suggestion；镜像 Artifact(creative_brief)（复用现有制品体系）。
 */
export function createAnalysisTools(analysis: CommerceAnalysisService): Tool[] {
  return [
    {
      name: 'commerce.analysis.generate',
      description: '生成电商分析：服务端计算事实/派生指标/规则异常（前一期对比 ≥10% 下降），你提供的可能原因与建议会与事实分开存储。',
      permission: 'write',
      inputSchema: z.strictObject({
        analysisType: z.enum(['sales', 'traffic', 'conversion', 'ads', 'roas', 'revenue', 'inventory', 'composite']),
        timeRange: z.strictObject({ start: z.string().optional(), end: z.string().optional(), days: z.number().int().min(1).max(92).optional() }).optional(),
        provider: z.string().min(1).max(40).optional(),
        connectionId: z.string().uuid().optional(),
        possibleCauses: z.array(z.string().max(500)).max(10).optional(),
        recommendations: z.array(z.string().max(500)).max(10).optional(),
      }),
      execute: async (raw, ctx) => {
        const input = raw as Parameters<CommerceAnalysisService['generateAnalysis']>[1];
        return analysis.generateAnalysis(ctx.userId, input, { agentRunId: ctx.agentRunId, projectId: ctx.projectId });
      },
    },
    {
      name: 'creativeBrief.create',
      description: '创建创意简报（主图/素材方案）。problem 与 objective 必填；数据证据自动取自最近一次电商分析的事实层。',
      permission: 'write',
      inputSchema: z.strictObject({
        problem: z.string().min(1).max(2000),
        objective: z.string().min(1).max(1000),
        target: z.string().max(500).optional(),
        creativeAngle: z.string().max(1000).optional(),
        visualDirection: z.string().max(1000).optional(),
        copyDirection: z.string().max(1000).optional(),
        constraints: z.record(z.string(), z.unknown()).optional(),
        platform: z.string().max(100).optional(),
        product: z.record(z.string(), z.unknown()).optional(),
        analysisId: z.string().uuid().optional(),
      }),
      execute: async (raw, ctx) => {
        const input = raw as Parameters<CommerceAnalysisService['createBrief']>[1];
        return analysis.createBrief(ctx.userId, input, {
          agentRunId: ctx.agentRunId, projectId: ctx.projectId,
          conversationId: ctx.conversationId, messageId: ctx.messageId,
          idempotencyKey: ctx.idempotencyKey, // ToolCall 级幂等：resume 重放绝不重复建制品
        });
      },
    },
  ];
}
