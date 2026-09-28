import { Inject, Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../modules/prisma/prisma.service';
import { LLMManagerService, ResolvedLLM } from './llm-manager.service';
import { ImageManagerService, ResolvedImage } from '../image/image-manager.service';
import { VideoManagerService, ResolvedVideo } from '../video/video-manager.service';
import { RoutingService } from '../../modules/provider-routing/routing.service';
import { CostBudget, RouteResult, RouteTarget } from '../../modules/provider-routing/provider-routing.types';

/** 媒体能力 → routingPolicy.defaults 的键（运营者偏好模型来源） */
const MEDIA_DEFAULTS_KEY = { image_generation: 'image', video_generation: 'video' } as const;

/**
 * LLM 回合路由句柄（M9-P3）：
 * - `resolved`：当前候选（首选）解析结果；
 * - `next()`：**换 provider 回退**——返回链上下一个候选的解析结果（链耗尽 → null）。
 *   与「同 provider 重试」（LLM_MAX_RETRIES，退避重试）是**两种不同语义**：
 *   重试 = 瞬时故障下再打同一个 provider；回退 = 该 provider 已被判定不行（熔断/持续失败），
 *   按服务端候选链换下一个 provider。二者的熔断计数都由调用方（Agent 引擎）写入，绝不双计。
 */
export interface LLMTurnRoute {
  resolved: ResolvedLLM;
  decisionId: string;
  /** 候选链（首选 + 回退，与审计同源） */
  chain: RouteTarget[];
  /** 切换下一候选（换 provider）；null = 回退链耗尽。不修改熔断计数（调用方是计数唯一写入者） */
  next(): Promise<ResolvedLLM | null>;
  /** 回退实际承载了本回合 → 审计行改写为实际 provider（reasonCode=fallback）；首选未变则空操作 */
  markUsed(): Promise<void>;
  /** 当前是否已切到回退候选 */
  isFallback(): boolean;
}

export interface LLMRouteRequest {
  organizationId?: string | null;
  runId?: string;
  taskId?: string;
  requestId?: string;
  /** 该回合需要工具调用能力（软偏好：命中优先，绝不硬过滤——能力降级语义由引擎裁决） */
  preferFunctionCalling?: boolean;
}

export interface MediaRouteRequest {
  capability: 'image_generation' | 'video_generation';
  organizationId?: string | null;
  runId?: string;
  taskId?: string;
  /** 成本预检预算（图片张数 / 视频秒数）——参与 ProviderPolicy 成本上限判定 */
  budget?: CostBudget;
}

@Injectable()
export class ModelResolverService {
  private readonly logger = new Logger('ModelResolver');

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(LLMManagerService) private readonly llmManager: LLMManagerService,
    @Inject(ImageManagerService) private readonly imageManager: ImageManagerService,
    @Inject(VideoManagerService) private readonly videoManager: VideoManagerService,
    // M9-P3：provider 选择权收口到 RoutingService（capability/组织策略/健康/延迟/成本/熔断排序）——
    // Pre-M9 G2 的「本服务自行判熔断」接线上移：熔断三态过滤在 RoutingService（open 剔除 / half_open 单飞探测）
    @Inject(RoutingService) private readonly routing: RoutingService,
  ) {}

  /**
   * LLM 回合路由（M9-P3 生产接线）：RoutingService.route() 决定 provider + 模型 + 回退链，
   * 再经 LLMManager 解析为可调用句柄（按 id 解析 + 调用期 SSRF 校验仍在 LLMManager 内，语义不变）。
   *
   * 决策输入全部是服务端事实：capability（text_generation；工具回合软偏好 function_calling）、
   * 组织策略（ProviderPolicy allow/deny/成本上限）、Provider.healthStatus、最近延迟采样、
   * 熔断三态、运营者偏好模型（routingPolicy.defaults.llm，只影响排序）。**LLM 绝不决定 provider。**
   */
  async resolveLLMRoute(req: LLMRouteRequest = {}): Promise<LLMTurnRoute> {
    const preferredModelId = await this.readDefaultModel('llm');
    const decision = await this.routing.route({
      capability: 'text_generation',
      organizationId: req.organizationId ?? null,
      runId: req.runId,
      taskId: req.taskId,
      requestId: req.requestId,
      preferredModelIds: preferredModelId ? [preferredModelId] : [],
      preferCapabilities: req.preferFunctionCalling ? ['function_calling'] : [],
    });

    let index = 0;
    return {
      resolved: await this.llmManager.resolve(decision.chain[0].modelId),
      decisionId: decision.decisionId,
      chain: decision.chain,
      isFallback: () => index > 0,
      next: async (): Promise<ResolvedLLM | null> => {
        index += 1;
        const target = decision.chain[index];
        if (!target) return null;
        // 解析失败（模型/provider 在决策后被停用）→ 由调用方按回退链耗尽处理（绝不静默沿用上一个）
        return this.llmManager.resolve(target.modelId);
      },
      markUsed: async (): Promise<void> => {
        const target = decision.chain[index];
        if (index > 0 && target) await this.routing.recordFallback(decision.decisionId, target);
      },
    };
  }

  /**
   * 媒体生成路由（M9-P3）：与 LLM 同一条 RoutingService 管道，capability 维度按类型
   * （image_generation / video_generation）。执行器用返回的 `invoke()` 按链回退调用
   * （不回退不可重试错误），决策审计与「实际使用的 provider」一致。
   */
  async resolveMediaRoute(req: MediaRouteRequest): Promise<RouteResult> {
    const defaultsKey = MEDIA_DEFAULTS_KEY[req.capability];
    const preferredModelId = await this.readDefaultModel(defaultsKey);
    return this.routing.route({
      capability: req.capability,
      organizationId: req.organizationId ?? null,
      runId: req.runId,
      taskId: req.taskId,
      budget: req.budget,
      preferredModelIds: preferredModelId ? [preferredModelId] : [],
    });
  }

  /**
   * 默认 LLM 解析（M9-P3：经 RoutingService 路由；返回首选）。
   * 熔断 open 的 provider 在路由层被剔除；全部候选不可用 → PROVIDER_UNAVAILABLE
   * （绝不静默打向已知故障 provider）。永不写死模型名。
   */
  async resolveDefaultLLM(): Promise<ResolvedLLM> {
    return (await this.resolveLLMRoute()).resolved;
  }

  /** 默认生图模型解析：经 RoutingService（image_generation 能力 + defaults.image 偏好） */
  async resolveDefaultImage(): Promise<ResolvedImage> {
    const route = await this.resolveMediaRoute({ capability: 'image_generation' });
    return this.imageManager.resolve(route.modelId);
  }

  /** 默认生视频模型解析：经 RoutingService（video_generation 能力 + defaults.video 偏好） */
  async resolveDefaultVideo(): Promise<ResolvedVideo> {
    const route = await this.resolveMediaRoute({ capability: 'video_generation' });
    return this.videoManager.resolve(route.modelId);
  }

  /** routingPolicy.defaults.<type>（运营者偏好模型；服务端事实，仅作排序偏好，绝不绕过策略/健康/熔断） */
  private async readDefaultModel(type: 'llm' | 'image' | 'video'): Promise<string | null> {
    const settings = await this.prisma.systemSetting.findUnique({ where: { key: 'routingPolicy' } });
    const defaults = (settings?.value as { defaults?: Record<string, string | null> } | null)?.defaults;
    return defaults?.[type] ?? null;
  }
}
