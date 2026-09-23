import { Inject, Injectable, Logger } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { randomUUID } from 'node:crypto';
import { LIMITS } from '@ai-agent/shared';
import { AppError, ErrorCode } from '../../common/errors/app-error';
import { PrismaService } from '../prisma/prisma.service';
import { StorageAdapter } from '../../core/storage/storage.types';
import { ModelResolverService } from '../../providers/llm/model-resolver.service';
import { ImageManagerService, ResolvedImage } from '../../providers/image/image-manager.service';
import { ImageGenerationResult, ImageProvider } from '../../providers/image/image.types';
import { ModelRouterService } from '../../core/model-router/model-router.service';
import { EventBusService } from '../../core/events/event-bus.service';
import { UsageService } from '../usage/usage.service';
import { IMAGE_QUEUE } from '../../core/queue/queue.module';

export interface PrepareImageInput {
  userId: string;
  conversationId?: string;
  messageId?: string;
  prompt: string;
  size?: string;
  aspectRatio?: string;
  quality?: 'standard' | 'high';
  count?: number;
  referenceImages?: string[];
}

const DEFAULT_DAILY_IMAGE_LIMIT = 50;
const POLL_INTERVALS_MS = [5000, 10000, 20000, 20000, 20000, 20000, 30000, 30000]; // 总上限 ~155s + 首轮
const MAX_DOWNLOAD_ATTEMPTS = 3;

/**
 * 图片生成服务——独立能力，不绑定 ChatService。
 * 调用入口（现在与未来）：Chat（ImageAgent）/ 未来的 Agent / Workflow / Creative Brief 流水线。
 * 职责：限额 → 任务状态机 → 模型候选回退（ModelRouter）→ Provider 调用（同步/异步轮询）→
 *       下载转存对象存储 → attachments(generated_image) → 用量/成本 → 事件发布。
 */
@Injectable()
export class ImageGenerationService {
  private readonly logger = new Logger('ImageGeneration');

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject('STORAGE_ADAPTER') private readonly storage: StorageAdapter,
    @Inject(ModelResolverService) private readonly modelResolver: ModelResolverService,
    @Inject(ImageManagerService) private readonly imageManager: ImageManagerService,
    @Inject(ModelRouterService) private readonly modelRouter: ModelRouterService,
    @Inject(EventBusService) private readonly events: EventBusService,
    @Inject(UsageService) private readonly usage: UsageService,
    @InjectQueue(IMAGE_QUEUE) private readonly imageQueue: Queue,
  ) {}

  /** 入口 1（HTTP 侧）：限额校验 + 建任务(pending) + 入队 */
  async prepareImageTask(input: PrepareImageInput) {
    const limits = await this.prisma.systemSetting.findUnique({ where: { key: 'limits' } });
    const dailyLimit = (limits?.value as { dailyImage?: number } | null)?.dailyImage ?? DEFAULT_DAILY_IMAGE_LIMIT;
    const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);
    const used = await this.prisma.usageRecord.count({
      where: { userId: input.userId, kind: 'image', createdAt: { gte: todayStart } },
    });
    if (used >= dailyLimit) throw new AppError(ErrorCode.QUOTA_EXCEEDED, '今日生图次数已达上限');

    const task = await this.prisma.generationTask.create({
      data: {
        userId: input.userId,
        conversationId: input.conversationId,
        messageId: input.messageId,
        type: 'image',
        status: 'pending',
        statusMessage: '排队中',
        input: {
          prompt: input.prompt,
          size: input.size,
          aspectRatio: input.aspectRatio,
          quality: input.quality,
          count: Math.min(Math.max(input.count ?? 1, 1), 4),
          referenceImages: input.referenceImages ?? [],
        },
      },
    });
    await this.imageQueue.add('generate', { taskId: task.id }, { attempts: 1, removeOnComplete: true, removeOnFail: true });
    return task;
  }

  /** 入口 2（Worker 侧）：任务执行——失败会重试回退其他候选，终态必落库 */
  async executeTask(taskId: string): Promise<void> {
    const task = await this.prisma.generationTask.findUnique({ where: { id: taskId } });
    if (!task || task.status !== 'pending') return; // 已取消/已处理 → 幂等跳过
    const startedAt = Date.now();
    await this.updateTask(taskId, { status: 'processing', statusMessage: '生成中', startedAt: new Date(), attempts: { increment: 1 } });
    await this.publishProgress(taskId, 10, '正在生成图片…');

    try {
      const input = task.input as { prompt: string; size?: string; aspectRatio?: string; quality?: 'standard' | 'high'; count?: number; referenceImages?: string[] };
      const candidates = await this.modelResolver.listImageCandidates();
      const { result, usedModel } = await this.modelRouter.execute(candidates, async (candidate) => {
        const resolved = await this.imageManager.resolve(candidate.modelId);
        return this.runGeneration(resolved, input, taskId);
      });
      await this.publishProgress(taskId, 80, '正在保存图片…');

      // 下载转存 → attachments（generated_image）
      const attachments = await this.storeImages(task, result.images, input);
      await this.updateTask(taskId, {
        status: 'completed', statusMessage: '完成', progress: 100, completedAt: new Date(),
        providerId: usedModel.providerId, modelId: usedModel.modelId,
        output: { attachments: attachments.map((a) => a.id) },
      });
      await this.usage.recordImageUsage({
        userId: task.userId, conversationId: task.conversationId ?? undefined, messageId: task.messageId ?? undefined, taskId,
        providerId: usedModel.providerId, modelId: usedModel.modelId,
        imageCount: result.images.length, latencyMs: Date.now() - startedAt, status: 'success',
      });
      await this.events.publish('task', { type: 'task.completed', taskId, progress: 100 });
      this.logger.log({ taskId, userId: task.userId, provider: usedModel.providerId, latencyMs: Date.now() - startedAt }, '生图任务完成');
    } catch (err) {
      const appErr = err instanceof AppError ? err : new AppError(ErrorCode.PROVIDER_UNKNOWN, (err as Error).message);
      await this.updateTask(taskId, {
        status: 'failed', statusMessage: appErr.message, errorCode: appErr.code, errorMessage: appErr.message, completedAt: new Date(),
      });
      await this.usage.recordImageUsage({
        userId: task.userId, conversationId: task.conversationId ?? undefined, messageId: task.messageId ?? undefined, taskId,
        providerId: task.providerId ?? '', modelId: task.modelId ?? '', imageCount: 0,
        latencyMs: Date.now() - startedAt, status: 'failed', errorCode: appErr.code,
      }).catch(() => undefined);
      await this.events.publish('task', { type: 'task.progress', taskId, progress: 100, message: '失败' });
      this.logger.warn({ taskId, code: appErr.code }, `生图任务失败: ${appErr.message}`);
    }
  }

  /** 单个模型上执行生成（同步 generate 或 异步 submit+轮询） */
  private async runGeneration(resolved: ResolvedImage, input: { prompt: string; size?: string; aspectRatio?: string; quality?: 'standard' | 'high'; count?: number; referenceImages?: string[] }, taskId: string): Promise<{ images: ImageGenerationResult['images']; usedProvider: ResolvedImage }> {
    const params = {
      prompt: input.prompt,
      model: resolved.apiModelId,
      size: input.size,
      aspectRatio: input.aspectRatio,
      quality: input.quality,
      count: input.count,
      referenceImages: input.referenceImages,
    };
    if (resolved.adapter.submit && resolved.adapter.getStatus) {
      const { remoteTaskId } = await resolved.adapter.submit(params);
      await this.prisma.generationTask.update({ where: { id: taskId }, data: { remoteTaskId } });
      for (let i = 0; i < POLL_INTERVALS_MS.length; i++) {
        await new Promise((r) => setTimeout(r, POLL_INTERVALS_MS[i]));
        const status = await resolved.adapter.getStatus!(remoteTaskId);
        if (status.status === 'completed') {
          if (!status.resultUrls?.length) throw new AppError(ErrorCode.PROVIDER_UNKNOWN, '生图完成但无结果');
          return { images: status.resultUrls.map((url) => ({ url })), usedProvider: resolved };
        }
        if (status.status === 'failed') throw new AppError(ErrorCode.PROVIDER_UNKNOWN, status.error ?? '生图失败');
        await this.publishProgress(taskId, 10 + Math.min(i, 6) * 10, '生成中');
      }
      throw new AppError(ErrorCode.PROVIDER_TIMEOUT, '生图超时');
    }
    if (resolved.adapter.generate) {
      const result = await resolved.adapter.generate(params);
      return { images: result.images, usedProvider: resolved };
    }
    throw new AppError(ErrorCode.PROVIDER_UNKNOWN, '生图适配器无可用接口');
  }

  /** 下载（data URL 或 http）→ 转存对象存储 → attachments(kind=generated_image, taskId) */
  private async storeImages(task: { id: string; userId: string; conversationId: string | null; messageId: string | null }, images: Array<{ url: string }>, input: { count?: number }) {
    const attachments = [];
    for (const image of images.slice(0, input.count ?? 1)) {
      const buffer = await this.downloadImage(image.url);
      const now = new Date();
      const storageKey = `${task.userId}/${now.getFullYear()}/${String(now.getMonth() + 1).padStart(2, '0')}/${randomUUID()}.png`;
      const { Readable } = await import('node:stream');
      await this.storage.put(storageKey, Readable.from(buffer), { contentType: 'image/png', sizeBytes: buffer.length });
      const att = await this.prisma.attachment.create({
        data: {
          userId: task.userId, conversationId: task.conversationId, messageId: task.messageId,
          kind: 'generated_image', type: 'image', mimeType: 'image/png',
          storageKey, originalName: `generated-${task.id.slice(0, 8)}.png`, sizeBytes: buffer.length,
          status: 'ready', taskId: task.id,
        },
      });
      attachments.push(att);
    }
    return attachments;
  }

  private async downloadImage(url: string): Promise<Buffer> {
    if (url.startsWith('data:')) {
      return Buffer.from(url.split(',')[1], 'base64');
    }
    for (let attempt = 1; attempt <= MAX_DOWNLOAD_ATTEMPTS; attempt++) {
      try {
        const res = await fetch(url);
        if (!res.ok) throw new Error(`下载失败: ${res.status}`);
        return Buffer.from(await res.arrayBuffer());
      } catch (err) {
        if (attempt === MAX_DOWNLOAD_ATTEMPTS) throw new AppError(ErrorCode.PROVIDER_UNKNOWN, `图片下载失败: ${(err as Error).message}`);
      }
    }
    throw new AppError(ErrorCode.PROVIDER_UNKNOWN, '图片下载失败');
  }

  private async updateTask(taskId: string, data: Record<string, unknown>) {
    await this.prisma.generationTask.update({ where: { id: taskId }, data: data as never });
  }

  private async publishProgress(taskId: string, progress: number, message: string) {
    await this.events.publish('task', { type: 'task.progress', taskId, progress, message });
  }
}
