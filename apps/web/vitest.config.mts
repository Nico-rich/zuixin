import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';

// Web 测试体系（Pre-M9 §1）：组件测试 + 少量集成（jsdom），不追求 e2e。
// 注意：测试文件统一放在 apps/web/test/ 下——Next 只构建 app/ 路由，测试文件不进入 next build。
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': resolve(__dirname, '.'),
      // shared 的 package.json main 指向 dist（构建产物，仓库内 .gitignore 忽略）。
      // 测试直接指向源码，保证在未构建 shared 的干净 worktree 上也能跑通（只读 import，不改动 shared）。
      '@ai-agent/shared': resolve(__dirname, '../../packages/shared/src/index.ts'),
    },
  },
  test: {
    environment: 'jsdom',
    globals: false,
    include: ['test/**/*.test.ts', 'test/**/*.test.tsx'],
    setupFiles: ['./test/setup.ts'],
    restoreMocks: true,
  },
});
