import { Global, Module } from '@nestjs/common';
import { LLMManagerService } from './llm/llm-manager.service';
import { ModelResolverService } from './llm/model-resolver.service';
import { ImageManagerService } from './image/image-manager.service';
import { VideoManagerService } from './video/video-manager.service';
import { EmbeddingManagerService } from './embedding/embedding-manager.service';
import { TestProviderBootstrapService } from './test-provider-bootstrap.service';
import { RoutingServiceModule } from '../modules/provider-routing/routing-service.module';

/**
 * Provider 访问层（@Global）。M9-P3：**provider 选择权收口**——
 * RoutingServiceModule 在此挂入，LLM（引擎）/ Image / Video / Embedding 四条链路
 * 共用同一 RoutingService 实例（决策输入全部为服务端事实，LLM 不参与 provider 选择）。
 * M13+：TestProviderBootstrapService（TEST_ENSURE_MOCK_PROVIDERS=1 时幂等启用 mock；
 * 生产环境变量不设则零开销）。@Global ⇒ API 与 Worker 两进程都执行。
 */
@Global()
@Module({
  imports: [RoutingServiceModule],
  providers: [
    LLMManagerService, ModelResolverService, ImageManagerService, VideoManagerService, EmbeddingManagerService,
    TestProviderBootstrapService,
  ],
  exports: [LLMManagerService, ModelResolverService, ImageManagerService, VideoManagerService, EmbeddingManagerService],
})
export class ProvidersModule {}
