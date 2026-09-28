/**
 * M10-P3（ARCH-11）游标分页基元：**(时间戳, id) 复合游标**。
 *
 * 为什么必须是复合游标：PostgreSQL 的时间列在本 schema 下是毫秒精度（Prisma DateTime → timestamp(3)），
 * 同一毫秒可以插入多行（会话内 user/assistant 两条消息相邻写入）。单列时间游标在毫秒边界上
 * 有并列值 → 翻页会**重复或遗漏**。复合游标配合 `orderBy: [{ ts }, { id }]` 给出**全序**，
 * 保证"无重复无遗漏"。
 *
 * 编码：base64url(`<ISO 时间>|<uuid>`)。游标是**纯位置标记**，不含任何权限语义——
 * 查询的硬条件永远是调用方 scope（conversationId / userId），伪造或借用他人游标只能得到
 * "自己数据内的错误位置"，不构成越权读取面（见 conversations.service 的 where 构造）。
 *
 * 解析严格性：非规范编码（非法 base64 / 非法时间 / 非 uuid / 非规范 ISO 形态）一律返回 null，
 * 由调用方转 400 VALIDATION_ERROR——绝不"尽力解析"出一个可能错位的边界。
 */

/** Prisma 生成的 id 恒为小写 uuid v4 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** 编码后长度上限（ISO 24 + '|' + uuid 36 = 61 → base64url 82；留裕量） */
const MAX_CURSOR_CHARS = 200;

export interface PageCursor {
  /** 排序时间列（消息 createdAt / 会话 updatedAt） */
  at: Date;
  id: string;
}

export function encodeCursor(at: Date, id: string): string {
  return Buffer.from(`${at.toISOString()}|${id}`, 'utf8').toString('base64url');
}

export function decodeCursor(raw: string): PageCursor | null {
  if (typeof raw !== 'string' || !raw || raw.length > MAX_CURSOR_CHARS) return null;
  let text: string;
  try {
    text = Buffer.from(raw, 'base64url').toString('utf8');
  } catch {
    return null;
  }
  const sep = text.indexOf('|');
  if (sep <= 0) return null;
  const at = new Date(text.slice(0, sep));
  const id = text.slice(sep + 1);
  if (Number.isNaN(at.getTime()) || !UUID_RE.test(id)) return null;
  // 规范化回验：拒绝 '2026-01-01' / 非规范 base64 变体等可产生歧义的输入
  if (encodeCursor(at, id) !== raw) return null;
  return { at, id };
}

export type PageDirection = 'first' | 'after' | 'before';

export interface PageQuery {
  limit?: number;
  after?: string;
  before?: string;
}

export interface PageWindow {
  /** 页码方向：首页 / 游标之后（更新的一侧）/ 游标之前（更早的一侧） */
  direction: PageDirection;
  cursor: PageCursor | null;
  limit: number;
}

export interface PageMeta {
  /** 本页条数 */
  limit: number;
  /** 是否还有更多（按请求方向） */
  hasMore: boolean;
  /** 请求方向上的下一页游标（本页最后一条）；无更多时为 null */
  nextCursor: string | null;
  /** 反方向的下一页游标（本页第一条）；用于"往回翻" */
  prevCursor: string | null;
  /** 本页排序方向（恒为请求方向的正序语义，便于客户端直接拼接渲染） */
  order: 'asc' | 'desc';
}

/**
 * 解析分页窗口：默认 `limit` 由调用方给出（保持各端点原有上限，向后兼容）。
 * before/after 由 zod 层保证互斥（同时给出 → 400）。
 */
export function resolveWindow(query: PageQuery, defaultLimit: number, maxLimit = 200): PageWindow {
  const limit = query.limit ?? defaultLimit;
  const after = query.after ? decodeCursor(query.after) : null;
  const before = query.before ? decodeCursor(query.before) : null;
  if (after) return { direction: 'after', cursor: after, limit: Math.min(limit, maxLimit) };
  if (before) return { direction: 'before', cursor: before, limit: Math.min(limit, maxLimit) };
  return { direction: 'first', cursor: null, limit: Math.min(limit, maxLimit) };
}

/**
 * 由"按取数方向排好序、且多取了一条"的行集构造一页 + 元数据：
 * - `hasMore` 由 `行数 > limit` 判定（避免额外 count 查询，多取的一条即探针）；
 * - `nextCursor` = 本页**最后一条**（沿取数方向继续翻页）；
 * - `prevCursor` = 本页**第一条**（往回翻）；
 * - `reverse=true` 时返回数组反转（`before` 方向取数用 desc，返回仍按端点惯用方向给出）。
 */
export function buildPage<T extends { id: string }>(
  fetched: T[],
  limit: number,
  reverse: boolean,
  /** 取一行的排序时间列 */
  at: (row: T) => Date,
  /** 返回数组的排序方向（端点惯用方向，恒定） */
  order: 'asc' | 'desc',
): { items: T[]; meta: PageMeta } {
  const hasMore = fetched.length > limit;
  const page = hasMore ? fetched.slice(0, limit) : fetched;
  const items = reverse ? [...page].reverse() : page;
  const head = page.at(0);
  const tail = page.at(-1);
  return {
    items,
    meta: {
      limit,
      hasMore,
      nextCursor: hasMore && tail ? encodeCursor(at(tail), tail.id) : null,
      prevCursor: head ? encodeCursor(at(head), head.id) : null,
      order,
    },
  };
}

/**
 * 复合游标的**严格**比较条件（配合 `orderBy: [{field},{id}]`）：`asc=true` → 取游标之后，
 * `asc=false` → 取游标之前。边界行（= 游标自身）两侧都不含 → 无重复；相邻页首尾相接 → 无遗漏。
 */
export function cursorFilter(
  field: 'createdAt' | 'updatedAt',
  cursor: PageCursor,
  asc: boolean,
): Record<string, unknown>[] {
  const cmp = asc ? 'gt' : 'lt';
  return [
    { [field]: { [cmp]: cursor.at } },
    { [field]: cursor.at, id: { [cmp]: cursor.id } },
  ];
}
