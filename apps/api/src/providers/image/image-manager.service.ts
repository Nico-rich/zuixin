import { Inject, Injectable, Logger, OnModuleInit, Optional } from '@nestjs/common';
import { AppError, ErrorCode } from '../../common/errors/app-error';
import { PrismaService } from '../../modules/prisma/prisma.service';
import { CryptoService } from '../../core/crypto/crypto.service';
import { ObservabilityService } from '../../core/tracing/observability.service';
import { assertProviderBaseUrlSafe } from '../../modules/security/provider-base-url.guard';
import { DnsResolver, nodeDnsResolver, SSRF_RESOLVER } from '../../modules/security/ssrf-guard';
import { ImageProvider } from './image.types';
import { OpenAIImageAdapter } from './adapters/openai-image.adapter';
import { DashScopeImageAdapter } from './adapters/dashscope-image.adapter';
import { MockImageAdapter } from './adapters/mock-image.adapter';
import { ProviderDegradationTracker, ProviderDegradedRecorder } from '../provider-degradation';

export interface ResolvedImage {
  providerId: string; providerName: string;
  modelId: string; apiModelId: string;
  adapter: ImageProvider; timeoutMs: number;
}

@Injectable()
export class ImageManagerService implements OnModuleInit {
  private readonly logger = new Logger('ImageManager');
  private providers = new Map<string, ImageProvider>();
  /** M10-P2 D12：配置校验失败的 provider（degraded）——不阻断启动，但可观测 + 调用期明确报错 */
  private readonly degraded: ProviderDegradationTracker;

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(CryptoService) private readonly crypto: CryptoService,
    // Pre-M9 F3-B：调用期 baseUrl 校验用的 DNS 解析器
    @Optional() @Inject(SSRF_RESOLVER) private readonly resolver: DnsResolver = nodeDnsResolver,
    // M10-P2 D12：provider_degraded 计数（@Optional：观测缺失不影响加载；@Global TracingModule 提供）
    @Optional() @Inject(ObservabilityService) private readonly metrics?: ProviderDegradedRecorder,
  ) {
    this.degraded = new ProviderDegradationTracker('image', this.logger, this.metrics);
  }

  async onModuleInit() { await this.refresh(); }

  async refresh(): Promise<void> {
    const rows = await this.prisma.provider.findMany({ where: { type: 'image', enabled: true } });
    const next = new Map<string, ImageProvider>();
    this.degraded.reset();
    for (const row of rows) {
      const apiKey = row.apiKeyEncrypted ? this.crypto.decrypt(row.apiKeyEncrypted) : '';
      try {
        next.set(row.id, this.buildAdapter(row.adapter, { baseUrl: row.baseUrl, apiKey, timeoutMs: row.timeoutMs }));
      } catch (err) {
        // M10-P2 D12：配置错误 → degraded（聚合告警 + 计数）；不阻断启动（见 provider-degradation.ts）
        this.degraded.markFailed(row, err);
      }
    }
    this.providers = next;
    this.logger.log(`Image providers 已加载: ${this.providers.size} 个`);
    await this.degraded.report();
  }

  /** 只读状态访问器（模型配置页/管理面）：loaded = 内存 adapter 已建；degradedReason = 加载失败归因（缺失即未加载的其它情形） */
  providerStatus(providerId: string): { loaded: boolean; degradedReason: string | null } {
    return { loaded: this.providers.has(providerId), degradedReason: this.degraded.reasonOf(providerId) ?? null };
  }

  async resolve(modelId: string): Promise<ResolvedImage> {
    const model = await this.prisma.model.findUnique({ where: { id: modelId }, include: { provider: true } });
    if (!model || !model.enabled || !model.provider.enabled) throw new Error(`生图模型不可用: ${modelId}`);
    // Pre-M9 F3-B：调用前按"当前"baseUrl 重跑 SSRF 判定（fail-closed；mock adapter 跳过）
    await assertProviderBaseUrlSafe({
      providerId: model.providerId, providerName: model.provider.name,
      adapter: model.provider.adapter, baseUrl: model.provider.baseUrl, resolver: this.resolver,
    });
    const adapter = this.providers.get(model.providerId);
    // M10-P2 D12：未加载（含配置校验失败）→ PROVIDER_CONFIG_INVALID（明确错误码 + 原因），绝不裸 500
    if (!adapter) {
      const reason = this.degraded.reasonOf(model.providerId);
      throw new AppError(
        ErrorCode.PROVIDER_CONFIG_INVALID,
        reason
          ? `生图 provider 配置无效（启动校验失败，degraded）: ${model.provider.name}（${model.providerId}）：${reason}`
          : `生图 provider 未加载: ${model.provider.name}（${model.providerId}）`,
      );
    }
    return {
      providerId: model.providerId, providerName: model.provider.name,
      modelId: model.id, apiModelId: model.apiModelId,
      adapter, timeoutMs: model.provider.timeoutMs,
    };
  }

  private buildAdapter(name: string, cfg: { baseUrl: string; apiKey: string; timeoutMs: number }): ImageProvider {
    switch (name) {
      // 智谱 CogView 的 v4 images API 与 OpenAI 同构，SDK + baseUrl 覆盖即可复用
      case 'openai-image':
      case 'zhipu-image':
        return new OpenAIImageAdapter(cfg);
      case 'dashscope-image':
        // Pre-M9 G5：透传 provider.timeoutMs 作为**单请求超时**（原实现丢弃该配置 →
        // 卡死连接只能等任务被清扫；默认 60s 与 schema provider.timeoutMs 默认一致）
        return new DashScopeImageAdapter({ baseUrl: cfg.baseUrl, apiKey: cfg.apiKey, timeoutMs: cfg.timeoutMs });
      case 'mock-image':
        return new MockImageAdapter();
      default:
        throw new Error(`未知生图 adapter: ${name}`);
    }
  }
}
