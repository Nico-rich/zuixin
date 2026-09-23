import { Inject, Injectable } from '@nestjs/common';
import { UsageKind, UsageStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

export interface ChatUsageInput {
  userId: string; conversationId: string; messageId: string;
  providerId: string; modelId: string;
  inputTokens: number; outputTokens: number;
  latencyMs: number; status: 'success' | 'failed'; errorCode?: string;
  runId?: string;   // AgentRun 关联（按 Run 聚合成本）
}

export interface MediaUsageInput {
  userId: string; conversationId?: string; messageId?: string; taskId: string;
  kind: 'image' | 'video';
  providerId: string; modelId: string;
  imageCount: number; videoSeconds: number;
  latencyMs: number; status: 'success' | 'failed'; errorCode?: string;
}

@Injectable()
export class UsageService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  /** 记录 LLM 调用用量并按后台配置价格估算成本（M5 后台可改单价） */
  async recordChatUsage(input: ChatUsageInput): Promise<void> {
    const model = await this.prisma.model.findUnique({ where: { id: input.modelId } });
    const estimatedCost = model
      ? (input.inputTokens * model.inputPrice + input.outputTokens * model.outputPrice) / 1_000_000
      : 0;
    await this.prisma.usageRecord.create({
      data: {
        userId: input.userId, conversationId: input.conversationId, messageId: input.messageId,
        providerId: input.providerId, modelId: input.modelId, runId: input.runId,
        kind: UsageKind.llm_chat,
        inputTokens: input.inputTokens, outputTokens: input.outputTokens,
        latencyMs: input.latencyMs, estimatedCost,
        status: input.status === 'success' ? UsageStatus.success : UsageStatus.failed,
        errorCode: input.errorCode,
      },
    });
  }

  /** 记录媒体用量（image/video 统一走 usage_records，不另建表）并按 unitPrice 估算成本 */
  async recordMediaUsage(input: MediaUsageInput): Promise<void> {
    const model = input.modelId ? await this.prisma.model.findUnique({ where: { id: input.modelId } }).catch(() => null) : null;
    const units = input.kind === 'image' ? input.imageCount : input.videoSeconds;
    const estimatedCost = model ? units * model.unitPrice : 0;
    await this.prisma.usageRecord.create({
      data: {
        userId: input.userId, conversationId: input.conversationId, messageId: input.messageId, taskId: input.taskId,
        providerId: input.providerId || undefined, modelId: input.modelId || undefined,
        kind: input.kind === 'image' ? UsageKind.image : UsageKind.video,
        imageCount: input.imageCount, videoSeconds: input.videoSeconds,
        latencyMs: input.latencyMs, estimatedCost,
        status: input.status === 'success' ? UsageStatus.success : UsageStatus.failed,
        errorCode: input.errorCode,
      },
    });
  }
}
