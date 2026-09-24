import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AgentsAdminService } from './agents-admin.service';

function makeService() {
  const prisma = {
    agent: {
      findMany: vi.fn(), findUnique: vi.fn(),
      create: vi.fn().mockResolvedValue({ id: 'agent-1', activeVersionId: null }),
      update: vi.fn().mockResolvedValue({}),
    },
    agentVersion: {
      create: vi.fn().mockImplementation(({ data }) => Promise.resolve({ id: `v-${data.version}`, ...data })),
      findFirst: vi.fn().mockResolvedValue(null),
      findUnique: vi.fn().mockResolvedValue(null),
      update: vi.fn().mockImplementation(({ where, data }) => Promise.resolve({ id: where.id, ...data })),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      aggregate: vi.fn().mockResolvedValue({ _max: { version: 1 } }),
    },
    $transaction: vi.fn(async (ops: unknown[]) => Promise.all(ops as Promise<unknown>[])),
  };
  const registry = { refresh: vi.fn().mockResolvedValue(undefined) };
  const svc = new AgentsAdminService(prisma as never, registry as never);
  return { svc, prisma, registry };
}

describe('AgentsAdminService（版本生命周期 + immutable 守卫）', () => {
  beforeEach(() => vi.clearAllMocks());

  it('create → 创建 Agent + v1 draft（定义只存在于版本行）', async () => {
    const { svc, prisma } = makeService();
    const r = await svc.create({ slug: 'x-agent', name: 'X', kind: 'custom', systemPrompt: 'v1 prompt', tools: ['image.generate'] });
    expect(prisma.agent.create).toHaveBeenCalled();
    expect(r.draftVersion.status).toBe('draft');
    expect(r.draftVersion.systemPrompt).toBe('v1 prompt');
  });

  it('publish：draft → published（旧 published 归档）+ activeVersionId 切换 + registry 刷新', async () => {
    const { svc, prisma, registry } = makeService();
    prisma.agent.findUnique.mockResolvedValue({ id: 'agent-1', activeVersionId: 'v-old' });
    prisma.agentVersion.findFirst.mockResolvedValue({ id: 'v-draft', agentId: 'agent-1', version: 2, status: 'draft' });
    await svc.publish('agent-1');
    expect(prisma.agentVersion.updateMany).toHaveBeenCalledWith({ where: { agentId: 'agent-1', status: 'published' }, data: { status: 'archived' } });
    expect(prisma.agentVersion.update).toHaveBeenCalledWith({ where: { id: 'v-draft' }, data: { status: 'published' } });
    expect(prisma.agent.update).toHaveBeenCalledWith({ where: { id: 'agent-1' }, data: { activeVersionId: 'v-draft' } });
    expect(registry.refresh).toHaveBeenCalled();
  });

  it('immutable：editDraft 只新建/更新 draft，绝不 UPDATE published/archived 行', async () => {
    const { svc, prisma } = makeService();
    prisma.agent.findUnique.mockResolvedValue({ id: 'agent-1', activeVersionId: 'v-pub' });
    prisma.agentVersion.findFirst.mockResolvedValue(null); // 无 draft
    prisma.agentVersion.findUnique.mockResolvedValue({ id: 'v-pub', agentId: 'agent-1', version: 1, status: 'published', systemPrompt: '旧', tools: [], config: null });
    prisma.agentVersion.aggregate.mockResolvedValue({ _max: { version: 1 } });
    await svc.editDraft('agent-1', { systemPrompt: '新' });
    // 新建 v2 draft（复制 v1 内容后修改），v1 不动
    expect(prisma.agentVersion.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ version: 2, status: 'draft' }),
    }));
    expect(prisma.agentVersion.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'v-2' },
      data: expect.objectContaining({ systemPrompt: '新' }),
    }));
  });

  it('publish 无草稿 → VALIDATION_ERROR', async () => {
    const { svc, prisma } = makeService();
    prisma.agent.findUnique.mockResolvedValue({ id: 'agent-1', activeVersionId: null });
    prisma.agentVersion.findFirst.mockResolvedValue(null);
    await expect(svc.publish('agent-1')).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });

  it('rollback：activeVersionId 指回目标版本（只允许 published/archived）', async () => {
    const { svc, prisma } = makeService();
    prisma.agent.findUnique.mockResolvedValue({ id: 'agent-1', activeVersionId: 'v2' });
    prisma.agentVersion.findFirst.mockResolvedValue({ id: 'v1', agentId: 'agent-1', version: 1, status: 'archived' });
    await svc.rollback('agent-1', 'v1');
    expect(prisma.agent.update).toHaveBeenCalledWith({ where: { id: 'agent-1' }, data: { activeVersionId: 'v1' } });
  });

  it('rollback 到 draft → VALIDATION_ERROR', async () => {
    const { svc, prisma } = makeService();
    prisma.agent.findUnique.mockResolvedValue({ id: 'agent-1', activeVersionId: 'v2' });
    prisma.agentVersion.findFirst.mockResolvedValue({ id: 'v3', agentId: 'agent-1', version: 3, status: 'draft' });
    await expect(svc.rollback('agent-1', 'v3')).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });
});
