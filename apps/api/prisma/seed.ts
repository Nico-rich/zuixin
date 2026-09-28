import { config as loadEnv } from 'dotenv';
import { resolve } from 'node:path';
// monorepo：先加载仓库根 .env（运行目录为 apps/api）
loadEnv({ path: resolve(process.cwd(), '../../.env') });
loadEnv({ path: resolve(process.cwd(), '.env'), override: true });

import { PrismaClient, ProviderType, ModelType, HealthStatus } from '@prisma/client';
import * as argon2 from 'argon2';
import { assertSeedPasswordSafe } from '../src/modules/security/production-guards';

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
  // M10-P1 生产守卫（D23）：生产环境拒绝用默认/占位口令初始化管理员
  // （默认口令 admin123456 一旦进入生产 = 一个公开已知口令的 admin 账号）。
  // 注意：本调用必须在 loadEnv 之后（文件顶部已加载 .env）。
  const email = process.env.SEED_ADMIN_EMAIL ?? 'admin@example.com';
  const password = process.env.SEED_ADMIN_PASSWORD ?? 'admin123456';
  assertSeedPasswordSafe({ ...process.env, SEED_ADMIN_PASSWORD: password });

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

  // dev/e2e 替身：意图路由（启发式分类仅存在于该替身 adapter；生产配置真实路由模型后自动接管）
  const mockRouter = await prisma.provider.upsert({
    where: { id: 'seed-llm-mock-router' },
    update: {},
    create: { id: 'seed-llm-mock-router', name: '本地路由替身', type: ProviderType.llm, adapter: 'mock-router', baseUrl: '', enabled: true, healthStatus: HealthStatus.healthy },
  });
  await prisma.model.upsert({
    where: { id: 'seed-model-mock-router-1' },
    update: {},
    create: { id: 'seed-model-mock-router-1', providerId: mockRouter.id, name: 'Mock Router', apiModelId: 'mock-router-1', type: ModelType.llm, capabilities: { jsonObject: true }, enabled: true, priority: 1 },
  });

  // 生图 Provider：mock-image（dev/e2e 替身，1×1 PNG）+ 三家真实（禁用，待后台填 key）
  const imageProviders = [
    { id: 'seed-img-mock', name: '本地生图替身', adapter: 'mock-image', baseUrl: '', enabled: true, api: 'mock-image-1' },
    { id: 'seed-img-openai', name: 'OpenAI Image', adapter: 'openai-image', baseUrl: 'https://api.openai.com/v1', enabled: false, api: 'gpt-image-1' },
    { id: 'seed-img-zhipu', name: '智谱 CogView', adapter: 'zhipu-image', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', enabled: false, api: 'cogview-4' },
    { id: 'seed-img-dashscope', name: '阿里通义万相', adapter: 'dashscope-image', baseUrl: 'https://dashscope.aliyuncs.com/api/v1', enabled: false, api: 'wanx2.1-t2i-turbo' },
  ];
  for (const p of imageProviders) {
    const provider = await prisma.provider.upsert({
      where: { id: p.id },
      update: {},
      create: { id: p.id, name: p.name, type: ProviderType.image, adapter: p.adapter, baseUrl: p.baseUrl, enabled: p.enabled, healthStatus: p.enabled ? HealthStatus.healthy : HealthStatus.untested },
    });
    await prisma.model.upsert({
      where: { id: `${p.id}-model` },
      update: {},
      create: { id: `${p.id}-model`, providerId: provider.id, name: p.name, apiModelId: p.api, type: ModelType.image, capabilities: { sizes: ['1024x1024'] }, unitPrice: 0, enabled: p.enabled, priority: p.enabled ? 1 : 100 },
    });
  }

  // 生视频 Provider：mock-video（dev/e2e 替身）+ 阿里通义万相（禁用，待后台填 key）
  const videoProviders = [
    { id: 'seed-vid-mock', name: '本地视频替身', adapter: 'mock-video', baseUrl: '', enabled: true, api: 'mock-video-1' },
    { id: 'seed-vid-dashscope', name: '阿里通义万相视频', adapter: 'dashscope-video', baseUrl: 'https://dashscope.aliyuncs.com/api/v1', enabled: false, api: 'wanx2.1-t2v-turbo' },
  ];
  for (const p of videoProviders) {
    const provider = await prisma.provider.upsert({
      where: { id: p.id },
      update: {},
      create: { id: p.id, name: p.name, type: ProviderType.video, adapter: p.adapter, baseUrl: p.baseUrl, enabled: p.enabled, healthStatus: p.enabled ? HealthStatus.healthy : HealthStatus.untested },
    });
    await prisma.model.upsert({
      where: { id: `${p.id}-model` },
      update: {},
      create: {
        id: `${p.id}-model`, providerId: provider.id, name: p.name, apiModelId: p.api, type: ModelType.video,
        capabilities: {
          supportedDurations: [5, 10],
          supportedAspectRatios: ['16:9', '9:16', '1:1'],
          supportedResolutions: ['720p', '1080p'],
          supportsReferenceImage: true,
          async: true,
        },
        unitPrice: 0, enabled: p.enabled, priority: p.enabled ? 1 : 100,
      },
    });
  }

  // M4/M5: 内置 Agent 三件套（定义迁移至 AgentVersion v1 published；Registry 只读 activeVersion）
  const agents = [
    {
      id: 'seed-agent-general', slug: 'general-assistant', name: '通用助手', kind: 'builtin',
      systemPrompt: '你是 AI 智能创作平台的通用助手。当用户需要生成图片/视频/制品或建议保存记忆时，使用对应工具；普通问答直接回答。',
      tools: ['image.generate', 'video.generate', 'artifact.create', 'memory.create_candidate', 'knowledge.search'],
    },
    { id: 'seed-agent-image', slug: 'image', name: '图片生成 Agent', kind: 'builtin', systemPrompt: '你负责图片生成任务。', tools: [] },
    { id: 'seed-agent-video', slug: 'video', name: '视频生成 Agent', kind: 'builtin', systemPrompt: '你负责视频生成任务。', tools: [] },
  ];
  for (const a of agents) {
    const agent = await prisma.agent.upsert({
      where: { id: a.id },
      update: { kind: a.kind },
      create: { id: a.id, slug: a.slug, name: a.name, kind: a.kind, builtin: true, enabled: true, priority: a.slug === 'general-assistant' ? 1 : 10 },
    });
    // 幂等快照：builtin Agent 的 v1 定义由 seed 刷新（dev 基线）；published 语义下生产变更走版本发布流
    const v1 = await prisma.agentVersion.upsert({
      where: { agentId_version: { agentId: agent.id, version: 1 } },
      update: {
        systemPrompt: a.systemPrompt, tools: a.tools, temperature: 0.7,
        config: a.slug === 'general-assistant' ? { maxSteps: 8, knowledge: { enabled: false } } : {},
      },
      create: {
        agentId: agent.id, version: 1, status: 'published',
        systemPrompt: a.systemPrompt, tools: a.tools, temperature: 0.7,
        config: a.slug === 'general-assistant' ? { maxSteps: 8, knowledge: { enabled: false } } : {},
      },
    });
    if (!agent.activeVersionId) {
      await prisma.agent.update({ where: { id: agent.id }, data: { activeVersionId: v1.id } });
    }
  }

  // M5-P5: embedding 替身（确定性向量，无 Key 全链路可跑）
  const embProvider = await prisma.provider.upsert({
    where: { id: 'seed-emb-mock' },
    update: {},
    create: { id: 'seed-emb-mock', name: '本地Embedding替身', type: 'embedding', adapter: 'mock-embedding', baseUrl: '', enabled: true, healthStatus: 'healthy' },
  });
  await prisma.model.upsert({
    where: { id: 'seed-emb-mock-model' },
    update: {},
    create: { id: 'seed-emb-mock-model', providerId: embProvider.id, name: 'Mock Embedding', apiModelId: 'mock-embedding-1', type: 'embedding', capabilities: { dimensions: 64 }, enabled: true, priority: 1, isDefault: true },
  });

  const routingPolicy = {
    confidenceThreshold: 0.7,
    routerModelId: 'seed-model-mock-router-1',
    defaults: { llm: 'seed-model-mock-echo', image: 'seed-img-mock-model', video: 'seed-vid-mock-model', vision: null, embedding: 'seed-emb-mock-model' },
    agentMapping: { chat: 'general-assistant', image_generation: 'image', video_generation: 'video' },
  };
  await prisma.systemSetting.upsert({
    where: { key: 'routingPolicy' },
    update: { value: routingPolicy },
    create: { key: 'routingPolicy', value: routingPolicy },
  });
  const limits = {
    dailyImage: 50, dailyVideo: 10, dailyMemoryCandidates: 20, videoConcurrency: 1, monthlyTokenBudget: 0,
    agentRunTimeoutMs: 120000, // 同步 run deadline（M5 语义）
    contextBudgetTokens: 8000,
    // M6: 异步长任务分层超时（lease 与 run deadline 分离，见 m6-architecture-design §12）
    agentRunDeadlineMs: 2400000,   // async run 总 deadline（40min，自 startedAt，含 waiting）
    agentRunLeaseTtlMs: 60000,     // lease TTL
    agentRunHeartbeatMs: 15000,    // 心跳间隔
    agentRunLlmTurnMs: 120000,     // LLM 单回合流级 watchdog
  };
  await prisma.systemSetting.upsert({
    where: { key: 'limits' },
    update: { value: limits },
    create: { key: 'limits', value: limits },
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
