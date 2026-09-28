import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { DiscoveryService } from '@nestjs/core';
import { Worker } from 'bullmq';
import { WorkerHost } from '@nestjs/bullmq';
import { LifecycleRegistry, ShutdownStep } from './lifecycle-registry';

/**
 * Pre-M9 G3：停机参与者（duck-typed 注册，避免"写了钩子但没接线"）。
 *
 * 参与者只需实现 `onLifecycleStep(step)`（可选实现），无需在本模块登记：
 * - 处理器（AgentRun / Workflow / Scheduler）在 'finalizeLeases' 释放 lease、中止在途执行；
 * 阶段顺序由 LifecycleRegistry 保证，参与者自身必须幂等（Nest 的 onApplicationShutdown 也会调用同一实现）。
 */
export interface LifecycleParticipant {
  onLifecycleStep(step: ShutdownStep): Promise<void> | void;
}

@Injectable()
export class LifecycleParticipantsService implements OnModuleInit {
  private readonly logger = new Logger('LifecycleParticipants');

  constructor(
    // 显式 @Inject：vitest/esbuild 不产出 design:paramtypes（emitDecoratorMetadata 由 tsc 提供），
    // 隐式类型注入在测试运行时会注入 undefined（AppModule 直接启动失败）
    @Inject(DiscoveryService) private readonly discovery: DiscoveryService,
    @Inject(LifecycleRegistry) private readonly lifecycle: LifecycleRegistry,
  ) {}

  onModuleInit(): void {
    for (const step of ['finalizeLeases'] as const) {
      this.lifecycle.register(step, `participants:${step}`, async () => {
        const failures: string[] = [];
        for (const p of this.participants()) {
          try {
            await p.onLifecycleStep(step);
          } catch (err) {
            failures.push(`${(p as object).constructor?.name ?? 'participant'}: ${(err as Error).message}`);
          }
        }
        if (failures.length) throw new Error(failures.join('; '));
      });
    }
  }

  private participants(): LifecycleParticipant[] {
    return this.discovery.getProviders()
      .map((w) => w.instance as Partial<LifecycleParticipant> | undefined)
      .filter((i): i is LifecycleParticipant => !!i && typeof i.onLifecycleStep === 'function')
      .filter((i) => i !== (this as unknown as LifecycleParticipant));
  }
}

/**
 * Pre-M9 G3：BullMQ Worker 生命周期（pause 停认领 / close 等在途收尾）。
 * 通过 DiscoveryService 找到所有 WorkerHost 实例（无需每个处理器手工登记），
 * `worker.pause(true)` 立即返回（不等在途 job），`worker.close()` 等当前 active job 自然结束（非 force 强杀）。
 */
@Injectable()
export class BullWorkerLifecycleService implements OnModuleInit {
  private readonly logger = new Logger('BullWorkerLifecycle');

  constructor(
    // 显式 @Inject：vitest/esbuild 不产出 design:paramtypes（emitDecoratorMetadata 由 tsc 提供），
    // 隐式类型注入在测试运行时会注入 undefined（AppModule 直接启动失败）
    @Inject(DiscoveryService) private readonly discovery: DiscoveryService,
    @Inject(LifecycleRegistry) private readonly lifecycle: LifecycleRegistry,
  ) {}

  onModuleInit(): void {
    this.lifecycle.register('stopClaim', 'bullmq:pause', async () => {
      for (const w of this.workers()) {
        await w.pause(true).catch((err) => this.logger.warn(`worker.pause 失败（继续）: ${(err as Error).message}`));
      }
      this.logger.log(`BullMQ worker 已暂停认领（${this.workers().length} 个）`);
    });
    this.lifecycle.register('closeBullmq', 'bullmq:close', async () => {
      for (const w of this.workers()) {
        await w.close().catch((err) => this.logger.warn(`worker.close 失败（继续）: ${(err as Error).message}`));
      }
      this.logger.log('BullMQ worker 已关闭（在途 job 已收尾）');
    });
  }

  /** 当前进程内全部 BullMQ Worker（WorkerHost.worker 在 onModuleInit 后才可读——此处为关机时读取） */
  private workers(): Worker[] {
    const out: Worker[] = [];
    for (const wrapper of this.discovery.getProviders()) {
      const instance = wrapper.instance as (WorkerHost & { worker?: Worker }) | undefined;
      if (!instance || !(instance instanceof WorkerHost)) continue;
      try {
        const w = instance.worker;
        if (w) out.push(w);
      } catch {
        // manualRegistration / 尚未初始化 → 无 worker 可管
      }
    }
    return out;
  }
}
