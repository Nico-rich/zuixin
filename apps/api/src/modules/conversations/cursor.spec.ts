import { describe, it, expect, vi } from 'vitest';
import { buildPage, cursorFilter, decodeCursor, encodeCursor, resolveWindow } from './cursor';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';

describe('cursor：复合游标编解码', () => {
  it('round-trip：编码后可无损解出同一 (时间, id)', () => {
    const at = new Date('2026-09-28T10:00:00.123Z');
    const raw = encodeCursor(at, A);
    expect(raw).not.toContain('|'); // base64url 不暴露裸分隔符
    expect(decodeCursor(raw)).toEqual({ at, id: A });
  });

  it('毫秒精度保留（同毫秒不同 id 是游标正确性的关键场景）', () => {
    const at = new Date('2026-09-28T10:00:00.123Z');
    expect(decodeCursor(encodeCursor(at, A))!.at.getTime()).toBe(at.getTime());
    expect(decodeCursor(encodeCursor(at, B))!.id).toBe(B);
  });

  it.each([
    ['空串', ''],
    ['非 base64 文本', '!!!not-a-cursor!!!'],
    ['缺分隔符', Buffer.from('2026-09-28T10:00:00.123Z').toString('base64url')],
    ['时间非法', Buffer.from(`not-a-date|${A}`).toString('base64url')],
    ['id 非 uuid', Buffer.from('2026-09-28T10:00:00.123Z|m1').toString('base64url')],
    ['非规范 ISO（会解析成另一个瞬间）', Buffer.from(`2026-09-28|${A}`).toString('base64url')],
    ['超长', 'a'.repeat(201)],
  ])('非法输入 → null（%s）', (_label, raw) => {
    expect(decodeCursor(raw)).toBeNull();
  });

  it('规范化回验：等价但非规范的 base64 变体被拒绝（绝不"尽力解析"）', () => {
    const raw = encodeCursor(new Date('2026-09-28T10:00:00.123Z'), A);
    const withPadding = `${raw}==`;
    expect(decodeCursor(withPadding)).toBeNull();
  });
});

describe('cursor：游标比较条件（严格 >/<，边界行两侧都不含）', () => {
  const cursor = { at: new Date('2026-09-28T10:00:00.000Z'), id: A };

  it('asc → 严格大于（同毫秒用 id 兜底）', () => {
    expect(cursorFilter('createdAt', cursor, true)).toEqual([
      { createdAt: { gt: cursor.at } },
      { createdAt: cursor.at, id: { gt: A } },
    ]);
  });

  it('desc → 严格小于', () => {
    expect(cursorFilter('updatedAt', cursor, false)).toEqual([
      { updatedAt: { lt: cursor.at } },
      { updatedAt: cursor.at, id: { lt: A } },
    ]);
  });
});

describe('cursor：窗口解析', () => {
  it('无游标 → first（沿用端点默认条数，向后兼容）', () => {
    expect(resolveWindow({}, 200)).toEqual({ direction: 'first', cursor: null, limit: 200 });
  });

  it('after / before 解析出对应方向', () => {
    const at = new Date('2026-09-28T10:00:00.000Z');
    expect(resolveWindow({ after: encodeCursor(at, A) }, 50).direction).toBe('after');
    expect(resolveWindow({ before: encodeCursor(at, A) }, 50).direction).toBe('before');
  });

  it('after 优先于 before（DTO 层已保证互斥，服务层仍取确定语义）', () => {
    const at = new Date('2026-09-28T10:00:00.000Z');
    const w = resolveWindow({ after: encodeCursor(at, A), before: encodeCursor(at, B) }, 50);
    expect(w.direction).toBe('after');
  });

  it('limit 上界收敛到 200（防单页拖库）', () => {
    expect(resolveWindow({ limit: 10_000 }, 50).limit).toBe(200);
  });
});

describe('cursor：buildPage 元数据', () => {
  const rows = (n: number) =>
    Array.from({ length: n }, (_, i) => ({ id: `${i}${A.slice(1)}`, createdAt: new Date(1_700_000_000_000 + i) }));
  const at = (r: { createdAt: Date }) => r.createdAt;

  it('多取一条 → hasMore=true 且被裁掉；nextCursor 指向本页最后一条', () => {
    const { items, meta } = buildPage(rows(4), 3, false, at, 'asc');
    expect(items).toHaveLength(3);
    expect(items.map((r) => r.createdAt.getTime())).toEqual([1_700_000_000_000, 1_700_000_000_001, 1_700_000_000_002]);
    expect(meta.hasMore).toBe(true);
    expect(meta.nextCursor).toBe(encodeCursor(items[2].createdAt, items[2].id));
    expect(meta.prevCursor).toBe(encodeCursor(items[0].createdAt, items[0].id));
    expect(meta.order).toBe('asc');
  });

  it('恰好取满（无多取行）→ hasMore=false 且 nextCursor=null（不误导客户端再翻）', () => {
    const { items, meta } = buildPage(rows(3), 3, false, at, 'asc');
    expect(items).toHaveLength(3);
    expect(meta.hasMore).toBe(false);
    expect(meta.nextCursor).toBeNull();
  });

  it('reverse=true → 返回数组反转（before 方向取数 desc，返回仍按 asc），游标仍指向取数方向末端', () => {
    const fetched = [...rows(4)].reverse(); // 模拟 desc 取数：4,3,2,1
    const { items, meta } = buildPage(fetched, 3, true, at, 'asc');
    expect(items.map((r) => r.createdAt.getTime())).toEqual([1_700_000_000_001, 1_700_000_000_002, 1_700_000_000_003]);
    // 继续往回翻的边界 = 取数方向的最后一条（= 本页最早一条）
    expect(meta.nextCursor).toBe(encodeCursor(fetched[2].createdAt, fetched[2].id));
    expect(meta.prevCursor).toBe(encodeCursor(fetched[0].createdAt, fetched[0].id));
  });

  it('空页：无游标可用（全部 null），不抛错', () => {
    const { items, meta } = buildPage([], 10, false, at, 'asc');
    expect(items).toEqual([]);
    expect(meta).toMatchObject({ hasMore: false, nextCursor: null, prevCursor: null, limit: 10 });
  });

  it('不修改入参数组（freeze 输入亦可）', () => {
    const input = rows(4);
    const snapshot = input.map((r) => r.id);
    buildPage(input, 2, false, at, 'asc');
    expect(input.map((r) => r.id)).toEqual(snapshot);
  });

  it('时间列取值器被逐行调用（不硬编码字段名）', () => {
    const probe = vi.fn((r: { createdAt: Date }) => r.createdAt);
    buildPage(rows(2), 2, false, probe, 'asc');
    expect(probe).toHaveBeenCalled();
  });
});
