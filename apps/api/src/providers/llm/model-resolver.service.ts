import { Inject, Injectable } from '@nestjs/common';
import { PrismaService } from '../../modules/prisma/prisma.service';
import { AppError, ErrorCode } from '../../common/errors/app-error';
import { LLMManagerService, ResolvedLLM } from './llm-manager.service';
import { ImageManagerService, ResolvedImage } from '../image/image-manager.service';
import { VideoManagerService, ResolvedVideo } from '../video/video-manager.service';
import { ModelCandidate } from '../../core/model-router/model-router.service';
import { CircuitBreakerService } from '../../core/circuit-breaker/circuit-breaker.service';

@Injectable()
export class ModelResolverService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(LLMManagerService) private readonly llmManager: LLMManagerService,
    @Inject(ImageManagerService) private readonly imageManager: ImageManagerService,
    @Inject(VideoManagerService) private readonly videoManager: VideoManagerService,
    @Inject(CircuitBreakerService) private readonly cb: CircuitBreakerService,
  ) {}

  /**
   * 默认 LLM 解析（Pre-M9 G2 熔断感知）：routingPolicy.defaults.llm 优先 → isDefault → priority 最小。
   * 熔断 open 的 provider 跳过（复用既有候选 fallback 语义）；半开 provider 仅作最后兜底（探测放行，成功即复位）；
   * 全部候选不可用 → PROVIDER_UNAVAILABLE（绝不静默打向已知故障 provider）。永不写死模型名。
   */
  async resolveDefaultLLM(): Promise<ResolvedLLM> {
    const settings = await this.prisma.systemSetting.findUnique({ where: { key: 'routingPolicy' } });
    const defaults = (settings?.value as { defaults?: Record<string, string | null> } | null)?.defaults;
    const preferredId = defaults?.llm ?? null;
    const rows = await this.prisma.model.findMany({
      where: { type: 'llm', enabled: true },
      include: { provider: { select: { enabled: true } } },
      orderBy: [{ isDefault: 'desc' }, { priority: 'asc' }],
    });
    const enabled = rows.filter((m) => m.provider.enabled);
    if (enabled.length === 0) throw new AppError(ErrorCode.PROVIDER_UNKNOWN, '没有可用的 LLM 模型，请在后台配置');
    const ordered = preferredId
      ? [...enabled.filter((m) => m.id === preferredId), ...enabled.filter((m) => m.id !== preferredId)]
      : enabled;
    const healthy: typeof ordered = [];
    const probes: typeof ordered = [];
    for (const m of ordered) {
      const s = await this.cb.state(m.providerId);
      if (s === 'open') continue;
      (s === 'half_open' ? probes : healthy).push(m);
    }
    const pick = healthy[0] ?? probes[0];
    if (!pick) throw new AppError(ErrorCode.PROVIDER_UNAVAILABLE, '所有 LLM provider 均处于熔断状态，请稍后重试');
    return this.llmManager.resolve(pick.id);
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
