import { describe, it, expect, vi } from 'vitest';
import { ConversationsService } from './conversations.service';
import { decodeCursor, encodeCursor } from './cursor';

function make() {
  const prisma = {
    conversation: { findMany: vi.fn(), findFirst: vi.fn(), create: vi.fn(), update: vi.fn(), findUnique: vi.fn() },
    message: { findMany: vi.fn() },
    project: { findFirst: vi.fn().mockResolvedValue({ id: 'p1', userId: 'u1' }) },
  };
  // M9-P2：会话删除的摘要清理走记忆域（不在此重复摘要生命周期语义）
  const summaries = { purgeConversation: vi.fn().mockResolvedValue({ summaries: 0, candidates: 0 }) };
  const svc = new ConversationsService(prisma as never, summaries as never);
  return { svc, prisma, summaries };
}

// ===== M10-P3 游标分页：内存假库（只覆盖本服务实际产出的 where/orderBy/take 形状）=====

/** 等值 + `OR: [{field:{gt|lt}}, {field, id:{gt|lt}}]` 复合游标匹配 */
function matches(row: Record<string, unknown>, where: Record<string, unknown>): boolean {
  for (const [key, value] of Object.entries(where)) {
    if (key === 'OR') {
      const clauses = value as Record<string, unknown>[];
      if (!clauses.some((clause) => matches(row, clause))) return false;
      continue;
    }
    if (value && typeof value === 'object' && !(value instanceof Date)) {
      const { gt, lt } = value as { gt?: Date | string; lt?: Date | string };
      const current = row[key] as never;
      if (gt !== undefined && !(current > (gt as never))) return false;
      if (lt !== undefined && !(current < (lt as never))) return false;
      continue;
    }
    // 时刻等价即相等（游标里的 Date 与行里的 Date 是不同对象，绝不按引用比较）
    if (value instanceof Date) {
      const current = row[key];
      if (!(current instanceof Date) || current.getTime() !== value.getTime()) return false;
      continue;
    }
    if (row[key] !== value) return false;
  }
  return true;
}

interface FakeArgs {
  where: Record<string, unknown>;
  orderBy: Array<Record<string, 'asc' | 'desc'>>;
  take: number;
}

/** 排序键归一：Date 按时刻（毫秒）比较，其余按值 */
const key = (v: unknown) => (v instanceof Date ? v.getTime() : v);

/** 模拟 Prisma：过滤 → 复合排序 → take（含"多取一条"语义） */
function fakeFindMany<T extends Record<string, unknown>>(rows: T[]) {
  return vi.fn(async (args: FakeArgs) => {
    const filtered = rows.filter((r) => matches(r, args.where));
    const sorted = [...filtered].sort((a, b) => {
      for (const spec of args.orderBy) {
        const [field, dir] = Object.entries(spec)[0];
        const av = key(a[field]);
        const bv = key(b[field]);
        if (av === bv) continue; // 同键 → 看下一个排序键（复合游标的全序前提）
        const cmp = (av as never) > (bv as never) ? 1 : -1;
        return dir === 'asc' ? cmp : -cmp;
      }
      return 0;
    });
    return sorted.slice(0, args.take) as never;
  });
}

/** uuid 形态且字典序 = 序号序（游标解码要求合法 uuid） */
const mid = (n: number) => `${String(n).padStart(8, '0')}-0000-4000-8000-000000000000`;
const T0 = new Date('2026-09-28T10:00:00.000Z');

/** 12 条消息，**每 4 条同毫秒**（单列时间游标必然重复/遗漏的场景） */
function collisionMessages(): Array<Record<string, unknown>> {
  return Array.from({ length: 12 }, (_, i) => ({
    id: mid(i),
    conversationId: 'c1',
    role: i % 2 === 0 ? 'user' : 'assistant',
    content: `m${i}`,
    status: 'completed',
    createdAt: new Date(T0.getTime() + Math.floor(i / 4)),
    editedAt: null,
  }));
}

describe('ConversationsService', () => {
  it('list 只查询自己的非删除会话，按 updatedAt 倒序（M10-P3：复合排序保证翻页全序）', async () => {
    const { svc, prisma } = make();
    prisma.conversation.findMany.mockResolvedValue([]);
    await svc.list('u1');
    expect(prisma.conversation.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { userId: 'u1', deletedAt: null },
      orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
    }));
  });

  it('list 默认仍取 50 条（与 M0~M9 固定 take 一致，向后兼容）', async () => {
    const { svc, prisma } = make();
    prisma.conversation.findMany.mockResolvedValue([]);
    await svc.list('u1');
    expect(prisma.conversation.findMany).toHaveBeenCalledWith(expect.objectContaining({ take: 51 }));
  });

  it('create 创建会话并默认标题', async () => {
    const { svc, prisma } = make();
    prisma.conversation.create.mockResolvedValue({ id: 'c1' });
    const r = await svc.create('u1', { title: '测试' });
    expect(prisma.conversation.create).toHaveBeenCalledWith(expect.objectContaining({ data: { userId: 'u1', title: '测试', projectId: null } }));
    expect(r.id).toBe('c1');
  });

  it('create 带 projectId：先校验项目归属再创建', async () => {
    const { svc, prisma } = make();
    await svc.create('u1', { projectId: 'p1' });
    expect(prisma.project.findFirst).toHaveBeenCalledWith({ where: { id: 'p1', userId: 'u1', deletedAt: null } });
    expect(prisma.conversation.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ projectId: 'p1' }) }));
  });

  it('create 带他人项目 → NOT_FOUND', async () => {
    const { svc, prisma } = make();
    prisma.project.findFirst.mockResolvedValue(null);
    await expect(svc.create('u1', { projectId: 'p-other' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('list 支持 projectId 过滤', async () => {
    const { svc, prisma } = make();
    prisma.conversation.findMany.mockResolvedValue([]);
    await svc.list('u1', { projectId: 'p1' });
    expect(prisma.conversation.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { userId: 'u1', deletedAt: null, projectId: 'p1' } }));
  });

  it('update 移动项目：null = 移出项目', async () => {
    const { svc, prisma } = make();
    prisma.conversation.findFirst.mockResolvedValue({ id: 'c1', userId: 'u1' });
    await svc.update('u1', 'c1', { projectId: null });
    expect(prisma.conversation.update).toHaveBeenCalledWith({ where: { id: 'c1' }, data: { projectId: null } });
  });

  it('update 移动到他人项目 → NOT_FOUND', async () => {
    const { svc, prisma } = make();
    prisma.conversation.findFirst.mockResolvedValue({ id: 'c1', userId: 'u1' });
    prisma.project.findFirst.mockResolvedValue(null);
    await expect(svc.update('u1', 'c1', { projectId: 'p-other' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('getMessages 先校验归属，非本人会话 → NOT_FOUND', async () => {
    const { svc, prisma } = make();
    prisma.conversation.findFirst.mockResolvedValue(null);
    await expect(svc.getMessages('u1', 'c-other')).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(prisma.message.findMany).not.toHaveBeenCalled();
  });

  it('getMessages 默认：复合升序（createdAt,id）+ 多取一条判定 hasMore，返回时间正序数组', async () => {
    const { svc, prisma } = make();
    prisma.conversation.findFirst.mockResolvedValue({ id: 'c1', userId: 'u1' });
    prisma.message.findMany.mockResolvedValue([]);
    const page = await svc.getMessages('u1', 'c1');
    expect(prisma.message.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { conversationId: 'c1' },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: 201, // 旧默认 200 + 1 探针
    }));
    expect(page.items).toEqual([]);
    expect(page.meta).toMatchObject({ limit: 200, hasMore: false, order: 'asc' });
  });

  it('getMessages after 游标：严格大于（同毫秒用 id 兜底）', async () => {
    const { svc, prisma } = make();
    prisma.conversation.findFirst.mockResolvedValue({ id: 'c1', userId: 'u1' });
    prisma.message.findMany.mockResolvedValue([]);
    const cursor = Buffer.from(`${T0.toISOString()}|${mid(3)}`).toString('base64url');
    await svc.getMessages('u1', 'c1', { after: cursor, limit: 5 });
    const args = prisma.message.findMany.mock.calls[0][0];
    expect(args.where).toEqual({
      conversationId: 'c1',
      OR: [{ createdAt: { gt: T0 } }, { createdAt: T0, id: { gt: mid(3) } }],
    });
    expect(args.orderBy).toEqual([{ createdAt: 'asc' }, { id: 'asc' }]);
    expect(args.take).toBe(6);
  });

  it('getMessages before 游标：反向取数（desc）后仍返回时间正序数组', async () => {
    const { svc, prisma } = make();
    prisma.conversation.findFirst.mockResolvedValue({ id: 'c1', userId: 'u1' });
    const rows = collisionMessages();
    prisma.message.findMany.mockResolvedValue([...rows].reverse().slice(0, 3)); // desc 取数前 3 条：m11,m10,m9
    const cursor = Buffer.from(`${T0.toISOString()}|${mid(9)}`).toString('base64url');
    const page = await svc.getMessages('u1', 'c1', { before: cursor, limit: 3 });
    const args = prisma.message.findMany.mock.calls[0][0];
    expect(args.orderBy).toEqual([{ createdAt: 'desc' }, { id: 'desc' }]);
    expect(page.items.map((m) => m.id)).toEqual([mid(9), mid(10), mid(11)]); // 反转为正序
  });

  it('getMessages 伪造/跨会话游标不越权：where 恒含本会话 conversationId', async () => {
    const { svc, prisma } = make();
    prisma.conversation.findFirst.mockResolvedValue({ id: 'c1', userId: 'u1' });
    prisma.message.findMany.mockResolvedValue([]);
    const foreign = Buffer.from(`${T0.toISOString()}|${mid(1)}`).toString('base64url');
    await svc.getMessages('u1', 'c1', { after: foreign });
    expect(prisma.message.findMany.mock.calls[0][0].where).toMatchObject({ conversationId: 'c1' });
  });

  it('游标正确性：同毫秒数据下逐页翻完 → 无重复、无遗漏、全局有序', async () => {
    const { svc, prisma } = make();
    prisma.conversation.findFirst.mockResolvedValue({ id: 'c1', userId: 'u1' });
    const rows = collisionMessages();
    prisma.message.findMany.mockImplementation(fakeFindMany(rows));

    const seen: string[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 10; page++) {
      const res = await svc.getMessages('u1', 'c1', { limit: 5, ...(cursor ? { after: cursor } : {}) });
      seen.push(...res.items.map((m) => m.id));
      if (!res.meta.hasMore) break;
      expect(res.meta.nextCursor).toBeTruthy();
      cursor = res.meta.nextCursor!;
    }
    expect(seen).toHaveLength(rows.length); // 无重复无遗漏
    expect(new Set(seen).size).toBe(rows.length); // 无重复
    expect(seen).toEqual(rows.map((r) => r.id)); // 全局时间序（同毫秒按 id 全序）
  });

  it('游标正确性（反向）：before 从尾往前逐页 → 同样无重复无遗漏', async () => {
    const { svc, prisma } = make();
    prisma.conversation.findFirst.mockResolvedValue({ id: 'c1', userId: 'u1' });
    const rows = collisionMessages();
    prisma.message.findMany.mockImplementation(fakeFindMany(rows));

    const seen: string[] = [];
    const lastRow = rows[rows.length - 1];
    // 起点：末条消息（before = 严格早于它）
    let cursor: string = encodeCursor(lastRow.createdAt as Date, lastRow.id as string);
    let lastHasMore = true;
    for (let page = 0; page < 10 && lastHasMore; page++) {
      expect(decodeCursor(cursor)).not.toBeNull(); // 每页边界游标都合法（可被 before 解析）
      const res = await svc.getMessages('u1', 'c1', { limit: 5, before: cursor });
      expect(res.items.map((m) => m.createdAt.getTime())).toEqual([...res.items.map((m) => m.createdAt.getTime())].sort((a, b) => a - b)); // 页内恒正序
      seen.unshift(...res.items.map((m) => m.id)); // 反向走 → 前插
      lastHasMore = res.meta.hasMore;
      if (lastHasMore) cursor = res.meta.nextCursor!;
    }
    expect(lastHasMore).toBe(false); // 走到最早一条（无更多）
    expect(seen).toEqual(rows.slice(0, rows.length - 1).map((r) => r.id)); // 末条之外全部，正序无重复无遗漏
  });

  it('软删除：非本人会话 → NOT_FOUND，且无任何副作用（不清理摘要）', async () => {
    const { svc, prisma, summaries } = make();
    prisma.conversation.findFirst.mockResolvedValue(null);
    await expect(svc.softDelete('u1', 'c-other')).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(prisma.conversation.update).not.toHaveBeenCalled();
    expect(summaries.purgeConversation).not.toHaveBeenCalled();
  });

  it('软删除成功：置 deletedAt 后传播清理会话摘要/未提升候选（隐私删除传播）', async () => {
    const { svc, prisma, summaries } = make();
    prisma.conversation.findFirst.mockResolvedValue({ id: 'c1', userId: 'u1' });
    prisma.conversation.update.mockResolvedValue({ id: 'c1' });
    await svc.softDelete('u1', 'c1');
    expect(prisma.conversation.update).toHaveBeenCalledWith({ where: { id: 'c1' }, data: { deletedAt: expect.any(Date) } });
    expect(summaries.purgeConversation).toHaveBeenCalledWith('c1');
  });

  it('软删除：摘要清理失败不回滚会话删除（清理是级联副作用，删除本身已生效）', async () => {
    const { svc, prisma, summaries } = make();
    prisma.conversation.findFirst.mockResolvedValue({ id: 'c1', userId: 'u1' });
    prisma.conversation.update.mockResolvedValue({ id: 'c1' });
    summaries.purgeConversation.mockRejectedValue(new Error('db down'));
    await expect(svc.softDelete('u1', 'c1')).resolves.toBeUndefined();
    expect(prisma.conversation.update).toHaveBeenCalled();
  });
});
