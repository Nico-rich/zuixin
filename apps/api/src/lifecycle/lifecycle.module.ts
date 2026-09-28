import { Global, Module } from '@nestjs/common';
import { DiscoveryModule } from '@nestjs/core';
import { LifecycleRegistry } from './lifecycle-registry';
import { BullWorkerLifecycleService, LifecycleParticipantsService } from './lifecycle-participants.service';

/**
 * Pre-M9 G3 生命周期模块（**独立文件**，防止循环 import）：
 * `lifecycle-registry.ts` 只放纯逻辑（SHUTDOWN_STEPS / LifecycleRegistry），参与者文件只依赖注册表（单向）；
 * 若把 @Module 定义留在 registry 文件里，则 registry → participants → registry 形成环，
 * 环内 `LifecycleRegistry` 在装饰器求值时尚未初始化 → `design:paramtypes` 记录 undefined →
 * Nest 注入 undefined → `onModuleInit` 崩溃（AppModule 无法启动）。
 */
@Global()
@Module({
  imports: [DiscoveryModule],
  providers: [LifecycleRegistry, LifecycleParticipantsService, BullWorkerLifecycleService],
  exports: [LifecycleRegistry],
})
export class LifecycleModule {}
