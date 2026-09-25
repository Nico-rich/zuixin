import { describe, it, expect, vi } from 'vitest';
import { LLMManagerService } from './llm-manager.service';

function makeManager() {
  const prisma = {
    provider: { findMany: vi.fn().mockResolvedValue([
      { id: 'p1', name: 'Test', type: 'llm', adapter: 'mock', baseUrl: '', apiKeyEncrypted: '', timeoutMs: 1000, enabled: true },
    ]) },
    model: { findUnique: vi.fn().mockResolvedValue({
      id: 'm1', providerId: 'p1', apiModelId: 'mock-echo', enabled: true,
      // Pre-M9 F3-B：resolve 会按 provider.adapter/baseUrl 重跑 SSRF 判定（mock adapter 跳过）
      provider: { id: 'p1', name: 'Test', enabled: true, adapter: 'mock', baseUrl: '' },
    }) },
  };
  const crypto = { decrypt: vi.fn().mockReturnValue('sk-x') };
  return { svc: new LLMManagerService(prisma as never, crypto as never), prisma };
}

describe('LLMManagerService', () => {
  it('refresh 加载 mock provider', async () => {
    const { svc } = makeManager();
    await svc.refresh();
    expect(svc.getProvider('p1')).toBeTruthy();
  });

  it('resolve 返回 adapter + apiModelId', async () => {
    const { svc } = makeManager();
    await svc.refresh();
    const r = await svc.resolve('m1');
    expect(r.apiModelId).toBe('mock-echo');
    expect(r.adapter.kind).toBe('llm');
  });

  it('resolve 不存在的模型抛错', async () => {
    const { svc, prisma } = makeManager();
    await svc.refresh();
    (prisma.model.findUnique as ReturnType<typeof vi.fn>).mockResolvedValueOnce(null);
    await expect(svc.resolve('nope')).rejects.toThrow('模型不可用');
  });

  it('refresh 只查询启用中的 LLM provider（过滤下推到 DB）', async () => {
    const { svc, prisma } = makeManager();
    await svc.refresh();
    const where = (prisma.provider.findMany as ReturnType<typeof vi.fn>).mock.calls[0][0].where;
    expect(where).toEqual({ type: 'llm', enabled: true });
  });

  // Pre-M9 F3-B：resolve 是 LLM 调用的唯一出口 → 调用期必须重跑 baseUrl SSRF 判定（fail-closed）
  describe('调用期 baseUrl 校验（F3-B）', () => {
    const resolveWith = async (provider: Record<string, unknown>) => {
      const { svc, prisma } = makeManager();
      await svc.refresh();
      (prisma.model.findUnique as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        id: 'm1', providerId: 'p1', apiModelId: 'x', enabled: true,
        provider: { id: 'p1', name: 'Evil', enabled: true, ...provider },
      });
      return svc.resolve('m1');
    };

    it('baseUrl 指向回环 → SSRF_BLOCKED（即使 adapter 已加载）', async () => {
      await expect(resolveWith({ adapter: 'openai-compatible', baseUrl: 'https://127.0.0.1:8080/v1' }))
        .rejects.toMatchObject({ code: 'SSRF_BLOCKED' });
    });

    it('baseUrl 为云 metadata → SSRF_BLOCKED', async () => {
      await expect(resolveWith({ adapter: 'openai-compatible', baseUrl: 'https://169.254.169.254/v1' }))
        .rejects.toMatchObject({ code: 'SSRF_BLOCKED' });
    });

    it('非 mock adapter 未配置 baseUrl → SSRF_BLOCKED', async () => {
      await expect(resolveWith({ adapter: 'openai-compatible', baseUrl: '' })).rejects.toMatchObject({ code: 'SSRF_BLOCKED' });
    });

    it('mock adapter（无出网目标）→ 正常解析', async () => {
      await expect(resolveWith({ adapter: 'mock', baseUrl: '' })).resolves.toMatchObject({ apiModelId: 'x' });
    });
  });
});
