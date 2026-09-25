import { Inject, Injectable, Logger } from '@nestjs/common';
import { Prisma, ProviderCapability } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { declaresCapabilityKey, modelSupports } from './capability-match';
import { ROUTING_CAPABILITIES, RoutingCapability } from './provider-routing.types';

export interface SyncResult {
  providers: number;      // 参与同步的 provider 数
  capabilities: number;   // 同步后有效能力行数
  upserted: number;
  removed: number;        // 数据已不支持（模型停用/删除）而清理掉的行
}

/**
 * M8-P7 Provider 能力目录：**从真实 Provider/Model 数据派生**（不手工臆造能力）。
 * `syncFromProviders()` 幂等重建：命中即 upsert，模型全部停用/删除的能力行清理。
 * 派生规则与 route() 的匹配规则同源（capability-match.ts），避免“声明能路由、实际选不出模型”。
 */
@Injectable()
export class ProviderCapabilitiesService {
  private readonly logger = new Logger('ProviderCapabilities');

  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  async syncFromProviders(): Promise<SyncResult> {
    const [providers, existing] = await Promise.all([
      this.prisma.provider.findMany({ include: { models: true }, orderBy: { id: 'asc' } }),
      this.prisma.providerCapability.findMany({ select: { id: true, providerId: true, capability: true } }),
    ]);

    const keep = new Set<string>();
    let upserted = 0;

    for (const provider of providers) {
      for (const capability of ROUTING_CAPABILITIES) {
        const models = provider.models.filter((m) => modelSupports(m, capability));
        if (models.length === 0) continue;
        keep.add(rowKey(provider.id, capability));

        const modelIds = models.map((m) => m.id);
        const contextWindow = models.reduce<number | null>(
          (max, m) => (m.contextWindow != null && (max == null || m.contextWindow > max) ? m.contextWindow : max), null,
        );
        const features = {
          modelCount: models.length,
          declared: models.some((m) => declaresCapabilityKey(m.capabilities, capability)),
          modelNames: models.map((m) => m.name),
        } satisfies Prisma.InputJsonObject;

        await this.prisma.providerCapability.upsert({
          where: { providerId_capability: { providerId: provider.id, capability } },
          create: {
            providerId: provider.id, capability, modelIds: modelIds as Prisma.InputJsonValue,
            contextWindow, features,
          },
          update: { modelIds: modelIds as Prisma.InputJsonValue, contextWindow, features },
        });
        upserted += 1;
      }
    }

    const stale = existing.filter((row) => !keep.has(rowKey(row.providerId, row.capability)));
    if (stale.length) {
      await this.prisma.providerCapability.deleteMany({ where: { id: { in: stale.map((s) => s.id) } } });
    }
    const result: SyncResult = {
      providers: providers.length, capabilities: keep.size, upserted, removed: stale.length,
    };
    this.logger.log(result, '能力目录已从 Provider/Model 数据重建');
    return result;
  }

  async list(filter: { capability?: string; providerId?: string } = {}): Promise<ProviderCapability[]> {
    return this.prisma.providerCapability.findMany({
      where: {
        ...(filter.capability ? { capability: filter.capability } : {}),
        ...(filter.providerId ? { providerId: filter.providerId } : {}),
      },
      orderBy: [{ providerId: 'asc' }, { capability: 'asc' }],
    });
  }
}

function rowKey(providerId: string, capability: RoutingCapability | string): string {
  return `${providerId}::${capability}`;
}
