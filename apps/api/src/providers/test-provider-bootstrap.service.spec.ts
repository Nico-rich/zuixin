import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { TestProviderBootstrapService } from './test-provider-bootstrap.service';
import { MOCK_MODEL_IDS, MOCK_PROVIDER_IDS } from './mock-provider-ids';

/**
 * M13+ 测试基建单测（离线）。断言：
 * - flag 未设 → 零 DB 写、零 refresh（生产路径零开销）；
 * - flag=1 → 仅对 5 个 mock provider 与 5 个 mock 模型的**停用行**做 updateMany + 无条件四 manager refresh；
 * - 行缺失 → warn 不抛；异常 → 只 warn 不阻断启动；
 * - id 清单与 seed 逐字一致（漂移即测试基建失效）。
 */
function makeService() {
  const prisma = {
    provider: {
      findMany: vi.fn(async () => MOCK_PROVIDER_IDS.map((id) => ({ id }))),
      updateMany: vi.fn(async () => ({ count: 0 })),
    },
    model: {
      updateMany: vi.fn(async () => ({ count: 0 })),
    },
  };
  const manager = { refresh: vi.fn(async () => undefined) };
  const svc = new TestProviderBootstrapService(prisma as never, manager as never, manager as never, manager as never, manager as never);
  return { svc, prisma, manager };
}

describe('TestProviderBootstrapService', () => {
  beforeEach(() => { delete process.env.TEST_ENSURE_MOCK_PROVIDERS; });
  afterEach(() => { delete process.env.TEST_ENSURE_MOCK_PROVIDERS; });

  it('清单与 seed 钉死（5 个 mock provider + 5 个 mock 模型；漂移即测试基建失效）', () => {
    expect([...MOCK_PROVIDER_IDS]).toEqual(['seed-llm-mock', 'seed-llm-mock-router', 'seed-img-mock', 'seed-vid-mock', 'seed-emb-mock']);
    expect([...MOCK_MODEL_IDS]).toEqual(['seed-model-mock-echo', 'seed-model-mock-router-1', 'seed-img-mock-model', 'seed-vid-mock-model', 'seed-emb-mock-model']);
  });

  it('flag 未设 → 零 DB 写、零 refresh（生产路径零开销）', async () => {
    const h = makeService();
    await h.svc.onModuleInit();
    expect(h.prisma.provider.findMany).not.toHaveBeenCalled();
    expect(h.prisma.provider.updateMany).not.toHaveBeenCalled();
    expect(h.manager.refresh).not.toHaveBeenCalled();
  });

  it('flag=1 → provider+model 各仅停用行 updateMany + 无条件四 refresh（count=0 也刷新对齐内存面）', async () => {
    process.env.TEST_ENSURE_MOCK_PROVIDERS = '1';
    const h = makeService();
    await h.svc.onModuleInit();
    expect(h.prisma.provider.updateMany).toHaveBeenCalledWith({
      where: { id: { in: [...MOCK_PROVIDER_IDS] }, enabled: false },
      data: { enabled: true },
    });
    expect(h.prisma.model.updateMany).toHaveBeenCalledWith({
      where: { id: { in: [...MOCK_MODEL_IDS] }, enabled: false },
      data: { enabled: true },
    });
    expect(h.manager.refresh).toHaveBeenCalledTimes(4);
  });

  it('行缺失 → warn 不抛；updateMany 抛错 → 只 warn 不阻断启动', async () => {
    process.env.TEST_ENSURE_MOCK_PROVIDERS = '1';
    const partial = makeService();
    partial.prisma.provider.findMany.mockResolvedValue([{ id: 'seed-llm-mock' }]);
    await expect(partial.svc.onModuleInit()).resolves.toBeUndefined();

    const boom = makeService();
    boom.prisma.provider.updateMany.mockRejectedValue(new Error('db down'));
    await expect(boom.svc.onModuleInit()).resolves.toBeUndefined();
  });
});
