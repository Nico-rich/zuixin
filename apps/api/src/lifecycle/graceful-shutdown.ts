import { INestApplicationContext, Logger, LoggerService } from '@nestjs/common';

/**
 * M8-P9 优雅停机（单文件模块，API 进程与 Worker 进程共用同一实现）。
 *
 * 目标：滚动发布 / 编排层驱逐（SIGTERM）时**不丢在途工作、不产生半写状态**，且**绝不无限等待**
 * （挂住的 onApplicationShutdown 会把发布卡死到 force kill，反而产生更多残留）。
 *
 * 时序（Nest 11 的真实行为，已核对 @nestjs/core@11.2.5 与 @nestjs/bullmq@11.0.5 源码）：
 *   1. `app.close()` → `callDestroyHook()`        —— onModuleDestroy（Prisma $disconnect / Redis disconnect）
 *   2. `app.close()` → `callBeforeShutdownHook()` —— beforeApplicationShutdown
 *   3. `app.close()` → `dispose()`                —— **HTTP server 关闭：停止接收新请求**（NestApplication 覆写）
 *   4. `app.close()` → `callShutdownHook()`       —— onApplicationShutdown，**按模块注册逆序**执行：
 *        4a. AgentRunProcessor / WorkflowProcessor / SchedulerProcessor（后注册的 worker 模块先跑）
 *            → 释放 lease / 中止 Engine / 等在途调度作业收尾；
 *        4b. BullExplorer（早注册的 BullModule）→ `worker.close()`：
 *            BullMQ 停止取新 job 并**等待当前 active job 自然结束**（非 force）。
 *   5. 进程退出（exit 0）。
 *
 * 因此"BullMQ Worker close 前等当前 job 结束"成立，且处理器有机会先释放 lease 让新 worker 接管。
 *
 * 超时兜底：`timeoutMs`（默认 30s）内未完成 → 记 error 日志 + 强制 `exit(1)`（编排层看得见失败，
 * 不会把 30s 当作"正常发布耗时"）。
 */

export type ShutdownPhase = 'start' | 'closing' | 'closed' | 'timeout' | 'failed';

export interface ShutdownEvent {
  phase: ShutdownPhase;
  /** 自停机开始（收到信号）的累计耗时 ms */
  elapsedMs: number;
  signal?: string;
  message?: string;
  /** 进程最终退出码（仅 closed/failed/timeout 有值） */
  exitCode?: number;
}

export interface GracefulShutdownOptions {
  /** worker 进程：日志文案区分（两者时序完全相同；worker 无 HTTP server，步骤 3 为空操作） */
  worker?: boolean;
  /** 超时兜底；默认 30_000ms（可用 GRACEFUL_SHUTDOWN_TIMEOUT_MS 覆盖） */
  timeoutMs?: number;
  /** 监听的信号，默认 SIGTERM + SIGINT */
  signals?: NodeJS.Signals[];
  /** 退出函数（测试注入替身；默认 process.exit） */
  exit?: (code: number) => void;
  /** 日志器（测试注入静默替身；默认 Nest Logger） */
  logger?: Pick<LoggerService, 'log' | 'warn' | 'error'>;
  /** 每个阶段回调（测试断言顺序用；生产不传） */
  onPhase?: (event: ShutdownEvent) => void;
}

export interface GracefulShutdownHandle {
  /** 触发停机（生产由信号触发；测试直接调用，不真发信号） */
  shutdown(signal?: string): Promise<ShutdownEvent[]>;
  isShuttingDown(): boolean;
  /** 解绑信号监听（测试卫生；生产不调用） */
  dispose(): void;
}

export const DEFAULT_SHUTDOWN_TIMEOUT_MS = 30_000;

function resolveTimeoutMs(explicit?: number): number {
  if (typeof explicit === 'number' && Number.isFinite(explicit) && explicit > 0) return explicit;
  const env = Number(process.env.GRACEFUL_SHUTDOWN_TIMEOUT_MS);
  return Number.isFinite(env) && env > 0 ? env : DEFAULT_SHUTDOWN_TIMEOUT_MS;
}

/**
 * 注册优雅停机（幂等：重复调用返回同一 handle；信号重复到达只执行一次序列）。
 * main.ts / worker.ts 各加一行即可，其余逻辑全部收敛在本文件。
 */
export function registerGracefulShutdown(
  app: Pick<INestApplicationContext, 'close'>,
  options: GracefulShutdownOptions = {},
): GracefulShutdownHandle {
  const logger: Pick<LoggerService, 'log' | 'warn' | 'error'> = options.logger ?? new Logger('GracefulShutdown');
  const exit = options.exit ?? ((code: number) => process.exit(code));
  const timeoutMs = resolveTimeoutMs(options.timeoutMs);
  const signals = options.signals ?? (['SIGTERM', 'SIGINT'] as NodeJS.Signals[]);
  const role = options.worker ? 'Worker' : 'API';

  const events: ShutdownEvent[] = [];
  let startedAt = 0;
  let started = false;
  let running: Promise<ShutdownEvent[]> | null = null;
  let forceTimer: NodeJS.Timeout | null = null;
  let finished = false;

  const emit = (e: ShutdownEvent) => {
    events.push(e);
    if (e.phase === 'start') logger.log(`[${role}] 收到 ${e.signal}，开始优雅停机（上限 ${timeoutMs}ms）`);
    else if (e.phase === 'closing') logger.log(`[${role}] 停止接收新请求/新任务，等待在途工作收尾（${e.elapsedMs}ms）`);
    else if (e.phase === 'closed') logger.log(`[${role}] 优雅停机完成，进程退出（${e.elapsedMs}ms）`);
    else if (e.phase === 'timeout') logger.error(`[${role}] 优雅停机超时（>${timeoutMs}ms），强制退出——请检查是否有钩子挂住`);
    else logger.error(`[${role}] 优雅停机失败：${e.message}（强制退出）`);
    options.onPhase?.(e);
  };

  const sequence = async (signal?: string): Promise<ShutdownEvent[]> => {
    startedAt = Date.now();
    finished = false;
    emit({ phase: 'start', elapsedMs: 0, signal });

    // 超时兜底：先武装再执行序列——序列任一 await 挂住都在 timeoutMs 后被强退
    forceTimer = setTimeout(() => {
      if (finished) return;
      finished = true;
      const ev: ShutdownEvent = { phase: 'timeout', elapsedMs: Date.now() - startedAt, exitCode: 1 };
      events.push(ev);
      logger.error(`[${role}] 优雅停机超时（>${timeoutMs}ms），强制退出——请检查是否有钩子挂住`);
      options.onPhase?.(ev);
      exit(1);
    }, timeoutMs);
    forceTimer.unref?.();

    try {
      emit({ phase: 'closing', elapsedMs: Date.now() - startedAt });
      // 一条 await 覆盖全部阶段：关 HTTP server → 处理器 onApplicationShutdown → BullMQ worker.close()
      // （BullMQ 非 force close 会等当前 active job 结束）→ onModuleDestroy（连接释放）
      await app.close();
      if (finished) return events; // 超时已强退（测试替身不会真退，这里显式短路）
      finished = true;
      if (forceTimer) clearTimeout(forceTimer);
      forceTimer = null;
      const ev: ShutdownEvent = { phase: 'closed', elapsedMs: Date.now() - startedAt, exitCode: 0 };
      emit(ev);
      exit(0);
    } catch (err) {
      if (finished) return events;
      finished = true;
      if (forceTimer) clearTimeout(forceTimer);
      forceTimer = null;
      emit({ phase: 'failed', elapsedMs: Date.now() - startedAt, message: (err as Error)?.message ?? String(err), exitCode: 1 });
      exit(1);
    }
    return events;
  };

  const shutdown = (signal?: string): Promise<ShutdownEvent[]> => {
    if (started) return running ?? Promise.resolve(events); // 幂等：第二次信号不再跑序列
    started = true;
    running = sequence(signal);
    return running;
  };

  const onSignal = (sig: NodeJS.Signals) => { void shutdown(sig); };
  for (const sig of signals) process.on(sig, onSignal);

  return {
    shutdown,
    isShuttingDown: () => started,
    dispose: () => {
      for (const sig of signals) process.off(sig, onSignal);
      if (forceTimer) clearTimeout(forceTimer);
      forceTimer = null;
    },
  };
}
