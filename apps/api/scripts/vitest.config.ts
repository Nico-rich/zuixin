import { defineConfig } from 'vitest/config';

/**
 * M10-P9 运维脚本的单测配置。
 *
 * 为什么单独一个配置：仓库根 `apps/api/vitest.config.ts` 的 include 只覆盖
 * `test/**\/*.e2e-spec.ts` 与 `src/**\/*.spec.ts`（e2e 共享真实基础设施，串行跑）。
 * 运维脚本是**纯文件 + 纯函数**逻辑（参数解析、dump 解析、安全闸门、核对），
 * 不该被拖进 e2e 的串行队列，也不该改动别人拥有的 vitest.config.ts。
 *
 * 运行：`cd apps/api && npx vitest run --config scripts/vitest.config.ts`
 */
export default defineConfig({
  test: {
    root: __dirname,
    environment: 'node',
    globals: false,
    include: ['**/*.spec.ts'],
    testTimeout: 20000,
  },
});
