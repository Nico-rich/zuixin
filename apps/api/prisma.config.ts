import { defineConfig } from 'prisma/config';
import { config as loadEnv } from 'dotenv';
import { resolve } from 'node:path';

// monorepo：环境变量唯一事实源在仓库根 .env（运行于 apps/api 目录时向上两级）
loadEnv({ path: resolve(process.cwd(), '../../.env') });
loadEnv({ path: resolve(process.cwd(), '.env'), override: true });

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
    seed: 'tsx prisma/seed.ts',
    // shadow 库每次创建/重置后执行（pgvector：历史迁移 M5-P1 含 CREATE EXTENSION vector）
    initShadowDb: 'CREATE EXTENSION IF NOT EXISTS vector;',
  },
  // initShadowDb 属外部库修改，需显式开启
  experimental: { externalTables: true },
});
