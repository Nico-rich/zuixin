import { describe, it, expect, vi } from 'vitest';
import { HypothesesService } from './hypotheses.service';
import { HypothesisDoc, StoredDoc } from './creative-loop-store';

/** 假设文档夹具（默认 draft，无 loop 引用） */
function makeDoc(over: Partial<HypothesisDoc> = {}): HypothesisDoc {
  return {
    kind: 'creative_hypothesis',
    organizationId: 'org1',
    projectId: null,
    status: 'draft',
    statement: '高对比主图可提升点击率',
    rationale: null,
    target: null,
    platform: null,
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

function makeHarness(over: {
  doc?: HypothesisDoc | null;
  cas?: number;
  casFields?: number;
  remove?: number;
  insight?: { organizationId: string } | null;
  /** 读取返回后、写入前的并发窗口钩子（模拟"另一路请求已写入" → 本次快照过期） */
  afterRead?: () => void;
} = {}) {
  const doc = over.doc === undefined ? makeDoc() : over.doc;
  let stored: StoredDoc<HypothesisDoc> | null = doc
    ? {
      id: 'hyp-1', userId: 'u1', doc, version: 1,
      createdAt: new Date('2026-01-01T00:00:00Z'), updatedAt: new Date('2026-01-01T00:00:00Z'),
    }
    : null;
  const store = {
    create: vi.fn(async (userId: string, d: HypothesisDoc) => ({ id: 'hyp-new', userId, doc: d, createdAt: new Date(), updatedAt: new Date(), version: 1 })),
    get: vi.fn(async () => {
      const snapshot = stored;
      over.afterRead?.(); // 读取与写入之间的并发窗口
      return snapshot;
    }),
    list: vi.fn(async () => (stored ? [stored] : [])),
    // 真实实现：status 谓词 + version 谓词（M11-P5/D2-02）；mock 同语义（只记录，断言形状用）
    cas: vi.fn(async (_id: string, _from: readonly string[], _next: HypothesisDoc, expectedVersion: number) =>
      (stored && stored.version !== expectedVersion ? 0 : over.cas ?? 1)),
    // 真实实现：非状态字段更新走 version CAS（锚定读取时版本；输家 count=0）；mock 同语义
    casFields: vi.fn(async (_id: string, expectedVersion: number) => (stored && stored.version === expectedVersion ? over.casFields ?? 1 : 0)),
    // 真实实现按 allowed 状态做 SQL 过滤（未命中 → count 0）；mock 同语义
    remove: vi.fn(async (_id: string, allowed: readonly string[]) => (doc && allowed.includes(doc.status) ? over.remove ?? 1 : 0)),
  };
  const insights = {
    get: vi.fn(async () => (over.insight === undefined
      ? { id: 'ins-1', userId: 'u1', doc: { organizationId: 'org1' }, createdAt: new Date(), updatedAt: new Date() }
      : over.insight ? { id: 'ins-1', userId: 'u1', doc: over.insight, createdAt: new Date(), updatedAt: new Date() } : null)),
  };
  const access = {
    resolveScope: vi.fn(async () => ({ organizationId: 'org1', projectId: 'proj1' as string | null })),
    requireRead: vi.fn(async () => undefined),
    requireWrite: vi.fn(async () => undefined),
    authorizeResource: vi.fn(async () => undefined),
  };
  return {
    service: new HypothesesService(store as never, insights as never, access as never), store, insights, access,
    get stored() { return stored; },
    /** 模拟"另一路并发写入"：行版本前移（编辑 / 执行引用挂接 / 状态推进） */
    advanceVersion: () => {
      if (stored) stored = { ...stored, version: stored.version + 1 };
    },
  };
}

/**
 * 假设服务单测：归属裁决、状态机唯一入口、条件更新（CAS）失败语义、终态只读。
 * 断言重点 = "非法推进/并发冲突绝不落库"。
 */
describe('HypothesesService（CRUD + 状态机 + 归属）', () => {
  it('create：落 draft + 组织/项目 scope（服务端解析）；写路径过 workflow.write', async () => {
    const h = makeHarness();
    const view = await h.service.create('u1', { statement: '高对比主图可提升点击率', successCriteria: { metric: 'roas', op: 'gte', value: 2 } });
    expect(view).toMatchObject({ id: 'hyp-new', status: 'draft', organizationId: 'org1', projectId: 'proj1', terminal: false });
    expect(h.access.requireWrite).toHaveBeenCalledWith('u1', 'org1');
    expect(h.store.create).toHaveBeenCalledTimes(1);
  });

  it('create：来源洞察必须同组织（跨租户引用 → 404，绝不落库）', async () => {
    const h = makeHarness({ insight: { organizationId: 'org-other' } });
    await expect(h.service.create('u1', { statement: '假设陈述', insightId: 'ins-1' }))
      .rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(h.store.create).not.toHaveBeenCalled();
    const missing = makeHarness({ insight: null });
    await expect(missing.service.create('u1', { statement: '假设陈述', insightId: 'ins-x' }))
      .rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('list/get：读路径按 workflow.read 裁决（非成员 → 404 由 access 层抛出）', async () => {
    const h = makeHarness();
    const listed = await h.service.list('u1', { limit: 10 });
    expect(listed.hypotheses).toHaveLength(1);
    expect(h.access.requireRead).toHaveBeenCalledWith('u1', 'org1');
    expect(h.store.list).toHaveBeenCalledWith({ organizationId: 'org1', projectId: 'proj1', status: undefined, take: 10 });

    await h.service.get('u1', 'hyp-1');
    expect(h.access.authorizeResource).toHaveBeenCalledWith(
      'u1', { organizationId: 'org1', userId: 'u1' }, 'workflow.read', '假设不存在',
    );
  });

  it('get：不存在 → 404（不泄露存在性）', async () => {
    const h = makeHarness({ doc: null });
    await expect(h.service.get('u1', 'hyp-x')).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('update：draft/ready 可编辑，走 version CAS（锚定读取时的行版本）', async () => {
    const h = makeHarness({ doc: makeDoc({ status: 'ready' }) });
    const view = await h.service.update('u1', 'hyp-1', { statement: '新的假设陈述' });
    expect(view.statement).toBe('新的假设陈述');
    expect(h.store.casFields).toHaveBeenCalledWith('hyp-1', 1, expect.objectContaining({ statement: '新的假设陈述', status: 'ready' }));
    expect(h.store.cas).not.toHaveBeenCalled(); // 非状态字段更新绝不走 status CAS
  });

  it('update：running/终态拒绝编辑（loop 已渲染进定义与审批理由，绝不半路改）', async () => {
    for (const status of ['running', 'validated', 'rejected'] as const) {
      const h = makeHarness({ doc: makeDoc({ status }) });
      await expect(h.service.update('u1', 'hyp-1', { statement: '改一下' }))
        .rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
      expect(h.store.casFields).not.toHaveBeenCalled();
    }
  });

  it('update：并发冲突（version CAS count=0）→ 400，绝不盲目覆盖', async () => {
    const h = makeHarness({ casFields: 0 });
    await expect(h.service.update('u1', 'hyp-1', { statement: '改一下' }))
      .rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });

  it('transition：合法边推进 + 追加历史（条件更新锚定 from **与读取时版本**）', async () => {
    const h = makeHarness({ doc: makeDoc({ status: 'ready' }) });
    const view = await h.service.transition('u1', 'hyp-1', 'running', { by: 'manual', patch: { loop: { workflowId: 'wf1', runId: 'run1', attempts: 1, startedAt: 'now' } } });
    expect(view.status).toBe('running');
    expect(view.history).toEqual([{ from: 'ready', to: 'running', at: expect.any(String), by: 'manual' }]);
    expect(h.store.cas).toHaveBeenCalledWith('hyp-1', ['ready'], expect.objectContaining({
      status: 'running',
      loop: { workflowId: 'wf1', runId: 'run1', attempts: 1, startedAt: 'now' },
    }), 1); // K=读取时版本（D2-02：并发编辑与状态推进绝不互相静默覆盖）
  });

  it('transition：读取后版本已被并发写入前移 → 400 且绝不落库（lost update 防护，D2-02）', async () => {
    // 模拟另一路请求在"本请求读取之后、条件更新之前"写入了非状态字段（版本前移 → 本次快照过期）
    let h: ReturnType<typeof makeHarness>;
    h = makeHarness({ doc: makeDoc({ status: 'ready' }), afterRead: () => h.advanceVersion() });
    await expect(h.service.transition('u1', 'hyp-1', 'running', { by: 'manual' }))
      .rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    // 锚点 = 读取时版本（v1），而非最新版本——所以版本前移必然使本次写入 count=0
    expect(h.store.cas).toHaveBeenCalledWith('hyp-1', ['ready'], expect.anything(), 1);
    expect(h.stored?.doc.status).toBe('ready'); // 状态未被本次转移改写
    expect(h.stored?.version).toBe(2); // 只有并发写入那一次（本次未落库）
  });

  it('transition：非法边 → 400 且绝不落库（draft→running / 终态复活）', async () => {
    const draft = makeHarness({ doc: makeDoc({ status: 'draft' }) });
    await expect(draft.service.transition('u1', 'hyp-1', 'running', { by: 'manual' }))
      .rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    expect(draft.store.cas).not.toHaveBeenCalled();

    const validated = makeHarness({ doc: makeDoc({ status: 'validated' }) });
    await expect(validated.service.transition('u1', 'hyp-1', 'running', { by: 'manual' }))
      .rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    expect(validated.store.cas).not.toHaveBeenCalled();
  });

  it('setStatus：draft→ready 提交（人工唯一可达边）；ready→rejected 记人工判定事实', async () => {
    const h = makeHarness({ doc: makeDoc({ status: 'draft' }) });
    const view = await h.service.setStatus('u1', 'hyp-1', { status: 'ready' });
    expect(view.status).toBe('ready');
    expect(h.store.cas).toHaveBeenCalledWith('hyp-1', ['draft'], expect.objectContaining({ status: 'ready' }), 1);

    const ready = makeHarness({ doc: makeDoc({ status: 'ready', successCriteria: { metric: 'roas', op: 'gte', value: 2 } }) });
    const rejected = await ready.service.setStatus('u1', 'hyp-1', { status: 'rejected', reason: '成本模型不成立' });
    expect(rejected.status).toBe('rejected');
    expect(rejected.verdict).toMatchObject({ decision: 'rejected', decidedBy: 'manual', reason: '成本模型不成立' });
  });

  it('setStatus：绝不接受直设 running/validated（执行中与终态只能由 loop/判定产出）', async () => {
    const running = makeHarness({ doc: makeDoc({ status: 'running' }) });
    await expect(running.service.setStatus('u1', 'hyp-1', { status: 'rejected' }))
      .rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    const validated = makeHarness({ doc: makeDoc({ status: 'validated' }) });
    await expect(validated.service.setStatus('u1', 'hyp-1', { status: 'ready' }))
      .rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    expect(running.store.cas).not.toHaveBeenCalled();
    expect(validated.store.cas).not.toHaveBeenCalled();
  });

  it('remove：仅 draft/rejected 可删（已启动/已判定的假设行是历史事实，绝不删除）', async () => {
    const draft = makeHarness({ doc: makeDoc({ status: 'draft' }) });
    expect(await draft.service.remove('u1', 'hyp-1')).toEqual({ deleted: true });
    expect(draft.store.remove).toHaveBeenCalledWith('hyp-1', ['draft', 'rejected']);

    const running = makeHarness({ doc: makeDoc({ status: 'running' }) });
    await expect(running.service.remove('u1', 'hyp-1')).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    // 删除语句带 allowed 过滤：running 不在允许集合内 → SQL 未删任何行（count 0）→ 服务层转 400
    expect(running.store.remove).toHaveBeenCalledWith('hyp-1', ['draft', 'rejected']);
    expect(await running.store.remove.mock.results[0].value).toBe(0);
  });

  it('patch：终态不可变更执行引用（只允许补记判定事实）；allowStatuses 之外 → 400', async () => {
    const terminal = makeHarness({ doc: makeDoc({ status: 'validated' }) });
    await expect(terminal.service.patch('hyp-1', { experimentId: 'exp1' }))
      .rejects.toMatchObject({ code: 'VALIDATION_ERROR' });

    const ready = makeHarness({ doc: makeDoc({ status: 'ready' }) });
    await expect(ready.service.patch('hyp-1', { evaluationRunId: 'run-1' }, { allowStatuses: ['running'] }))
      .rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    expect(ready.store.casFields).not.toHaveBeenCalled();
  });

  it('patch：合法挂接走 version CAS（并发状态推进/并发编辑的输家 count=0 → 400）', async () => {
    const h = makeHarness({ doc: makeDoc({ status: 'running' }) });
    const row = await h.service.patch('hyp-1', { evaluationRunId: 'eval-1' });
    expect(row.doc.evaluationRunId).toBe('eval-1');
    expect(h.store.casFields).toHaveBeenCalledWith('hyp-1', 1, expect.objectContaining({ evaluationRunId: 'eval-1' }));

    // 版本已前移（并发写入赢了）：CAS 未命中 → 400，绝不覆盖
    const raced = makeHarness({ doc: makeDoc({ status: 'running' }), casFields: 0 });
    await expect(raced.service.patch('hyp-1', { evaluationRunId: 'eval-1' }))
      .rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });
});
