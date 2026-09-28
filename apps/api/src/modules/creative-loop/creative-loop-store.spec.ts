import { describe, it, expect, vi } from 'vitest';
import { Prisma } from '@prisma/client';
import {
  HYPOTHESIS_KIND, HypothesisDoc, HypothesisStore, INSIGHT_KIND, InsightDoc, InsightStore,
} from './creative-loop-store';
import { factsHashOf } from './insight-rules';

/**
 * M10-P4 存储层单测（专表映射 + CAS 语义 + 删除语义 + 存量回填幂等）。
 *
 * 与 e2e 互补：这里用内存版 Prisma 假实现（不连云 DB），把"绝不误写/绝不误删"的
 * 边界逐条钉死——
 * - 文档 ↔ 专表列**逐字段映射**（kind 由表决定并重建，容器判别彻底消失）；
 * - 状态推进 = status CAS；非状态字段更新 = version CAS（count=0 绝不覆盖）；
 * - 解读写入 = factsHash CAS（事实层变化 → 拒写；facts/derived 绝不进入该构造路径）；
 * - 删除仅 allowed 状态（已启动 loop 的假设行是历史事实，绝不删除）；
 * - 存量回填：只读旧容器行 → 专表、按 id 幂等、脏行跳过不阻塞、扫描失败不缓存（下次重试）。
 */

/** Prisma 的 SQL NULL 哨兵（写库后读回为 null；假实现须模拟数据库而非透传哨兵） */
function dbNullToNull(data: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(data)) out[key] = val === Prisma.DbNull ? null : val;
  return out;
}

/** 内存版 Prisma 假实现：仅覆盖 store 用到的委托与谓词（JSONB 存对象、可空 JSON 存 null） */
function makeFakePrisma(seed: {
  hypotheses?: Array<Record<string, unknown>>;
  insights?: Array<Record<string, unknown>>;
  legacy?: Array<Record<string, unknown>>;
} = {}) {
  const hypotheses = new Map<string, Record<string, unknown>>();
  const insights = new Map<string, Record<string, unknown>>();
  for (const row of (seed.hypotheses ?? [])) hypotheses.set(row.id as string, row);
  for (const row of (seed.insights ?? [])) insights.set(row.id as string, row);
  const legacyRows = [...(seed.legacy ?? [])];
  let inserts = 0;

  const matches = (row: Record<string, unknown> | undefined, where: Record<string, unknown>): boolean => {
    if (!row) return false;
    if (where.id !== undefined && row.id !== where.id) return false;
    if (where.organizationId !== undefined && row.organizationId !== where.organizationId) return false;
    if (where.factsHash !== undefined && row.factsHash !== where.factsHash) return false;
    if (where.version !== undefined && row.version !== where.version) return false;
    if (where.projectId !== undefined && row.projectId !== where.projectId) return false;
    if (where.userId !== undefined && row.userId !== where.userId) return false;
    if (where.status !== undefined) {
      const status = where.status as { in?: string[] } | string;
      if (typeof status === 'string') {
        if (row.status !== status) return false;
      } else if (status.in && !status.in.includes(row.status as string)) return false;
    }
    return true;
  };

  const delegate = (table: Map<string, Record<string, unknown>>) => ({
    create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
      const id = (data.id ?? `gen-${table.size + 1}-${Date.now()}`) as string; // Prisma @default(cuid()) 的替身
      if (table.has(id)) throw new Error('unique violation');
      const row = {
        id,
        version: 1,
        createdAt: new Date('2026-02-01T00:00:00Z'),
        updatedAt: new Date('2026-02-01T00:00:00Z'),
        ...dbNullToNull(data),
      };
      table.set(row.id as string, row);
      return row;
    }),
    findUnique: vi.fn(async ({ where }: { where: { id: string } }) => table.get(where.id) ?? null),
    findMany: vi.fn(async ({ where, take }: { where: Record<string, unknown>; take?: number }) =>
      [...table.values()].filter((row) => matches(row, where)).slice(0, take ?? 50)),
    updateMany: vi.fn(async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
      let count = 0;
      for (const [id, row] of table) {
        if (!matches(row, where)) continue;
        const next: Record<string, unknown> = { ...row, ...dbNullToNull(data) };
        const increment = (data.version as { increment?: number } | undefined)?.increment;
        if (increment) next.version = (row.version as number) + increment;
        table.set(id, next);
        count++;
      }
      return { count };
    }),
    deleteMany: vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
      let count = 0;
      for (const [id, row] of [...table.entries()]) {
        if (!matches(row, where)) continue;
        table.delete(id);
        count++;
      }
      return { count };
    }),
    createMany: vi.fn(async ({ data, skipDuplicates }: { data: Array<Record<string, unknown>>; skipDuplicates?: boolean }) => {
      let count = 0;
      for (const row of data) {
        const id = row.id as string;
        if (table.has(id)) {
          if (skipDuplicates) continue; // 幂等：既有专表行绝不被旧容器覆盖
          throw new Error('unique violation');
        }
        table.set(id, { updatedAt: new Date('2026-02-01T00:00:00Z'), ...dbNullToNull(row) });
        count++;
        inserts++;
      }
      return { count };
    }),
  });

  const prisma = {
    creativeHypothesis: delegate(hypotheses),
    creativeInsight: delegate(insights),
    artifact: { findMany: vi.fn(async () => legacyRows) },
  };
  return { prisma, hypotheses, insights, legacyRows, get inserts() { return inserts; } };
}

function makeHypothesisDoc(over: Partial<HypothesisDoc> = {}): HypothesisDoc {
  return {
    kind: 'creative_hypothesis',
    organizationId: 'org1',
    projectId: 'proj1',
    status: 'draft',
    statement: '高对比主图可提升点击率',
    rationale: null,
    target: '一线城市',
    platform: 'mock',
    insightId: null,
    successCriteria: null,
    loop: null,
    evaluationRunId: null,
    baselineRunId: null,
    experimentId: null,
    verdict: null,
    history: [],
    ...over,
  };
}

function makeInsightDoc(over: Partial<InsightDoc> = {}): InsightDoc {
  const facts = { performance: { current: { impressions: 1000 } } };
  const derived = { metrics: { roas: 3 } };
  return {
    kind: 'creative_insight',
    organizationId: 'org1',
    projectId: 'proj1',
    window: { start: '2026-01-01T00:00:00.000Z', end: '2026-01-31T00:00:00.000Z', days: 30 },
    filters: { artifactId: null, campaignId: null, projectId: 'proj1' },
    facts,
    derived,
    factsHash: factsHashOf(facts, derived),
    interpretation: null,
    layering: { facts: 'service-computed', derived: 'service-computed', interpretation: 'llm-interpretation' },
    ...over,
  };
}

describe('HypothesisStore（专表：映射 + status/version CAS + 删除语义）', () => {
  it('create/get：专表逐字段落库（organizationId 直列）→ 读回同一文档（kind 由表重建）', async () => {
    const { prisma } = makeFakePrisma();
    const store = new HypothesisStore(prisma as never);
    const doc = makeHypothesisDoc({
      successCriteria: { metric: 'roas', op: 'gte', value: 1 },
      history: [{ from: 'draft', to: 'ready', at: '2026-01-01T00:00:00.000Z', by: 'manual' }],
    });
    const stored = await store.create('u1', doc);
    expect(stored.version).toBe(1);
    expect(stored.doc).toEqual(doc);

    const row = await prisma.creativeHypothesis.findUnique({ where: { id: stored.id } });
    expect(row).toMatchObject({ organizationId: 'org1', projectId: 'proj1', userId: 'u1', status: 'draft' });
    const read = await store.get(stored.id);
    expect(read?.doc).toEqual(doc);
    expect(read?.doc.kind).toBe(HYPOTHESIS_KIND);
    expect(await store.get('missing')).toBeNull();
  });

  it('create：非法状态拒绝落库（DB 枚举之外一律 INTERNAL，绝不写半条）', async () => {
    const { prisma, hypotheses } = makeFakePrisma();
    const store = new HypothesisStore(prisma as never);
    await expect(store.create('u1', makeHypothesisDoc({ status: 'bogus' as never })))
      .rejects.toMatchObject({ code: 'INTERNAL' });
    expect(hypotheses.size).toBe(0);
  });

  it('可空 JSON 列落 SQL NULL 哨兵（DbNull）而非 JSON null；数组列落空数组', async () => {
    const { prisma } = makeFakePrisma();
    const store = new HypothesisStore(prisma as never);
    await store.create('u1', makeHypothesisDoc());
    const [args] = (prisma.creativeHypothesis.create as unknown as {
      mock: { calls: Array<[{ data: Record<string, unknown> }]> };
    }).mock.calls[0];
    expect(args.data.successCriteria).toBe(Prisma.DbNull);
    expect(args.data.loop).toBe(Prisma.DbNull);
    expect(args.data.verdict).toBe(Prisma.DbNull);
    expect(args.data.history).toEqual([]);
    expect(args.data.statement).toBe('高对比主图可提升点击率');
  });

  it('list：组织/项目/状态谓词全部 server-side 直列（无 JSON path、无 JS 侧过滤）', async () => {
    const { prisma } = makeFakePrisma();
    const store = new HypothesisStore(prisma as never);
    await store.create('u1', makeHypothesisDoc({ statement: 'A' }));
    await store.create('u1', makeHypothesisDoc({ statement: 'B', status: 'ready' }));
    await store.create('u1', makeHypothesisDoc({ statement: 'C', organizationId: 'org2' }));
    await store.create('u1', makeHypothesisDoc({ statement: 'D', projectId: null }));

    expect((await store.list({ organizationId: 'org1' })).map((r) => r.doc.statement).sort())
      .toEqual(['A', 'B', 'D']);
    expect((await store.list({ organizationId: 'org1', status: 'ready' })).map((r) => r.doc.statement))
      .toEqual(['B']);
    expect(await store.list({ organizationId: 'org1', projectId: 'proj1' })).toHaveLength(2);
    expect(await store.list({ organizationId: 'org2' })).toHaveLength(1);
    expect(await store.list({ organizationId: 'org1', take: 1 })).toHaveLength(1);
  });

  it('cas（status CAS）：锚定 from 状态 + 组织 scope；version 递增；未命中 count=0 绝不覆盖', async () => {
    const { prisma } = makeFakePrisma();
    const store = new HypothesisStore(prisma as never);
    const created = await store.create('u1', makeHypothesisDoc());
    const next = makeHypothesisDoc({
      status: 'ready', statement: '被提交的陈述',
      history: [{ from: 'draft', to: 'ready', at: 'now', by: 'manual' }],
    });

    expect(await store.cas(created.id, ['ready'], next)).toBe(0); // 当前 draft ∉ from → 未命中
    expect(await store.cas(created.id, ['draft'], next)).toBe(1);
    const after = await store.get(created.id);
    expect(after?.doc.status).toBe('ready');
    expect(after?.doc.statement).toBe('被提交的陈述');
    expect(after?.version).toBe(2); // 每次写入 +1

    // 组织 scope：文档归属与行不一致 → 绝不落到该行上
    expect(await store.cas(created.id, ['ready'], makeHypothesisDoc({ status: 'draft', organizationId: 'org-other' }))).toBe(0);
    expect((await store.get(created.id))?.doc.status).toBe('ready');
  });

  it('casFields（version CAS）：锚定读取时版本；版本已前移 → count=0（并发编辑绝不覆盖）', async () => {
    const { prisma } = makeFakePrisma();
    const store = new HypothesisStore(prisma as never);
    const created = await store.create('u1', makeHypothesisDoc());

    expect(await store.casFields(created.id, created.version, makeHypothesisDoc({ statement: '第一个写入者' }))).toBe(1);
    expect((await store.get(created.id))?.doc.statement).toBe('第一个写入者');

    // 第二个写入者仍拿着旧版本号（模拟并发读）→ 未命中
    expect(await store.casFields(created.id, created.version, makeHypothesisDoc({ statement: '第二个写入者' }))).toBe(0);
    expect((await store.get(created.id))?.doc.statement).toBe('第一个写入者');
  });

  it('casFields 同样受组织 scope 约束（跨租户写入 count=0）', async () => {
    const { prisma } = makeFakePrisma();
    const store = new HypothesisStore(prisma as never);
    const created = await store.create('u1', makeHypothesisDoc());
    expect(await store.casFields(created.id, 1, makeHypothesisDoc({ organizationId: 'org-other' }))).toBe(0);
    expect((await store.get(created.id))?.version).toBe(1);
  });

  it('remove：仅 allowed 状态可删（running 一行不删——已启动的假设是历史事实）', async () => {
    const { prisma, hypotheses } = makeFakePrisma();
    const store = new HypothesisStore(prisma as never);
    const draft = await store.create('u1', makeHypothesisDoc());
    const running = await store.create('u1', makeHypothesisDoc({ status: 'running' }));

    expect(await store.remove(running.id, ['draft', 'rejected'])).toBe(0);
    expect(hypotheses.has(running.id)).toBe(true);
    expect(await store.remove(draft.id, ['draft', 'rejected'])).toBe(1);
    expect(hypotheses.has(draft.id)).toBe(false);
  });
});

describe('InsightStore（专表：三层字段 + factsHash CAS）', () => {
  it('create/get：facts/derived/interpretation/layering 逐列落库 → 读回一致；解读默认空', async () => {
    const { prisma } = makeFakePrisma();
    const store = new InsightStore(prisma as never);
    const doc = makeInsightDoc();
    const stored = await store.create('u1', doc);
    expect(stored.doc).toEqual(doc);
    const read = await store.get(stored.id);
    expect(read?.doc).toEqual(doc);
    expect(read?.doc.kind).toBe(INSIGHT_KIND);
    expect(read?.doc.interpretation).toBeNull();
    expect(read?.doc.factsHash).toBe(doc.factsHash);
  });

  it('saveInterpretation：factsHash CAS 命中才写入；指纹不符 → count=0，facts/derived 永不被解读路径改写', async () => {
    const { prisma } = makeFakePrisma();
    const store = new InsightStore(prisma as never);
    const doc = makeInsightDoc();
    const created = await store.create('u1', doc);
    const next: InsightDoc = {
      ...doc,
      interpretation: { source: 'llm-interpretation', items: ['解读文本'], model: 'mock', attachedAt: 'now' },
    };

    expect(await store.saveInterpretation(created.id, doc.factsHash, next)).toBe(1);
    const after = await store.get(created.id);
    expect(after?.doc.interpretation?.items).toEqual(['解读文本']);
    expect(after?.doc.facts).toEqual(doc.facts);
    expect(after?.doc.derived).toEqual(doc.derived);
    expect(after?.doc.factsHash).toBe(doc.factsHash); // 指纹本身不因解读而变
    expect(after?.version).toBe(2);

    // 事实层已变化（旧指纹不再命中）→ 拒写：解读必须基于最新事实重新生成
    expect(await store.saveInterpretation(created.id, 'stale-hash', next)).toBe(0);
    expect((await store.get(created.id))?.doc.interpretation?.items).toEqual(['解读文本']);
  });
});

describe('存量回填（旧 Artifact 容器 → 专表；只读 + 幂等 + 不阻塞）', () => {
  const legacyHypothesis = {
    id: 'legacy-h1',
    userId: 'u1',
    createdAt: new Date('2025-12-01T00:00:00Z'),
    content: {
      kind: 'creative_hypothesis',
      organizationId: 'org1',
      projectId: 'proj1',
      status: 'validated',
      statement: '历史假设',
      rationale: '历史理由',
      target: null,
      platform: 'mock',
      insightId: 'legacy-i1',
      successCriteria: { metric: 'roas', op: 'gte', value: 1 },
      loop: { workflowId: 'wf-legacy', runId: 'run-legacy', attempts: 1, startedAt: '2025-12-01T00:00:00.000Z' },
      evaluationRunId: null,
      baselineRunId: null,
      experimentId: null,
      verdict: { decision: 'validated', decidedBy: 'criteria', reason: '历史判定' },
      history: [{ from: 'draft', to: 'validated', at: '2025-12-01T00:00:00.000Z', by: 'criteria' }],
    },
  };
  const legacyInsight = {
    id: 'legacy-i1',
    userId: 'u1',
    createdAt: new Date('2025-12-01T00:00:00Z'),
    content: {
      kind: 'creative_insight',
      organizationId: 'org1',
      projectId: 'proj1',
      window: { start: '2025-11-01T00:00:00.000Z', end: '2025-12-01T00:00:00.000Z', days: 30 },
      filters: { artifactId: null },
      facts: { performance: { current: { impressions: 1 } } },
      derived: { metrics: { roas: 2 } },
      factsHash: 'legacy-hash',
      interpretation: { source: 'llm-interpretation', items: ['历史解读'], model: 'mock', attachedAt: '2025-12-01T00:00:00.000Z' },
      layering: { facts: 'service-computed', derived: 'service-computed', interpretation: 'llm-interpretation' },
    },
  };

  it('首次访问回填：原 id/归属/时间线/内容逐字段保留；旧容器行只读不删', async () => {
    const fake = makeFakePrisma({ legacy: [legacyHypothesis, legacyInsight] });
    await new HypothesisStore(fake.prisma as never).list({ organizationId: 'org1' });

    const migrated = await new HypothesisStore(fake.prisma as never).get('legacy-h1');
    expect(migrated).toMatchObject({
      id: 'legacy-h1', userId: 'u1', version: 1, createdAt: new Date('2025-12-01T00:00:00Z'),
    });
    expect(migrated?.doc).toMatchObject({
      kind: HYPOTHESIS_KIND, organizationId: 'org1', projectId: 'proj1', status: 'validated',
      statement: '历史假设', rationale: '历史理由', insightId: 'legacy-i1',
      successCriteria: { metric: 'roas', op: 'gte', value: 1 },
      verdict: { decision: 'validated', decidedBy: 'criteria' },
    });
    expect(migrated?.doc.history).toHaveLength(1);
    expect(migrated?.doc.loop?.runId).toBe('run-legacy');

    const insight = await new InsightStore(fake.prisma as never).get('legacy-i1');
    expect(insight?.doc).toMatchObject({ kind: INSIGHT_KIND, organizationId: 'org1', factsHash: 'legacy-hash' });
    expect(insight?.doc.interpretation?.items).toEqual(['历史解读']);
    expect(fake.legacyRows).toHaveLength(2); // 旧行保留（只读迁移，不删审计痕迹）
  });

  it('幂等：同一 PrismaService 只扫一次；回填后专表行绝不被旧内容覆盖', async () => {
    const fake = makeFakePrisma({ legacy: [legacyHypothesis, legacyInsight] });
    const store = new HypothesisStore(fake.prisma as never);
    await store.list({ organizationId: 'org1' }); // 第一次：回填
    const insertsAfterFirst = fake.inserts;
    expect(insertsAfterFirst).toBe(2);

    await store.list({ organizationId: 'org1' }); // 同实例：记忆化 → 不再扫
    await new HypothesisStore(fake.prisma as never).list({ organizationId: 'org1' }); // 另建 store：同一 PrismaService 亦记忆化
    expect(fake.inserts).toBe(insertsAfterFirst);

    // 回填后再编辑专表行 → 版本前移；同版本号的第二次写入被拒（既有专表行不会被旧容器内容回滚）
    expect(await store.casFields('legacy-h1', 1, makeHypothesisDoc({ statement: '专表内的最新陈述' }))).toBe(1);
    expect(await store.casFields('legacy-h1', 1, makeHypothesisDoc({ statement: '第二个写入者' }))).toBe(0);
    expect((await store.get('legacy-h1'))?.doc.statement).toBe('专表内的最新陈述');
  });

  it('脏行跳过：缺 organizationId / 状态非法一律不写入（保留原行，模块照常可用）', async () => {
    const fake = makeFakePrisma({
      legacy: [
        { id: 'broken-org', userId: 'u1', createdAt: new Date(), content: { kind: 'creative_hypothesis', status: 'draft', statement: 'x' } },
        { id: 'broken-status', userId: 'u1', createdAt: new Date(), content: { kind: 'creative_hypothesis', organizationId: 'org1', status: 'weird', statement: 'x' } },
      ],
    });
    const store = new HypothesisStore(fake.prisma as never);
    expect(await store.list({ organizationId: 'org1' })).toEqual([]);
    expect(await store.get('broken-org')).toBeNull();
    expect(await store.get('broken-status')).toBeNull();
    expect(fake.legacyRows).toHaveLength(2);
  });

  it('单行失败不阻塞其余行（外键/数据错误 → 跳过该行，后续行照常回填）', async () => {
    const fake = makeFakePrisma({ legacy: [legacyHypothesis, legacyInsight] });
    (fake.prisma.creativeHypothesis.createMany as unknown as { mockImplementationOnce: (fn: () => never) => void })
      .mockImplementationOnce(() => {
        throw new Error('FK violation');
      });
    const store = new HypothesisStore(fake.prisma as never);
    expect(await store.list({ organizationId: 'org1' })).toEqual([]); // 绝不抛出
    expect(await store.get('legacy-h1')).toBeNull(); // 该行被跳过（保留旧行待人工处理）
    expect(await new InsightStore(fake.prisma as never).get('legacy-i1')).toMatchObject({ id: 'legacy-i1' }); // 其余行照常
  });

  it('扫描级失败不缓存：读路径不报错，下次访问重试成功', async () => {
    const fake = makeFakePrisma({ legacy: [legacyHypothesis] });
    (fake.prisma.artifact.findMany as unknown as { mockImplementationOnce: (fn: () => never) => void })
      .mockImplementationOnce(() => {
        throw new Error('db down');
      });
    const store = new HypothesisStore(fake.prisma as never);
    expect(await store.list({ organizationId: 'org1' })).toEqual([]); // 不因回填失败而 500

    expect((await store.get('legacy-h1'))?.doc.statement).toBe('历史假设'); // 重试 → 回填成功
  });

  it('回填只扫旧容器判别谓词（type=other + content.kind ∈ 两种 kind）', async () => {
    const fake = makeFakePrisma({ legacy: [legacyHypothesis] });
    await new HypothesisStore(fake.prisma as never).list({ organizationId: 'org1' });
    const [args] = (fake.prisma.artifact.findMany as unknown as {
      mock: { calls: Array<[{ where: Record<string, unknown>; select: Record<string, boolean> }]> };
    }).mock.calls[0];
    expect(args.where.type).toBe('other');
    expect(args.where.OR).toEqual([
      { content: { path: ['kind'], equals: 'creative_hypothesis' } },
      { content: { path: ['kind'], equals: 'creative_insight' } },
    ]);
    expect(args.select).toMatchObject({ id: true, userId: true, content: true, createdAt: true });
  });
});
