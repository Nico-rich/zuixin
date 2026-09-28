import { Inject, Injectable, Logger } from '@nestjs/common';
import { z } from 'zod';
import { PrismaService } from '../../modules/prisma/prisma.service';
import { ModelResolverService } from '../../providers/llm/model-resolver.service';

/** 记忆分类唯一事实源（M9-P2 候选提炼复用，绝不各自硬编码枚举） */
export const MEMORY_CATEGORIES = ['preference', 'profile', 'instruction', 'project_context', 'workflow', 'other'] as const;

export const ExtractedCandidatesSchema = z.object({
  memories: z.array(z.object({
    content: z.string().min(1).max(2000),
    category: z.enum(MEMORY_CATEGORIES),
    importance: z.number().int().min(0).max(100),
    confidence: z.number().min(0).max(1),
  })),
});

const CONFIDENCE_THRESHOLD = 0.7;
const DEFAULT_DAILY_LIMIT = 20;

export interface ExtractInput {
  userId: string;
  conversationId: string;
  projectId?: string;
  userMessage: string;
  assistantReply: string;
  sourceMessageId: string;
}

/**
 * 记忆提取接口。
 * M2 策略：AI 提取候选 → 保存为 candidate（status），人工确认后 active；
 * 不自动确认、不无限保存——置信度阈值 + 每日候选上限双闸门。
 */
export interface MemoryExtractor {
  /** 返回本次保存的候选数 */
  extractCandidates(input: ExtractInput): Promise<number>;
}

/** 接口的 DI token（接口类型在运行时被擦除，不能用类名当 token） */
export const MEMORY_EXTRACTOR = Symbol('MEMORY_EXTRACTOR');

@Injectable()
export class LLMMemoryExtractor implements MemoryExtractor {
  private readonly logger = new Logger('MemoryExtractor');

  constructor(
    @Inject(ModelResolverService) private readonly modelResolver: ModelResolverService,
    @Inject(PrismaService) private readonly prisma: PrismaService,
  ) {}

  async extractCandidates(input: ExtractInput): Promise<number> {
    try {
      const limits = await this.prisma.systemSetting.findUnique({ where: { key: 'limits' } });
      const dailyLimit = (limits?.value as { dailyMemoryCandidates?: number } | null)?.dailyMemoryCandidates ?? DEFAULT_DAILY_LIMIT;
      const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);
      const used = await this.prisma.memory.count({
        where: { userId: input.userId, source: 'extractor', createdAt: { gte: todayStart } },
      });
      if (used >= dailyLimit) return 0; // 防无限保存

      const { adapter, apiModelId } = await this.modelResolver.resolveDefaultLLM();
      const r = await adapter.chat({
        model: apiModelId,
        temperature: 0,
        responseFormat: { type: 'json_object' },
        messages: [
          { role: 'system', content: this.systemPrompt() },
          { role: 'user', content: `用户消息："${input.userMessage}"\nAI 回复："${input.assistantReply.slice(0, 2000)}"` },
        ],
      });
      const parsed = ExtractedCandidatesSchema.safeParse(JSON.parse(r.content));
      if (!parsed.success) return 0; // 非法 JSON → 安全降级（mock LLM 场景即此路径）

      let saved = 0;
      for (const c of parsed.data.memories) {
        if (c.confidence < CONFIDENCE_THRESHOLD) continue;
        await this.prisma.memory.create({
          data: {
            userId: input.userId,
            scope: input.projectId ? 'project' : 'user',
            projectId: input.projectId ?? null,
            content: c.content,
            category: c.category,
            importance: c.importance,
            confidence: c.confidence,
            status: 'candidate',
            source: 'extractor',
            sourceMessageId: input.sourceMessageId,
          },
        });
        saved++;
      }
      return saved;
    } catch (err) {
      this.logger.warn(`记忆提取失败（不影响聊天）：${(err as Error).message}`);
      return 0;
    }
  }

  private systemPrompt(): string {
    return `你是记忆提取器。从本轮对话中提取值得长期记住的、用户明确表达的事实/偏好/指令。
只输出 JSON：{"memories":[{"content":"...","category":"preference|profile|instruction|project_context|workflow|other","importance":0~100,"confidence":0~1}]}
规则：
1. 只提取用户明确表达的稳定偏好/事实/工作指令（如"以后都按 2000×2000 做"），不提取一般问答内容；
2. confidence 表示"这值得保存"的置信度；importance 表示对未来任务的重要程度——两者独立；
3. 拿不准时 confidence 低于 0.7；
4. 没有可提取内容时输出 {"memories":[]}。`;
  }
}
