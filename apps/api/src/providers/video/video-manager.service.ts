import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../../modules/prisma/prisma.service';
import { CryptoService } from '../../core/crypto/crypto.service';
import { VideoProvider } from './video.types';
import { DashScopeVideoAdapter } from './adapters/dashscope-video.adapter';
import { MockVideoAdapter } from './adapters/mock-video.adapter';

export interface ResolvedVideo {
  providerId: string; providerName: string;
  modelId: string; apiModelId: string;
  adapter: VideoProvider; timeoutMs: number;
  /** models.capabilities 声明（支持时长/比例/分辨率/参考图等），参数校验用 */
  capabilities: Record<string, unknown>;
}

@Injectable()
export class VideoManagerService implements OnModuleInit {
  private readonly logger = new Logger('VideoManager');
  private providers = new Map<string, VideoProvider>();

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(CryptoService) private readonly crypto: CryptoService,
  ) {}

  async onModuleInit() { await this.refresh(); }

  async refresh(): Promise<void> {
    const rows = await this.prisma.provider.findMany({ where: { type: 'video', enabled: true } });
    const next = new Map<string, VideoProvider>();
    for (const row of rows) {
      const apiKey = row.apiKeyEncrypted ? this.crypto.decrypt(row.apiKeyEncrypted) : '';
      try {
        next.set(row.id, this.buildAdapter(row.adapter, { baseUrl: row.baseUrl, apiKey, timeoutMs: row.timeoutMs }));
      } catch (err) {
        this.logger.error(`视频 provider ${row.name} 初始化失败: ${(err as Error).message}`);
      }
    }
    this.providers = next;
    this.logger.log(`Video providers 已加载: ${this.providers.size} 个`);
  }

  async resolve(modelId: string): Promise<ResolvedVideo> {
    const model = await this.prisma.model.findUnique({ where: { id: modelId }, include: { provider: true } });
    if (!model || !model.enabled || !model.provider.enabled) throw new Error(`视频模型不可用: ${modelId}`);
    const adapter = this.providers.get(model.providerId);
    if (!adapter) throw new Error(`视频 provider 未加载: ${model.providerId}`);
    return {
      providerId: model.providerId, providerName: model.provider.name,
      modelId: model.id, apiModelId: model.apiModelId,
      adapter, timeoutMs: model.provider.timeoutMs,
      capabilities: (model.capabilities ?? {}) as Record<string, unknown>,
    };
  }

  private buildAdapter(name: string, cfg: { baseUrl: string; apiKey: string; timeoutMs: number }): VideoProvider {
    switch (name) {
      case 'dashscope-video':
        return new DashScopeVideoAdapter({ baseUrl: cfg.baseUrl, apiKey: cfg.apiKey });
      case 'mock-video':
        return new MockVideoAdapter();
      default:
        throw new Error(`未知视频 adapter: ${name}`);
    }
  }
}
