/**
 * M11-P10 E-08：Worker 入口的生产守卫接线（**源码级断言**，与 m8-p9-reliability.e2e-spec.ts 里
 * 「main.ts / worker.ts 均已接线」同一手法——"写了模块没挂上"是这类 fail-fast 守卫最典型的失败形态：
 * 守卫本身有单测、main.ts 有接线，唯独 Worker 漏了，于是生产里 API 起不来而 Worker 照常消费队列）。
 *
 * 为什么不 import worker.ts 做行为断言：该模块在**导入时**就 `bootstrap()`（真实拉起 Nest + BullMQ），
 * 单测里导入等于起一个消费端进程。真正的行为验证放在 e2e/手工：用编译产物跑
 * `NODE_ENV=production node dist/src/worker.js`，占位密钥下必须是**退出码 1**且日志含守卫失败原因。
 * 本文件只钉住"接线存在且位置正确"这一层（守卫行为本身由 production-guards.spec.ts 覆盖）。
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const WORKER_SRC = readFileSync(resolve(process.cwd(), 'src/worker.ts'), 'utf8');

describe('worker.ts 启动路径（M11-P10 E-08 生产守卫接线）', () => {
  it('调用 assertProductionSafety()，且**早于** Nest 容器创建（绝不"先连上 DB/Redis 再检查配置"）', () => {
    const guardAt = WORKER_SRC.indexOf('assertProductionSafety()');
    const containerAt = WORKER_SRC.indexOf('NestFactory.createApplicationContext');
    expect(guardAt).toBeGreaterThan(-1);
    expect(containerAt).toBeGreaterThan(-1);
    expect(guardAt).toBeLessThan(containerAt);
  });

  it('守卫与 API 同源：从 modules/security/production-guards 导入（不在 Worker 里另写一份）', () => {
    expect(WORKER_SRC).toContain("import { assertProductionSafety } from './modules/security/production-guards';");
  });

  it('守卫调用是无条件语句（不被 if/env 判断包裹，否则等于没接线）', () => {
    // 形如 `  assertProductionSafety();` 的独立一行；带 `if`/`&&`/`&&` 前缀的实现会被这条拦下
    expect(/\n\s*assertProductionSafety\(\);\s*\n/.test(WORKER_SRC)).toBe(true);
  });

  it('启动失败（含守卫 fail-fast）显式非零退出，不留"半启动"的消费端进程', () => {
    expect(WORKER_SRC).toContain('bootstrap().catch(');
    expect(WORKER_SRC).toMatch(/process\.exit\(1\)/);
  });

  it('M8-P9 优雅停机接线未被破坏（既有源码级断言：worker 侧必须带 { worker: true }）', () => {
    expect(WORKER_SRC).toContain('registerGracefulShutdown(app, { worker: true })');
  });
});
