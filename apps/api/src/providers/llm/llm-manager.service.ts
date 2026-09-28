import { Inject, Injectable, Logger, OnModuleInit, Optional } from '@nestjs/common';
import { PrismaService } from '../../modules/prisma/prisma.service';
import { CryptoService } from '../../core/crypto/crypto.service';
import { assertProviderBaseUrlSafe } from '../../modules/security/provider-base-url.guard';
import { DnsResolver, nodeDnsResolver, SSRF_RESOLVER } from '../../modules/security/ssrf-guard';
import { LLMProvider } from './llm.types';
import { OpenAICompatibleAdapter } from './adapters/openai-compatible.adapter';
import { MockLLMAdapter } from './adapters/mock.adapter';
import { MockRouterAdapter } from './adapters/mock-router.adapter';

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

  // 显式 @Inject：vitest/esbuild 场景下装饰器元数据不可靠，显式注入最稳
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(CryptoService) private readonly crypto: CryptoService,
    // Pre-M9 F3-B：调用期 baseUrl 校验用的 DNS 解析器（@Optional 便于非 DI 单测直接构造）
    @Optional() @Inject(SSRF_RESOLVER) private readonly resolver: DnsResolver = nodeDnsResolver,
  ) {}

  async onModuleInit() { await this.refresh(); }

  /** 从 DB 重建所有 LLM provider 实例（后台变更后调用） */
  async refresh(): Promise<void> {
    const rows = await this.prisma.provider.findMany({ where: { type: 'llm', enabled: true } });
    const next = new Map<string, LLMProvider>();
    for (const row of rows) {
      const apiKey = row.apiKeyEncrypted ? this.crypto.decrypt(row.apiKeyEncrypted) : '';
      try {
        next.set(row.id, this.buildAdapter(row.adapter, { baseUrl: row.baseUrl, apiKey, timeoutMs: row.timeoutMs }));
      } catch (err) {
        this.logger.error(`provider ${row.name} 初始化失败: ${(err as Error).message}`);
      }
    }
    this.providers = next;
    this.logger.log(`LLM providers 已加载: ${this.providers.size} 个`);
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
    if (!adapter) throw new Error(`provider 未加载: ${model.providerId}`);
    return {
      providerId: model.providerId, providerName: model.provider.name,
      modelId: model.id, apiModelId: model.apiModelId,
      adapter, timeoutMs: model.provider.timeoutMs,
      capabilities: (model.capabilities ?? {}) as Record<string, unknown>,
    };
  }

  getProvider(providerId: string): LLMProvider | undefined { return this.providers.get(providerId); }

  private buildAdapter(name: string, cfg: { baseUrl: string; apiKey: string; timeoutMs: number }): LLMProvider {
    switch (name) {
      case 'openai-compatible': return new OpenAICompatibleAdapter(cfg);
      case 'mock': return new MockLLMAdapter({ timeoutMs: cfg.timeoutMs }, Number(process.env.MOCK_DELAY_MS ?? 20));
      case 'mock-router': return new MockRouterAdapter();
      default: throw new Error(`未知 LLM adapter: ${name}`);
    }
  }
}
