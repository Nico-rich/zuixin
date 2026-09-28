import { describe, it, expect, vi } from 'vitest';
import { MemoryCandidateService } from './memory-candidate.service';

/** 内存 fake Prisma（只实现本服务用到的语义；时间递增保证次序确定） */
type CandRow = {
  id: string; userId: string; projectId: string | null; sourceSummaryId: string | null;
  content: string; category: string; importance: number; confidence: number;
  status: string; createdAt: Date; promotedAt: Date | null;
};
type MemRow = {
  id: string; userId: string; scope: string; projectId: string | null; content: string; category: string;
  importance: number; confidence: number | null; status: string; source: string | null;
  sourceMessageId: string | null; metadata: unknown; createdAt: Date;
};
type MsgRow = { id: string; conversationId: string; userId: string; role: string; content: string; status: string; createdAt: Date };

const T0 = Date.parse('2026-09-28T00:00:00Z');
const at = (sec: number) => new Date(T0 + sec * 1000);

function makeDb(init: {
  summary?: Partial<{ id: string; conversationId: string; summary: string; sourceStartMessageId: string | null; sourceEndMessageId: string | null; stale: boolean }>;
  messages?: MsgRow[];
  memories?: MemRow[];
  candidates?: CandRow[];
  dailyLimit?: number;
  memoryUsedToday?: number;
} = {}) {
  let seq = 0;
  let clock = T0 + 100_000;
  const nextTime = () => new Date((clock += 1000));
  const summary = init.summary
    ? { summarizedThroughMessageId: null, tokenCount: 0, parentSummaryId: null, stale: false, createdAt: at(0), updatedAt: at(0), ...init.summary }
    : null;
  const messages = [...(init.messages ?? [])];
  const memories = [...(init.memories ?? [])];
  const candidates = [...(init.candidates ?? [])];
  const conversations = [{ id: 'conv1', userId: 'u1', projectId: 'p1' }];

  const match = (m: Record<string, unknown>, where: Record<string, unknown>): boolean => {
    for (const [key, cond] of Object.entries(where)) {
      const value = m[key];
      if (cond && typeof cond === 'object' && !(cond instanceof Date)) {
        const c = cond as { in?: unknown[]; gte?: Date; lte?: Date };
        if (c.in && !c.in.includes(value)) return false;
        if (c.gte && !((value as Date) >= c.gte)) return false;
        if (c.lte && !((value as Date) <= c.lte)) return false;
      } else if (value !== cond) {
        return false;
      }
    }
    return true;
  };

  const prisma = {
    conversationSummary: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => (summary && summary.id === where.id ? summary : null)),
    },
    conversation: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => conversations.find((c) => c.id === where.id) ?? null),
    },
    message: {
      findMany: vi.fn(async ({ where }: { where: Record<string, unknown> }) =>
        messages.filter((m) => match(m as unknown as Record<string, unknown>, where)).map((m) => ({ ...m }))),
    },
    memoryCandidate: {
      count: vi.fn(async ({ where }: { where: Record<string, unknown> }) => candidates.filter((c) => match(c as unknown as Record<string, unknown>, where)).length),
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => candidates.find((c) => c.id === where.id) ?? null),
      create: vi.fn(async ({ data }: { data: Partial<CandRow> }) => {
        const created = { id: `cand${++seq}`, createdAt: nextTime(), promotedAt: null, ...data } as CandRow;
        candidates.push(created);
        return created;
      }),
      update: vi.fn(async ({ where, data }: { where: { id: string }; data: Partial<CandRow> }) => {
        const row = candidates.find((c) => c.id === where.id)!;
        Object.assign(row, data);
        return row;
      }),
    },
    memory: {
      count: vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
        if (where.createdAt) return init.memoryUsedToday ?? 0; // 今日已用（每日上限）
        return memories.filter((m) => match(m as unknown as Record<string, unknown>, where)).length;
      }),
      create: vi.fn(async ({ data }: { data: Partial<MemRow> }) => {
        const created = { id: `mem${++seq}`, createdAt: nextTime(), ...data } as MemRow;
        memories.push(created);
        return created;
      }),
    },
    systemSetting: {
      findUnique: vi.fn(async () => ({ key: 'limits', value: { dailyMemoryCandidates: init.dailyLimit ?? 20 } })),
    },
  };
  return { prisma, memories, candidates, summary };
}

const msg = (id: string, role: 'user' | 'assistant', content: string, sec: number): MsgRow =>
  ({ id, conversationId: 'conv1', userId: 'u1', role, content, status: 'completed', createdAt: at(sec) });

const REAL_MESSAGES = [
  msg('m1', 'user', '以后亚马逊主图都按照 2000×2000 做', 0),
  msg('m2', 'assistant', '好的，已记录', 1),
];
const SUMMARY_TEXT = '这是摘要文本：用户偏好黑金配色（不得进入提炼输入）';

function makeService(db: ReturnType<typeof makeDb>, llmReply: string | Error = JSON.stringify({ memories: [] })) {
  const chat = vi.fn(async (_params: { messages: Array<{ role: string; content: string }> }) => {
    if (llmReply instanceof Error) throw llmReply;
    return { content: llmReply };
  });
  const modelResolver = { resolveDefaultLLM: vi.fn().mockResolvedValue({ adapter: { chat }, apiModelId: 'm' }) };
  const summaryRefiner = { markStale: vi.fn().mockResolvedValue(1), current: vi.fn(), latestUsable: vi.fn() };
  const svc = new MemoryCandidateService(db.prisma as never, modelResolver as never, summaryRefiner as never);
  return { svc, chat, summaryRefiner, modelResolver };
}

function makeDbWithInterval(over: Parameters<typeof makeDb>[0] = {}) {
  return makeDb({
    summary: {
      id: 'sum1', conversationId: 'conv1', summary: SUMMARY_TEXT,
      sourceStartMessageId: 'm1', sourceEndMessageId: 'm2', ...(over.summary ?? {}),
    },
    messages: REAL_MESSAGES,
    ...over,
  });
}

const item = (over: Partial<{ content: string; category: string; importance: number; confidence: number }> = {}) => ({
  content: '用户偏好亚马逊主图 2000×2000', category: 'preference', importance: 80, confidence: 0.9, ...over,
});

describe('MemoryCandidateService（三态提炼，防循环污染）', () => {
  it('提炼输入只含真实对话行，摘要文本绝不进 prompt（防循环）', async () => {
    const db = makeDbWithInterval();
    const { svc, chat } = makeService(db, JSON.stringify({ memories: [item()] }));
    await svc.extractFromSummary('sum1');
    const prompt = chat.mock.calls[0][0].messages.map((m) => m.content).join('\n');
    expect(prompt).toContain('以后亚马逊主图都按照 2000×2000 做');
    expect(prompt).toContain('好的，已记录');
    expect(prompt).not.toContain('这是摘要文本'); // 摘要只提供区间/追溯，不是提炼来源
  });

  it('达阈值 → active：写既有 Memory 表（active）+ 候选行 active/promotedAt + 双向追溯', async () => {
    const db = makeDbWithInterval();
    const { svc } = makeService(db, JSON.stringify({ memories: [item()] }));
    const r = await svc.extractFromSummary('sum1');
    expect(r).toMatchObject({ summaryId: 'sum1', extracted: 1, promoted: 1, rejected: 0 });
    const memory = db.memories[0];
    expect(memory).toMatchObject({
      userId: 'u1', scope: 'project', projectId: 'p1', status: 'active', source: 'extractor',
      sourceMessageId: 'm2', content: '用户偏好亚马逊主图 2000×2000', importance: 80, confidence: 0.9,
    });
    expect(memory.metadata).toMatchObject({ sourceSummaryId: 'sum1' });
    const cand = db.candidates[0];
    expect(cand).toMatchObject({ userId: 'u1', projectId: 'p1', sourceSummaryId: 'sum1', status: 'active' });
    expect(cand.promotedAt).toBeInstanceOf(Date);
  });

  it('低于可提炼下限 → rejected 显式记录（不再反复提炼）', async () => {
    const db = makeDbWithInterval();
    const reply = JSON.stringify({ memories: [item({ content: '随口一提', confidence: 0.3, importance: 30 })] });
    const { svc } = makeService(db, reply);
    const r = await svc.extractFromSummary('sum1');
    expect(r).toMatchObject({ extracted: 1, promoted: 0, rejected: 1 });
    expect(db.candidates[0].status).toBe('rejected');
    expect(db.memories).toHaveLength(0);
  });

  it('中间区间（未达提升阈值）→ candidate（留人工确认，与 M2 语义一致）', async () => {
    const db = makeDbWithInterval();
    const reply = JSON.stringify({ memories: [item({ confidence: 0.6, importance: 75 })] });
    const { svc } = makeService(db, reply);
    const r = await svc.extractFromSummary('sum1');
    expect(r).toMatchObject({ extracted: 1, promoted: 0, rejected: 0 });
    expect(db.candidates[0].status).toBe('candidate');
    expect(db.memories).toHaveLength(0);
  });

  it('重复内容（既有 Memory 或候选）→ 跳过，不重复落库', async () => {
    const db = makeDbWithInterval({ memories: [{ id: 'mem-old', userId: 'u1', scope: 'user', projectId: null, content: '用户偏好亚马逊主图 2000×2000', category: 'preference', importance: 80, confidence: 0.9, status: 'active', source: 'manual', sourceMessageId: null, metadata: null, createdAt: at(0) }] });
    const { svc } = makeService(db, JSON.stringify({ memories: [item()] }));
    const r = await svc.extractFromSummary('sum1');
    expect(r).toMatchObject({ extracted: 0, promoted: 0, duplicated: 1 });
    expect(db.candidates).toHaveLength(0);
  });

  it('幂等：同一摘要版本已有候选 → 跳过（不重复提炼同一区间）', async () => {
    const db = makeDbWithInterval({ candidates: [{ id: 'old', userId: 'u1', projectId: null, sourceSummaryId: 'sum1', content: 'x', category: 'other', importance: 10, confidence: 0.1, status: 'rejected', createdAt: at(0), promotedAt: null }] });
    const { svc, chat } = makeService(db, JSON.stringify({ memories: [item()] }));
    const r = await svc.extractFromSummary('sum1');
    expect(r.skipped).toBe('already_extracted');
    expect(chat).not.toHaveBeenCalled();
  });

  it('区间锚点消息被删除 → 不提炼 + 标陈旧待重算（绝不从摘要文本兜底取事实）', async () => {
    // 区间起始锚点 m-gone 已不在消息表中（消息被删除）
    const db = makeDb({
      summary: { id: 'sum1', conversationId: 'conv1', summary: SUMMARY_TEXT, sourceStartMessageId: 'm-gone', sourceEndMessageId: 'm2' },
      messages: REAL_MESSAGES,
    });
    const { svc, chat, summaryRefiner } = makeService(db, JSON.stringify({ memories: [item()] }));
    const r = await svc.extractFromSummary('sum1');
    expect(r.skipped).toBe('anchor_missing');
    expect(chat).not.toHaveBeenCalled();
    expect(summaryRefiner.markStale).toHaveBeenCalledWith('conv1', ['m-gone', 'm2']);
  });

  it('陈旧摘要版本 → 不提炼（等重算）', async () => {
    const db = makeDbWithInterval({ summary: { stale: true } });
    const { svc, chat } = makeService(db, JSON.stringify({ memories: [item()] }));
    const r = await svc.extractFromSummary('sum1');
    expect(r.skipped).toBe('no_summary');
    expect(chat).not.toHaveBeenCalled();
  });

  it('每日候选上限已满 → 候选落库但不提升（防无限保存）', async () => {
    const db = makeDbWithInterval({ dailyLimit: 5, memoryUsedToday: 5 });
    const { svc } = makeService(db, JSON.stringify({ memories: [item()] }));
    const r = await svc.extractFromSummary('sum1');
    expect(r).toMatchObject({ extracted: 1, promoted: 0 });
    expect(db.candidates[0].status).toBe('candidate');
    expect(db.memories).toHaveLength(0);
  });

  it('LLM 非法 JSON / 抛错 → 0 候选（安全降级，不抛异常）', async () => {
    const bad = makeDbWithInterval();
    const a = await makeService(bad, '不是JSON').svc.extractFromSummary('sum1');
    expect(a.extracted).toBe(0);
    expect(bad.candidates).toHaveLength(0);

    const down = makeDbWithInterval();
    const b = await makeService(down, new Error('provider down')).svc.extractFromSummary('sum1');
    expect(b.extracted).toBe(0);
    expect(down.candidates).toHaveLength(0);
  });

  it('人工裁决：candidate → active 写入 Memory 表；→ rejected 只改候选态', async () => {
    const db = makeDbWithInterval({ candidates: [{ id: 'cand-x', userId: 'u1', projectId: null, sourceSummaryId: 'sum1', content: '偏好：黑金配色', category: 'preference', importance: 85, confidence: 0.9, status: 'candidate', createdAt: at(0), promotedAt: null }] });
    const { svc } = makeService(db);
    expect(await svc.decide('cand-x', 'rejected')).toBe(true);
    expect(db.candidates[0].status).toBe('rejected');
    expect(db.memories).toHaveLength(0);
    db.candidates[0].status = 'candidate';
    expect(await svc.decide('cand-x', 'active')).toBe(true);
    expect(db.candidates[0].status).toBe('active');
    expect(db.memories[0]).toMatchObject({ userId: 'u1', content: '偏好：黑金配色', status: 'active', scope: 'user' });
    expect(await svc.decide('cand-x', 'active')).toBe(false); // 已非 candidate → 幂等拒绝
  });
});
