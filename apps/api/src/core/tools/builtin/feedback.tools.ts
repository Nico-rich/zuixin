import { z } from 'zod';
import { Tool } from '../tool.types';
import { FeedbackService } from '../../../modules/feedback/feedback.service';

/** M7-P8 学习闭环工具（feedback.submit / performance.capture / performance.insights） */
export function createFeedbackTools(feedback: FeedbackService): Tool[] {
  return [
    {
      name: 'feedback.submit',
      description: '对制品/简报/素材提交评分（1~5）与评价；高分/低分会沉淀为绩效记忆候选。',
      permission: 'write',
      inputSchema: z.strictObject({
        subjectType: z.enum(['artifact', 'creativeBrief', 'product', 'campaign', 'ad', 'generationTask', 'agentRun', 'analysis']),
        subjectId: z.string().min(1).max(100),
        rating: z.number().int().min(1).max(5),
        comment: z.string().max(2000).optional(),
      }),
      execute: async (raw, ctx) => {
        const input = raw as Parameters<FeedbackService['submit']>[1];
        return feedback.submit(ctx.userId, { ...input, projectId: ctx.projectId });
      },
    },
    {
      name: 'performance.capture',
      description: '回流传媒绩效（曝光/点击/花费/转化/营收/订单）；派生 CTR/CVR/ROAS 由服务端计算，达标/不达标沉淀记忆。',
      permission: 'write',
      inputSchema: z.strictObject({
        artifactId: z.string().uuid().optional(),
        campaignId: z.string().uuid().optional(),
        adId: z.string().uuid().optional(),
        platform: z.string().min(1).max(40).optional(),
        metrics: z.strictObject({
          impressions: z.number().int().min(0), clicks: z.number().int().min(0), spend: z.number().min(0),
          conversions: z.number().int().min(0), revenue: z.number().min(0), orders: z.number().int().min(0),
        }),
      }),
      execute: async (raw, ctx) => {
        const input = raw as Parameters<FeedbackService['capturePerformance']>[1];
        return feedback.capturePerformance(ctx.userId, { ...input, projectId: ctx.projectId });
      },
    },
    {
      name: 'performance.insights',
      description: '读取学习洞察：绩效记忆候选（历史创意表现）+ 近期绩效事实（分层标注）——未来创意简报的数据底座。',
      permission: 'read',
      inputSchema: z.strictObject({ limit: z.number().int().min(1).max(50).optional() }),
      execute: async (raw, ctx) => {
        const input = raw as { limit?: number };
        return feedback.insights(ctx.userId, input.limit ?? 10);
      },
    },
  ];
}
