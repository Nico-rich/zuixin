/**
 * M10-P15 · 治理面（analytics / audit / metrics / billing / scheduler / events / routing / feedback）IDOR 矩阵。
 *
 * 这批端点的横轴是**组织级裁决**（`require`/`authorize`），矩阵断言：
 * ① 组织级读：带他人 organizationId 或**不存在的** organizationId → 同为 403 FORBIDDEN「无权访问该组织」
 *    （同码同文案 ⇒ 不留"组织是否存在"的枚举 oracle）；
 * ② 角色越权：`billing.write` 仅 owner（admin/member/viewer → 403「权限不足」）；
 *    `workflow.write` 为 owner/admin/member（viewer → 403）；`workflow.read`/`organization.read` 全部角色可读；
 * ③ 资源级 404：跨组织的作业取消/暂停/恢复、事件重投、平台策略 → 404 或 403，且与幽灵 id 零信息差，
 *    并有零副作用断言（他人的作业/事件状态绝不被越权改写）；
 * ④ 列表租户隔离：本人面（个人作业、审计、反馈）只含本人行；组织面绝不含他组织行。
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { INestApplication } from '@nestjs/common';
import {
  Actor, assertIndistinguishable, assertNoLeak, createActor, createIdorApp, data, errorCode,
  ghostId, http, HttpApi, IdorApp,
} from './support/idor-harness';

const P = '/api/v1';

interface IdRow { id: string }

describe('M10-P15 IDOR 矩阵 · governance（analytics/audit/metrics/billing/scheduler/events/routing）', () => {
  let h: IdorApp;
  let app: INestApplication;
  let api: HttpApi;

  let ownerA: Actor; let adminA: Actor; let memberA: Actor; let viewerA: Actor; let ownerB: Actor;
  let orgA: string; let orgB: string;
  let jobA: string; let jobOwnA: string; let jobPersonalA: string; let eventDeadA: string;
  let planId: string | null;

  const post = (path: string, cookie: string, body: unknown = {}) => api.post(path, cookie).send(body as object);

  beforeAll(async () => {
    h = await createIdorApp();
    app = h.app;
    api = http(app);
    ownerA = await createActor(h, 'gv-owner');
    adminA = await createActor(h, 'gv-admin');
    memberA = await createActor(h, 'gv-member');
    viewerA = await createActor(h, 'gv-viewer');
    ownerB = await createActor(h, 'gv-b');
    orgA = ownerA.personalOrgId;
    orgB = ownerB.personalOrgId;
    await h.prisma.organizationMember.create({ data: { organizationId: orgA, userId: adminA.userId, role: 'admin' } });
    await h.prisma.organizationMember.create({ data: { organizationId: orgA, userId: memberA.userId, role: 'member' } });
    await h.prisma.organizationMember.create({ data: { organizationId: orgA, userId: viewerA.userId, role: 'viewer' } });

    // orgA 的作业（组织面，探查用）+ 专用于正向锚的作业 + ownerA 的个人作业（个人面）
    jobA = (await h.prisma.scheduledJob.create({
      data: { name: 'A 组织作业', handler: 'noop', type: 'one-shot', status: 'pending', organizationId: orgA, ownerUserId: ownerA.userId, runAt: new Date(Date.now() + 3_600_000) },
    })).id;
    jobOwnA = (await h.prisma.scheduledJob.create({
      data: { name: 'A 组织作业（本人取消锚）', handler: 'noop', type: 'one-shot', status: 'pending', organizationId: orgA, ownerUserId: ownerA.userId, runAt: new Date(Date.now() + 3_600_000) },
    })).id;
    jobPersonalA = (await h.prisma.scheduledJob.create({
      data: { name: 'A 个人作业', handler: 'noop', type: 'one-shot', status: 'pending', organizationId: null, ownerUserId: ownerA.userId, runAt: new Date(Date.now() + 3_600_000) },
    })).id;
    // orgA 的死信事件（重投矩阵用）
    eventDeadA = (await h.prisma.eventEnvelope.create({
      data: { eventId: `m10p15-evt-${Date.now()}`, eventType: 'order.created', organizationId: orgA, status: 'dead', attempts: 3, lastError: 'boom', payload: { secret: 'A 的事件载荷' } },
    })).eventId;

    // 指标样本：orgA / orgB 各一条（跨组织隔离断言用）
    await h.prisma.metricSample.create({ data: { organizationId: orgA, name: 'request_count', value: 11, labels: { userId: ownerA.userId } } });
    await h.prisma.metricSample.create({ data: { organizationId: orgB, name: 'request_count', value: 22, labels: { userId: ownerB.userId } } });

    // 计费计划（订阅正向锚用；平台目录，缺失则跳过正向锚）
    const plan = await h.prisma.plan.findFirst({ where: { active: true }, select: { id: true } });
    planId = plan?.id ?? null;
  });

  afterAll(async () => { await app?.close(); });

  // ───────────────────────── ① 组织级读：无组织存在性 oracle ─────────────────────────
  it('① 组织级读：他人/不存在的 organizationId → 同为 403「无权访问该组织」（无枚举 oracle）', async () => {
    const ghost = ghostId();
    const reads: Array<[string, string]> = [
      ['analytics overview', `${P}/analytics/overview?organizationId=`],
      ['analytics breakdown', `${P}/analytics/breakdown?organizationId=`],
      ['analytics sources', `${P}/analytics/sources?organizationId=`],
      ['metrics', `${P}/metrics?organizationId=`],
      ['scheduler jobs', `${P}/scheduler/jobs?organizationId=`],
      ['events', `${P}/events?organizationId=`],
      ['events dead-letter', `${P}/events/dead-letter?organizationId=`],
      ['billing subscription', `${P}/billing/subscription?organizationId=`],
      ['billing usage', `${P}/billing/usage?organizationId=`],
      ['billing invoices', `${P}/billing/invoices?organizationId=`],
      ['billing reconciliation', `${P}/billing/reconciliation?organizationId=`],
      ['routing decisions', `${P}/routing/decisions?organizationId=`],
      ['routing policies', `${P}/routing/policies?organizationId=`],
    ];
    for (const [label, base] of reads) {
      const foreign = await api.get(`${base}${orgB}`, ownerA.cookie);
      const missing = await api.get(`${base}${ghost}`, ownerA.cookie);
      // billing 读需 billing.read：ownerA 有；权限不足时同为 403 但仍须与"组织不存在"不可区分
      expect([403], `${label} 跨组织读`).toContain(foreign.status);
      expect(errorCode(foreign), `${label} 错误码`).toBe('FORBIDDEN');
      assertIndistinguishable(missing, foreign, label);
      assertNoLeak(foreign, [orgB, 'A 组织作业', 'A 的事件载荷'], label);
    }
  });

  // ───────────────────────── ② 角色越权 ─────────────────────────
  it('② 角色矩阵：billing.write 仅 owner；workflow.write = owner/admin/member（viewer 403）；读面全角色可读', async () => {
    // 组织级读：viewer 也是合法读者（200）
    for (const [label, path] of [
      ['analytics', `${P}/analytics/overview?organizationId=${orgA}`],
      ['metrics', `${P}/metrics?organizationId=${orgA}`],
      ['scheduler read', `${P}/scheduler/jobs?organizationId=${orgA}`],
      ['events read', `${P}/events?organizationId=${orgA}`],
      ['audit read', `${P}/audit-logs`],
    ] as Array<[string, string]>) {
      const res = await api.get(path, viewerA.cookie);
      expect(res.status, `viewer ${label}`).toBe(200);
    }
    // 写面：billing.write 仅 owner（admin 亦无 —— 矩阵明示）
    for (const [name, cookie] of [['admin', adminA.cookie], ['member', memberA.cookie], ['viewer', viewerA.cookie]] as Array<[string, string]>) {
      const res = await post(`${P}/analytics/refresh`, cookie, { organizationId: orgA });
      expect(res.status, `${name} analytics refresh`).toBe(403);
      expect(errorCode(res)).toBe('FORBIDDEN');
    }
    expect((await post(`${P}/analytics/refresh`, ownerA.cookie, { organizationId: orgA })).status).not.toBe(403);
    // billing 读：member 有 billing.read（200）；viewer 无（403「权限不足」）
    expect((await api.get(`${P}/billing/subscription?organizationId=${orgA}`, memberA.cookie)).status).toBe(200);
    const viewerBilling = await api.get(`${P}/billing/subscription?organizationId=${orgA}`, viewerA.cookie);
    expect(viewerBilling.status).toBe(403);
    // billing.write：admin/member/viewer 403；owner 放行
    if (planId) {
      for (const [name, cookie] of [['admin', adminA.cookie], ['member', memberA.cookie], ['viewer', viewerA.cookie]] as Array<[string, string]>) {
        const res = await post(`${P}/billing/subscribe`, cookie, { organizationId: orgA, planId });
        expect(res.status, `${name} billing.subscribe`).toBe(403);
      }
      expect((await post(`${P}/billing/subscribe`, ownerA.cookie, { organizationId: orgA, planId })).status).not.toBe(403);
    }
    // workflow.write：viewer 403（scheduler 建作业 / 事件重投）；member 放行
    expect((await post(`${P}/scheduler/jobs`, viewerA.cookie, { name: 'v', handler: 'noop', organizationId: orgA })).status).toBe(403);
    expect((await post(`${P}/events/${eventDeadA}/redeliver`, viewerA.cookie)).status).toBe(403);
    expect((await post(`${P}/scheduler/jobs`, memberA.cookie, { name: 'm10p15 成员作业', handler: 'noop', organizationId: orgA })).status).not.toBe(403);
  });

  // ───────────────────────── ③ 作业 / 事件（组织级 403 + 个人级 404）─────────────────────────
  it('③ 作业：组织作业跨组织 → 403「无权访问该组织」（M8-P5 冻结语义）；个人作业跨用户 → 404；均零副作用', async () => {
    const ghost = ghostId();
    // 组织作业：非成员 = 组织维度越权 → 403（**冻结错误码**，等价语义不因 P15 改写；见报告风险清单：
    // "他人真实作业 403 / 幽灵作业 404" 构成 1 位作业行存在性 oracle，属 M8 冻结语义下的已知取舍）
    const orgProbes: Array<[string, () => Promise<{ status: number; body: unknown }>, () => Promise<{ status: number; body: unknown }>]> = [
      ['cancel', () => post(`${P}/scheduler/jobs/${jobA}/cancel`, ownerB.cookie), () => post(`${P}/scheduler/jobs/${ghost}/cancel`, ownerB.cookie)],
      ['pause', () => post(`${P}/scheduler/jobs/${jobA}/pause`, ownerB.cookie), () => post(`${P}/scheduler/jobs/${ghost}/pause`, ownerB.cookie)],
      ['resume', () => post(`${P}/scheduler/jobs/${jobA}/resume`, ownerB.cookie), () => post(`${P}/scheduler/jobs/${ghost}/resume`, ownerB.cookie)],
    ];
    for (const [name, foreignFn, ghostFn] of orgProbes) {
      const foreign = await foreignFn();
      const missing = await ghostFn();
      expect(foreign.status, `跨组织作业 ${name}`).toBe(403);
      expect(errorCode(foreign), `跨组织作业 ${name} 错误码`).toBe('FORBIDDEN');
      expect(missing.status, `幽灵作业 ${name}`).toBe(404);
      assertNoLeak(foreign, [jobA, ownerA.userId], `scheduler job ${name}`);
    }
    // 个人作业：跨用户 = 用户级资源 → 404（与幽灵 id 零信息差，本模块真防枚举面）
    const personalForeign = await post(`${P}/scheduler/jobs/${jobPersonalA}/cancel`, ownerB.cookie);
    const personalMissing = await post(`${P}/scheduler/jobs/${ghost}/cancel`, ownerB.cookie);
    expect(personalForeign.status).toBe(404);
    expect(errorCode(personalForeign)).toBe('NOT_FOUND');
    assertIndistinguishable(personalMissing, personalForeign, 'scheduler personal job cancel');
    assertNoLeak(personalForeign, [jobPersonalA, ownerA.userId], 'scheduler personal job cancel');
    // 零副作用：两个作业仍是 pending（越权取消绝不落库）
    expect((await h.prisma.scheduledJob.findUnique({ where: { id: jobA } }))?.status).toBe('pending');
    expect((await h.prisma.scheduledJob.findUnique({ where: { id: jobPersonalA } }))?.status).toBe('pending');
    // 正向锚：本组织 owner 取消自己的作业（专用行，避免影响 ④ 的组织列表断言）→ 状态真的推进
    const own = await post(`${P}/scheduler/jobs/${jobOwnA}/cancel`, ownerA.cookie);
    expect(own.status).toBe(201);
    expect((await h.prisma.scheduledJob.findUnique({ where: { id: jobOwnA } }))?.status).toBe('cancelled');
  });

  it('③-b 事件重投：跨组织 404（与幽灵事件同形）；本人组织成员放行且状态真的推进', async () => {
    const ghostEvent = `00000000-0000-4000-8000-${String(Date.now() % 1e12).padStart(12, '0')}`;
    const foreign = await post(`${P}/events/${eventDeadA}/redeliver`, ownerB.cookie);
    const missing = await post(`${P}/events/${ghostEvent}/redeliver`, ownerB.cookie);
    expect(foreign.status).toBe(404);
    assertIndistinguishable(missing, foreign, 'event redeliver');
    assertNoLeak(foreign, [eventDeadA, 'A 的事件载荷', orgA], 'event redeliver');
    // 零副作用：他人越权绝不改动事件状态
    expect((await h.prisma.eventEnvelope.findUnique({ where: { eventId: eventDeadA } }))?.status).toBe('dead');
    // 正向锚：本组织成员（workflow.write）放行且状态离开 dead
    const ok = await post(`${P}/events/${eventDeadA}/redeliver`, memberA.cookie);
    expect(ok.status).not.toBe(403);
    expect(ok.status).not.toBe(404);
    expect((await h.prisma.eventEnvelope.findUnique({ where: { eventId: eventDeadA } }))?.status).not.toBe('dead');
  });

  // ───────────────────────── ④ 列表租户隔离 ─────────────────────────
  it('④ 列表隔离：组织面绝不含他组织行；个人面（个人作业/审计/反馈）只含本人行', async () => {
    // 个人作业面：A 通过 API 建个人作业（缺省 = 个人组织）→ A 可见、B 绝不可见
    const pj = data<{ job: IdRow }>(await post(`${P}/scheduler/jobs`, ownerA.cookie, { name: 'M10P15 A 个人作业', handler: 'noop' }));
    const mineJobs = data<{ jobs: IdRow[] }>(await api.get(`${P}/scheduler/jobs`, ownerA.cookie)).jobs;
    expect(mineJobs.some((j) => j.id === pj.job.id)).toBe(true); // 归属锚
    const personalList = data<{ jobs: IdRow[] }>(await api.get(`${P}/scheduler/jobs`, ownerB.cookie)).jobs;
    expect(personalList.some((j) => j.id === pj.job.id)).toBe(false);
    expect(personalList.some((j) => j.id === jobPersonalA)).toBe(false);

    // 组织面：ownerB 读自己组织的作业列表，绝不含 orgA 的作业
    const orgList = data<{ jobs: IdRow[] }>(await api.get(`${P}/scheduler/jobs?organizationId=${orgB}`, ownerB.cookie)).jobs;
    expect(orgList.some((j) => j.id === jobA)).toBe(false);
    expect(orgList.some((j) => j.id === pj.job.id)).toBe(false); // 个人组织作业绝不出现在共享组织列表
    const orgAList = data<{ jobs: IdRow[] }>(await api.get(`${P}/scheduler/jobs?organizationId=${orgA}`, ownerA.cookie)).jobs;
    expect(orgAList.some((j) => j.id === jobA)).toBe(true); // 归属锚

    // 指标：orgA 面无 orgB 样本（值 22 绝不出现在 A 的结果里）；orgB 面无 orgA 样本
    const metricsA = data<Array<{ value: number }>>(await api.get(`${P}/metrics?organizationId=${orgA}`, ownerA.cookie));
    expect(metricsA.some((m) => m.value === 22)).toBe(false);
    expect(metricsA.some((m) => m.value === 11)).toBe(true);
    const metricsB = data<Array<{ value: number }>>(await api.get(`${P}/metrics?organizationId=${orgB}`, ownerB.cookie));
    expect(metricsB.some((m) => m.value === 11)).toBe(false);

    // 审计：`where` 只有 `userId`（设计即用户级）→ A 的行可见、B 的行绝不出现
    const anchorTarget = `m10p15-audit-${Date.now()}`;
    await h.prisma.auditLog.create({
      data: { userId: ownerA.userId, action: 'm10p15.anchor', targetType: 'm10p15', targetId: anchorTarget },
    });
    const auditA = data<Array<{ targetId: string | null; userId: string }>>(await api.get(`${P}/audit-logs`, ownerA.cookie));
    expect(auditA.some((r) => r.targetId === anchorTarget)).toBe(true); // 归属锚：本人可见
    expect(auditA.every((r) => r.userId === ownerA.userId)).toBe(true); // 列表纯用户级
    const auditB = await api.get(`${P}/audit-logs`, ownerB.cookie);
    assertNoLeak(auditB, [anchorTarget, ownerA.userId], 'audit-logs 跨用户');
    expect(data<Array<{ targetId: string | null }>>(auditB).some((r) => r.targetId === anchorTarget)).toBe(false);

    // 反馈：A 的反馈不出现在 B 的列表（userId 钉死）
    const fb = data<IdRow>(await post(`${P}/feedback`, ownerA.cookie, { subjectType: 'artifact', subjectId: 'm10p15-subj', rating: 5 }));
    const fbB = data<IdRow[]>(await api.get(`${P}/feedback`, ownerB.cookie));
    expect(fbB.some((r) => r.id === fb.id)).toBe(false);
  });

  // ───────────────────────── ⑤ 平台面与路由 ─────────────────────────
  it('⑤ 平台面：平台级策略/能力维护仅平台管理员；路由决策只返回本组织决策', async () => {
    // 平台级策略（organizationId=null）与平台策略列表：非管理员 → 403
    const platformPolicy = await post(`${P}/routing/policies`, ownerA.cookie, { organizationId: null, providerId: 'mock-openai' });
    expect(platformPolicy.status).toBe(403);
    expect((await api.get(`${P}/routing/policies?platform=true`, ownerA.cookie)).status).toBe(403);
    // 能力目录维护（sync）仅平台管理员；只读目录登录即可
    expect((await post(`${P}/routing/capabilities/sync`, ownerA.cookie)).status).toBe(403);
    expect((await api.get(`${P}/routing/capabilities`, ownerA.cookie)).status).toBe(200);

    // 路由决策：带他人 organizationId → 403（同码同文案，无组织存在性 oracle）
    const foreign = await api.get(`${P}/routing/decisions?organizationId=${orgB}`, ownerA.cookie);
    const missing = await api.get(`${P}/routing/decisions?organizationId=${ghostId()}`, ownerA.cookie);
    expect(foreign.status).toBe(403);
    assertIndistinguishable(missing, foreign, 'routing decisions');
  });
});
