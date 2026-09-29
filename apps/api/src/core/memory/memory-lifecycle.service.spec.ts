import { describe, it, expect, vi } from 'vitest';
import { MemoryLifecycleService, DEFAULT_MEMORY_DECAY_STEP, DEFAULT_MEMORY_VERIFY_BOOST } from './memory-lifecycle.service';
import { lifecycleOf, MEMORY_LIFECYCLE_KEY, MEMORY_ORIGIN_KEY } from './memory-provenance';

const DAY = 24 * 60 * 60 * 1_000;
const NOW = new Date('2026-09-29T05:00:00.000Z');
const ago = (ms: number) => new Date(NOW.getTime() - ms);

type MemRow = {
  id: string; userId: string; status: string; content: string; category: string; importance: number;
  projectId: string | null; lastUsedAt: Date | null; createdAt: Date; updatedAt: Date;
  metadata: Record<string, unknown> | null; source: string | null;
};
type RunRow = { id: string; userId: string; projectId: string | null; status: string; completedAt: Date };

const eq = (a: unknown, b: unknown) => (a instanceof Date && b instanceof Date ? a.getTime() === b.getTime() : a === b);

/** 只实现本服务实际发出的查询形态的 fake Prisma（语义与 Prisma 一致：Date 相等按时间、null 匹配 null） */
function makeDb(init: { memories?: Partial<MemRow>[]; runs?: RunRow[]; usage?: Array<{ runId: string; status: string }> } = {}) {
  let seq = 0;
  const memories: MemRow[] = (init.memories ?? []).map((m, i) => ({
    id: m.id ?? `m${i + 1}`, userId: m.userId ?? 'u1', status: m.status ?? 'active',
    content: m.content ?? '偏好：黑金配色', category: m.category ?? 'preference', importance: m.importance ?? 50,
    projectId: m.projectId ?? null, lastUsedAt: m.lastUsedAt ?? null,
    createdAt: m.createdAt ?? ago(60 * DAY), updatedAt: m.updatedAt ?? ago(60 * DAY),
    metadata: m.metadata ?? null, source: m.source ?? 'manual',
  }));
  const runs = init.runs ?? [];
  const usage = init.usage ?? [];

  const matchCond = (value: unknown, cond: unknown): boolean => {
    if (cond === null) return value === null;
    if (cond instanceof Date) return eq(value, cond);
    if (cond && typeof cond === 'object') {
      const c = cond as { in?: unknown[]; gte?: Date; lte?: Date; lt?: Date; gt?: Date };
      if (c.in && !c.in.some((x) => eq(value, x))) return false;
      if (c.gte && !((value as Date) >= c.gte)) return false;
      if (c.lte && !((value as Date) <= c.lte)) return false;
      if (c.lt && !((value as Date) < c.lt)) return false;
      if (c.gt && !((value as Date) > c.gt)) return false;
      return true;
    }
    return eq(value, cond);
  };
  const match = (row: Record<string, unknown>, where: Record<string, unknown>): boolean => {
    for (const [key, cond] of Object.entries(where)) {
      if (key === 'OR') {
        if (!(cond as Array<Record<string, unknown>>).some((sub) => match(row, sub))) return false;
        continue;
      }
      if (!matchCond(row[key], cond)) return false;
    }
    return true;
  };

  const prisma = {
    memory: {
      groupBy: vi.fn(async ({ where, take, skip }: { where: Record<string, unknown>; take?: number; skip?: number }) => {
        const users = [...new Set(memories.filter((m) => match(m as unknown as Record<string, unknown>, where)).map((m) => m.userId))].sort();
        return users.slice(skip ?? 0, (skip ?? 0) + (take ?? users.length)).map((userId) => ({ userId }));
      }),
      findMany: vi.fn(async ({ where, take }: { where: Record<string, unknown>; take?: number }) =>
        memories.filter((m) => match(m as unknown as Record<string, unknown>, where)).slice(0, take ?? memories.length).map((m) => ({ ...m }))),
      updateMany: vi.fn(async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        const rows = memories.filter((m) => match(m as unknown as Record<string, unknown>, where));
        for (const row of rows) {
          Object.assign(row, data, { updatedAt: new Date(NOW.getTime() + ++seq * 1000) }); // @updatedAt 语义
        }
        return { count: rows.length };
      }),
    },
    agentRun: {
      findMany: vi.fn(async ({ where, take }: { where: Record<string, unknown>; take?: number }) =>
        runs.filter((r) => match(r as unknown as Record<string, unknown>, where)).slice(0, take ?? runs.length)),
    },
    usageRecord: {
      findMany: vi.fn(async ({ where }: { where: Record<string, unknown> }) =>
        usage.filter((u) => match(u as unknown as Record<string, unknown>, where))),
    },
    // 周期作业开通器（RecurringJobProvisioner）的存在性直查：默认"行缺失 + 有 admin" → 走开通路径
    scheduledJob: { findFirst: vi.fn().mockResolvedValue(null) },
    user: { findFirst: vi.fn().mockResolvedValue({ id: 'admin-1' }) },
  };
  return { prisma, memories, runs, usage };
}

function makeService(db: ReturnType<typeof makeDb>) {
  const registerHandler = vi.fn();
  const scheduler = { registerHandler, schedule: vi.fn() };
  const metrics = { recordMetric: vi.fn().mockResolvedValue(undefined) };
  const svc = new MemoryLifecycleService(db.prisma as never, scheduler as never, metrics as never);
  return { svc, scheduler, metrics, registerHandler };
}

/** 成功执行证据（completed run + 成功计量） */
const okRun = (id: string, userId: string, completedAt: Date, projectId: string | null = null): RunRow =>
  ({ id, userId, projectId, status: 'completed', completedAt });
const withUsage = (ids: string[]) => ids.map((runId) => ({ runId, status: 'success' }));

describe('MemoryLifecycleService（M12-P3 结果驱动：验证提升 / 衰减降级 / 淘汰 / 来源闸门）', () => {
  it('① 结果验证提升：被用过 + 相关成功执行（completed run + 成功计量）→ importance 上调并记验证锚', async () => {
    const used = ago(2 * DAY);
    const db = makeDb({
      memories: [{ id: 'm1', lastUsedAt: used, importance: 50 }],
      runs: [okRun('r1', 'u1', new Date(used.getTime() + 3_600_000))],
      usage: withUsage(['r1']),
    });
    const { svc } = makeService(db);
    const r = await svc.sweep({ now: NOW });
    expect(r).toMatchObject({ verified: 1, writes: 1, promoted: 0, demoted: 0, evicted: 0 });
    expect(db.memories[0].importance).toBe(50 + DEFAULT_MEMORY_VERIFY_BOOST);
    expect(lifecycleOf(db.memories[0].metadata)).toMatchObject({
      lastVerifiedRunId: 'r1', lastVerifiedUseAt: used.toISOString(), lastVerifiedAt: NOW.toISOString(),
    });
  });

  it('① 幂等：同一次使用只验证一次（第二次巡逻零写入，绝不让 importance 无限上涨）', async () => {
    const used = ago(2 * DAY);
    const db = makeDb({
      memories: [{ id: 'm1', lastUsedAt: used, importance: 50 }],
      runs: [okRun('r1', 'u1', new Date(used.getTime() + 3_600_000))],
      usage: withUsage(['r1']),
    });
    const { svc } = makeService(db);
    await svc.sweep({ now: NOW });
    const second = await svc.sweep({ now: NOW });
    expect(second).toMatchObject({ verified: 0, writes: 0 });
    expect(db.memories[0].importance).toBe(50 + DEFAULT_MEMORY_VERIFY_BOOST);
  });

  it('① 证据面收口：run 行 completed 但**无成功计量事实** → 不算成功执行（空 run 绝不冒充验证）', async () => {
    const used = ago(2 * DAY);
    const noUsage = makeDb({ memories: [{ id: 'm1', lastUsedAt: used }], runs: [okRun('r1', 'u1', new Date(used.getTime() + 3_600_000))] });
    expect((await makeService(noUsage).svc.sweep({ now: NOW })).verified).toBe(0);

    // 计量存在但状态 failed → 同样不算
    const failedUsage = makeDb({
      memories: [{ id: 'm1', lastUsedAt: used }],
      runs: [okRun('r1', 'u1', new Date(used.getTime() + 3_600_000))],
      usage: [{ runId: 'r1', status: 'failed' }],
    });
    expect((await makeService(failedUsage).svc.sweep({ now: NOW })).verified).toBe(0);
  });

  it('① 证据窗口：执行早于使用（因果倒置）或超出关联窗口 → 不验证', async () => {
    const used = ago(10 * DAY);
    const before = makeDb({
      memories: [{ id: 'm1', lastUsedAt: used }],
      runs: [okRun('r1', 'u1', new Date(used.getTime() - DAY))], // 用之前就完成了
      usage: withUsage(['r1']),
    });
    expect((await makeService(before).svc.sweep({ now: NOW })).verified).toBe(0);

    const tooLate = makeDb({
      memories: [{ id: 'm1', lastUsedAt: used }],
      runs: [okRun('r1', 'u1', new Date(used.getTime() + 20 * DAY))], // 超出 7 天关联窗口
      usage: withUsage(['r1']),
    });
    expect((await makeService(tooLate).svc.sweep({ now: NOW })).verified).toBe(0);
  });

  it('① 相关性：项目级记忆只认同项目执行；用户级记忆接受该用户任意项目执行', async () => {
    const used = ago(2 * DAY);
    const t = new Date(used.getTime() + 3_600_000);
    const projScoped = makeDb({
      memories: [{ id: 'm1', projectId: 'p2', lastUsedAt: used }],
      runs: [okRun('r1', 'u1', t, 'p1')],
      usage: withUsage(['r1']),
    });
    expect((await makeService(projScoped).svc.sweep({ now: NOW })).verified).toBe(0); // 他人项目执行不算

    const userScoped = makeDb({
      memories: [{ id: 'm1', projectId: null, lastUsedAt: used }],
      runs: [okRun('r1', 'u1', t, 'p1')],
      usage: withUsage(['r1']),
    });
    expect((await makeService(userScoped).svc.sweep({ now: NOW })).verified).toBe(1);
  });

  it('② 长期未用 → 按步长衰减；期间有失败执行 → 步长加倍（负向结果加速降级）', async () => {
    const stale = ago(60 * DAY);
    const plain = makeDb({ memories: [{ id: 'm1', importance: 90, lastUsedAt: stale, createdAt: ago(90 * DAY) }] });
    const r1 = await makeService(plain).svc.sweep({ now: NOW });
    expect(r1).toMatchObject({ decayed: 1, demoted: 0, verified: 0 });
    expect(plain.memories[0].importance).toBe(90 - DEFAULT_MEMORY_DECAY_STEP);

    const withFailure = makeDb({
      memories: [{ id: 'm1', importance: 90, lastUsedAt: stale, createdAt: ago(90 * DAY) }],
      runs: [{ id: 'r1', userId: 'u1', projectId: null, status: 'failed', completedAt: new Date(stale.getTime() + DAY) }],
    });
    const r2 = await makeService(withFailure).svc.sweep({ now: NOW });
    expect(r2).toMatchObject({ decayed: 1, demoted: 0 });
    expect(withFailure.memories[0].importance).toBe(90 - DEFAULT_MEMORY_DECAY_STEP * 2);
  });

  it('② 衰减触地板 → 降级为 candidate（退出上下文）+ 记 demotedAt；行保留（绝不物理删）', async () => {
    const db = makeDb({ memories: [{ id: 'm1', importance: 25, lastUsedAt: ago(60 * DAY), createdAt: ago(90 * DAY) }] });
    const r = await makeService(db).svc.sweep({ now: NOW });
    expect(r).toMatchObject({ demoted: 1, decayed: 0 });
    expect(db.memories[0].status).toBe('candidate');
    expect(db.memories[0].importance).toBe(25 - DEFAULT_MEMORY_DECAY_STEP);
    expect(lifecycleOf(db.memories[0].metadata)).toMatchObject({ demoteReason: 'stale', demotedAt: NOW.toISOString() });
  });

  it('② 从未被用过但创建已久 → 同样进入衰减/降级（lastUsedAt=null 不得被当作"刚用过"）', async () => {
    const db = makeDb({ memories: [{ id: 'm1', importance: 100, lastUsedAt: null, createdAt: ago(200 * DAY) }] });
    const r = await makeService(db).svc.sweep({ now: NOW });
    expect(r.decayed).toBe(1);
    expect(db.memories[0].importance).toBe(90);
  });

  it('② 人工裁决优先：userAffirmedAt 在窗口内 → 服务端绝不降级（人的决定不被过期时间无声推翻）', async () => {
    const db = makeDb({
      memories: [{
        id: 'm1', importance: 25, lastUsedAt: ago(60 * DAY), createdAt: ago(90 * DAY),
        metadata: { [MEMORY_LIFECYCLE_KEY]: { userAffirmedAt: ago(DAY).toISOString() } },
      }],
    });
    const r = await makeService(db).svc.sweep({ now: NOW });
    expect(r).toMatchObject({ decayed: 0, demoted: 0, writes: 0 });
    expect(db.memories[0].status).toBe('active');
    expect(db.memories[0].importance).toBe(25);
  });

  it('③ 淘汰：降级后超过淘汰窗口 → rejected（永久退出上下文）；未过窗口 → 原样保留', async () => {
    const evict = makeDb({
      memories: [{
        id: 'm1', status: 'candidate', importance: 10, createdAt: ago(120 * DAY),
        metadata: { [MEMORY_LIFECYCLE_KEY]: { demotedAt: ago(40 * DAY).toISOString() } },
      }],
    });
    const r = await makeService(evict).svc.sweep({ now: NOW });
    expect(r).toMatchObject({ evicted: 1, promoted: 0 });
    expect(evict.memories[0].status).toBe('rejected');
    expect(lifecycleOf(evict.memories[0].metadata)).toMatchObject({ evictedAt: NOW.toISOString() });

    const keep = makeDb({
      memories: [{
        id: 'm1', status: 'candidate', importance: 10, createdAt: ago(40 * DAY),
        metadata: { [MEMORY_LIFECYCLE_KEY]: { demotedAt: ago(5 * DAY).toISOString() } },
      }],
    });
    const r2 = await makeService(keep).svc.sweep({ now: NOW });
    expect(r2).toMatchObject({ evicted: 0, promoted: 0, writes: 0 });
    expect(keep.memories[0].status).toBe('candidate');
  });

  it('③ 已降级过的行**绝不自动复活**（避免降级↔升格抖动；恢复只走人工 PATCH）', async () => {
    const db = makeDb({
      memories: [{
        id: 'm1', status: 'candidate', source: 'manual', createdAt: ago(2 * DAY),
        metadata: { [MEMORY_ORIGIN_KEY]: 'user', [MEMORY_LIFECYCLE_KEY]: { demotedAt: ago(DAY).toISOString() } },
      }],
      runs: [okRun('r1', 'u1', ago(DAY))],
      usage: withUsage(['r1']),
    });
    const r = await makeService(db).svc.sweep({ now: NOW });
    expect(r).toMatchObject({ promoted: 0, writes: 0 });
    expect(db.memories[0].status).toBe('candidate');
  });

  it('④ 结果升格：人工来源候选 + 创建后窗口内成功执行 → active（promotedBy=outcome）', async () => {
    const createdAt = ago(3 * DAY);
    const db = makeDb({
      memories: [{ id: 'm1', status: 'candidate', source: 'manual', createdAt, importance: 60, metadata: { [MEMORY_ORIGIN_KEY]: 'user' } }],
      runs: [okRun('r1', 'u1', new Date(createdAt.getTime() + DAY))],
      usage: withUsage(['r1']),
    });
    const r = await makeService(db).svc.sweep({ now: NOW });
    expect(r).toMatchObject({ promoted: 1, writes: 1 });
    expect(db.memories[0].status).toBe('active');
    expect(lifecycleOf(db.memories[0].metadata)).toMatchObject({ promotedBy: 'outcome', promotedByRunId: 'r1' });
  });

  it('④ 来源闸门（红线条）：LLM 来源候选**即使**有成功执行证据也绝不升格', async () => {
    const createdAt = ago(3 * DAY);
    const evidence = {
      runs: [okRun('r1', 'u1', new Date(createdAt.getTime() + DAY))],
      usage: withUsage(['r1']),
    };
    // Agent 工具自报（memory.create_candidate）
    const agentTool = makeDb({ memories: [{ id: 'm1', status: 'candidate', source: 'agent', createdAt, metadata: { [MEMORY_ORIGIN_KEY]: 'agent' } }], ...evidence });
    expect((await makeService(agentTool).svc.sweep({ now: NOW })).promoted).toBe(0);
    expect(agentTool.memories[0].status).toBe('candidate');
    // 工具路径的 feedback 派生（LLM 打分 → 提示注入持久化通道，审计风险 2）
    const llmFeedback = makeDb({ memories: [{ id: 'm2', status: 'candidate', source: 'feedback', createdAt, metadata: { [MEMORY_ORIGIN_KEY]: 'agent', kind: 'performance' } }], ...evidence });
    expect((await makeService(llmFeedback).svc.sweep({ now: NOW })).promoted).toBe(0);
    expect(llmFeedback.memories[0].status).toBe('candidate');
    // 历史行（无标注、source=feedback）→ 兜底为最低信任，同样不升格
    const legacy = makeDb({ memories: [{ id: 'm3', status: 'candidate', source: 'feedback', createdAt, metadata: null }], ...evidence });
    expect((await makeService(legacy).svc.sweep({ now: NOW })).promoted).toBe(0);
  });

  it('④ 静默期与回看窗口：刚落的候选不立刻升格；过老的候选只能人工裁决', async () => {
    const evidence = (createdAt: Date) => ({
      runs: [okRun('r1', 'u1', new Date(createdAt.getTime() + 60_000))],
      usage: withUsage(['r1']),
    });
    const fresh = makeDb({ memories: [{ id: 'm1', status: 'candidate', source: 'manual', createdAt: ago(60_000) }], ...evidence(ago(60_000)) });
    expect((await makeService(fresh).svc.sweep({ now: NOW })).promoted).toBe(0); // 静默期内

    const ancient = makeDb({ memories: [{ id: 'm1', status: 'candidate', source: 'manual', createdAt: ago(120 * DAY) }], ...evidence(ago(120 * DAY)) });
    expect((await makeService(ancient).svc.sweep({ now: NOW })).promoted).toBe(0); // 超出回看窗口
  });

  it('有界执行：写入预算用尽 → truncated（下个周期继续），绝不无界写', async () => {
    const db = makeDb({
      memories: [
        { id: 'm1', lastUsedAt: ago(2 * DAY) }, { id: 'm2', lastUsedAt: ago(2 * DAY) },
      ],
      runs: [okRun('r1', 'u1', ago(DAY))],
      usage: withUsage(['r1']),
    });
    const r = await makeService(db).svc.sweep({ now: NOW, maxWrites: 1 });
    expect(r).toMatchObject({ verified: 1, writes: 1, truncated: true });
  });

  it('CAS 乐观锁：写入条件含 updatedAt + status —— 并发赢家已改行时本进程零写入', async () => {
    const used = ago(2 * DAY);
    const db = makeDb({
      memories: [{ id: 'm1', lastUsedAt: used, importance: 50, updatedAt: ago(DAY) }],
      runs: [okRun('r1', 'u1', new Date(used.getTime() + 3_600_000))],
      usage: withUsage(['r1']),
    });
    // 载入之后、写入之前，用户改了行（updatedAt 前移）→ CAS 不命中：
    // 查询返回的是**载入时的快照**（updatedAt 仍是 ago(DAY)），随后库里那行被并发改动。
    db.prisma.memory.findMany.mockImplementationOnce(async () => {
      const loaded = structuredClone(db.memories[0]);
      db.memories[0].updatedAt = ago(60_000);
      return [loaded];
    });
    const r = await makeService(db).svc.sweep({ now: NOW });
    expect(r).toMatchObject({ writes: 0, verified: 0 });
    expect(db.memories[0].importance).toBe(50); // 绝不覆盖用户的并发改动
  });

  it('活跃信号：0 写入也记一条 memory_lifecycle_sweep_count（"在跑但没活儿"与"没跑"可区分）', async () => {
    const db = makeDb({ memories: [{ id: 'm1', lastUsedAt: ago(DAY) }] }); // 新鲜且无证据 → 无写入
    const { svc, metrics } = makeService(db);
    const r = await svc.sweep({ now: NOW });
    expect(r.writes).toBe(0);
    expect(metrics.recordMetric).toHaveBeenCalledWith('memory_lifecycle_sweep_count', 0, 'count', expect.any(Object), null);
  });

  it('注册 handler：onModuleInit 注册 memory.lifecycle（worker 侧未注册的 handler 一律判失败）', async () => {
    const db = makeDb();
    const { svc, registerHandler } = makeService(db);
    registerHandler.mockClear();
    // 只验证注册动作本身；周期作业开通由 RecurringJobProvisioner 负责（其行为由既有 spec 覆盖）
    const scheduler = { registerHandler, schedule: vi.fn().mockResolvedValue({ job: { id: 'j1', status: 'scheduled' }, created: true }) };
    const probe = new MemoryLifecycleService(db.prisma as never, scheduler as never, undefined as never);
    await probe.onModuleInit();
    expect(registerHandler).toHaveBeenCalledWith('memory.lifecycle', expect.any(Function));
    expect(scheduler.schedule).toHaveBeenCalledWith(expect.objectContaining({
      handler: 'memory.lifecycle', type: 'recurring', idempotencyKey: 'platform:memory-lifecycle:v1',
    }));
    probe.onModuleDestroy();
    void svc;
  });
});
