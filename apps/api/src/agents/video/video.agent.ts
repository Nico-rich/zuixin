import { AgentEvent } from '@ai-agent/shared';
import { Agent, AgentContext } from '../agent.types';
import { MediaGenerationService } from '../../modules/generations/media-generation.service';

export interface VideoAgentDeps {
  generations: MediaGenerationService;
}

/**
 * 生视频 Agent（M3 为直接编排，非 LLM tool-calling Loop）：
 * status → 创建 Video Task（入队）→ task.created(kind=video) → done。
 */
export class VideoAgent implements Agent {
  readonly id = 'video';

  constructor(private readonly deps: VideoAgentDeps) {}

  async *execute(ctx: AgentContext): AsyncIterable<AgentEvent> {
    yield { type: 'status', stage: 'video_generation', message: '正在创建视频生成任务…' };
    try {
      const task = await this.deps.generations.prepareVideoTask({
        userId: ctx.userId,
        conversationId: ctx.conversationId,
        messageId: ctx.messageId,
        params: {
          prompt: ctx.intent.parameters.prompt,
          duration: ctx.intent.parameters.duration,
          aspectRatio: ctx.intent.parameters.aspectRatio,
          referenceImages: ctx.attachments.filter((a) => a.type === 'image').map((a) => a.url),
        },
      });
      yield { type: 'task.created', taskId: task.id, kind: 'video' };
      yield { type: 'done', messageId: ctx.messageId };
    } catch (err) {
      const e = err as { code?: string; message?: string };
      yield { type: 'error', code: e.code ?? 'INTERNAL', message: e.message ?? '视频生成失败' };
    }
  }
}
