/**
 * M13+（模型配置页）：mock 替身的 provider id 清单（与 `prisma/seed.ts` **逐字一致**；单测钉死）。
 *
 * 测试基建依赖：vitest/Playwright 跑在共享 dev 库上，而用户可随时在模型配置页停用 mock——
 * seed 的 mock upsert 是 `update: {}`（重跑 seed **不会**恢复被停用的替身），因此
 * `TestProviderBootstrapService`（TEST_ENSURE_MOCK_PROVIDERS=1）在进程启动时幂等启用这 5 个 id，
 * 保证测试套件无论用户配置如何都能拿到 mock。生产启动**绝不**设置该 env。
 */
export const MOCK_PROVIDER_IDS = [
  'seed-llm-mock',
  'seed-llm-mock-router',
  'seed-img-mock',
  'seed-vid-mock',
  'seed-emb-mock',
] as const;

/** mock 替身的**模型** id（与 seed 逐字一致）——用户在配置页可停用模型，测试基建同样要幂等启用 */
export const MOCK_MODEL_IDS = [
  'seed-model-mock-echo',
  'seed-model-mock-router-1',
  'seed-img-mock-model',
  'seed-vid-mock-model',
  'seed-emb-mock-model',
] as const;
