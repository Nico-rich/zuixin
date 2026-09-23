import { describe, it, expect, vi } from 'vitest';
import { LLMManagerService } from './llm-manager.service';

function makeManager() {
  const prisma = {
    provider: { findMany: vi.fn().mockResolvedValue([
      { id: 'p1', name: 'Test', type: 'llm', adapter: 'mock', baseUrl: '', apiKeyEncrypted: '', timeoutMs: 1000, enabled: true },
    ]) },
    model: { findUnique: vi.fn().mockResolvedValue({
      id: 'm1', apiModelId: 'mock-echo', enabled: true,
      provider: { id: 'p1', name: 'Test', enabled: true },
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

  it('禁用的 provider 不会被加载', async () => {
    const { svc, prisma } = makeManager();
    (prisma.provider.findMany as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
      { id: 'p2', name: 'Disabled', type: 'llm', adapter: 'mock', baseUrl: '', apiKeyEncrypted: '', timeoutMs: 1000, enabled: false },
    ]);
    await svc.refresh();
    expect(svc.getProvider('p2')).toBeUndefined();
  });
});
