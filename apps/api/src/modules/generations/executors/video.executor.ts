import { Inject, Injectable } from '@nestjs/common';
import { AppError, ErrorCode } from '@ai-agent/shared';
import { ModelResolverService } from '../../../providers/llm/model-resolver.service';
import { VideoManagerService, ResolvedVideo } from '../../../providers/video/video-manager.service';
import { ModelRouterService } from '../../../core/model-router/model-router.service';
import { MediaExecContext, MediaExecResult, MediaExecutor } from '../media-types';

interface VideoTaskInput {
  prompt: string;
  duration?: number;
  aspectRatio?: string;
  resolution?: string;
  referenceImages?: string[];
}

/** 视频轮询间隔：10s 起指数退避，60s 封顶；绝对 deadline 由 MediaGenerationService 下发 */
const POLL_INTERVALS_MS = [10_000, 20_000, 30_000, 30_000, 60_000, 60_000, 60_000, 60_000, 60_000, 60_000, 60_000, 60_000, 60_000, 60_000, 60_000, 60_000, 60_000, 60_000, 60_000, 60_000, 60_000, 60_000, 60_000, 60_000, 60_000, 60_000, 60_000, 60_000];

/** 视频执行器：capability 校验 → submit → 轮询（与 ImageExecutor 完全独立，不共享实现） */
@Injectable()
export class VideoExecutor implements MediaExecutor {
  readonly type = 'video' as const;

  constructor(
    @Inject(ModelResolverService) private readonly modelResolver: ModelResolverService,
    @Inject(VideoManagerService) private readonly videoManager: VideoManagerService,
    @Inject(ModelRouterService) private readonly modelRouter: ModelRouterService,
  ) {}

  async execute(ctx: MediaExecContext): Promise<MediaExecResult> {
    const input = ctx.task.input as unknown as VideoTaskInput;
    const candidates = await this.modelResolver.listVideoCandidates();
    const { result, usedModel } = await this.modelRouter.execute(candidates, async (candidate) => {
      await ctx.setProviderAttempt(candidate.providerId, candidate.modelId);
      const resolved = await this.videoManager.resolve(candidate.modelId);
      this.assertCapabilities(resolved, input);
      return this.runGeneration(resolved, input, ctx);
    });
    return {
      files: [{ url: result.url, mimeType: 'video/mp4', metadata: { duration: input.duration } }],
      imageCount: 0,
      videoSeconds: input.duration ?? 0,
      providerId: usedModel.providerId,
      modelId: usedModel.modelId,
    };
  }

  /** 参数能力校验：不支持 → UNSUPPORTED_PARAMETER（不可重试 → 不触发 Provider 回退，绝不静默改写参数） */
  private assertCapabilities(resolved: ResolvedVideo, input: VideoTaskInput): void {
    const caps = resolved.capabilities;
    this.assert(caps['supportedDurations'], input.duration, `时长 ${input.duration}s`);
    this.assert(caps['supportedAspectRatios'], input.aspectRatio, `比例 ${input.aspectRatio}`);
    this.assert(caps['supportedResolutions'], input.resolution, `分辨率 ${input.resolution}`);
    if (input.referenceImages?.length && caps['supportsReferenceImage'] === false) {
      throw new AppError(ErrorCode.UNSUPPORTED_PARAMETER, '当前模型不支持参考图（图生视频）');
    }
  }

  private assert(supported: unknown, value: unknown, label: string): void {
    if (value == null || supported == null) return; // 未提供参数或模型未声明能力 → 放行
    if (Array.isArray(supported) && !supported.includes(value)) {
      throw new AppError(ErrorCode.UNSUPPORTED_PARAMETER, `${label}不被当前模型支持（支持: ${supported.join(', ')}）`);
    }
  }

  private async runGeneration(resolved: ResolvedVideo, input: VideoTaskInput, ctx: MediaExecContext): Promise<{ url: string }> {
    const { remoteTaskId } = await resolved.adapter.submit({
      prompt: input.prompt,
      model: resolved.apiModelId,
      imageUrl: input.referenceImages?.[0],
      duration: input.duration,
      aspectRatio: input.aspectRatio,
      resolution: input.resolution,
      signal: AbortSignal.timeout(ctx.deadline - Date.now()),
    });
    await ctx.setRemoteTaskId(remoteTaskId);
    const totalWindow = Math.max(ctx.deadline - Date.now(), 1);
    for (let i = 0; i < POLL_INTERVALS_MS.length; i++) {
      if (Date.now() >= ctx.deadline) throw new AppError(ErrorCode.MEDIA_TASK_TIMEOUT, '视频生成超时');
      await new Promise((r) => setTimeout(r, POLL_INTERVALS_MS[i]));
      const status = await resolved.adapter.getStatus(remoteTaskId);
      if (status.status === 'completed') {
        if (!status.resultUrl) throw new AppError(ErrorCode.PROVIDER_UNKNOWN, '视频完成但无结果');
        return { url: status.resultUrl };
      }
      if (status.status === 'failed') throw new AppError(ErrorCode.PROVIDER_UNKNOWN, status.error ?? '视频生成失败');
      const elapsed = Date.now() - (ctx.deadline - totalWindow);
      await ctx.publishProgress(Math.min(Math.round((elapsed / totalWindow) * 90), 90), `生成中（已 ${Math.round(elapsed / 1000)}s）`);
    }
    throw new AppError(ErrorCode.MEDIA_TASK_TIMEOUT, '视频生成超时');
  }
}
