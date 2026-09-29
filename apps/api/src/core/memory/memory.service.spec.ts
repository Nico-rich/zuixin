import { describe, it, expect, vi } from 'vitest';
import { MemoryService } from './memory.service';

function make() {
  const prisma = {
    memory: {
      findMany: vi.fn().mockResolvedValue([]),
      findFirst: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
      delete: vi.fn(),
    },
    project: { findFirst: vi.fn().mockResolvedValue({ id: 'p1', userId: 'u1' }) },
  };
  const svc = new MemoryService(prisma as never);
  return { svc, prisma };
}

describe('MemoryService.create（scope 一致性校验）', () => {
  it('user memory：projectId 必须为空', async () => {
    const { svc } = make();
    await expect(svc.create('u1', { scope: 'user', projectId: 'p1', content: 'x', category: 'preference' }))
      .rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });

  it('project memory：projectId 必填且必须归属本人', async () => {
    const { svc, prisma } = make();
    prisma.memory.create.mockResolvedValue({ id: 'm1' });
    await svc.create('u1', { scope: 'project', projectId: 'p1', content: '品牌：黑金', category: 'project_context' });
    expect(prisma.memory.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ scope: 'project', projectId: 'p1', status: 'candidate' }),
    }));
  });

  it('project memory：他人项目 → NOT_FOUND', async () => {
    const { svc, prisma } = make();
    prisma.project.findFirst.mockResolvedValue(null);
    await expect(svc.create('u1', { scope: 'project', projectId: 'p-other', content: 'x', category: 'other' }))
      .rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});

describe('MemoryService.list/search', () => {
  it('按 scope/status 过滤 + ILIKE 搜索 + importance 排序', async () => {
    const { svc, prisma } = make();
    await svc.list('u1', { scope: 'user', status: 'active', q: '主图' });
    expect(prisma.memory.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        userId: 'u1', scope: 'user', status: 'active',
        content: { contains: '主图', mode: 'insensitive' },
      }),
      orderBy: [
        { importance: 'desc' },
        { lastUsedAt: { sort: 'desc', nulls: 'last' } }, // D15：最近被用过的优先，从未用过的最后
        { createdAt: 'desc' },
      ],
    }));
  });

  it('D15：lastUsedAt 参与排序，且 NULLS LAST（绝不让"没用过的"盖过"用过的"）', async () => {
    const { svc, prisma } = make();
    await svc.list('u1', {});
    const orderBy = prisma.memory.findMany.mock.calls[0][0].orderBy as Array<Record<string, unknown>>;
    expect(orderBy).toHaveLength(3);
    expect(orderBy[0]).toEqual({ importance: 'desc' }); // 主序不变：importance 仍是第一关键字
    expect(orderBy[1]).toEqual({ lastUsedAt: { sort: 'desc', nulls: 'last' } }); // 次序：使用新鲜度
    expect(orderBy[2]).toEqual({ createdAt: 'desc' }); // 兜底：排序确定可复现
  });

  it('projectId 越权 → 返回空（按 userId+projectId 双条件）', async () => {
    const { svc, prisma } = make();
    await svc.list('u1', { scope: 'project', projectId: 'p-other' });
    expect(prisma.memory.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ userId: 'u1', projectId: 'p-other' }),
    }));
  });
});

describe('MemoryService.update/remove/markUsed', () => {
  it('update 先校验归属；支持 candidate→active（并记人工裁决锚 lifecycle.userAffirmedAt）', async () => {
    const { svc, prisma } = make();
    prisma.memory.findFirst.mockResolvedValue({ id: 'm1', userId: 'u1', metadata: { kind: 'performance' } });
    await svc.update('u1', 'm1', { status: 'active' });
    // M12-P3：人工把记忆改回 active = 显式裁决 → 生命周期巡逻在窗口内绝不把它再次自动降级
    expect(prisma.memory.update).toHaveBeenCalledWith({
      where: { id: 'm1' },
      data: {
        status: 'active',
        metadata: {
          kind: 'performance', // 既有幂等锚绝不被覆盖
          lifecycle: { userAffirmedAt: expect.any(String) },
        },
      },
    });
    // 归属校验（谓词必须含 userId）在任何写入之前
    expect(prisma.memory.findFirst).toHaveBeenCalledWith({ where: { id: 'm1', userId: 'u1' } });
  });

  it('update 非状态字段不写 metadata（人工锚只由显式 active 恢复产生）', async () => {
    const { svc, prisma } = make();
    prisma.memory.findFirst.mockResolvedValue({ id: 'm1', userId: 'u1', metadata: { kind: 'performance' } });
    await svc.update('u1', 'm1', { importance: 80 });
    expect(prisma.memory.update).toHaveBeenCalledWith({ where: { id: 'm1' }, data: { importance: 80 } });
  });

  it('update 非本人 → NOT_FOUND', async () => {
    const { svc, prisma } = make();
    prisma.memory.findFirst.mockResolvedValue(null);
    await expect(svc.update('u1', 'm-other', { status: 'active' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('markUsed 批量刷新 lastUsedAt', async () => {
    const { svc, prisma } = make();
    await svc.markUsed(['m1', 'm2']);
    expect(prisma.memory.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ['m1', 'm2'] } },
      data: { lastUsedAt: expect.any(Date) },
    });
  });
});
