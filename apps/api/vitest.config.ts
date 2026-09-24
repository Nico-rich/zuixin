import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

export default defineConfig({
  test: {
    environment: 'node',
    globals: false,
    include: ['test/**/*.e2e-spec.ts', 'src/**/*.spec.ts'],
    setupFiles: ['./src/env.ts'],
    testTimeout: 20000,
    // M6-P5 起串行执行套件：e2e 共享真实 PostgreSQL/Redis/BullMQ（并行时不同套件的 Worker 会互抢
    // 队列 job、时序断言失去确定性）。单测不受影响。
    fileParallelism: false,
  },
  resolve: { alias: { '@ai-agent/shared': resolve(__dirname, '../../packages/shared/dist') } },
});
