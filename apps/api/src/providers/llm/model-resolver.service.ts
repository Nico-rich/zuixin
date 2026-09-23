import { Inject, Injectable } from '@nestjs/common';
import { PrismaService } from '../../modules/prisma/prisma.service';
import { AppError, ErrorCode } from '../../common/errors/app-error';
import { LLMManagerService, ResolvedLLM } from './llm-manager.service';

@Injectable()
export class ModelResolverService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(LLMManagerService) private readonly llmManager: LLMManagerService,
  ) {}

  /** 默认 LLM 解析：routingPolicy.defaults.llm → isDefault → priority 最小；永不写死模型名 */
  async resolveDefaultLLM(): Promise<ResolvedLLM> {
    const settings = await this.prisma.systemSetting.findUnique({ where: { key: 'routingPolicy' } });
    const defaults = (settings?.value as { defaults?: Record<string, string | null> } | null)?.defaults;
    let modelId = defaults?.llm ?? null;
    if (!modelId) {
      const fallback = await this.prisma.model.findFirst({
        where: { type: 'llm', enabled: true },
        orderBy: [{ isDefault: 'desc' }, { priority: 'asc' }],
      });
      modelId = fallback?.id ?? null;
    }
    if (!modelId) throw new AppError(ErrorCode.PROVIDER_UNKNOWN, '没有可用的 LLM 模型，请在后台配置');
    return this.llmManager.resolve(modelId);
  }
}
