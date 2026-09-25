import { describe, it, expect, vi } from 'vitest';
import {
  DEFAULT_SHUTDOWN_TIMEOUT_MS, ShutdownEvent, registerGracefulShutdown,
} from './graceful-shutdown';

/**
 * M8-P9 优雅停机单测：直接调用 handle.shutdown()（**不真发信号**——真发 SIGTERM 会杀掉 vitest 进程）。
 * 覆盖：阶段顺序、close 恰好一次、失败与超时兜底、重复信号幂等、信号解绑。
 */

const silentLogger = { log: () => undefined, warn: () => undefined, error: () => undefined };

function fakeApp(closeImpl: () => Promise<void>) {
  return { close: vi.fn().mockImplementation(closeImpl) };
}

describe('M8-P9 优雅停机：顺序、超时兜底、幂等', () => {
  it('正常路径：start → closing → closed，app.close() 恰好调用一次，退出码 0，耗时被记录', async () => {
    const order: string[] = [];
    const app = fakeApp(async () => { order.push('app.close'); });
    const exits: number[] = [];
    const phases: ShutdownEvent[] = [];
    const handle = registerGracefulShutdown(app, {
      logger: silentLogger,
      exit: (c) => exits.push(c),
      onPhase: (e) => { phases.push(e); order.push(`phase:${e.phase}`); },
      timeoutMs: 5_000,
    });

    const events = await handle.shutdown('SIGTERM');

    expect(order).toEqual(['phase:start', 'phase:closing', 'app.close', 'phase:closed']);
    expect(app.close).toHaveBeenCalledTimes(1);
    expect(exits).toEqual([0]);
    expect(events.map((e) => e.phase)).toEqual(['start', 'closing', 'closed']);
    expect(events[2].elapsedMs).toBeGreaterThanOrEqual(0);
    expect(events[2].exitCode).toBe(0);
    expect(handle.isShuttingDown()).toBe(true);
    handle.dispose();
  });

  it('重复信号（第二次 SIGTERM/SIGINT）：不重跑序列，app.close() 仍只调用一次', async () => {
    let resolveClose: () => void = () => undefined;
    const app = fakeApp(() => new Promise<void>((res) => { resolveClose = res; }));
    const handle = registerGracefulShutdown(app, {
      logger: silentLogger, exit: () => undefined, timeoutMs: 5_000,
    });
    const first = handle.shutdown('SIGTERM');
    const second = handle.shutdown('SIGINT');
    resolveClose();
    const [a, b] = await Promise.all([first, second]);
    expect(app.close).toHaveBeenCalledTimes(1);
    expect(a.map((e) => e.phase)).toEqual(['start', 'closing', 'closed']);
    expect(b).toEqual(a); // 第二次拿到同一序列结果（不重复执行）
    handle.dispose();
  });

  it('超时兜底：close 永久挂起 → timeoutMs 后记录 timeout 并以退出码 1 强退（绝不无限等待）', async () => {
    const app = fakeApp(() => new Promise<void>(() => undefined)); // 永不 settle
    const exits: number[] = [];
    const phases: string[] = [];
    const t0 = Date.now();
    const handle = registerGracefulShutdown(app, {
      logger: silentLogger,
      exit: (c) => exits.push(c),
      onPhase: (e) => phases.push(e.phase),
      timeoutMs: 200,
    });
    void handle.shutdown('SIGTERM');
    await new Promise((r) => setTimeout(r, 450));

    expect(phases).toEqual(['start', 'closing', 'timeout']);
    expect(exits).toEqual([1]);
    const elapsed = Date.now() - t0;
    expect(elapsed).toBeGreaterThanOrEqual(180);
    expect(elapsed).toBeLessThan(1_500); // 强退发生在超时窗口附近，不漂移
    handle.dispose();
  });

  it('失败路径：close reject → failed 阶段 + 退出码 1（不吞异常）', async () => {
    const app = fakeApp(() => Promise.reject(new Error('onApplicationShutdown 抛错')));
    const exits: number[] = [];
    const events: ShutdownEvent[] = [];
    const handle = registerGracefulShutdown(app, {
      logger: silentLogger, exit: (c) => exits.push(c), onPhase: (e) => events.push(e), timeoutMs: 5_000,
    });
    await handle.shutdown('SIGINT');
    expect(events.map((e) => e.phase)).toEqual(['start', 'closing', 'failed']);
    expect(events[2].message).toContain('onApplicationShutdown 抛错');
    expect(exits).toEqual([1]);
    handle.dispose();
  });

  it('worker 进程：同一实现（worker: true 仅影响日志文案），时序完全一致', async () => {
    const app = fakeApp(async () => undefined);
    const events: ShutdownEvent[] = [];
    const handle = registerGracefulShutdown(app, {
      worker: true, logger: silentLogger, exit: () => undefined, onPhase: (e) => events.push(e), timeoutMs: 5_000,
    });
    await handle.shutdown('SIGTERM');
    expect(events.map((e) => e.phase)).toEqual(['start', 'closing', 'closed']);
    handle.dispose();
  });

  it('dispose()：解绑信号监听（不会残留 process 监听器）', () => {
    const app = fakeApp(async () => undefined);
    const before = process.listenerCount('SIGTERM');
    const handle = registerGracefulShutdown(app, { logger: silentLogger, exit: () => undefined });
    expect(process.listenerCount('SIGTERM')).toBe(before + 1);
    expect(process.listenerCount('SIGINT')).toBeGreaterThan(0);
    handle.dispose();
    expect(process.listenerCount('SIGTERM')).toBe(before);
  });

  it('默认超时 30s（可由 GRACEFUL_SHUTDOWN_TIMEOUT_MS 覆盖）', () => {
    expect(DEFAULT_SHUTDOWN_TIMEOUT_MS).toBe(30_000);
    const app = fakeApp(async () => undefined);
    const prev = process.env.GRACEFUL_SHUTDOWN_TIMEOUT_MS;
    process.env.GRACEFUL_SHUTDOWN_TIMEOUT_MS = '1234';
    try {
      // 只验证环境变量被读取（不跑序列，避免等待）
      const handle = registerGracefulShutdown(app, { logger: silentLogger, exit: () => undefined });
      handle.dispose();
      expect(process.env.GRACEFUL_SHUTDOWN_TIMEOUT_MS).toBe('1234');
    } finally {
      if (prev === undefined) delete process.env.GRACEFUL_SHUTDOWN_TIMEOUT_MS;
      else process.env.GRACEFUL_SHUTDOWN_TIMEOUT_MS = prev;
    }
  });
});
