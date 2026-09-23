import { config as loadEnv } from 'dotenv';
import { resolve } from 'node:path';

// monorepo：环境变量唯一事实源在仓库根 .env。
// 必须在任何 PrismaClient / NestFactory 构造之前执行（main.ts / worker.ts / vitest setupFiles 均引入）。
loadEnv({ path: resolve(process.cwd(), '../../.env') });
loadEnv({ path: resolve(process.cwd(), '.env'), override: true });
