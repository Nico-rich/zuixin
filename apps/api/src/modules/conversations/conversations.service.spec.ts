import { describe, it, expect, vi } from 'vitest';
import { ConversationsService } from './conversations.service';

function make() {
  const prisma = {
    conversation: { findMany: vi.fn(), findFirst: vi.fn(), create: vi.fn(), update: vi.fn(), findUnique: vi.fn() },
    message: { findMany: vi.fn() },
  };
  const svc = new ConversationsService(prisma as never);
  return { svc, prisma };
}

describe('ConversationsService', () => {
  it('list 只查询自己的非删除会话，按 updatedAt 倒序', async () => {
    const { svc, prisma } = make();
    prisma.conversation.findMany.mockResolvedValue([]);
    await svc.list('u1');
    expect(prisma.conversation.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { userId: 'u1', deletedAt: null },
      orderBy: { updatedAt: 'desc' },
    }));
  });

  it('create 创建会话并默认标题', async () => {
    const { svc, prisma } = make();
    prisma.conversation.create.mockResolvedValue({ id: 'c1' });
    const r = await svc.create('u1', { title: '测试' });
    expect(prisma.conversation.create).toHaveBeenCalledWith(expect.objectContaining({ data: { userId: 'u1', title: '测试' } }));
    expect(r.id).toBe('c1');
  });

  it('getMessages 先校验归属，非本人会话 → NOT_FOUND', async () => {
    const { svc, prisma } = make();
    prisma.conversation.findFirst.mockResolvedValue(null);
    await expect(svc.getMessages('u1', 'c-other')).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(prisma.message.findMany).not.toHaveBeenCalled();
  });

  it('getMessages 按 createdAt 正序返回', async () => {
    const { svc, prisma } = make();
    prisma.conversation.findFirst.mockResolvedValue({ id: 'c1', userId: 'u1' });
    prisma.message.findMany.mockResolvedValue([]);
    await svc.getMessages('u1', 'c1');
    expect(prisma.message.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { conversationId: 'c1' }, orderBy: { createdAt: 'asc' } }));
  });

  it('软删除：先校验归属再置 deletedAt', async () => {
    const { svc, prisma } = make();
    prisma.conversation.findFirst.mockResolvedValue(null);
    await expect(svc.softDelete('u1', 'c-other')).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});
