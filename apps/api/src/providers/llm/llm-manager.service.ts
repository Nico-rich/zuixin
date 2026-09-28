import { Inject, Injectable, Logger, OnModuleInit, Optional } from '@nestjs/common';
import { AppError, ErrorCode } from '../../common/errors/app-error';
import { PrismaService } from '../../modules/prisma/prisma.service';
import { CryptoService } from '../../core/crypto/crypto.service';
import { ObservabilityService } from '../../core/tracing/observability.service';
import { assertProviderBaseUrlSafe } from '../../modules/security/provider-base-url.guard';
import { DnsResolver, nodeDnsResolver, SSRF_RESOLVER } from '../../modules/security/ssrf-guard';
import { LLMProvider } from './llm.types';
import { OpenAICompatibleAdapter } from './adapters/openai-compatible.adapter';
import { MockLLMAdapter } from './adapters/mock.adapter';
import { MockRouterAdapter } from './adapters/mock-router.adapter';
import { ProviderDegradationTracker, ProviderDegradedRecorder } from '../provider-degradation';

export interface ResolvedLLM {
  providerId: string; providerName: string;
  modelId: string; apiModelId: string;
  adapter: LLMProvider; timeoutMs: number;
  /** models.capabilities 声明（如 functionCalling: false 表示不支持工具调用） */
  capabilities: Record<string, unknown>;
}

@Injectable()
export class LLMManagerService implements OnModuleInit {
  private readonly logger = new Logger('LLMManager');
  private providers = new Map<string, LLMProvider>();
  /** M10-P2 D12：配置校验失败的 provider（degraded）——不阻断启动，但必须可观测 + 调用期明确报错 */
  private readonly degraded: ProviderDegradationTracker;

  // 显式 @Inject：vitest/esbuild 场景下装饰器元数据不可靠，显式注入最稳
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(CryptoService) private readonly crypto: CryptoService,
    // Pre-M9 F3-B：调用期 baseUrl 校验用的 DNS 解析器（@Optional 便于非 DI 单测直接构造）
    @Optional() @Inject(SSRF_RESOLVER) private readonly resolver: DnsResolver = nodeDnsResolver,
    // M10-P2 D12：provider_degraded 计数（@Optional：观测面缺失绝不影响 provider 加载；由 @Global TracingModule 提供）
    @Optional() @Inject(ObservabilityService) private readonly metrics?: ProviderDegradedRecorder,
  ) {
    // 构造函数体内初始化（字段初始化器先于参数属性赋值执行，此处 this.logger/metrics 才可用）
    this.degraded = new ProviderDegradationTracker('llm', this.logger, this.metrics);
  }

  async onModuleInit() { await this.refresh(); }

  /** 从 DB 重建所有 LLM provider 实例（后台变更后调用） */
  async refresh(): Promise<void> {
    const rows = await this.prisma.provider.findMany({ where: { type: 'llm', enabled: true } });
    const next = new Map<string, LLMProvider>();
    this.degraded.reset();
    for (const row of rows) {
      const apiKey = row.apiKeyEncrypted ? this.crypto.decrypt(row.apiKeyEncrypted) : '';
      try {
        next.set(row.id, this.buildAdapter(row.adapter, { baseUrl: row.baseUrl, apiKey, timeoutMs: row.timeoutMs }));
      } catch (err) {
        // M10-P2 D12：配置错误 → degraded（聚合告警 + 计数）；不阻断启动（见 provider-degradation.ts 取舍说明）
        this.degraded.markFailed(row, err);
      }
    }
    this.providers = next;
    this.logger.log(`LLM providers 已加载: ${this.providers.size} 个`);
    await this.degraded.report();
  }

  /** 按 modelId 解析出可调用的组合（provider + adapter + api_model_id） */
  async resolve(modelId: string): Promise<ResolvedLLM> {
    const model = await this.prisma.model.findUnique({ where: { id: modelId }, include: { provider: true } });
    if (!model || !model.enabled || !model.provider.enabled) throw new Error(`模型不可用: ${modelId}`);
    // Pre-M9 F3-B：调用前按"当前"baseUrl 重跑 SSRF 判定（fail-closed；mock adapter 跳过）
    await assertProviderBaseUrlSafe({
      providerId: model.providerId, providerName: model.provider.name,
      adapter: model.provider.adapter, baseUrl: model.provider.baseUrl, resolver: this.resolver,
    });
    const adapter = this.providers.get(model.providerId);
    // M10-P2 D12：未加载 = 配置校验失败（degraded）或该 provider 在刷新窗口内——对外必须是
    // PROVIDER_CONFIG_INVALID（明确错误码 + 原因），绝不裸 500（旧行为：`throw new Error(...)`）也绝不静默跳过
    if (!adapter) throw new AppError(ErrorCode.PROVIDER_CONFIG_INVALID, this.notLoadedMessage(model.provider.name, model.providerId));
    return {
      providerId: model.providerId, providerName: model.provider.name,
      modelId: model.id, apiModelId: model.apiModelId,
      adapter, timeoutMs: model.provider.timeoutMs,
      capabilities: (model.capabilities ?? {}) as Record<string, unknown>,
    };
  }

  getProvider(providerId: string): LLMProvider | undefined { return this.providers.get(providerId); }

  /** degraded 原因归因（配置校验失败时把真实原因带给调用方；缺失则说明是未加载的其它情形） */
  private notLoadedMessage(name: string, providerId: string): string {
    const reason = this.degraded.reasonOf(providerId);
    return reason
      ? `provider 配置无效（启动校验失败，degraded）: ${name}（${providerId}）：${reason}`
      : `provider 未加载: ${name}（${providerId}）`;
  }

  private buildAdapter(name: string, cfg: { baseUrl: string; apiKey: string; timeoutMs: number }): LLMProvider {
    switch (name) {
      case 'openai-compatible': return new OpenAICompatibleAdapter(cfg);
      case 'mock': return new MockLLMAdapter({ timeoutMs: cfg.timeoutMs }, Number(process.env.MOCK_DELAY_MS ?? 20));
      case 'mock-router': return new MockRouterAdapter();
      default: throw new Error(`未知 LLM adapter: ${name}`);
    }
  }
}
