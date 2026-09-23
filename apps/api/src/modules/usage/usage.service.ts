import { Inject, Injectable } from '@nestjs/common';
import { UsageKind, UsageStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

export interface ChatUsageInput {
  userId: string; conversationId: string; messageId: string;
  providerId: string; modelId: string;
  inputTokens: number; outputTokens: number;
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
        providerId: input.providerId, modelId: input.modelId,
        kind: UsageKind.llm_chat,
        inputTokens: input.inputTokens, outputTokens: input.outputTokens,
        latencyMs: input.latencyMs, estimatedCost,
        status: input.status === 'success' ? UsageStatus.success : UsageStatus.failed,
        errorCode: input.errorCode,
      },
    });
  }
}
