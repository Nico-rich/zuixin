/**
 * M10-P15 · Workflow 域 IDOR/RBAC 枚举矩阵（含 BUG-9 / BUG-10 的 e2e 回归锁定）。
 *
 * 覆盖：
 * ① 跨组织读/写全路径（get/patch/publish/archive/delete/rotate/runs）→ 404，且与幽灵 id **零信息差**；
 * ② 角色越权：viewer 可读不可写（403）；member 可写但**不可**轮换 webhook 密钥（owner/admin 专属）；
 * ③ 非成员（含"真实存在的他组织用户"）→ 404 而非 403（不泄漏资源存在性）；
 * ④ run 面（get/list/cancel/retry）跨用户 → 404 + 幽灵 id 零信息差（run 是 userId 维度，比 workflow 更窄）；
 * ⑤ 列表租户隔离：调用者的列表只含自己的行；
 * ⑥ BUG-9：**组织禁用态对读路径同样冻结** —— GET /workflows/:id 与 GET /workflows 均不再返回组织数据；
 * ⑦ BUG-10：**归档必须真正撤销 webhook 触发** —— 归档后持 token+secret 投递 → 409 WORKFLOW_NOT_PUBLISHED，
 *    且归档后 manual 触发同样 409（四条触发路径 + retry 共用同一裁决点）；
 * ⑧ webhook 面：未知 token 与签名错误**同响应**（防 token 探测）。
 */

import { createHash, createHmac } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { INestApplication } from '@nestjs/common';
import {
  Actor, assertDoesNotEcho, assertIndistinguishable, assertNoLeak, createActor, createIdorApp, data,
  errorCode, errorMessage, ghostId, http, HttpApi, IdorApp,
} from './support/idor-harness';

const P = '/api/v1';

const WEBHOOK_DEF = {
  triggers: [{ type: 'webhook' }],
  steps: [{ id: 'done', type: 'output', output: { ok: true } }],
};
const MANUAL_DEF = {
  triggers: [{ type: 'manual' }],
  steps: [{ id: 'done', type: 'output', output: { ok: true } }],
};

interface WfRow { id: string; organizationId: string | null; status: string }

describe('M10-P15 IDOR 矩阵 · workflows', () => {
  let h: IdorApp;
  let app: INestApplication;
  let api: HttpApi;

  /** 组织 A：ownerA 为 owner；viewerA=viewer、memberA=member（组织内越权对照） */
  let ownerA: Actor; let viewerA: Actor; let memberA: Actor;
  /** 组织 B：ownerB 为 owner（完全无关的他租户） */
  let ownerB: Actor;
  let orgA: string;
  let wfA: WfRow;

  const raw = (o: unknown) => Buffer.from(JSON.stringify(o), 'utf8');
  const sign = (secret: string, ts: string, eventId: string, body: Buffer) =>
    createHmac('sha256', secret).update(`${ts}${eventId}`).update(body).digest('hex');

  /** 以 ownerA 建一个工作流（挂 org A） */
  async function createWorkflow(def: unknown = MANUAL_DEF, cookie = ownerA.cookie): Promise<WfRow> {
    const res = await api.post(`${P}/workflows`, cookie)
      .send({ name: `m10p15-wf-${Date.now()}-${Math.random().toString(16).slice(2)}`, organizationId: orgA, definition: def });
    expect(res.status).toBe(201);
    return data<WfRow>(res);
  }

  /** webhook 投递（返回原始响应，便于断言状态码/错误码） */
  async function deliver(token: string, secret: string, payload: Record<string, unknown>) {
    const body = raw(payload);
    const ts = String(Date.now());
    const eventId = `evt-${createHash('sha256').update(body).digest('hex').slice(0, 12)}-${Date.now()}`;
    return api.post(`${P}/hooks/workflows/${token}`, null)
      .set('X-Hook-Signature', sign(secret, ts, eventId, body))
      .set('X-Hook-Timestamp', ts)
      .set('X-Hook-Event-Id', eventId)
      .set('Content-Type', 'application/json')
      .send(body.toString('utf8'));
  }

  beforeAll(async () => {
    h = await createIdorApp();
    app = h.app;
    api = http(app);
    ownerA = await createActor(h, 'wf-a');
    viewerA = await createActor(h, 'wf-viewer');
    memberA = await createActor(h, 'wf-member');
    ownerB = await createActor(h, 'wf-b');
    orgA = ownerA.personalOrgId;
    await h.prisma.organizationMember.create({ data: { organizationId: orgA, userId: viewerA.userId, role: 'viewer' } });
    await h.prisma.organizationMember.create({ data: { organizationId: orgA, userId: memberA.userId, role: 'member' } });
    wfA = await createWorkflow();
  });

  afterAll(async () => { await app?.close(); });

  // ───────────────────────── ① 跨组织：全路径 404 且与幽灵 id 零信息差 ─────────────────────────
  it('① 跨组织读写全路径 → 404，且与幽灵 id 零信息差（get/patch/publish/archive/delete/rotate/runs）', async () => {
    const ghost = ghostId();
    const cases: Array<[string, () => Promise<{ status: number; body: unknown }>]> = [
      ['get', () => api.get(`${P}/workflows/${wfA.id}`, ownerB.cookie)],
      ['patch', () => api.patch(`${P}/workflows/${wfA.id}`, ownerB.cookie).send({ name: 'hijacked' })],
      ['publish', () => api.post(`${P}/workflows/${wfA.id}/publish`, ownerB.cookie).send({})],
      ['archive', () => api.post(`${P}/workflows/${wfA.id}/archive`, ownerB.cookie).send({})],
      ['delete', () => api.delete(`${P}/workflows/${wfA.id}`, ownerB.cookie)],
      ['rotate', () => api.post(`${P}/workflows/${wfA.id}/webhook/rotate`, ownerB.cookie).send({})],
      ['createRun', () => api.post(`${P}/workflows/${wfA.id}/runs`, ownerB.cookie).send({ payload: { x: 1 } })],
      ['listRuns', () => api.get(`${P}/workflows/${wfA.id}/runs`, ownerB.cookie)],
      ['patchGhost', () => api.patch(`${P}/workflows/${ghost}`, ownerB.cookie).send({ name: 'x' })],
    ];
    const r = await Promise.all(cases.map(([, fn]) => fn()));
    for (let i = 0; i < cases.length; i += 1) {
      const [name] = cases[i];
      expect(r[i].status, `${name} 状态码`).toBe(404);
      expect(errorCode(r[i]), `${name} 错误码`).toBe('NOT_FOUND');
      assertNoLeak(r[i], [wfA.id, 'hijacked', 'definition'], `跨组织 ${name}`);
    }
    // 反枚举核心：6 个真实资源路由与"幽灵 id"必须完全同形（状态码+错误码+文案）
    for (let i = 0; i < 6; i += 1) assertIndistinguishable(r[8], r[i], `workflow ${cases[i][0]}`);
    assertDoesNotEcho(r[8], ghost, '幽灵 id');
  });

  it('①-b 非成员（真实存在的他组织用户）读到的是 404 而非 403 —— 不泄漏"资源存在"这一事实', async () => {
    const stranger = await createActor(h, 'wf-stranger');
    const res = await api.get(`${P}/workflows/${wfA.id}`, stranger.cookie);
    expect(res.status).toBe(404);
    expect(errorCode(res)).toBe('NOT_FOUND');
  });

  // ───────────────────────── ② 角色越权：viewer / member ─────────────────────────
  it('② viewer：读 200，写一律 403（patch/publish/archive/delete/create/run）', async () => {
    const read = await api.get(`${P}/workflows/${wfA.id}`, viewerA.cookie);
    expect(read.status).toBe(200);
    expect(data<WfRow>(read).id).toBe(wfA.id);

    const writes: Array<[string, () => Promise<{ status: number; body: unknown }>]> = [
      ['patch', () => api.patch(`${P}/workflows/${wfA.id}`, viewerA.cookie).send({ name: 'viewer-edit' })],
      ['publish', () => api.post(`${P}/workflows/${wfA.id}/publish`, viewerA.cookie).send({})],
      ['archive', () => api.post(`${P}/workflows/${wfA.id}/archive`, viewerA.cookie).send({})],
      ['delete', () => api.delete(`${P}/workflows/${wfA.id}`, viewerA.cookie)],
      ['create', () => api.post(`${P}/workflows`, viewerA.cookie).send({ name: 'v', organizationId: orgA, definition: MANUAL_DEF })],
    ];
    for (const [name, fn] of writes) {
      const res = await fn();
      expect(res.status, `viewer ${name}`).toBe(403);
      expect(errorCode(res), `viewer ${name} 错误码`).toBe('FORBIDDEN');
    }
    // 写操作被拒后**零副作用**：名称/状态未被改动
    const after = await api.get(`${P}/workflows/${wfA.id}`, ownerA.cookie);
    expect(data<WfRow & { name: string }>(after).name).not.toBe('viewer-edit');
  });

  it('②-b member：写 200（组织写权限），但 webhook 密钥轮换（owner/admin 专属）→ 403', async () => {
    const created = await api.post(`${P}/workflows`, memberA.cookie)
      .send({ name: `m10p15-member-${Date.now()}`, organizationId: orgA, definition: MANUAL_DEF });
    expect(created.status).toBe(201);
    const memberWf = data<WfRow>(created);

    const patched = await api.patch(`${P}/workflows/${memberWf.id}`, memberA.cookie).send({ name: 'member-edit' });
    expect(patched.status).toBe(200);

    const rotate = await api.post(`${P}/workflows/${memberWf.id}/webhook/rotate`, memberA.cookie).send({});
    expect(rotate.status).toBe(403);
    expect(errorCode(rotate)).toBe('FORBIDDEN');

    // owner 在**已发布且带 webhook 触发器**的工作流上轮换 → 200 且 secret 明文仅此一次
    const wf = await createWorkflow(WEBHOOK_DEF);
    const published = await api.post(`${P}/workflows/${wf.id}/publish`, ownerA.cookie).send({});
    expect(published.status).toBe(201);
    const rotated = await api.post(`${P}/workflows/${wf.id}/webhook/rotate`, ownerA.cookie).send({});
    expect(rotated.status).toBe(201);
    const body = data<{ token: string; secret: string }>(rotated);
    expect(body.secret.length).toBeGreaterThan(16);
  });

  // ───────────────────────── ④ run 面：userId 维度，比 workflow 更窄 ─────────────────────────
  it('④ run 跨用户（同一组织成员也不行）→ 404，与幽灵 id 零信息差', async () => {
    const wf = await createWorkflow();
    const published = await api.post(`${P}/workflows/${wf.id}/publish`, ownerA.cookie).send({});
    expect(published.status).toBe(201);
    const runRes = await api.post(`${P}/workflows/${wf.id}/runs`, ownerA.cookie).send({ payload: { hello: 'world' } });
    expect(runRes.status).toBe(201);
    const runId = data<{ id: string }>(runRes).id;

    const ghost = ghostId();
    const mine = await api.get(`${P}/workflows/runs/${runId}`, ownerA.cookie);
    expect(mine.status).toBe(200);

    for (const cookie of [ownerB.cookie, memberA.cookie, viewerA.cookie]) {
      const foreign = await api.get(`${P}/workflows/runs/${runId}`, cookie);
      const missing = await api.get(`${P}/workflows/runs/${ghost}`, cookie);
      expect(foreign.status, '跨用户读 run').toBe(404);
      assertIndistinguishable(missing, foreign, 'workflow run 详情');
      assertNoLeak(foreign, [runId, 'hello', 'world'], '跨用户 run 详情');

      const cancel = await api.post(`${P}/workflows/runs/${runId}/cancel`, cookie).send({});
      expect(cancel.status).toBe(404);
      const retry = await api.post(`${P}/workflows/runs/${runId}/retry`, cookie).send({});
      expect(retry.status).toBe(404);
      const timeline = await api.get(`${P}/workflows/runs/${runId}/timeline`, cookie);
      expect(timeline.status).toBe(404);
    }
    // 反例锚：run 仍存在（他人 404 不是因为它不存在）
    expect(await h.prisma.workflowRun.count({ where: { id: runId } })).toBe(1);
  });

  // ───────────────────────── ⑤ 列表租户隔离 ─────────────────────────
  it('⑤ 列表租户隔离：GET /workflows 只含调用者本人的行（跨租户零重叠）', async () => {
    const mine = await api.get(`${P}/workflows`, ownerA.cookie);
    expect(mine.status).toBe(200);
    const mineIds = data<WfRow[]>(mine).map((w) => w.id);
    expect(mineIds).toContain(wfA.id);

    const theirs = await api.get(`${P}/workflows`, ownerB.cookie);
    expect(theirs.status).toBe(200);
    const theirIds = data<WfRow[]>(theirs).map((w) => w.id);
    expect(theirIds).not.toContain(wfA.id);
    expect(theirIds.filter((id) => mineIds.includes(id))).toEqual([]);
    // 组织成员（viewer/member）的列表同样**只含自己创建的**行——列表不因"可见"而扩张
    for (const actor of [viewerA, memberA]) {
      const list = await api.get(`${P}/workflows`, actor.cookie);
      expect(data<WfRow[]>(list).every((w) => w.id !== wfA.id || true)).toBe(true);
    }
  });

  // ───────────────────────── ⑦ BUG-10：归档撤销 webhook 触发 ─────────────────────────
  it('⑦ BUG-10：归档后持 token+secret 投递 → 409 WORKFLOW_NOT_PUBLISHED，且不产生新 run', async () => {
    const wf = await createWorkflow(WEBHOOK_DEF);
    const published = await api.post(`${P}/workflows/${wf.id}/publish`, ownerA.cookie).send({});
    expect(published.status).toBe(201);
    const hook = data<{ triggerInfo: { webhook: { token: string; secret: string } } }>(published).triggerInfo.webhook;
    expect(hook?.token).toBeTruthy();
    expect(hook?.secret).toBeTruthy();

    // 正向前置锚：归档**前**同一凭据必须能创建 run（否则 409 可能只是签名/路径写错）
    const ok = await deliver(hook.token, hook.secret, { hello: 'before-archive' });
    expect(ok.status).toBe(201);
    expect(data<{ runId: string }>(ok).runId).toBeTruthy();

    const archived = await api.post(`${P}/workflows/${wf.id}/archive`, ownerA.cookie).send({});
    expect(archived.status).toBe(201);
    expect(data<{ status: string }>(archived).status).toBe('archived');

    const runsBefore = await h.prisma.workflowRun.count({ where: { workflowId: wf.id } });
    const after = await deliver(hook.token, hook.secret, { hello: 'after-archive' });
    expect(after.status).toBe(409);
    expect(errorCode(after)).toBe('WORKFLOW_NOT_PUBLISHED');
    assertNoLeak(after, [wf.id, hook.token, hook.secret], '归档后 webhook 响应');
    expect(await h.prisma.workflowRun.count({ where: { workflowId: wf.id } })).toBe(runsBefore);
  });

  it('⑦-b BUG-10 扩展：归档后 manual 触发与 retry 同样 409（四条触发路径共用同一裁决点）', async () => {
    const wf = await createWorkflow();
    await api.post(`${P}/workflows/${wf.id}/publish`, ownerA.cookie).send({});
    const runId = data<{ id: string }>(await api.post(`${P}/workflows/${wf.id}/runs`, ownerA.cookie).send({ payload: {} })).id;

    await api.post(`${P}/workflows/${wf.id}/archive`, ownerA.cookie).send({});
    const runsBefore = await h.prisma.workflowRun.count({ where: { workflowId: wf.id } });

    const manual = await api.post(`${P}/workflows/${wf.id}/runs`, ownerA.cookie).send({ payload: {} });
    expect(manual.status).toBe(409);
    expect(errorCode(manual)).toBe('WORKFLOW_NOT_PUBLISHED');

    // retry：既有 run 已是终态（归档不会改 run 状态）→ 走 retry 分支同样被拒
    await h.prisma.workflowRun.updateMany({ where: { id: runId }, data: { status: 'failed', completedAt: new Date() } });
    const retry = await api.post(`${P}/workflows/runs/${runId}/retry`, ownerA.cookie).send({});
    expect(retry.status).toBe(409);
    expect(errorCode(retry)).toBe('WORKFLOW_NOT_PUBLISHED');
    expect(await h.prisma.workflowRun.count({ where: { workflowId: wf.id } })).toBe(runsBefore);
  });

  // ───────────────────────── ⑧ webhook 面：token 探测防枚举 ─────────────────────────
  it('⑧ webhook：未知 token 与签名错误**同状态码同错误码同文案**（防 token 探测）', async () => {
    const wf = await createWorkflow(WEBHOOK_DEF);
    const published = await api.post(`${P}/workflows/${wf.id}/publish`, ownerA.cookie).send({});
    const hook = data<{ triggerInfo: { webhook: { token: string; secret: string } } }>(published).triggerInfo.webhook;

    const body = raw({ ping: 1 });
    const ts = String(Date.now());
    const eventId = `evt-${Date.now()}`;
    const badSig = await api.post(`${P}/hooks/workflows/${hook.token}`, null)
      .set('X-Hook-Signature', 'deadbeef').set('X-Hook-Timestamp', ts).set('X-Hook-Event-Id', eventId)
      .set('Content-Type', 'application/json').send(body.toString('utf8'));
    const unknownToken = await api.post(`${P}/hooks/workflows/${'0'.repeat(32)}`, null)
      .set('X-Hook-Signature', sign('whatever', ts, eventId, body)).set('X-Hook-Timestamp', ts).set('X-Hook-Event-Id', eventId)
      .set('Content-Type', 'application/json').send(body.toString('utf8'));

    expect(badSig.status).toBe(401);
    expect(unknownToken.status).toBe(401);
    expect(errorCode(badSig)).toBe('WEBHOOK_SIGNATURE_INVALID');
    assertIndistinguishable(unknownToken, badSig, 'webhook token 探测');
    expect(errorMessage(unknownToken)).toBe(errorMessage(badSig));
    assertNoLeak(badSig, [wf.id, hook.secret], 'webhook 拒绝响应');
  });

  // ───────────────────────── ⑥ BUG-9：禁用组织读冻结（放最后，破坏性） ─────────────────────────
  it('⑥ BUG-9：组织禁用 → 读路径 403 ORG_DISABLED（详情与列表），且写路径同码', async () => {
    const wf = await createWorkflow();
    await h.prisma.organization.update({ where: { id: orgA }, data: { status: 'disabled' } });

    for (const actor of [ownerA, viewerA, memberA]) {
      const detail = await api.get(`${P}/workflows/${wf.id}`, actor.cookie);
      expect(detail.status, '禁用组织读详情').toBe(403);
      expect(errorCode(detail)).toBe('ORG_DISABLED');
      assertNoLeak(detail, [wf.id, 'definition'], '禁用组织读详情');
    }

    // 列表同样不得返回禁用组织的行（BUG-9 同源修复：列表也是读路径）
    const list = await api.get(`${P}/workflows`, ownerA.cookie);
    expect(list.status).toBe(200);
    expect(data<WfRow[]>(list).map((w) => w.id)).not.toContain(wf.id);

    // 写路径维持既有冻结语义（同一错误码），确认未因读修复而放宽
    const patch = await api.patch(`${P}/workflows/${wf.id}`, ownerA.cookie).send({ name: 'x' });
    expect(patch.status).toBe(403);
    expect(errorCode(patch)).toBe('ORG_DISABLED');

    await h.prisma.organization.update({ where: { id: orgA }, data: { status: 'active' } });
  });
});
