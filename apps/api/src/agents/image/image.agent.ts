import { AgentEvent } from '@ai-agent/shared';
import { Agent, AgentContext } from '../agent.types';
import { MediaGenerationService } from '../../modules/generations/media-generation.service';

export interface ImageAgentDeps {
  generations: MediaGenerationService;
}

/**
 * 生图 Agent（M2 为直接编排，非 LLM tool-calling Loop）：
 * status → 创建 GenerationTask（入队）→ task.created → done。
 * 任务进度经轮询/未来 SSE 通道反馈，图片结果落 attachments 挂在消息上。
 */
export class ImageAgent implements Agent {
  readonly id = 'image';

  constructor(private readonly deps: ImageAgentDeps) {}

  async *execute(ctx: AgentContext): AsyncIterable<AgentEvent> {
    yield { type: 'status', stage: 'image_generation', message: '正在创建图片生成任务…' };
    try {
      const task = await this.deps.generations.prepareImageTask({
        userId: ctx.userId,
        conversationId: ctx.conversationId,
        messageId: ctx.messageId,
        params: {
          prompt: ctx.intent.parameters.prompt,
          aspectRatio: ctx.intent.parameters.aspectRatio,
          count: 1,
          referenceImages: ctx.attachments.filter((a) => a.type === 'image').map((a) => a.url),
        },
      });
      yield { type: 'task.created', taskId: task.id, kind: 'image' };
      yield { type: 'done', messageId: ctx.messageId };
    } catch (err) {
      const e = err as { code?: string; message?: string };
      yield { type: 'error', code: e.code ?? 'INTERNAL', message: e.message ?? '图片生成失败' };
    }
  }
}
