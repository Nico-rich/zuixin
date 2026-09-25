import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../../modules/prisma/prisma.service';
import { CryptoService } from '../../core/crypto/crypto.service';
import { AppError, ErrorCode } from '../../common/errors/app-error';
import { EmbeddingProvider } from './embedding.types';
import { MockEmbeddingProvider } from './adapters/mock-embedding.adapter';
import { OpenAIEmbeddingProvider } from './adapters/openai-embedding.adapter';

export interface ResolvedEmbedding {
  providerId: string; providerName: string;
  modelId: string; apiModelId: string;
  provider: EmbeddingProvider; dimensions: number;
}

@Injectable()
export class EmbeddingManagerService implements OnModuleInit {
  private readonly logger = new Logger('EmbeddingManager');
  private providers = new Map<string, EmbeddingProvider>();

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(CryptoService) private readonly crypto: CryptoService,
  ) {}

  async onModuleInit() { await this.refresh(); }

  async refresh(): Promise<void> {
    const rows = await this.prisma.provider.findMany({ where: { type: 'embedding', enabled: true } });
    const next = new Map<string, EmbeddingProvider>();
    for (const row of rows) {
      const apiKey = row.apiKeyEncrypted ? this.crypto.decrypt(row.apiKeyEncrypted) : '';
      try {
        next.set(row.id, this.buildAdapter(row.adapter, row.baseUrl, apiKey, row.timeoutMs));
      } catch (err) {
        this.logger.error(`embedding provider ${row.name} 初始化失败: ${(err as Error).message}`);
      }
    }
    this.providers = next;
    this.logger.log(`Embedding providers 已加载: ${this.providers.size} 个`);
  }

  /** 默认 embedding 模型解析：routingPolicy.defaults.embedding → isDefault → priority */
  async resolveDefault(): Promise<ResolvedEmbedding> {
    const settings = await this.prisma.systemSetting.findUnique({ where: { key: 'routingPolicy' } });
    const defaults = (settings?.value as { defaults?: Record<string, string | null> } | null)?.defaults;
    let modelId = defaults?.embedding ?? null;
    if (!modelId) {
      const fallback = await this.prisma.model.findFirst({
        where: { type: 'embedding', enabled: true },
        orderBy: [{ isDefault: 'desc' }, { priority: 'asc' }],
      });
      modelId = fallback?.id ?? null;
    }
    if (!modelId) throw new AppError(ErrorCode.PROVIDER_UNKNOWN, '没有可用的 embedding 模型，请在后台配置');
    const model = await this.prisma.model.findUnique({ where: { id: modelId }, include: { provider: true } });
    if (!model || !model.enabled || !model.provider.enabled) throw new AppError(ErrorCode.PROVIDER_UNKNOWN, 'embedding 模型不可用');
    const provider = this.providers.get(model.providerId);
    if (!provider) throw new AppError(ErrorCode.PROVIDER_UNKNOWN, `embedding provider 未加载: ${model.providerId}`);
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
