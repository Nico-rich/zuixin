import { z } from 'zod';
import { Tool } from '../tool.types';
import { MediaGenerationService } from '../../../modules/generations/media-generation.service';
import { ArtifactService } from '../../../modules/artifacts/artifact.service';
import { MemoryService } from '../../memory/memory.service';

const REFERENCE_IMAGES = z.array(z.string()).max(4).optional();

/** image.generate：Agent → Tool → MediaGenerationService → ImageProvider（返回任务引用，不阻塞等待） */
export function createImageGenerateTool(generations: MediaGenerationService): Tool {
  return {
    name: 'image.generate',
    description: '创建图片生成任务（支持生成主图/海报/插画等）。返回任务 ID，生成结果稍后以附件形式出现在对话中。',
    permission: 'generate',
    inputSchema: z.strictObject({
      prompt: z.string().min(1).max(4000),
      aspectRatio: z.string().optional(),
      count: z.number().int().min(1).max(4).optional(),
      referenceImages: REFERENCE_IMAGES,
    }),
    execute: async (raw, ctx) => {
      const input = raw as { prompt: string; aspectRatio?: string; count?: number; referenceImages?: string[] };
      const task = await generations.prepareMediaTask({
        userId: ctx.userId, conversationId: ctx.conversationId, messageId: ctx.messageId, type: 'image',
        params: { prompt: input.prompt, aspectRatio: input.aspectRatio, count: input.count, referenceImages: input.referenceImages },
        idempotencyKey: ctx.idempotencyKey, runId: ctx.agentRunId, toolCallId: ctx.toolCallId,
      });
      return { taskId: task.id, status: task.status };
    },
  };
}

/** video.generate：Agent → Tool → MediaGenerationService → VideoProvider */
export function createVideoGenerateTool(generations: MediaGenerationService): Tool {
  return {
    name: 'video.generate',
    description: '创建视频生成任务（文生视频/图生视频）。返回任务 ID，生成结果稍后以附件形式出现在对话中。',
    permission: 'generate',
    inputSchema: z.strictObject({
      prompt: z.string().min(1).max(4000),
      duration: z.number().positive().max(60).optional(),
      aspectRatio: z.string().optional(),
      referenceImages: REFERENCE_IMAGES,
    }),
    execute: async (raw, ctx) => {
      const input = raw as { prompt: string; duration?: number; aspectRatio?: string; referenceImages?: string[] };
      const task = await generations.prepareMediaTask({
        userId: ctx.userId, conversationId: ctx.conversationId, messageId: ctx.messageId, type: 'video',
        params: { prompt: input.prompt, duration: input.duration, aspectRatio: input.aspectRatio, referenceImages: input.referenceImages },
        idempotencyKey: ctx.idempotencyKey, runId: ctx.agentRunId, toolCallId: ctx.toolCallId,
      });
      return { taskId: task.id, status: task.status };
    },
  };
}

/** artifact.create：Agent 产出结构化制品（Creative Brief/报告/分析结果） */
export function createArtifactTool(artifacts: ArtifactService): Tool {
  return {
    name: 'artifact.create',
    description: '创建结构化制品（如创意简报 creative_brief、分析报告 report/analysis）。用于保存 Agent 的结构化产出。',
    permission: 'write',
    inputSchema: z.strictObject({
      type: z.enum(['creative_brief', 'image', 'video', 'report', 'analysis', 'other']),
      title: z.string().min(1).max(200),
      summary: z.string().max(2000).optional(),
      content: z.record(z.string(), z.unknown()).optional(),
    }),
    execute: async (raw, ctx) => {
      const input = raw as { type: 'creative_brief' | 'image' | 'video' | 'report' | 'analysis' | 'other'; title: string; summary?: string; content?: Record<string, unknown> };
      const artifact = await artifacts.create(ctx.userId, {
        type: input.type, title: input.title, summary: input.summary, content: input.content,
        projectId: ctx.projectId, conversationId: ctx.conversationId, messageId: ctx.messageId,
        runId: ctx.agentRunId, toolCallId: ctx.toolCallId,
      });
      return { artifactId: artifact.id, status: artifact.status };
    },
  };
}

/** memory.create_candidate：Agent 建议记忆（只产 candidate，绝不绕过 MemoryService 状态机） */
export function createMemoryCandidateTool(memories: MemoryService): Tool {
  return {
    name: 'memory.create_candidate',
    description: '建议保存一条长期记忆候选（用户偏好/项目背景等）。只会创建候选，需要人工确认后生效。',
    permission: 'write',
    inputSchema: z.strictObject({
      content: z.string().min(1).max(2000),
      category: z.enum(['preference', 'profile', 'instruction', 'project_context', 'workflow', 'other']),
      importance: z.number().int().min(0).max(100).optional(),
      confidence: z.number().min(0).max(1).optional(),
    }),
    execute: async (raw, ctx) => {
      const input = raw as { content: string; category: 'preference' | 'profile' | 'instruction' | 'project_context' | 'workflow' | 'other'; importance?: number; confidence?: number };
      const memory = await memories.create(ctx.userId, {
        scope: ctx.projectId ? 'project' : 'user',
        projectId: ctx.projectId,
        content: input.content,
        category: input.category,
        importance: input.importance,
        confidence: input.confidence,
        status: 'candidate',
        source: 'agent',
        sourceMessageId: ctx.messageId,
      });
      return { memoryId: memory.id, status: memory.status };
    },
  };
}
