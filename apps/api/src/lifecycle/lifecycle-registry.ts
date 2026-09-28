import { Injectable, Logger } from '@nestjs/common';

/**
 * Pre-M9 G3 优雅停机阶段（唯一权威顺序；API 进程与 Worker 进程共用）。
 *
 * 为何需要显式阶段：Nest 的 `app.close()` 内部顺序是
 *   callDestroyHook（onModuleDestroy：Prisma $disconnect / Redis disconnect）
 *   → callBeforeShutdownHook → dispose（HTTP adapter close）→ callShutdownHook（处理器释放 lease）
 * ——即**先断连接、后释放 lease**，与"在途工作收尾"的需求相反。因此本包把需要严格排序的动作
 * 提前到 `app.close()` **之前**执行；`app.close()` 只承担尾部（Redis/DB 释放等 Nest teardown）。
 *
 * 阶段语义（与 Pre-M9 G3 规格的 10 步一一对应见注释）：
 *  1. stopAcceptingHttp     —— 关闭 listen socket：不再接受新 HTTP 连接（已在途请求继续跑完）
 *  2/5. stopClaim           —— BullMQ worker.pause(true)：不再领取新 job（"停新队列 job" = "worker 停 claim"，
 *                              单进程内是同一操作：pause 之后既不入队新工作也不再认领）
 *  3. stopSseSubscriptions  —— SSE 进入 draining：拒绝新建订阅（503），已有流不受影响
 *  4a. drainSse             —— 关闭已建立的 SSE 流（先 end 干净 EOF，宽限后 destroy 兜底）
 *  4b. drainHttp            —— 有界等待在途 HTTP 连接归零
 *  6. finalizeLeases        —— 处理器释放 lease / 中止 Engine（参与者实现 onLifecycleStep）
 *  7/8. closeBullmq         —— worker.close()：等在途 job 自然收尾（非 force）后关闭 BullMQ
 *  9. closeRedis            —— 由 app.close() 的 onModuleDestroy 执行（本序列之后，结构性保证顺序）
 *  10. closeDatabase        —— 同上（PrismaService.$disconnect）
 */
export const SHUTDOWN_STEPS = [
  'stopAcceptingHttp',
  'stopClaim',
  'stopSseSubscriptions',
  'drainSse',
  'drainHttp',
  'finalizeLeases',
  'closeBullmq',
  'closeRedis',
  'closeDatabase',
] as const;

export type ShutdownStep = (typeof SHUTDOWN_STEPS)[number];

export interface LifecycleHandler {
  /** 阶段内唯一名（日志/断言用） */
  name: string;
  run: () => Promise<void> | void;
}

export interface LifecycleStepResult {
  step: ShutdownStep;
  ran: string[];
  failures: Array<{ name: string; message: string }>;
  timedOut: boolean;
  tookMs: number;
}

/**
 * 停机阶段处理器注册表（进程内单例）。
 * 参与者（SSE 注册表 / BullMQ worker 生命周期 / 处理器 lease 钩子）在 onModuleInit 注册，
 * graceful-shutdown 在关机时按 SHUTDOWN_STEPS 顺序驱动。
 */
@Injectable()
export class LifecycleRegistry {
  private readonly logger = new Logger('Lifecycle');
  private readonly handlers = new Map<ShutdownStep, LifecycleHandler[]>();

  register(step: ShutdownStep, name: string, run: () => Promise<void> | void): void {
    const list = this.handlers.get(step) ?? [];
    if (list.some((h) => h.name === name)) return; // 幂等：重复注册（模块重复加载）不重复执行
    list.push({ name, run });
    this.handlers.set(step, list);
  }

  handlersOf(step: ShutdownStep): LifecycleHandler[] {
    return [...(this.handlers.get(step) ?? [])];
  }

  /**
   * 执行单个阶段：顺序执行全部 handler（顺序 = 注册顺序），逐个 try/catch，
   * 阶段整体超时（timeoutMs）后放弃剩余 handler（记录 timedOut）——绝不无限等待。
   */
  async runStep(step: ShutdownStep, timeoutMs: number): Promise<LifecycleStepResult> {
    const startedAt = Date.now();
    const list = this.handlersOf(step);
    const ran: string[] = [];
    const failures: Array<{ name: string; message: string }> = [];
    let timedOut = false;
    if (list.length === 0) return { step, ran, failures, timedOut, tookMs: 0 };

    for (const h of list) {
      const remaining = timeoutMs - (Date.now() - startedAt);
      if (remaining <= 0) { timedOut = true; break; }
      try {
        let timer: NodeJS.Timeout | null = null;
        const guard = new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error(`阶段 ${step} 超时（>${remaining}ms）`)), remaining);
          timer.unref?.();
        });
        try {
          await Promise.race([Promise.resolve(h.run()), guard]);
          ran.push(h.name);
        } finally {
          if (timer) clearTimeout(timer);
        }
      } catch (err) {
        const message = (err as Error)?.message ?? String(err);
        failures.push({ name: h.name, message });
        if (message.includes('超时')) timedOut = true;
        this.logger.warn(`停机阶段 ${step}/${h.name} 未完成：${message}（继续后续阶段，绝不挂住发布）`);
      }
    }
    const tookMs = Date.now() - startedAt;
    if (tookMs > 0) this.logger.log(`停机阶段 ${step} 完成（${tookMs}ms，handlers=${ran.length}/${list.length}）`);
    return { step, ran, failures, timedOut, tookMs };
  }
}
// 模块定义在 lifecycle.module.ts（本文件保持零依赖，避免 registry ↔ participants 循环 import）
