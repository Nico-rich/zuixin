import { describe, it, expect, vi } from 'vitest';
import { DEGRADED_SUMMARY_MARKER, isDegradedSummarySegment, SummaryRefinerService } from './summary-refiner.service';

/**
 * 内存 fake Prisma（只实现本服务用到的语义：会话摘要版本行 / 消息 / 候选 / systemSetting）。
 * 时间递增 1s → 版本与消息次序确定（不依赖真实时钟）。
 */
type Msg = { id: string; conversationId: string; userId: string; role: string; content: string; status: string; createdAt: Date };
type Row = {
  id: string; conversationId: string; summary: string; summarizedThroughMessageId: string | null;
  sourceStartMessageId: string | null; sourceEndMessageId: string | null; tokenCount: number;
  parentSummaryId: string | null; stale: boolean; createdAt: Date; updatedAt: Date;
};
type Cand = { id: string; sourceSummaryId: string | null; status: string };

const T0 = Date.parse('2026-09-28T00:00:00Z');
const at = (sec: number) => new Date(T0 + sec * 1000);

function row(over: Partial<Row> & { id: string; conversationId: string; summary: string }): Row {
  return {
    summarizedThroughMessageId: null, sourceStartMessageId: null, sourceEndMessageId: null,
    tokenCount: 0, parentSummaryId: null, stale: false, createdAt: at(0), updatedAt: at(0), ...over,
  };
}

function makeDb(init: { messages?: Msg[]; summaries?: Row[]; candidates?: Cand[]; threshold?: number } = {}) {
  const messages = [...(init.messages ?? [])];
  const summaries = [...(init.summaries ?? [])];
  const candidates = [...(init.candidates ?? [])];
  let seq = 0;
  let clock = T0 + 100_000; // 新建行时间戳递增（在种子数据之后）
  const nextId = (p: string) => `${p}${++seq}`;
  const nextTime = () => new Date((clock += 1000));

  const orderRows = <T extends { createdAt: Date; id: string }>(rows: T[], orderBy: Array<Record<string, 'asc' | 'desc'>> = []) => {
    const keys = orderBy.flatMap((o) => Object.entries(o));
    return [...rows].sort((a, b) => {
      for (const [k, dir] of keys) {
        const av = (a as unknown as Record<string, unknown>)[k];
        const bv = (b as unknown as Record<string, unknown>)[k];
        const cmp = av === bv ? 0 : (av as never) < (bv as never) ? -1 : 1;
        if (cmp) return dir === 'asc' ? cmp : -cmp;
      }
      return 0;
    });
  };

  // 与 Prisma where 语义对齐（仅本服务用到的算子：等值 / in / gt / gte / lte / OR）
  const match = (m: Record<string, unknown>, where: Record<string, unknown>): boolean => {
    for (const [key, cond] of Object.entries(where)) {
      if (key === 'OR') {
        if (!(cond as Array<Record<string, unknown>>).some((c) => match(m, c))) return false;
        continue;
      }
      const value = m[key];
      if (cond && typeof cond === 'object' && !(cond instanceof Date)) {
        const c = cond as { in?: unknown[]; gt?: Date; gte?: Date; lte?: Date };
        if (c.in && !c.in.includes(value)) return false;
        if (c.gt && !((value as Date) > c.gt)) return false;
        if (c.gte && !((value as Date) >= c.gte)) return false;
        if (c.lte && !((value as Date) <= c.lte)) return false;
      } else if (value !== cond) {
        return false;
      }
    }
    return true;
  };

  const prisma = {
    // M10 Final Audit H4：maybeRefine 计量上下文查找（归属随真实会话行解析）
    conversation: {
      findUnique: vi.fn(async () => ({ userId: 'u1', projectId: null })),
    },
    message: {
      create: vi.fn(),
      findMany: vi.fn(async ({ where, orderBy, take }: { where: Record<string, unknown>; orderBy: Array<Record<string, 'asc' | 'desc'>>; take?: number }) => {
        const rows = orderRows(messages.filter((m) => match(m as unknown as Record<string, unknown>, where)), orderBy);
        return (take ? rows.slice(0, take) : rows) as unknown as Msg[];
      }),
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => messages.find((m) => m.id === where.id) ?? null),
    },
    conversationSummary: {
      findMany: vi.fn(async ({ where, orderBy, take }: { where: Record<string, unknown>; orderBy: Array<Record<string, 'asc' | 'desc'>>; take?: number }) => {
        const rows = orderRows(summaries.filter((s) => match(s as unknown as Record<string, unknown>, where)), orderBy);
        return (take ? rows.slice(0, take) : rows) as Row[];
      }),
      findFirst: vi.fn(async ({ where, orderBy }: { where: Record<string, unknown>; orderBy: Array<Record<string, 'asc' | 'desc'>> }) =>
        orderRows(summaries.filter((s) => match(s as unknown as Record<string, unknown>, where)), orderBy)[0] ?? null),
      create: vi.fn(async ({ data }: { data: Partial<Row> & { conversationId: string; summary: string } }) => {
        const created = row({ id: nextId('s'), createdAt: nextTime(), updatedAt: nextTime(), ...data } as Row & { conversationId: string; summary: string });
        summaries.push(created);
        return created;
      }),
      updateMany: vi.fn(async ({ where, data }: { where: { conversationId: string; id: { in: string[] }; stale?: boolean }; data: Partial<Row> }) => {
        const hit = summaries.filter((s) => s.conversationId === where.conversationId && where.id.in.includes(s.id) && (where.stale === undefined || s.stale === where.stale));
        hit.forEach((s) => Object.assign(s, data));
        return { count: hit.length };
      }),
      deleteMany: vi.fn(async ({ where }: { where: { conversationId: string } }) => {
        const doomed = summaries.filter((s) => s.conversationId === where.conversationId);
        for (const s of doomed) summaries.splice(summaries.indexOf(s), 1);
        return { count: doomed.length };
      }),
      delete: vi.fn(async ({ where }: { where: { id: string } }) => {
        const i = summaries.findIndex((s) => s.id === where.id);
        const [removed] = summaries.splice(i, 1);
        return removed;
      }),
    },
    memoryCandidate: {
      // sourceSummaryId 既可能是等值（rollback 单版本）也可能是 in（purgeFrom 多版本）
      deleteMany: vi.fn(async ({ where }: { where: { sourceSummaryId: string | { in: string[] }; status?: string } }) => {
        const target = where.sourceSummaryId;
        const hits = (id: string | null) => (typeof target === 'string' ? id === target : Boolean(id && target.in.includes(id)));
        const doomed = candidates.filter((c) => hits(c.sourceSummaryId) && (where.status === undefined || c.status === where.status));
        for (const c of doomed) candidates.splice(candidates.indexOf(c), 1);
        return { count: doomed.length };
      }),
    },
    systemSetting: {
      findUnique: vi.fn(async () => ({ key: 'limits', value: { summaryRefineThreshold: init.threshold ?? 6 } })),
    },
  };
  return { prisma, messages, summaries, candidates };
}

function makeRefiner(db: ReturnType<typeof makeDb>, llmReply: string | Error = '增量摘要') {
  const chat = vi.fn(async () => {
    if (llmReply instanceof Error) throw llmReply;
    return { content: llmReply };
  });
  const modelResolver = { resolveDefaultLLM: vi.fn().mockResolvedValue({ adapter: { chat }, apiModelId: 'm', providerId: 'p', modelId: 'mid' }) };
  // M10 Final Audit H4：UsageService 注入（摘要 LLM 计量；单测断言计量调用）
  const usage = { recordChatUsage: vi.fn().mockResolvedValue(undefined) };
  return { svc: new SummaryRefinerService(db.prisma as never, modelResolver as never, usage as never), chat, modelResolver, usage };
}

const msg = (id: string, role: 'user' | 'assistant', content: string, sec: number): Msg =>
  ({ id, conversationId: 'c1', userId: 'u1', role, content, status: 'completed', createdAt: at(sec) });

/** 连续 N 条消息（user/assistant 交替），从 fromSec 起 */
const segment = (n: number, fromSec: number, fromIdx = 1): Msg[] =>
  Array.from({ length: n }, (_, i) => msg(`m${fromIdx + i}`, i % 2 === 0 ? 'user' : 'assistant', `内容${fromIdx + i}`, fromSec + i));

const CONV = 'c1';
/** 追加一段新消息（模拟对话继续：一次 refine 只覆盖当次可见的连续消息段） */
const append = (db: ReturnType<typeof makeDb>, n: number, fromSec: number, fromIdx: number) => {
  db.messages.push(...segment(n, fromSec, fromIdx));
};

describe('SummaryRefinerService（增量摘要版本链）', () => {
  it('未达阈值：不建版本行，pendingMessages 记录待摘要消息数', async () => {
    const db = makeDb({ messages: segment(4, 0) });
    const { svc, chat } = makeRefiner(db);
    const r = await svc.maybeRefine(CONV);
    expect(r.created).toEqual([]);
    expect(r.pendingMessages).toBe(4);
    expect(db.summaries).toHaveLength(0);
    expect(chat).not.toHaveBeenCalled(); // 未达阈值不调 LLM
  });

  it('达阈值：建首版（覆盖 sourceStart..sourceEnd、无 parent、tokenCount 记录）', async () => {
    const db = makeDb({ messages: segment(6, 0) });
    const { svc } = makeRefiner(db, '首批摘要文本');
    const r = await svc.maybeRefine(CONV);
    expect(r.created).toHaveLength(1);
    const v1 = db.summaries[0];
    expect(v1.summary).toBe('首批摘要文本');
    expect(v1.sourceStartMessageId).toBe('m1');
    expect(v1.sourceEndMessageId).toBe('m6');
    expect(v1.summarizedThroughMessageId).toBe('m6');
    expect(v1.parentSummaryId).toBeNull();
    expect(v1.tokenCount).toBeGreaterThan(0);
    expect(v1.stale).toBe(false);
  });

  it('并发保护（乐观 CAS）：LLM 提炼期间链头已被推进 → 放弃本次建段，不重复覆盖同一区间', async () => {
    const db = makeDb({ messages: segment(6, 0) });
    const { svc, chat } = makeRefiner(db, '首批');
    // 模拟并发写入者：LLM 调用期间另一次 refine 已建段（链头变化）
    chat.mockImplementation(async () => {
      db.summaries.push(row({ id: 's-concurrent', conversationId: CONV, summary: '并发生成的段' }));
      return { content: '首批' };
    });
    const r = await svc.maybeRefine(CONV);
    expect(r.created).toEqual([]);
    expect(db.summaries.map((s) => s.id)).toEqual(['s-concurrent']); // 未重复建段
  });

  it('增量链：第二版链上前版，文本 = 前版全文 + 新增段（追加不变式），区间不重叠', async () => {
    const db = makeDb({ messages: segment(6, 0) });
    await makeRefiner(db, '首批摘要文本').svc.maybeRefine(CONV); // v1 覆盖 m1..m6
    append(db, 6, 6, 7); // 对话继续：m7..m12
    const second = makeRefiner(db, '第二批摘要文本');
    const r = await second.svc.maybeRefine(CONV);
    expect(r.created).toHaveLength(1);
    const [v1, v2] = db.summaries;
    expect(v2.parentSummaryId).toBe(v1.id);
    expect(v2.sourceStartMessageId).toBe('m7');
    expect(v2.sourceEndMessageId).toBe('m12');
    expect(v2.summary).toBe('首批摘要文本\n第二批摘要文本'); // 追加，不是覆盖
    expect(v2.tokenCount).toBeGreaterThan(v1.tokenCount);

    // latestUsable：最新版本 + 版本段（最早→最新）→ 供上下文按段裁剪
    const chain = await second.svc.latestUsable(CONV);
    expect(chain!.summaryId).toBe(v2.id);
    expect(chain!.version).toBe(2);
    expect(chain!.segments).toEqual(['首批摘要文本', '第二批摘要文本']);
    expect(chain!.text).toBe(v2.summary);
  });

  it('LLM 回显前版全文 → 截掉回显，只保留增量（不重复膨胀）', async () => {
    const db = makeDb({ messages: segment(6, 0) });
    await makeRefiner(db, '首批摘要文本').svc.maybeRefine(CONV);
    append(db, 6, 6, 7);
    const { svc } = makeRefiner(db, '首批摘要文本\n第二批摘要文本');
    await svc.maybeRefine(CONV);
    expect(db.summaries[1].summary).toBe('首批摘要文本\n第二批摘要文本');
  });

  it('LLM 失败 → 确定性兜底段（仅由真实消息行压缩，绝不引入摘要自身）', async () => {
    const db = makeDb({ messages: segment(6, 0) });
    const { svc } = makeRefiner(db, new Error('provider down'));
    const r = await svc.maybeRefine(CONV);
    expect(r.created).toHaveLength(1);
    const v1 = db.summaries[0];
    expect(v1.summary).toContain('摘要降级');
    expect(v1.summary).toContain('内容1');
    expect(v1.summary).toContain('用户：');
    expect(v1.tokenCount).toBeGreaterThan(0);
  });

  it('D29：兜底段 = 显式降级标记；latestUsable 报 degraded=true（正常摘要为 false）', async () => {
    const degradedDb = makeDb({ messages: segment(6, 0) });
    const degraded = makeRefiner(degradedDb, new Error('provider down'));
    await degraded.svc.maybeRefine(CONV);
    const withFallback = await degraded.svc.latestUsable(CONV);
    expect(withFallback!.segments[0].startsWith(DEGRADED_SUMMARY_MARKER)).toBe(true);
    expect(withFallback!.degraded).toBe(true);

    const normalDb = makeDb({ messages: segment(6, 0) });
    const normal = makeRefiner(normalDb, '正常摘要');
    await normal.svc.maybeRefine(CONV);
    expect((await normal.svc.latestUsable(CONV))!.degraded).toBe(false);
  });

  it('D29：降级段之后追加正常段 → 链整体仍按降级处理（保守，绝不与正常摘要同权）', async () => {
    const db = makeDb({ messages: segment(6, 0) });
    await makeRefiner(db, new Error('provider down')).svc.maybeRefine(CONV); // v1 = 兜底段
    append(db, 6, 6, 7);
    await makeRefiner(db, '正常增量摘要').svc.maybeRefine(CONV); // v2 = 正常段（追加在降级段之后）
    const chain = await makeRefiner(db).svc.latestUsable(CONV);
    expect(chain!.segments).toHaveLength(2);
    expect(chain!.segments[1]).not.toContain(DEGRADED_SUMMARY_MARKER);
    expect(chain!.degraded).toBe(true);
  });

  it('D29：isDegradedSummarySegment 只认段首标记（正文里提到标记不算降级）', () => {
    expect(isDegradedSummarySegment(DEGRADED_SUMMARY_MARKER)).toBe(true);
    expect(isDegradedSummarySegment(`\n ${DEGRADED_SUMMARY_MARKER}\n用户：内容1`)).toBe(true); // 容错前导空白
    expect(isDegradedSummarySegment('用户偏好黑金配色')).toBe(false);
    expect(isDegradedSummarySegment(`前文提到的${DEGRADED_SUMMARY_MARKER}不算降级`)).toBe(false);
  });

  it('防循环污染：摘要过程绝不写 Message 表（摘要不回流成对话输入）', async () => {
    const db = makeDb({ messages: segment(6, 0) });
    const { svc } = makeRefiner(db, '摘要');
    await svc.maybeRefine(CONV);
    expect(db.prisma.message.create).not.toHaveBeenCalled();
    expect(db.messages).toHaveLength(6);
  });

  it('阈值来自 limits.summaryRefineThreshold（服务端配置）', async () => {
    const db = makeDb({ messages: segment(2, 0), threshold: 2 });
    const { svc } = makeRefiner(db, '摘要');
    const r = await svc.maybeRefine(CONV);
    expect(r.created).toHaveLength(1);
    expect(db.summaries[0].sourceEndMessageId).toBe('m2');
  });

  it('已覆盖区间不重复覆盖：新消息未达阈值 → 无新版本', async () => {
    const db = makeDb({ messages: segment(6, 0) });
    await makeRefiner(db, '首批').svc.maybeRefine(CONV);
    append(db, 2, 6, 7);
    const r = await makeRefiner(db, '第二批').svc.maybeRefine(CONV);
    expect(r.created).toEqual([]);
    expect(r.pendingMessages).toBe(2);
    expect(db.summaries).toHaveLength(1);
  });

  it('回滚：删除最新版 → 前版恢复为 current；同时清理该版未提升候选', async () => {
    const db = makeDb({
      messages: segment(6, 0),
      candidates: [
        { id: 'cand1', sourceSummaryId: 's-v1', status: 'candidate' },
        { id: 'cand2', sourceSummaryId: 's-v1', status: 'active' },
      ],
    });
    const first = makeRefiner(db, '首批');
    await first.svc.maybeRefine(CONV);
    const v1 = db.summaries[0];
    append(db, 6, 6, 7);
    await makeRefiner(db, '第二批').svc.maybeRefine(CONV);
    expect(db.summaries).toHaveLength(2);
    const v2 = db.summaries[1];
    db.candidates.push({ id: 'cand3', sourceSummaryId: v2.id, status: 'candidate' });

    const { svc } = makeRefiner(db, 'x');
    const r = await svc.rollback(CONV);
    expect(r.removedId).toBe(v2.id);
    expect(r.current!.id).toBe(v1.id);
    expect(r.removedCandidates).toBe(1);
    expect(db.candidates.map((c) => c.id)).toEqual(['cand1', 'cand2']); // 已提升/不相关候选不受影响
    const now = await svc.current(CONV);
    expect(now!.id).toBe(v1.id); // 前版恢复为 current（唯一约束已移除 → 必须取最新版）
  });

  it('陈旧标记：区间内消息被编辑/删除 → 该版本及其后代标 stale', async () => {
    const db = makeDb({ messages: segment(6, 0) });
    await makeRefiner(db, '首批').svc.maybeRefine(CONV);
    append(db, 6, 6, 7);
    await makeRefiner(db, '第二批').svc.maybeRefine(CONV);
    const { svc } = makeRefiner(db, 'x');
    const marked = await svc.markStale(CONV, ['m3']); // m3 落在 v1 区间 → v1 + 其后代 v2 都陈旧
    expect(marked).toBe(2);
    expect(db.summaries.every((s) => s.stale)).toBe(true);
    // 全部陈旧 → 无可信版本进上下文
    expect(await svc.latestUsable(CONV)).toBeNull();
  });

  it('陈旧检测：锚点消息被删除 → detectStale 自动标记（含后代）', async () => {
    const db = makeDb({ messages: segment(6, 0) });
    await makeRefiner(db, '首批').svc.maybeRefine(CONV);
    append(db, 6, 6, 7);
    await makeRefiner(db, '第二批').svc.maybeRefine(CONV);
    // 删除 v2 的结束锚点（模拟消息被删除）
    const idx = db.messages.findIndex((m) => m.id === 'm12');
    db.messages.splice(idx, 1);
    const { svc } = makeRefiner(db, 'x');
    expect(await svc.detectStale(CONV)).toBe(1); // 只有 v2 的锚点丢失；v1 区间完好
    expect(db.summaries[0].stale).toBe(false);
    expect(db.summaries[1].stale).toBe(true);
    expect((await svc.latestUsable(CONV))!.summaryId).toBe(db.summaries[0].id); // 回退到前版
  });

  it('重算：删除陈旧版及其后代 → 从存活链头强制重建（不重复覆盖）', async () => {
    const db = makeDb({ messages: segment(6, 0) });
    await makeRefiner(db, '首批').svc.maybeRefine(CONV);
    append(db, 6, 6, 7);
    await makeRefiner(db, '第二批').svc.maybeRefine(CONV);
    const v1 = db.summaries[0];
    db.summaries[1].stale = true; // v2 区间被污染
    const { svc } = makeRefiner(db, '重算后的第二批');
    const r = await svc.recomputeStale(CONV);
    expect(r.removed).toBe(1);
    expect(r.created).toHaveLength(1);
    expect(db.summaries).toHaveLength(2);
    const rebuilt = db.summaries[1];
    expect(rebuilt.parentSummaryId).toBe(v1.id);
    expect(rebuilt.sourceStartMessageId).toBe('m7');
    expect(rebuilt.sourceEndMessageId).toBe('m12');
    expect(rebuilt.summary).toBe(`首批\n重算后的第二批`);
    expect(rebuilt.stale).toBe(false);
  });

  it('隐私删除传播：purgeConversation 清空版本链 + 未提升候选（已提升候选保留）', async () => {
    const db = makeDb({
      messages: segment(6, 0),
      candidates: [
        { id: 'cand1', sourceSummaryId: 's-v1', status: 'candidate' },
        { id: 'cand2', sourceSummaryId: 's-v1', status: 'active' },
      ],
    });
    await makeRefiner(db, '首批').svc.maybeRefine(CONV);
    const v1 = db.summaries[0];
    db.candidates.push({ id: 'cand3', sourceSummaryId: v1.id, status: 'candidate' });
    const { svc } = makeRefiner(db, 'x');
    const r = await svc.purgeConversation(CONV);
    expect(r).toEqual({ summaries: 1, candidates: 1 });
    expect(db.summaries).toHaveLength(0);
    expect(db.candidates.map((c) => c.id)).toEqual(['cand1', 'cand2']); // 已提升候选不受影响
    expect(await svc.current(CONV)).toBeNull();
  });

  it('隐私删除传播：无摘要的会话 purge 为无副作用空操作', async () => {
    const db = makeDb({});
    const { svc } = makeRefiner(db, 'x');
    expect(await svc.purgeConversation(CONV)).toEqual({ summaries: 0, candidates: 0 });
  });

  it('锚点丢失：链头锚点被删 → 整链标陈旧（等待重算），不新建错位版本', async () => {
    const db = makeDb({ messages: segment(6, 0) });
    await makeRefiner(db, '首批').svc.maybeRefine(CONV);
    append(db, 6, 6, 7);
    db.messages.splice(db.messages.findIndex((m) => m.id === 'm6'), 1); // 删除链头锚点
    const { svc } = makeRefiner(db, '第二批');
    const r = await svc.maybeRefine(CONV);
    expect(r.created).toEqual([]);
    expect(db.summaries[0].stale).toBe(true);
  });
});
