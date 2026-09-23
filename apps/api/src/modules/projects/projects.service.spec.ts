import { describe, it, expect, vi } from 'vitest';
import { ProjectsService } from './projects.service';

function make() {
  const prisma = {
    project: {
      findMany: vi.fn(),
      findFirst: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
    },
  };
  const svc = new ProjectsService(prisma as never);
  return { svc, prisma };
}

describe('ProjectsService', () => {
  it('list 只查询本人的非删除项目', async () => {
    const { svc, prisma } = make();
    prisma.project.findMany.mockResolvedValue([]);
    await svc.list('u1');
    expect(prisma.project.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { userId: 'u1', deletedAt: null },
      orderBy: { updatedAt: 'desc' },
    }));
  });

  it('create 创建项目', async () => {
    const { svc, prisma } = make();
    prisma.project.create.mockResolvedValue({ id: 'p1' });
    await svc.create('u1', { name: '亚马逊店铺', description: 'x', metadata: { brand: '插排' } });
    expect(prisma.project.create).toHaveBeenCalledWith({
      data: { userId: 'u1', name: '亚马逊店铺', description: 'x', metadata: { brand: '插排' } },
    });
  });

  it('get 非本人项目 → NOT_FOUND', async () => {
    const { svc, prisma } = make();
    prisma.project.findFirst.mockResolvedValue(null);
    await expect(svc.get('u1', 'p-other')).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('rename/update 先校验归属', async () => {
    const { svc, prisma } = make();
    prisma.project.findFirst.mockResolvedValue({ id: 'p1', userId: 'u1' });
    prisma.project.update.mockResolvedValue({ id: 'p1' });
    await svc.update('u1', 'p1', { name: '新名字' });
    expect(prisma.project.update).toHaveBeenCalledWith({ where: { id: 'p1' }, data: { name: '新名字' } });
  });

  it('softDelete 置 deletedAt（软删除，对话保留）', async () => {
    const { svc, prisma } = make();
    prisma.project.findFirst.mockResolvedValue({ id: 'p1', userId: 'u1' });
    await svc.softDelete('u1', 'p1');
    expect(prisma.project.update).toHaveBeenCalledWith({ where: { id: 'p1' }, data: { deletedAt: expect.any(Date) } });
  });
});
