import { Module } from '@nestjs/common';
import { RoutingService } from './routing.service';

/**
 * M9-P3：路由决策服务的**最小依赖面**（RoutingService 只需 Prisma + 熔断器，二者均 @Global）。
 * 供 ProvidersModule（LLM/媒体/embedding 四条调用链的注入点）复用同一实例——
 * 与 HTTP 面（ProviderRoutingModule，额外挂组织模块）共享同一定义，进程内只实例化一次。
 */
@Module({
  providers: [RoutingService],
  exports: [RoutingService],
})
export class RoutingServiceModule {}
