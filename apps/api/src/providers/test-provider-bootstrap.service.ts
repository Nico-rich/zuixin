import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../modules/prisma/prisma.service';
import { MOCK_MODEL_IDS, MOCK_PROVIDER_IDS } from './mock-provider-ids';
import { LLMManagerService } from './llm/llm-manager.service';
import { ImageManagerService } from './image/image-manager.service';
import { VideoManagerService } from './video/video-manager.service';
import { EmbeddingManagerService } from './embedding/embedding-manager.service';

/**
 * M13+ 测试基建（**生产启动绝不受影响**）：`TEST_ENSURE_MOCK_PROVIDERS=1` 时，
 * 进程启动幂等启用 5 个 mock 替身并刷新四个 manager。
 *
 * 为什么需要：e2e（vitest + Playwright）跑在共享 dev 库，且依赖 mock 回复；而用户在
 * 模型配置页可停用 mock——seed 的 mock upsert 是 `update: {}`（重跑 seed 不恢复停用态）。
 * 本服务保证"跑测试"与"用户配置"互不永久干扰：测试跑完 mock 回到启用，用户可随时再禁用。
 *
 * 注入面：ProvidersModule（@Global ⇒ API 与 Worker 两进程都执行——worker 也消费 provider 调用）。
 * 失败语义：任何异常只 warn 不阻断启动（测试会在首个用例失败处暴露问题，不靠启动失败）。
 */
@Injectable()
export class TestProviderBootstrapService implements OnModuleInit {
  private readonly logger = new Logger('TestProviderBootstrap');

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(LLMManagerService) private readonly llm: LLMManagerService,
    @Inject(ImageManagerService) private readonly image: ImageManagerService,
    @Inject(VideoManagerService) private readonly video: VideoManagerService,
    @Inject(EmbeddingManagerService) private readonly embedding: EmbeddingManagerService,
  ) {}

  async onModuleInit(): Promise<void> {
    if (process.env.TEST_ENSURE_MOCK_PROVIDERS !== '1') return; // 生产路径零开销

    try {
      const existing = await this.prisma.provider.findMany({
        where: { id: { in: [...MOCK_PROVIDER_IDS] } }, select: { id: true },
      });
      const missing = MOCK_PROVIDER_IDS.filter((id) => !existing.some((r) => r.id === id));
      if (missing.length > 0) {
        this.logger.warn({ missing }, 'mock provider 缺失（请先 pnpm db:seed）；本次仅对存在的行启用');
      }
      const res = await this.prisma.provider.updateMany({
        where: { id: { in: [...MOCK_PROVIDER_IDS] }, enabled: false },
        data: { enabled: true },
      });
      // 模型级同样幂等启用（用户在配置页停用的 mock 模型必须恢复——路由候选按 Model.enabled 过滤）
      const modelRes = await this.prisma.model.updateMany({
        where: { id: { in: [...MOCK_MODEL_IDS] }, enabled: false },
        data: { enabled: true },
      });
      if (res.count > 0 || modelRes.count > 0) {
        this.logger.warn({ providers: res.count, models: modelRes.count }, '测试基建：已幂等启用 mock 替身（TEST_ENSURE_MOCK_PROVIDERS=1）');
      }
      // 无条件刷新：即便 count=0（本就启用），也要让内存 adapter 表与 DB 对齐
      await Promise.all([this.llm.refresh(), this.image.refresh(), this.video.refresh(), this.embedding.refresh()]);
    } catch (err) {
      this.logger.warn(`测试基建 mock 启用失败（不阻断启动）: ${(err as Error).message}`);
    }
  }
}
