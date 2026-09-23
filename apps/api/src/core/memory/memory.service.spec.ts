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
      orderBy: { importance: 'desc' },
    }));
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
  it('update 先校验归属；支持 candidate→active', async () => {
    const { svc, prisma } = make();
    prisma.memory.findFirst.mockResolvedValue({ id: 'm1', userId: 'u1' });
    await svc.update('u1', 'm1', { status: 'active' });
    expect(prisma.memory.update).toHaveBeenCalledWith({ where: { id: 'm1' }, data: { status: 'active' } });
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
