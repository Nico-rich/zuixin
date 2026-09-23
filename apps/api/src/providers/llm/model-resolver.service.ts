import { Inject, Injectable } from '@nestjs/common';
import { PrismaService } from '../../modules/prisma/prisma.service';
import { AppError, ErrorCode } from '../../common/errors/app-error';
import { LLMManagerService, ResolvedLLM } from './llm-manager.service';
import { ImageManagerService, ResolvedImage } from '../image/image-manager.service';
import { VideoManagerService, ResolvedVideo } from '../video/video-manager.service';
import { ModelCandidate } from '../../core/model-router/model-router.service';

@Injectable()
export class ModelResolverService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(LLMManagerService) private readonly llmManager: LLMManagerService,
    @Inject(ImageManagerService) private readonly imageManager: ImageManagerService,
    @Inject(VideoManagerService) private readonly videoManager: VideoManagerService,
  ) {}

  /** 默认 LLM 解析：routingPolicy.defaults.llm → isDefault → priority 最小；永不写死模型名 */
  async resolveDefaultLLM(): Promise<ResolvedLLM> {
    const settings = await this.prisma.systemSetting.findUnique({ where: { key: 'routingPolicy' } });
    const defaults = (settings?.value as { defaults?: Record<string, string | null> } | null)?.defaults;
    let modelId = defaults?.llm ?? null;
    if (!modelId) {
      const fallback = await this.prisma.model.findFirst({
        where: { type: 'llm', enabled: true },
        orderBy: [{ isDefault: 'desc' }, { priority: 'asc' }],
      });
      modelId = fallback?.id ?? null;
    }
    if (!modelId) throw new AppError(ErrorCode.PROVIDER_UNKNOWN, '没有可用的 LLM 模型，请在后台配置');
    return this.llmManager.resolve(modelId);
  }

  /** 默认生图模型解析：routingPolicy.defaults.image → isDefault → priority 最小 */
  async resolveDefaultImage(): Promise<ResolvedImage> {
    const settings = await this.prisma.systemSetting.findUnique({ where: { key: 'routingPolicy' } });
    const defaults = (settings?.value as { defaults?: Record<string, string | null> } | null)?.defaults;
    let modelId = defaults?.image ?? null;
    if (!modelId) {
      const fallback = await this.prisma.model.findFirst({
        where: { type: 'image', enabled: true },
        orderBy: [{ isDefault: 'desc' }, { priority: 'asc' }],
      });
      modelId = fallback?.id ?? null;
    }
    if (!modelId) throw new AppError(ErrorCode.PROVIDER_UNKNOWN, '没有可用的生图模型，请在后台配置');
    return this.imageManager.resolve(modelId);
  }

  /** 生图候选列表（供 ModelRouter 熔断过滤 + 可重试回退） */
  async listImageCandidates(): Promise<ModelCandidate[]> {
    return this.listMediaCandidates('image');
  }

  /** 生视频候选列表 */
  async listVideoCandidates(): Promise<ModelCandidate[]> {
    return this.listMediaCandidates('video');
  }

  /** 默认生视频模型解析：routingPolicy.defaults.video → isDefault → priority 最小 */
  async resolveDefaultVideo(): Promise<ResolvedVideo> {
    const settings = await this.prisma.systemSetting.findUnique({ where: { key: 'routingPolicy' } });
    const defaults = (settings?.value as { defaults?: Record<string, string | null> } | null)?.defaults;
    let modelId = defaults?.video ?? null;
    if (!modelId) {
      const fallback = await this.prisma.model.findFirst({
        where: { type: 'video', enabled: true },
        orderBy: [{ isDefault: 'desc' }, { priority: 'asc' }],
      });
      modelId = fallback?.id ?? null;
    }
    if (!modelId) throw new AppError(ErrorCode.PROVIDER_UNKNOWN, '没有可用的视频模型，请在后台配置');
    return this.videoManager.resolve(modelId);
  }

  private async listMediaCandidates(type: 'image' | 'video'): Promise<ModelCandidate[]> {
    const models = await this.prisma.model.findMany({
      where: { type, enabled: true },
      include: { provider: { select: { enabled: true } } },
    });
    return models
      .filter((m) => m.provider.enabled)
      .map((m) => ({ modelId: m.id, providerId: m.providerId, priority: m.priority, cost: m.unitPrice, latencyMs: 0 }));
  }
}
