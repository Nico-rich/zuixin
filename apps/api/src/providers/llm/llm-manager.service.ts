import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../../modules/prisma/prisma.service';
import { CryptoService } from '../../core/crypto/crypto.service';
import { LLMProvider } from './llm.types';
import { OpenAICompatibleAdapter } from './adapters/openai-compatible.adapter';
import { MockLLMAdapter } from './adapters/mock.adapter';
import { MockRouterAdapter } from './adapters/mock-router.adapter';

export interface ResolvedLLM {
  providerId: string; providerName: string;
  modelId: string; apiModelId: string;
  adapter: LLMProvider; timeoutMs: number;
}

@Injectable()
export class LLMManagerService implements OnModuleInit {
  private readonly logger = new Logger('LLMManager');
  private providers = new Map<string, LLMProvider>();

  // 显式 @Inject：vitest/esbuild 场景下装饰器元数据不可靠，显式注入最稳
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(CryptoService) private readonly crypto: CryptoService,
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
    const adapter = this.providers.get(model.providerId);
    if (!adapter) throw new Error(`provider 未加载: ${model.providerId}`);
    return {
      providerId: model.providerId, providerName: model.provider.name,
      modelId: model.id, apiModelId: model.apiModelId,
      adapter, timeoutMs: model.provider.timeoutMs,
    };
  }

  getProvider(providerId: string): LLMProvider | undefined { return this.providers.get(providerId); }

  private buildAdapter(name: string, cfg: { baseUrl: string; apiKey: string; timeoutMs: number }): LLMProvider {
    switch (name) {
      case 'openai-compatible': return new OpenAICompatibleAdapter(cfg);
      case 'mock': return new MockLLMAdapter(Number(process.env.MOCK_DELAY_MS ?? 20));
      case 'mock-router': return new MockRouterAdapter();
      default: throw new Error(`未知 LLM adapter: ${name}`);
    }
  }
}
