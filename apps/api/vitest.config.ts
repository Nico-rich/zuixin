import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

export default defineConfig({
  test: {
    environment: 'node',
    globals: false,
    include: ['test/**/*.e2e-spec.ts', 'src/**/*.spec.ts'],
    setupFiles: ['./src/env.ts'],
    testTimeout: 20000,
  },
  resolve: { alias: { '@ai-agent/shared': resolve(__dirname, '../../packages/shared/dist') } },
});
