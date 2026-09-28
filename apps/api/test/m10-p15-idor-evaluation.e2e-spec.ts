/**
 * M10-P15 · Evaluation + Creative-Loop 域 IDOR/RBAC 枚举矩阵（含 BUG-3 的 e2e 回归锁定）。
 *
 * 覆盖：
 * ① 跨组织资源（dataset / evaluator / run / experiment / hypothesis / insight）读写 → 404 且与幽灵 id 零信息差；
 * ② 角色越权：`evaluation.write` 仅 owner/admin —— member 创建 → 403、viewer 读 → 200 写 → 403；
 *    列表带他组织 organizationId → 403（组织级裁决，不泄漏组织存在性）；
 * ③ 列表租户隔离：列表只含本组织行；
 * ④ BUG-3：变体绑定 agentVersionId 必须带**归属谓词**（本组织 ∨ 系统级）——
 *    他组织版本与悬空 id **同为 404**（此前全局 findUnique → 跨租户 201 是存在性 oracle）；
 * ⑤ 组织禁用态：evaluation 读路径 403 ORG_DISABLED。
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { INestApplication } from '@nestjs/common';
import {
  Actor, assertIndistinguishable, assertNoLeak, createActor, createIdorApp, data, errorCode,
  ghostId, http, HttpApi, IdorApp,
} from './support/idor-harness';

const P = '/api/v1';

interface IdRow { id: string; organizationId?: string }

describe('M10-P15 IDOR 矩阵 · evaluation / creative-loop', () => {
  let h: IdorApp;
  let app: INestApplication;
  let api: HttpApi;

  let ownerA: Actor; let memberA: Actor; let viewerA: Actor; let ownerB: Actor;
  let orgA: string;
  /** org B 的 agent 版本（他租户）；系统级（平台目录）agent 版本 */
  let foreignVersionId: string;
  let systemVersionId: string;

  const post = (path: string, cookie: string, body: unknown = {}) => api.post(path, cookie).send(body as object);

  beforeAll(async () => {
    h = await createIdorApp();
    app = h.app;
    api = http(app);
    ownerA = await createActor(h, 'ev-a');
    memberA = await createActor(h, 'ev-member');
    viewerA = await createActor(h, 'ev-viewer');
    ownerB = await createActor(h, 'ev-b');
    orgA = ownerA.personalOrgId;
    await h.prisma.organizationMember.create({ data: { organizationId: orgA, userId: memberA.userId, role: 'member' } });
    await h.prisma.organizationMember.create({ data: { organizationId: orgA, userId: viewerA.userId, role: 'viewer' } });

    // 直接落库（agent/版本的创建面是平台管理端点，与本矩阵无关）：他组织版本 + 系统级版本
    const foreignAgent = await h.prisma.agent.create({
      data: { slug: `m10p15-foreign-${Date.now()}`, name: '他组织 agent', scope: 'organization', organizationId: ownerB.personalOrgId },
    });
    foreignVersionId = (await h.prisma.agentVersion.create({
      data: { agentId: foreignAgent.id, version: 1, systemPrompt: 'x' },
    })).id;
    const systemAgent = await h.prisma.agent.create({
      data: { slug: `m10p15-system-${Date.now()}`, name: '平台 agent', scope: 'system' },
    });
    systemVersionId = (await h.prisma.agentVersion.create({
      data: { agentId: systemAgent.id, version: 1, systemPrompt: 'x' },
    })).id;
  });

  afterAll(async () => { await app?.close(); });

  // ───────────────────────── ① 跨组织资源：404 与幽灵零信息差 ─────────────────────────
  it('① dataset/evaluator/experiment 跨组织读写 → 404，与幽灵 id 零信息差', async () => {
    const ds = data<IdRow>(await post(`${P}/evaluation/datasets`, ownerA.cookie, { name: 'A 数据集', organizationId: orgA }));
    const ev = data<IdRow>(await post(`${P}/evaluation/evaluators`, ownerA.cookie,
      { name: 'A 评估器', type: 'exact_match', config: {}, organizationId: orgA }));
    const exp = data<IdRow>(await post(`${P}/evaluation/experiments`, ownerA.cookie, { name: 'A 实验', organizationId: orgA }));

    const ghost = ghostId();
    const probes: Array<[string, IdRow, () => Promise<{ status: number; body: unknown }>]> = [
      ['dataset', ds, () => api.get(`${P}/evaluation/datasets/${ds.id}`, ownerB.cookie)],
      ['evaluator', ev, () => api.get(`${P}/evaluation/evaluators/${ev.id}`, ownerB.cookie)],
      ['experiment', exp, () => api.get(`${P}/evaluation/experiments/${exp.id}`, ownerB.cookie)],
    ];
    for (const [name, row, fn] of probes) {
      const foreign = await fn();
      const missing = await api.get(`${P}/evaluation/${name === 'dataset' ? 'datasets' : name === 'evaluator' ? 'evaluators' : 'experiments'}/${ghost}`, ownerB.cookie);
      expect(foreign.status, `${name} 跨组织读`).toBe(404);
      assertIndistinguishable(missing, foreign, `evaluation ${name}`);
      assertNoLeak(foreign, [row.id, 'A 数据集', 'A 评估器', 'A 实验'], `evaluation ${name}`);
    }

    // 写路径：跨组织 patch/delete/cancel/变体 全部 404（不产生任何副作用）
    const writes: Array<[string, () => Promise<{ status: number; body: unknown }>]> = [
      ['patch dataset', () => api.patch(`${P}/evaluation/datasets/${ds.id}`, ownerB.cookie).send({ name: 'hijack' })],
      ['put cases', () => api.put(`${P}/evaluation/datasets/${ds.id}/cases`, ownerB.cookie).send({ cases: [{ input: 'x' }] })],
      ['patch evaluator', () => api.patch(`${P}/evaluation/evaluators/${ev.id}`, ownerB.cookie).send({ name: 'hijack' })],
      ['delete evaluator', () => api.delete(`${P}/evaluation/evaluators/${ev.id}`, ownerB.cookie)],
      ['experiment status', () => post(`${P}/evaluation/experiments/${exp.id}/status`, ownerB.cookie, { status: 'running' })],
      ['experiment variants', () => post(`${P}/evaluation/experiments/${exp.id}/variants`, ownerB.cookie, { name: 'v' })],
    ];
    for (const [name, fn] of writes) {
      const res = await fn();
      expect(res.status, `跨组织 ${name}`).toBe(404);
      expect(errorCode(res), `跨组织 ${name} 错误码`).toBe('NOT_FOUND');
      assertNoLeak(res, [ds.id, ev.id, exp.id, 'hijack'], `跨组织 ${name}`);
    }
    // 零副作用锚：资源仍在且名称未被改写
    const still = data<IdRow & { name: string }>(await api.get(`${P}/evaluation/datasets/${ds.id}`, ownerA.cookie));
    expect(still.name).toBe('A 数据集');
  });

  it('①-b 建 run 的 children 一律按组织重新裁决 —— 他组织 dataset / agentVersion → 404', async () => {
    const foreignDs = data<IdRow>(await post(`${P}/evaluation/datasets`, ownerB.cookie, { name: 'B 数据集', organizationId: ownerB.personalOrgId }));

    const res = await post(`${P}/evaluation/runs`, ownerA.cookie, { datasetId: foreignDs.id, agentVersionId: systemVersionId });
    expect(res.status).toBe(404);
    assertNoLeak(res, [foreignDs.id], '跨组织 datasetId');

    // 反例锚：同一请求体换成自己的 dataset → 不再是 404（证明上一条 404 来自归属裁决而非参数错误）
    const ownDs = data<IdRow>(await post(`${P}/evaluation/datasets`, ownerA.cookie, { name: 'A run 数据集', organizationId: orgA }));
    const ok = await post(`${P}/evaluation/runs`, ownerA.cookie, { datasetId: ownDs.id, agentVersionId: systemVersionId });
    expect([201, 400]).toContain(ok.status); // 201 = 建 run；400 = 后续前置条件（不影响归属裁决结论）
    expect(ok.status).not.toBe(404);
  });

  // ───────────────────────── ② 角色越权与组织级裁决 ─────────────────────────
  it('② evaluation.write 仅 owner/admin：member 创建 → 403；组织级列表带他组织 organizationId → 403', async () => {
    for (const cookie of [memberA.cookie, viewerA.cookie]) {
      const res = await post(`${P}/evaluation/datasets`, cookie, { name: 'x', organizationId: orgA });
      expect(res.status).toBe(403);
      expect(errorCode(res)).toBe('FORBIDDEN');
    }
    // 他组织 organizationId → 403（组织级裁决；不区分"组织不存在"与"非成员"）
    for (const orgId of [ownerB.personalOrgId, ghostId()]) {
      const res = await api.get(`${P}/evaluation/datasets?organizationId=${orgId}`, ownerA.cookie);
      expect(res.status).toBe(403);
      expect(errorCode(res)).toBe('FORBIDDEN');
    }
    // viewer 读本组织列表 → 200（只读角色可读）
    const read = await api.get(`${P}/evaluation/datasets?organizationId=${orgA}`, viewerA.cookie);
    expect(read.status).toBe(200);
  });

  // ───────────────────────── ③ 列表租户隔离 ─────────────────────────
  it('③ 列表租户隔离：A 的列表不含 B 的行，反之亦然', async () => {
    const a = data<{ datasets: IdRow[] }>(await api.get(`${P}/evaluation/datasets?organizationId=${orgA}`, ownerA.cookie)).datasets;
    const b = data<{ datasets: IdRow[] }>(await api.get(`${P}/evaluation/datasets?organizationId=${ownerB.personalOrgId}`, ownerB.cookie)).datasets;
    const aIds = a.map((d) => d.id);
    expect(b.map((d) => d.id).filter((id) => aIds.includes(id))).toEqual([]);
    expect(everyOwnedBy(a, orgA)).toBe(true);
    expect(everyOwnedBy(b, ownerB.personalOrgId)).toBe(true);
  });

  // ───────────────────────── ④ BUG-3：变体绑定的归属谓词 ─────────────────────────
  it('④ BUG-3：变体绑定他组织 agentVersionId → 404，与幽灵 id **零信息差**；系统级版本放行', async () => {
    const exp = data<IdRow>(await post(`${P}/evaluation/experiments`, ownerA.cookie, { name: 'BUG-3 实验', organizationId: orgA }));

    const foreign = await post(`${P}/evaluation/experiments/${exp.id}/variants`, ownerA.cookie,
      { name: 'v-foreign', agentVersionId: foreignVersionId });
    const ghost = await post(`${P}/evaluation/experiments/${exp.id}/variants`, ownerA.cookie,
      { name: 'v-ghost', agentVersionId: ghostId() });
    expect(foreign.status).toBe(404);
    assertIndistinguishable(ghost, foreign, 'variant agentVersionId 绑定');
    assertNoLeak(foreign, [foreignVersionId], '变体绑定他组织版本');
    // 零副作用：他组织的版本绝不被挂到本组织变体上
    expect(await h.prisma.experimentVariant.count({ where: { experimentId: exp.id, agentVersionId: foreignVersionId } })).toBe(0);

    // 系统级版本（平台目录）必须放行——只认 organizationId 会把正常流程误杀成 404
    const system = await post(`${P}/evaluation/experiments/${exp.id}/variants`, ownerA.cookie,
      { name: 'v-system', agentVersionId: systemVersionId });
    expect(system.status).toBe(201);
    expect(await h.prisma.experimentVariant.count({ where: { experimentId: exp.id, agentVersionId: systemVersionId } })).toBe(1);
  });

  // ───────────────────────── ⑤ creative-loop：跨组织 + 角色 ─────────────────────────
  it('⑤ creative-loop：跨组织 hypothesis/insight 读 → 404；viewer 写 hypothesis → 403（workflow.write）', async () => {
    const hyp = data<IdRow>(await post(`${P}/creative-loop/hypotheses`, ownerA.cookie,
      { statement: 'M10P15 假设陈述', organizationId: orgA }));
    const ghost = ghostId();

    const foreign = await api.get(`${P}/creative-loop/hypotheses/${hyp.id}`, ownerB.cookie);
    const missing = await api.get(`${P}/creative-loop/hypotheses/${ghost}`, ownerB.cookie);
    expect(foreign.status).toBe(404);
    assertIndistinguishable(missing, foreign, 'creative-loop hypothesis');
    assertNoLeak(foreign, [hyp.id, 'M10P15 假设陈述'], 'creative-loop hypothesis');

    const foreignWrite = await post(`${P}/creative-loop/hypotheses/${hyp.id}/status`, ownerB.cookie, { status: 'ready' });
    expect(foreignWrite.status).toBe(404);

    // viewer（只读角色）：读 200，写 403
    const viewerRead = await api.get(`${P}/creative-loop/hypotheses/${hyp.id}`, viewerA.cookie);
    expect(viewerRead.status).toBe(200);
    const viewerWrite = await post(`${P}/creative-loop/hypotheses/${hyp.id}/status`, viewerA.cookie, { status: 'ready' });
    expect(viewerWrite.status).toBe(403);
    expect(errorCode(viewerWrite)).toBe('FORBIDDEN');
    // 零副作用：状态未被改动
    expect((await h.prisma.creativeHypothesis.findUnique({ where: { id: hyp.id } }))?.status).not.toBe('ready');
  });

  // ───────────────────────── ⑥ 组织禁用态（放最后，破坏性） ─────────────────────────
  it('⑥ 组织禁用 → evaluation 读路径 403 ORG_DISABLED（读详情与列表同码）', async () => {
    const ds = data<IdRow>(await post(`${P}/evaluation/datasets`, ownerA.cookie, { name: '禁用前数据集', organizationId: orgA }));
    await h.prisma.organization.update({ where: { id: orgA }, data: { status: 'disabled' } });

    for (const cookie of [ownerA.cookie, viewerA.cookie]) {
      const detail = await api.get(`${P}/evaluation/datasets/${ds.id}`, cookie);
      expect(detail.status, '禁用组织读详情').toBe(403);
      expect(errorCode(detail)).toBe('ORG_DISABLED');
      const list = await api.get(`${P}/evaluation/datasets?organizationId=${orgA}`, cookie);
      expect(list.status).toBe(403);
      expect(errorCode(list)).toBe('ORG_DISABLED');
    }
    assertNoLeak(await api.get(`${P}/evaluation/datasets/${ds.id}`, ownerA.cookie), [ds.id, '禁用前数据集'], '禁用组织读详情');

    await h.prisma.organization.update({ where: { id: orgA }, data: { status: 'active' } });
  });
});

/** 行归属必须是本组织（列表绝不跨租户） */
function everyOwnedBy(rows: IdRow[], organizationId: string): boolean {
  return rows.every((r) => r.organizationId === undefined || r.organizationId === organizationId);
}
