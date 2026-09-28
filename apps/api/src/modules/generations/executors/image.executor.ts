import { Inject, Injectable } from '@nestjs/common';
import { AppError, ErrorCode } from '@ai-agent/shared';
import { ModelResolverService } from '../../../providers/llm/model-resolver.service';
import { ImageManagerService, ResolvedImage } from '../../../providers/image/image-manager.service';
import { ModelRouterService } from '../../../core/model-router/model-router.service';
import { MediaExecContext, MediaExecResult, MediaExecutor, MediaRemoteQuery, MediaRemoteStatus } from '../media-types';
import { PrismaService } from '../../prisma/prisma.service';

interface ImageTaskInput {
  prompt: string;
  size?: string;
  aspectRatio?: string;
  quality?: 'standard' | 'high';
  count?: number;
  referenceImages?: string[];
}

const POLL_INTERVALS_MS = [5000, 10000, 20000, 20000, 20000, 20000, 30000, 30000]; // 内部退避上限 ~155s

/** 图片执行器：候选回退（ModelRouter）→ 同步/异步 Provider 调用（不涉及任务生命周期） */
@Injectable()
export class ImageExecutor implements MediaExecutor {
  readonly type = 'image' as const;

  constructor(
    @Inject(ModelResolverService) private readonly modelResolver: ModelResolverService,
    @Inject(ImageManagerService) private readonly imageManager: ImageManagerService,
    @Inject(ModelRouterService) private readonly modelRouter: ModelRouterService,
    @Inject(PrismaService) private readonly prisma: PrismaService,
  ) {}

  async execute(ctx: MediaExecContext): Promise<MediaExecResult> {
    const input = ctx.task.input as unknown as ImageTaskInput;
    const candidates = await this.modelResolver.listImageCandidates();
    const { result, usedModel } = await this.modelRouter.execute(candidates, async (candidate) => {
      await ctx.setProviderAttempt(candidate.providerId, candidate.modelId);
      const resolved = await this.imageManager.resolve(candidate.modelId);
      return this.runGeneration(resolved, input, ctx);
    });
    return {
      files: result.images.map((i) => ({ url: i.url, mimeType: 'image/png' })),
      imageCount: result.images.length,
      videoSeconds: 0,
      providerId: usedModel.providerId,
      modelId: usedModel.modelId,
    };
  }

  /**
   * Pre-M9 G7：按 remoteTaskId 反查远端真实状态（恢复路径专用，不轮询、不重试）。
   * 解析不到适配器/模型已停用（resolve 抛错）→ 由调用方兜底；适配器无 getStatus（同步型）→ null。
   */
  async queryRemoteStatus(query: MediaRemoteQuery): Promise<MediaRemoteStatus | null> {
    if (!query.modelId) return null; // 无 provider 归因（示例：claim 后立刻崩溃）→ 无法定位远端任务
    const { adapter } = await this.imageManager.resolve(query.modelId);
    if (!adapter.getStatus) return null; // 同步型 provider：无远端任务概念
    const signal = AbortSignal.timeout(Math.max(query.deadline - Date.now(), 1));
    const status = await adapter.getStatus(query.remoteTaskId, { signal });
    if (status.status === 'completed') {
      if (!status.resultUrls?.length) return { status: 'failed', error: '生图完成但无结果' };
      return {
        status: 'completed',
        result: {
          files: status.resultUrls.map((url) => ({ url, mimeType: 'image/png' })),
          imageCount: status.resultUrls.length,
          videoSeconds: 0,
          providerId: query.providerId ?? '',
          modelId: query.modelId,
        },
      };
    }
    if (status.status === 'failed') return { status: 'failed', error: status.error ?? '生图失败' };
    return { status: 'processing' };
  }

  /** 单个模型执行：同步 generate 或 异步 submit+轮询（含绝对 deadline 检查） */
  private async runGeneration(resolved: ResolvedImage, input: ImageTaskInput, ctx: MediaExecContext): Promise<{ images: Array<{ url: string }> }> {
    const remaining = () => ctx.deadline - Date.now();
    // Pre-M9 G5：本次尝试的整体截止信号（贯穿 submit + 每轮 getStatus；适配器组合单请求超时后交给 fetch）
    const deadlineSignal = AbortSignal.timeout(Math.max(remaining(), 1));
    const params = {
      prompt: input.prompt,
      model: resolved.apiModelId,
      size: input.size,
      aspectRatio: input.aspectRatio,
      quality: input.quality,
      count: input.count,
      referenceImages: input.referenceImages,
      signal: deadlineSignal,
    };
    if (resolved.adapter.submit && resolved.adapter.getStatus) {
      const { remoteTaskId } = await resolved.adapter.submit(params);
      await ctx.setRemoteTaskId(remoteTaskId);
      for (let i = 0; i < POLL_INTERVALS_MS.length; i++) {
        if (remaining() <= 0) throw new AppError(ErrorCode.MEDIA_TASK_TIMEOUT, '生图超时');
        await new Promise((r) => setTimeout(r, POLL_INTERVALS_MS[i]));
        const status = await resolved.adapter.getStatus!(remoteTaskId, { signal: deadlineSignal });
        if (status.status === 'completed') {
          if (!status.resultUrls?.length) throw new AppError(ErrorCode.PROVIDER_UNKNOWN, '生图完成但无结果');
          return { images: status.resultUrls.map((url) => ({ url })) };
        }
        if (status.status === 'failed') throw new AppError(ErrorCode.PROVIDER_UNKNOWN, status.error ?? '生图失败');
        await ctx.publishProgress(10 + Math.min(i, 6) * 10, '生成中');
      }
      throw new AppError(ErrorCode.MEDIA_TASK_TIMEOUT, '生图超时');
    }
    if (resolved.adapter.generate) {
      const result = await resolved.adapter.generate(params);
      return { images: result.images };
    }
    throw new AppError(ErrorCode.PROVIDER_UNKNOWN, '生图适配器无可用接口');
  }
}
