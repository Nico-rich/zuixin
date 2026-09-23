import { Inject, Injectable, Logger } from '@nestjs/common';
import { TaskIntent, TaskIntentSchema } from '@ai-agent/shared';
import { PrismaService } from '../../modules/prisma/prisma.service';
import { LLMManagerService } from '../../providers/llm/llm-manager.service';
import { ChatMessage } from '../../providers/llm/llm.types';

export interface ClassifyInput {
  userMessage: string;
  attachments: Array<{ type: 'image' | 'video' | 'file' }>;
  history: ChatMessage[]; // 最近 2 轮（由 M1 chat 模块裁剪传入）
}

const FALLBACK_INTENT: TaskIntent = { type: 'chat', confidence: 1, parameters: { prompt: '' } };

@Injectable()
export class RouterService {
  private readonly logger = new Logger('Router');

  constructor(
    @Inject(LLMManagerService) private readonly llmManager: LLMManagerService,
    @Inject(PrismaService) private readonly prisma: PrismaService,
  ) {}

  async classify(input: ClassifyInput): Promise<TaskIntent> {
    // 快路径：无文字 + 单图片 → 图片理解（省一次 LLM 调用）
    if (!input.userMessage.trim() && input.attachments.length === 1 && input.attachments[0].type === 'image') {
      return { type: 'image_analysis', confidence: 1, parameters: { prompt: '' } };
    }
    const settings = await this.prisma.systemSetting.findUnique({ where: { key: 'routingPolicy' } });
    const value = settings?.value as { confidenceThreshold?: number; routerModelId?: string | null } | null;
    const threshold = value?.confidenceThreshold ?? 0.7;
    const routerModelId = value?.routerModelId;
    if (!routerModelId) return this.fallback(input.userMessage); // 未配置路由模型 → 聊天兜底

    const messages: ChatMessage[] = [
      { role: 'system', content: this.buildSystemPrompt() },
      ...input.history,
      { role: 'user', content: this.buildUserMessage(input) },
    ];

    try {
      const { adapter, apiModelId } = await this.llmManager.resolve(routerModelId);
      // 第一次尝试结构化输出；非法 JSON 重试一次
      for (let attempt = 0; attempt < 2; attempt++) {
        const r = await adapter.chat({ model: apiModelId, messages, temperature: 0, responseFormat: { type: 'json_object' } });
        const parsed = this.parseJSON(r.content);
        if (!parsed) continue;
        const result = TaskIntentSchema.safeParse(parsed);
        if (result.success) {
          return result.data.confidence >= threshold ? result.data : this.fallback(input.userMessage);
        }
      }
      this.logger.warn('Router 结构化输出失败，降级 chat');
      return this.fallback(input.userMessage);
    } catch (err) {
      this.logger.warn(`Router LLM 调用失败（${(err as Error).message}），降级 chat`);
      return this.fallback(input.userMessage);
    }
  }

  private fallback(userMessage: string): TaskIntent {
    return { ...FALLBACK_INTENT, parameters: { prompt: userMessage } };
  }

  private parseJSON(text: string): unknown {
    try { return JSON.parse(text); } catch { return null; }
  }

  private buildSystemPrompt(): string {
    return `你是 AI 平台的意图路由器。根据用户消息判断任务类型，只输出 JSON，不要输出其他内容。
类型枚举: chat(普通对话/知识问答/写作), image_generation(生成/设计图片、海报、插画), video_generation(生成/制作视频), image_analysis(分析图片内容), file_analysis(分析文档文件), agent_task(交给特定 Agent), workflow(多步骤任务)。
输出格式: {"type":"...","confidence":0.0~1.0,"parameters":{"prompt":"<生成或分析任务的优化提示词，chat 类型填用户原话>","aspectRatio":"可选 1:1/16:9/9:16","duration":可选秒数,"referenceMessageId":"可选，用户说换一个风格/基于上一张图时填写引用消息"}}
规则: 1) 普通问答必须归为 chat；2) 拿不准时 confidence 低于 0.7；3) parameters.prompt 必填。`;
  }

  private buildUserMessage(input: ClassifyInput): string {
    const att = input.attachments.length ? `\n附件: ${input.attachments.map((a) => a.type).join(', ')}` : '';
    const history = input.history.length ? `\n最近对话: ${JSON.stringify(input.history.map((m) => ({ role: m.role, content: typeof m.content === 'string' ? m.content.slice(0, 200) : '(多模态)' })))}` : '';
    return `用户消息: "${input.userMessage}"${att}${history}`;
  }
}
