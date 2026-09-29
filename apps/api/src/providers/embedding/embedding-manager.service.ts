import { Inject, Injectable, Logger, OnModuleInit, Optional } from '@nestjs/common';
import { PrismaService } from '../../modules/prisma/prisma.service';
import { CryptoService } from '../../core/crypto/crypto.service';
import { AppError, ErrorCode } from '../../common/errors/app-error';
import { ObservabilityService } from '../../core/tracing/observability.service';
import { assertProviderBaseUrlSafe } from '../../modules/security/provider-base-url.guard';
import { DnsResolver, nodeDnsResolver, SSRF_RESOLVER } from '../../modules/security/ssrf-guard';
import { RoutingService } from '../../modules/provider-routing/routing.service';
import { EmbeddingProvider } from './embedding.types';
import { MockEmbeddingProvider } from './adapters/mock-embedding.adapter';
import { OpenAIEmbeddingProvider } from './adapters/openai-embedding.adapter';
import { ProviderDegradationTracker, ProviderDegradedRecorder } from '../provider-degradation';

export interface ResolvedEmbedding {
  providerId: string; providerName: string;
  modelId: string; apiModelId: string;
  provider: EmbeddingProvider; dimensions: number;
}

@Injectable()
export class EmbeddingManagerService implements OnModuleInit {
  private readonly logger = new Logger('EmbeddingManager');
  private providers = new Map<string, EmbeddingProvider>();
  /** M10-P2 D12：配置校验失败的 provider（degraded）——不阻断启动，但可观测 + 调用期明确报错 */
  private readonly degraded: ProviderDegradationTracker;

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(CryptoService) private readonly crypto: CryptoService,
    // M9-P3：provider 选择权收口到 RoutingService（capability/组织策略/健康/延迟/成本/熔断排序）
    @Inject(RoutingService) private readonly routing: RoutingService,
    // Pre-M9 F3-B：调用期 baseUrl 校验用的 DNS 解析器
    @Optional() @Inject(SSRF_RESOLVER) private readonly resolver: DnsResolver = nodeDnsResolver,
    // M10-P2 D12：provider_degraded 计数（@Optional：观测缺失不影响加载；@Global TracingModule 提供）
    @Optional() @Inject(ObservabilityService) private readonly metrics?: ProviderDegradedRecorder,
  ) {
    this.degraded = new ProviderDegradationTracker('embedding', this.logger, this.metrics);
  }

  async onModuleInit() { await this.refresh(); }

  async refresh(): Promise<void> {
    const rows = await this.prisma.provider.findMany({ where: { type: 'embedding', enabled: true } });
    const next = new Map<string, EmbeddingProvider>();
    this.degraded.reset();
    for (const row of rows) {
      const apiKey = row.apiKeyEncrypted ? this.crypto.decrypt(row.apiKeyEncrypted) : '';
      try {
        next.set(row.id, this.buildAdapter(row.adapter, row.baseUrl, apiKey, row.timeoutMs));
      } catch (err) {
        // M10-P2 D12：配置错误 → degraded（聚合告警 + 计数）；不阻断启动（见 provider-degradation.ts）
        this.degraded.markFailed(row, err);
      }
    }
    this.providers = next;
    this.logger.log(`Embedding providers 已加载: ${this.providers.size} 个`);
    await this.degraded.report();
  }

  /** 只读状态访问器（模型配置页/管理面）：loaded = 内存 adapter 已建；degradedReason = 加载失败归因（缺失即未加载的其它情形） */
  providerStatus(providerId: string): { loaded: boolean; degradedReason: string | null } {
    return { loaded: this.providers.has(providerId), degradedReason: this.degraded.reasonOf(providerId) ?? null };
  }

  /**
   * 默认 embedding 模型解析（M9-P3：与 LLM/媒体同一条 RoutingService 管道，capability=embedding）：
   * 组织策略/健康/延迟/成本/熔断事实排序；routingPolicy.defaults.embedding 仅作**偏好排序**（不做硬过滤）。
   * 无可用候选 → PROVIDER_UNAVAILABLE（路由层裁决并留审计），模型行缺失/停用 → PROVIDER_UNKNOWN。
   */
  async resolveDefault(): Promise<ResolvedEmbedding> {
    const settings = await this.prisma.systemSetting.findUnique({ where: { key: 'routingPolicy' } });
    const defaults = (settings?.value as { defaults?: Record<string, string | null> } | null)?.defaults;
    const preferredModelId = defaults?.embedding ?? null;
    const route = await this.routing.route({
      capability: 'embedding',
      preferredModelIds: preferredModelId ? [preferredModelId] : [],
    });
    const modelId: string = route.modelId;
    const model = await this.prisma.model.findUnique({ where: { id: modelId }, include: { provider: true } });
    if (!model || !model.enabled || !model.provider.enabled) throw new AppError(ErrorCode.PROVIDER_UNKNOWN, 'embedding 模型不可用');
    const provider = this.providers.get(model.providerId);
    // M10-P2 D12：未加载（含配置校验失败）→ PROVIDER_CONFIG_INVALID（明确错误码 + 原因），不再笼统 PROVIDER_UNKNOWN
    if (!provider) {
      const reason = this.degraded.reasonOf(model.providerId);
      throw new AppError(
        ErrorCode.PROVIDER_CONFIG_INVALID,
        reason
          ? `embedding provider 配置无效（启动校验失败，degraded）: ${model.provider.name}（${model.providerId}）：${reason}`
          : `embedding provider 未加载: ${model.provider.name}（${model.providerId}）`,
      );
    }
    // Pre-M9 F3-B：调用前按"当前"baseUrl 重跑 SSRF 判定（fail-closed；mock adapter 跳过）
    await assertProviderBaseUrlSafe({
      providerId: model.providerId, providerName: model.provider.name,
      adapter: model.provider.adapter, baseUrl: model.provider.baseUrl, resolver: this.resolver,
    });
    return {
      providerId: model.providerId, providerName: model.provider.name,
      modelId: model.id, apiModelId: model.apiModelId,
      provider, dimensions: provider.getDimensions(),
    };
  }

  private buildAdapter(adapter: string, baseUrl: string, apiKey: string, timeoutMs: number): EmbeddingProvider {
    switch (adapter) {
      case 'mock-embedding':
        // Pre-M9 P4：平台固定嵌入维度 1536（与 DocumentChunk.embedding vector(1536) + HNSW 索引一致；
        // 真实 adapter 必须产出同维度——混合维度无法建 ANN 索引）
        return new MockEmbeddingProvider(Number(process.env.MOCK_EMBEDDING_DIMS ?? 1536));
      case 'openai-embedding':
        return new OpenAIEmbeddingProvider({ baseUrl, apiKey, timeoutMs }, 'text-embedding-3-small', 1536);
      default:
        throw new Error(`未知 embedding adapter: ${adapter}`);
    }
  }
}
