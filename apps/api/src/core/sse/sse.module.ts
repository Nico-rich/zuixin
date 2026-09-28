import { Global, Module } from '@nestjs/common';
import { EventsModule } from '../events/events.module';
import { SseRegistryService } from './sse-registry.service';
import { TaskChannelRelayService } from './task-channel-relay.service';

/**
 * Pre-M9 G3：SSE 连接纳管（全局单例——SSE 端点分布在 chat / agent-runs 等多个模块）。
 * M10-P13：新增 task 通道 → SSE 转发器（订阅 Redis `task`，按 owner 路由到已注册连接）。
 * EventsModule 为 @Global（同一模块实例 → EventBusService 与应用其余部分共享单例），此处显式导入只为模块自足。
 */
@Global()
@Module({
  imports: [EventsModule],
  providers: [SseRegistryService, TaskChannelRelayService],
  exports: [SseRegistryService, TaskChannelRelayService],
})
export class SseModule {}
