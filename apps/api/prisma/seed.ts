import { config as loadEnv } from 'dotenv';
import { resolve } from 'node:path';
// monorepo：先加载仓库根 .env（运行目录为 apps/api）
loadEnv({ path: resolve(process.cwd(), '../../.env') });
loadEnv({ path: resolve(process.cwd(), '.env'), override: true });

import { PrismaClient, ProviderType, ModelType, HealthStatus } from '@prisma/client';
import * as argon2 from 'argon2';

const prisma = new PrismaClient();

/** LLM 六家厂商（全部走 openai-compatible adapter；apiKey 留空，M5 后台填写） */
const LLM_PROVIDERS = [
  { name: 'OpenAI', baseUrl: 'https://api.openai.com/v1' },
  { name: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1' },
  { name: 'Kimi(月之暗面)', baseUrl: 'https://api.moonshot.cn/v1' },
  { name: '阿里百炼(Qwen)', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1' },
  { name: '火山方舟(豆包)', baseUrl: 'https://ark.cn-beijing.volces.com/api/v3' },
  { name: '智谱(GLM)', baseUrl: 'https://open.bigmodel.cn/api/paas/v4' },
];

async function main() {
  const email = process.env.SEED_ADMIN_EMAIL ?? 'admin@example.com';
  const password = process.env.SEED_ADMIN_PASSWORD ?? 'admin123456';

  const admin = await prisma.user.upsert({
    where: { email },
    update: {},
    create: { email, passwordHash: await argon2.hash(password), displayName: '管理员', role: 'admin' },
  });
  console.log('admin user:', admin.email);

  for (const p of LLM_PROVIDERS) {
    const provider = await prisma.provider.upsert({
      where: { id: `seed-llm-${p.name}` },
      update: { baseUrl: p.baseUrl },
      create: {
        id: `seed-llm-${p.name}`, name: p.name, type: ProviderType.llm, adapter: 'openai-compatible',
        baseUrl: p.baseUrl, enabled: false, healthStatus: HealthStatus.untested,
      },
    });
    const api = providerDefaultApiModel(p.name);
    await prisma.model.upsert({
      where: { id: `seed-model-${provider.id}-${api}` },
      update: {},
      create: {
        id: `seed-model-${provider.id}-${api}`, providerId: provider.id,
        name: p.name === 'OpenAI' ? 'GPT-4o mini' : '默认模型', apiModelId: api,
        type: ModelType.llm,
        capabilities: {
          vision: p.name !== 'DeepSeek' && p.name !== 'Kimi(月之暗面)',
          jsonObject: true,
          jsonSchema: p.name === 'OpenAI',
        },
        contextWindow: 128000, enabled: true, priority: 100,
      },
    });
  }

  // 本地 mock provider（无真实 key 时开发/测试用）
  const mock = await prisma.provider.upsert({
    where: { id: 'seed-llm-mock' },
    update: {},
    create: {
      id: 'seed-llm-mock', name: '本地Mock', type: ProviderType.llm, adapter: 'mock',
      baseUrl: '', enabled: true, healthStatus: HealthStatus.healthy,
    },
  });
  await prisma.model.upsert({
    where: { id: 'seed-model-mock-echo' },
    update: {},
    create: {
      id: 'seed-model-mock-echo', providerId: mock.id, name: 'Mock Echo', apiModelId: 'mock-echo',
      type: ModelType.llm, capabilities: {}, enabled: true, priority: 1, isDefault: true,
    },
  });

  await prisma.systemSetting.upsert({
    where: { key: 'routingPolicy' },
    update: {},
    create: {
      key: 'routingPolicy',
      value: {
        confidenceThreshold: 0.7, routerModelId: null,
        defaults: { llm: 'seed-model-mock-echo', image: null, video: null, vision: null },
      },
    },
  });
  await prisma.systemSetting.upsert({
    where: { key: 'limits' },
    update: {},
    create: { key: 'limits', value: { dailyImage: 50, videoConcurrency: 1, monthlyTokenBudget: 0 } },
  });

  console.log('seed done');
}

/** 各家默认 api_model_id（admin 可在后台改） */
function providerDefaultApiModel(name: string): string {
  switch (name) {
    case 'DeepSeek': return 'deepseek-chat';
    case 'Kimi(月之暗面)': return 'kimi-k2-0711-preview';
    case '阿里百炼(Qwen)': return 'qwen-plus';
    case '火山方舟(豆包)': return 'doubao-pro-32k';
    case '智谱(GLM)': return 'glm-4-plus';
    default: return 'gpt-4o-mini';
  }
}

main().catch((e) => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
