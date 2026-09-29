import { describe, it, expect, vi } from 'vitest';
import { Logger } from '@nestjs/common';
import { MemoryCandidateService, memoryContentHash } from './memory-candidate.service';

/** 内存 fake Prisma（只实现本服务用到的语义；时间递增保证次序确定） */
type CandRow = {
  id: string; userId: string; projectId: string | null; sourceSummaryId: string | null;
  content: string; contentHash?: string; category: string; importance: number; confidence: number;
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
      // M12-P3：人工裁决按 {id, userId} 谓词取行（跨用户与幽灵 id 同路径 → 零信息差）
      findFirst: vi.fn(async ({ where }: { where: Record<string, unknown> }) => candidates.find((c) => match(c as unknown as Record<string, unknown>, where)) ?? null),
      findMany: vi.fn(async ({ where, take }: { where: Record<string, unknown>; take?: number }) =>
        candidates.filter((c) => match(c as unknown as Record<string, unknown>, where)).slice(0, take ?? candidates.length)),
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
      // M12-P3：人工拒绝走条件更新（status='candidate' 参与 WHERE → 并发裁决只有一个赢家）
      updateMany: vi.fn(async ({ where, data }: { where: Record<string, unknown>; data: Partial<CandRow> }) => {
        const rows = candidates.filter((c) => match(c as unknown as Record<string, unknown>, where));
        for (const row of rows) Object.assign(row, data);
        return { count: rows.length };
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

  it('去重锚点 = contentHash（与 DB UNIQUE(userId, contentHash) 同口径）：既有候选指纹相同 → 跳过', async () => {
    const content = '用户偏好亚马逊主图 2000×2000';
    const db = makeDbWithInterval({
      // 来源摘要为空 → 不触发 already_extracted 幂等分支，命中纯去重分支
      candidates: [{ id: 'cand-old', userId: 'u1', projectId: null, sourceSummaryId: null, content, contentHash: memoryContentHash(content), category: 'preference', importance: 80, confidence: 0.9, status: 'rejected', createdAt: at(0), promotedAt: null }],
    });
    const { svc } = makeService(db, JSON.stringify({ memories: [item()] }));
    const r = await svc.extractFromSummary('sum1');
    expect(r).toMatchObject({ extracted: 0, promoted: 0, duplicated: 1 });
    expect(db.candidates).toHaveLength(1);
  });

  it('落库候选携带 contentHash（内容 sha256；应用层预检与 DB 约束同一锚点）', async () => {
    const db = makeDbWithInterval();
    const { svc } = makeService(db, JSON.stringify({ memories: [item()] }));
    await svc.extractFromSummary('sum1');
    expect(db.candidates[0].contentHash).toBe(memoryContentHash('用户偏好亚马逊主图 2000×2000'));
  });

  it('并发兜底（X-29）：create 撞 UNIQUE(P2002) → 计 duplicated 并继续，绝不抛错（500）、绝无重复候选行', async () => {
    const db = makeDbWithInterval();
    const reply = JSON.stringify({
      memories: [
        { content: '并发候选A', category: 'preference', importance: 80, confidence: 0.9 },
        { content: '并发候选B', category: 'preference', importance: 80, confidence: 0.9 },
      ],
    });
    const { svc } = makeService(db, reply);
    // 竞态窗口：应用层 isDuplicate 时还看不到对方的行，INSERT 时才撞唯一键（另一实例已写入同一 contentHash）
    db.prisma.memoryCandidate.create.mockRejectedValueOnce(
      Object.assign(new Error('Unique constraint failed on the fields: (`userId`,`contentHash`)'), { code: 'P2002' }),
    );
    const r = await svc.extractFromSummary('sum1');
    expect(r).toMatchObject({ skipped: null, extracted: 1, duplicated: 1, promoted: 1 }); // 绝不因 P2002 中断整批
    expect(db.candidates).toHaveLength(1); // 绝无重复候选行
    expect(db.candidates[0].content).toBe('并发候选B'); // 后续条目照常落库
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

  it('LLM 输出非法 JSON / 不合 schema → warn 日志（D30：降级不再静默）', async () => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    try {
      const bad = makeDbWithInterval();
      await makeService(bad, '不是JSON').svc.extractFromSummary('sum1');
      expect(warn.mock.calls.some((c) => String(c[0]).includes('不是合法 JSON'))).toBe(true);

      const mismatch = makeDbWithInterval();
      await makeService(mismatch, JSON.stringify({ memories: [{ content: 'x' }] })).svc.extractFromSummary('sum1');
      expect(warn.mock.calls.some((c) => String(c[0]).includes('不符合约定 schema'))).toBe(true);
      expect(mismatch.candidates).toHaveLength(0); // 降级行为不变：0 候选
    } finally {
      warn.mockRestore();
    }
  });

  it('人工裁决：candidate → active 写入 Memory 表；→ rejected 只改候选态', async () => {
    const db = makeDbWithInterval({ candidates: [{ id: 'cand-x', userId: 'u1', projectId: null, sourceSummaryId: 'sum1', content: '偏好：黑金配色', category: 'preference', importance: 85, confidence: 0.9, status: 'candidate', createdAt: at(0), promotedAt: null }] });
    const { svc } = makeService(db);
    expect(await svc.decide('u1', 'cand-x', 'rejected')).toBe(true);
    expect(db.candidates[0].status).toBe('rejected');
    expect(db.memories).toHaveLength(0);
    db.candidates[0].status = 'candidate';
    expect(await svc.decide('u1', 'cand-x', 'active')).toBe(true);
    expect(db.candidates[0].status).toBe('active');
    expect(db.memories[0]).toMatchObject({ userId: 'u1', content: '偏好：黑金配色', status: 'active', scope: 'user' });
    expect(await svc.decide('u1', 'cand-x', 'active')).toBe(false); // 已非 candidate → 幂等拒绝
  });

  // ===== M12-P3：人工裁决接线（IDOR 谓词 + 闸门标注 + 候选读取面）=====

  it('decide 归属谓词：跨用户裁决 → false 且零副作用（绝不二次提升）', async () => {
    const db = makeDbWithInterval({ candidates: [{ id: 'cand-x', userId: 'u1', projectId: null, sourceSummaryId: 'sum1', content: '偏好：黑金配色', category: 'preference', importance: 85, confidence: 0.9, status: 'candidate', createdAt: at(0), promotedAt: null }] });
    const { svc } = makeService(db);
    expect(await svc.decide('u2', 'cand-x', 'active')).toBe(false); // 他人候选
    expect(await svc.decide('u2', 'cand-x', 'rejected')).toBe(false);
    expect(await svc.decide('u1', 'ghost', 'active')).toBe(false); // 幽灵 id 同路径
    expect(db.candidates[0].status).toBe('candidate');
    expect(db.memories).toHaveLength(0);
    // 谓词锚：一律 {id, userId}（放宽即等于跨租户可改）
    expect(db.prisma.memoryCandidate.findFirst).toHaveBeenCalledWith({ where: { id: 'cand-x', userId: 'u2' } });
  });

  it('人工提升标注来源与生命周期簿记：origin=extractor + promotedBy=human（谁把它推进上下文必须可追溯）', async () => {
    const db = makeDbWithInterval({ candidates: [{ id: 'cand-x', userId: 'u1', projectId: null, sourceSummaryId: 'sum1', content: '偏好：黑金配色', category: 'preference', importance: 85, confidence: 0.9, status: 'candidate', createdAt: at(0), promotedAt: null }] });
    const { svc } = makeService(db);
    await svc.decide('u1', 'cand-x', 'active');
    expect(db.memories[0].metadata).toMatchObject({ origin: 'extractor', lifecycle: { promotedBy: 'human' } });
  });

  it('候选读取面 listCandidates：只出本人候选（status 默认 candidate，take 收敛 1~200）', async () => {
    const db = makeDbWithInterval({
      candidates: [
        { id: 'c1', userId: 'u1', projectId: null, sourceSummaryId: null, content: '本人候选', category: 'other', importance: 50, confidence: 0.5, status: 'candidate', createdAt: at(0), promotedAt: null },
        { id: 'c2', userId: 'u2', projectId: null, sourceSummaryId: null, content: '他人候选', category: 'other', importance: 50, confidence: 0.5, status: 'candidate', createdAt: at(1), promotedAt: null },
      ],
    });
    const { svc } = makeService(db);
    const mine = await svc.listCandidates('u1');
    expect(mine.map((c) => c.id)).toEqual(['c1']);
    await svc.listCandidates('u1', { take: 10_000 });
    expect(db.prisma.memoryCandidate.findMany).toHaveBeenLastCalledWith(expect.objectContaining({ take: 200 }));
  });

  it('闸门锚：摄取期自动提升路径显式标注 origin=extractor（提升行元数据可追溯来源）', async () => {
    const db = makeDbWithInterval();
    const { svc } = makeService(db, JSON.stringify({ memories: [item()] }));
    await svc.extractFromSummary('sum1');
    expect(db.memories[0].metadata).toMatchObject({ origin: 'extractor', lifecycle: { promotedBy: 'ingest' } });
  });
});
