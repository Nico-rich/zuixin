import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../../modules/prisma/prisma.service';
import { CryptoService } from '../../core/crypto/crypto.service';
import { ImageProvider } from './image.types';
import { OpenAIImageAdapter } from './adapters/openai-image.adapter';
import { DashScopeImageAdapter } from './adapters/dashscope-image.adapter';
import { MockImageAdapter } from './adapters/mock-image.adapter';

export interface ResolvedImage {
  providerId: string; providerName: string;
  modelId: string; apiModelId: string;
  adapter: ImageProvider; timeoutMs: number;
}

@Injectable()
export class ImageManagerService implements OnModuleInit {
  private readonly logger = new Logger('ImageManager');
  private providers = new Map<string, ImageProvider>();

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(CryptoService) private readonly crypto: CryptoService,
  ) {}

  async onModuleInit() { await this.refresh(); }

  async refresh(): Promise<void> {
    const rows = await this.prisma.provider.findMany({ where: { type: 'image', enabled: true } });
    const next = new Map<string, ImageProvider>();
    for (const row of rows) {
      const apiKey = row.apiKeyEncrypted ? this.crypto.decrypt(row.apiKeyEncrypted) : '';
      try {
        next.set(row.id, this.buildAdapter(row.adapter, { baseUrl: row.baseUrl, apiKey, timeoutMs: row.timeoutMs }));
      } catch (err) {
        this.logger.error(`生图 provider ${row.name} 初始化失败: ${(err as Error).message}`);
      }
    }
    this.providers = next;
    this.logger.log(`Image providers 已加载: ${this.providers.size} 个`);
  }

  async resolve(modelId: string): Promise<ResolvedImage> {
    const model = await this.prisma.model.findUnique({ where: { id: modelId }, include: { provider: true } });
    if (!model || !model.enabled || !model.provider.enabled) throw new Error(`生图模型不可用: ${modelId}`);
    const adapter = this.providers.get(model.providerId);
    if (!adapter) throw new Error(`生图 provider 未加载: ${model.providerId}`);
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
        return new DashScopeImageAdapter({ baseUrl: cfg.baseUrl, apiKey: cfg.apiKey });
      case 'mock-image':
        return new MockImageAdapter();
      default:
        throw new Error(`未知生图 adapter: ${name}`);
    }
  }
}
