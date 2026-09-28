/**
 * M10-P15 · 残差 IDOR/RBAC 矩阵：evaluation 资源面 / extensions 私有面 / creative-loop（洞察+假设）/
 * 审批列表 / 聊天发消息 / 绩效洞察 / 计划目录 / 市场目录 / 评审审核（含 BUG-16 锁定）。
 *
 * 这批端点在第一批矩阵中只覆盖到"集合级"或未覆盖，此处补齐**资源级 + 角色级**断言：
 * ① evaluation 资源：dataset 版本 / run 详情 / run 对照 / run 取消 —— 跨组织 404 与幽灵 id 同码同文案；
 *    写面（取消）= evaluation.write，仅 owner/admin：viewer/member → 403 且零副作用；
 * ② extensions 私有面：`GET /extensions/:id` 的**组织上下文双面**（他人 organizationId → 403 同形；
 *    本组织上下文 + 他人私有扩展 → 404 与幽灵同形）；steps 同形；PATCH/deprecate/archive 跨组织被拒且零副作用；
 * ③ creative-loop：洞察与假设的资源级跨组织一律 404（同码同文案）+ 列表租户隔离；
 * ④ 残差面：审批/会话列表用户级隔离、POST /chat 跨用户会话 404、绩效洞察 userId 隔离、
 *    `GET /billing/plans` 与 `GET /marketplace/categories` 平台目录登录即可读且零组织数据泄漏、
 *    `POST /marketplace/reviews/:id/moderation` 的 **BUG-16**（非成员 404 文案必须与幽灵评审逐字相同）。
 *
 * 说明：所有 404 判定发生在任何业务读写之前，故资源行可用 prisma 直插（正向锚点仍走真实 API）。
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { INestApplication } from '@nestjs/common';
import {
  Actor, addMember, assertIndistinguishable, assertNoLeak, createActor, createIdorApp, data, errorCode,
  ghostId, http, HttpApi, IdorApp,
} from './support/idor-harness';

const P = '/api/v1';

interface IdRow { id: string }

describe('M10-P15 IDOR 矩阵 · 残差（evaluation 资源 / extensions 私有面 / creative-loop / 目录与审核）', () => {
  let h: IdorApp;
  let app: INestApplication;
  let api: HttpApi;

  let ownerA: Actor; let memberA: Actor; let viewerA: Actor; let ownerB: Actor;
  let orgA: string; let orgB: string;

  let projectA: string;
  let datasetA: string; let runA: string; let runCancelA: string;
  let extA: string; let publicationA: string; let reviewA: string;
  let insightA: string; let hypothesisA: string;
  let conversationA: string; let approvalA: string; let approvalRunA: string;
  let markerCampaign: string;

  const post = (path: string, cookie: string, body: unknown = {}) => api.post(path, cookie).send(body as object);

  beforeAll(async () => {
    h = await createIdorApp();
    app = h.app;
    api = http(app);
    ownerA = await createActor(h, 'rs-owner');
    memberA = await createActor(h, 'rs-member');
    viewerA = await createActor(h, 'rs-viewer');
    ownerB = await createActor(h, 'rs-b');
    orgA = ownerA.personalOrgId;
    orgB = ownerB.personalOrgId;
    await addMember(h, orgA, memberA.userId, 'member');
    await addMember(h, orgA, viewerA.userId, 'viewer');

    // 项目走真实 API（创意闭环要求"项目挂组织"——直插行没有组织关系，会被 400 拒绝）
    const projectRes = await post(`${P}/projects`, ownerA.cookie, { name: 'M10P15 残差项目 A' });
    expect(projectRes.status, `创建项目失败：${JSON.stringify(projectRes.body)}`).toBe(201);
    projectA = data<IdRow>(projectRes).id;
    // 绩效事实（绩效洞察隔离断言用；userId 钉死）
    markerCampaign = `m10p15-campaign-${Date.now()}`;
    await h.prisma.creativePerformance.create({
      data: {
        userId: ownerA.userId, projectId: projectA, campaignId: markerCampaign, platform: 'mock',
        periodStart: new Date(Date.now() - 86_400_000), periodEnd: new Date(),
        impressions: 1000, clicks: 30, spend: 100, conversions: 3, revenue: 300, orders: 3,
      },
    });

    // ── evaluation：数据集（API 真实创建，落 A 个人组织）+ run（直插：404 在任何业务读之前）──
    datasetA = data<IdRow>(await post(`${P}/evaluation/datasets`, ownerA.cookie, { name: 'M10P15 A 数据集' })).id;
    const runData = {
      organizationId: orgA, userId: ownerA.userId, datasetId: datasetA, datasetVersion: 1,
      agentId: 'm10p15-agent', agentVersionId: 'm10p15-agent-version', configSnapshot: {}, status: 'pending',
    };
    runA = (await h.prisma.evaluationRun.create({ data: runData })).id;
    runCancelA = (await h.prisma.evaluationRun.create({ data: runData })).id;

    // ── extensions：A 的组织私有扩展（直插；manifest 不在本表）+ 其市场条目与评审 ──
    extA = (await h.prisma.extension.create({
      data: {
        organizationId: orgA, ownerUserId: ownerA.userId, name: 'M10P15 A 私有扩展',
        slug: `m10p15-residual-${Date.now()}`, kind: 'tool', status: 'draft',
      },
    })).id;
    publicationA = (await h.prisma.extensionPublication.create({
      data: {
        organizationId: orgA, userId: ownerA.userId, extensionId: extA, status: 'published',
        category: 'knowledge', description: 'M10P15 A 的市场条目',
      },
    })).id;
    reviewA = (await h.prisma.extensionReview.create({
      data: { publicationId: publicationA, userId: ownerB.userId, rating: 4, body: 'M10P15 局外人的评审', moderationStatus: 'pending' },
    })).id;

    // ── creative-loop：A 的洞察与假设（走真实 API，组织 scope 由服务端解析）──
    const insightRes = await post(`${P}/creative-loop/insights`, ownerA.cookie,
      { projectId: projectA, days: 30, includeEvaluation: false });
    expect(insightRes.status, `创建洞察失败：${JSON.stringify(insightRes.body)}`).toBe(201);
    insightA = data<IdRow>(insightRes).id;
    const hypothesisRes = await post(`${P}/creative-loop/hypotheses`, ownerA.cookie,
      { statement: 'M10P15 A 的假设：提升主图对比度可提升点击率', platform: 'mock', projectId: projectA });
    expect(hypothesisRes.status, `创建假设失败：${JSON.stringify(hypothesisRes.body)}`).toBe(201);
    hypothesisA = data<IdRow>(hypothesisRes).id;

    // ── 会话 / 审批（用户级资源）──
    conversationA = (await h.prisma.conversation.create({ data: { userId: ownerA.userId, title: 'A 的残差会话' } })).id;
    const agent = await h.prisma.agent.create({ data: { slug: `m10p15-residual-${Date.now()}`, name: 'M10P15 残差 agent', scope: 'system' } });
    approvalRunA = (await h.prisma.agentRun.create({
      data: { userId: ownerA.userId, agentId: agent.id, status: 'waiting' },
    })).id;
    approvalA = (await h.prisma.approval.create({
      data: { userId: ownerA.userId, agentRunId: approvalRunA, status: 'requested', reason: 'A 的残差审批理由' },
    })).id;
    expect(conversationA && approvalA && approvalRunA).toBeTruthy();
  });

  afterAll(async () => { await app?.close(); });

  // ───────────────────── ① evaluation 资源面 ─────────────────────
  it('① evaluation 资源：dataset 版本 / run 详情 / run 对照 / run 取消 跨组织 404（与幽灵同形）+ 零副作用', async () => {
    const ghost = ghostId();
    const probes: Array<[string, () => Promise<{ status: number; body: unknown }>, () => Promise<{ status: number; body: unknown }>]> = [
      ['dataset versions', () => api.get(`${P}/evaluation/datasets/${datasetA}/versions`, ownerB.cookie),
        () => api.get(`${P}/evaluation/datasets/${ghost}/versions`, ownerB.cookie)],
      ['run get', () => api.get(`${P}/evaluation/runs/${runA}`, ownerB.cookie),
        () => api.get(`${P}/evaluation/runs/${ghost}`, ownerB.cookie)],
      ['run comparison', () => api.get(`${P}/evaluation/runs/${runA}/comparison`, ownerB.cookie),
        () => api.get(`${P}/evaluation/runs/${ghost}/comparison`, ownerB.cookie)],
      ['run cancel', () => post(`${P}/evaluation/runs/${runA}/cancel`, ownerB.cookie),
        () => post(`${P}/evaluation/runs/${ghost}/cancel`, ownerB.cookie)],
    ];
    for (const [name, foreignFn, ghostFn] of probes) {
      const foreign = await foreignFn();
      const missing = await ghostFn();
      expect(foreign.status, `跨组织 ${name}`).toBe(404);
      expect(errorCode(foreign), `跨组织 ${name} 错误码`).toBe('NOT_FOUND');
      assertIndistinguishable(missing, foreign, `evaluation ${name}`);
      assertNoLeak(foreign, [datasetA, runA, orgA, ownerA.userId, 'M10P15 A 数据集'], `evaluation ${name}`);
    }
    // 零副作用：跨组织取消绝不改他人 run 状态
    expect((await h.prisma.evaluationRun.findUnique({ where: { id: runA } }))?.status).toBe('pending');
    expect((await h.prisma.evaluationRun.findUnique({ where: { id: runCancelA } }))?.status).toBe('pending');
    // 正向锚：本组织 owner 读 200（证明上面 404 来自归属裁决而非资源缺失/路由错误）
    expect((await api.get(`${P}/evaluation/datasets/${datasetA}/versions`, ownerA.cookie)).status).toBe(200);
    expect((await api.get(`${P}/evaluation/runs/${runA}`, ownerA.cookie)).status).toBe(200);
    expect((await api.get(`${P}/evaluation/runs/${runA}/comparison`, ownerA.cookie)).status).toBe(200);
  });

  // ───────────────────── ② evaluation 角色面 ─────────────────────
  it('② evaluation 写面（取消 run）= evaluation.write：viewer/member 403「权限不足」且零副作用；owner 放行', async () => {
    for (const [name, actor] of [['viewer', viewerA], ['member', memberA]] as Array<[string, Actor]>) {
      const res = await post(`${P}/evaluation/runs/${runCancelA}/cancel`, actor.cookie);
      expect(res.status, `${name} 取消 run`).toBe(403);
      expect(errorCode(res), `${name} 取消 run`).toBe('FORBIDDEN');
      assertNoLeak(res, [runCancelA, orgA, datasetA], `evaluation cancel ${name}`);
    }
    // 零副作用：越权取消绝不落库
    expect((await h.prisma.evaluationRun.findUnique({ where: { id: runCancelA } }))?.status).toBe('pending');
    // 正向锚：owner 放行且状态真的推进（取消是写动作，非"无操作 200"）
    const ok = await post(`${P}/evaluation/runs/${runCancelA}/cancel`, ownerA.cookie);
    expect(ok.status).toBe(201);
    expect((await h.prisma.evaluationRun.findUnique({ where: { id: runCancelA } }))?.status).toBe('cancelled');
  });

  // ───────────────────── ③ extensions 私有面 ─────────────────────
  it('③ extensions 私有面：详情双面裁决（他人组织 403 同形 / 本组织上下文 404 同形）+ 管理写被拒且零副作用', async () => {
    const ghost = ghostId();
    const ghostOrg = ghostId();

    // (a) 组织上下文面：带他人 organizationId → 403「无权访问该组织」，与幽灵 organizationId 同码同文案
    const foreignOrg = await api.get(`${P}/extensions/${extA}?organizationId=${orgA}`, ownerB.cookie);
    const missingOrg = await api.get(`${P}/extensions/${extA}?organizationId=${ghostOrg}`, ownerB.cookie);
    expect(foreignOrg.status).toBe(403);
    expect(errorCode(foreignOrg)).toBe('FORBIDDEN');
    assertIndistinguishable(missingOrg, foreignOrg, 'extensions get 组织上下文');
    assertNoLeak(foreignOrg, [extA, 'M10P15 A 私有扩展', ownerA.userId], 'extensions get 跨组织');

    // (b) 资源可见性面：在本组织上下文里读他人私有扩展 → 404，与幽灵扩展 id 同码同文案（防枚举核心）
    const foreignExt = await api.get(`${P}/extensions/${extA}?organizationId=${orgB}`, ownerB.cookie);
    const missingExt = await api.get(`${P}/extensions/${ghost}?organizationId=${orgB}`, ownerB.cookie);
    expect(foreignExt.status).toBe(404);
    expect(errorCode(foreignExt)).toBe('NOT_FOUND');
    assertIndistinguishable(missingExt, foreignExt, 'extensions get 资源可见性');
    assertNoLeak(foreignExt, [extA, 'M10P15 A 私有扩展', orgA, ownerA.userId], 'extensions get 资源可见性');

    // (c) steps：组织上下文同形（幽灵 organizationId 与真实他人 organizationId 不可区分）
    const foreignSteps = await api.get(`${P}/extensions/steps?organizationId=${orgA}`, ownerB.cookie);
    const missingSteps = await api.get(`${P}/extensions/steps?organizationId=${ghostOrg}`, ownerB.cookie);
    expect(foreignSteps.status).toBe(403);
    assertIndistinguishable(missingSteps, foreignSteps, 'extensions steps 组织上下文');

    // (d) 管理写：跨组织 PATCH/deprecate/archive 一律拒绝（现状 403 = M8 冻结的"跨组织管理 = 越权"语义；
    //     幽灵 id → 404。两者可区分属已知 1 位 id 存在性 oracle，已列入报告 NOT FIXED/风险清单）
    const foreignWrite = await api.patch(`${P}/extensions/${extA}`, ownerB.cookie).send({ name: '越权改名' });
    expect([403, 404], '跨组织 PATCH').toContain(foreignWrite.status);
    expect([403, 404]).toContain((await post(`${P}/extensions/${extA}/deprecate`, ownerB.cookie)).status);
    expect([403, 404]).toContain((await post(`${P}/extensions/${extA}/archive`, ownerB.cookie)).status);
    // 零副作用：扩展仍是 draft、未产生任何新版本行
    const ext = await h.prisma.extension.findUnique({ where: { id: extA } });
    expect(ext?.status).toBe('draft');
    expect(ext?.name).toBe('M10P15 A 私有扩展');
    expect(await h.prisma.extensionVersion.count({ where: { extensionId: extA } })).toBe(0);
    // 正向锚：本组织 owner 读 200
    expect((await api.get(`${P}/extensions/${extA}?organizationId=${orgA}`, ownerA.cookie)).status).toBe(200);
  });

  // ───────────────────── ④ creative-loop 洞察 ─────────────────────
  it('④ 洞察：跨组织 get / interpretation → 404「洞察不存在」（与幽灵同形）+ 列表租户隔离', async () => {
    const ghost = ghostId();
    const foreignGet = await api.get(`${P}/creative-loop/insights/${insightA}`, ownerB.cookie);
    const missingGet = await api.get(`${P}/creative-loop/insights/${ghost}`, ownerB.cookie);
    expect(foreignGet.status).toBe(404);
    expect(errorCode(foreignGet)).toBe('NOT_FOUND');
    assertIndistinguishable(missingGet, foreignGet, 'insight get');
    assertNoLeak(foreignGet, [insightA, orgA, projectA, ownerA.userId], 'insight get');

    const foreignInterp = await post(`${P}/creative-loop/insights/${insightA}/interpretation`, ownerB.cookie,
      { items: ['越权写入的解读'] });
    const missingInterp = await post(`${P}/creative-loop/insights/${ghost}/interpretation`, ownerB.cookie,
      { items: ['越权写入的解读'] });
    expect(foreignInterp.status).toBe(404);
    assertIndistinguishable(missingInterp, foreignInterp, 'insight interpretation');
    // 零副作用：越权解读绝不落库（本人读回仍是空解读）
    const own = data<{ interpretation: { items: string[] } | null }>(await api.get(`${P}/creative-loop/insights/${insightA}`, ownerA.cookie));
    expect(own.interpretation?.items ?? []).not.toContain('越权写入的解读');

    // 列表租户隔离：B 的洞察列表（个人面与显式组织面）绝不含 A 的洞察
    const listB = data<{ insights: IdRow[] }>(await api.get(`${P}/creative-loop/insights`, ownerB.cookie)).insights;
    expect(listB.some((i) => i.id === insightA)).toBe(false);
    const listBOrg = data<{ insights: IdRow[] }>(await api.get(`${P}/creative-loop/insights?organizationId=${orgB}`, ownerB.cookie)).insights;
    expect(listBOrg.some((i) => i.id === insightA)).toBe(false);
    const listA = data<{ insights: IdRow[] }>(await api.get(`${P}/creative-loop/insights`, ownerA.cookie)).insights;
    expect(listA.some((i) => i.id === insightA)).toBe(true); // 归属锚
  });

  // ───────────────────── ⑤ creative-loop 假设 ─────────────────────
  it('⑤ 假设：跨组织 10 个端点一律 404「假设不存在」（与幽灵同形）+ 零副作用（绝不固化 workflow）', async () => {
    const ghost = ghostId();
    const probes: Array<[string, () => Promise<{ status: number; body: unknown }>]> = [
      ['get', () => api.get(`${P}/creative-loop/hypotheses/${hypothesisA}`, ownerB.cookie)],
      ['patch', () => api.patch(`${P}/creative-loop/hypotheses/${hypothesisA}`, ownerB.cookie).send({ statement: '越权改写' })],
      ['status set', () => post(`${P}/creative-loop/hypotheses/${hypothesisA}/status`, ownerB.cookie, { status: 'ready' })],
      ['delete', () => api.delete(`${P}/creative-loop/hypotheses/${hypothesisA}`, ownerB.cookie)],
      ['loop status', () => api.get(`${P}/creative-loop/hypotheses/${hypothesisA}/status`, ownerB.cookie)],
      ['loop run', () => api.get(`${P}/creative-loop/hypotheses/${hypothesisA}/run`, ownerB.cookie)],
      ['loop start', () => post(`${P}/creative-loop/hypotheses/${hypothesisA}/start`, ownerB.cookie, { waitMs: 500 })],
      ['conclude', () => post(`${P}/creative-loop/hypotheses/${hypothesisA}/conclude`, ownerB.cookie, { decision: 'rejected', reason: '越权判定' })],
      ['evaluation', () => post(`${P}/creative-loop/hypotheses/${hypothesisA}/evaluation`, ownerB.cookie, { evaluationRunId: datasetA })],
      ['experiment', () => post(`${P}/creative-loop/hypotheses/${hypothesisA}/experiment`, ownerB.cookie, { experimentId: datasetA })],
    ];
    const ghostRes = await api.get(`${P}/creative-loop/hypotheses/${ghost}`, ownerB.cookie);
    for (const [name, fn] of probes) {
      const res = await fn();
      expect(res.status, `跨组织假设 ${name}：${JSON.stringify(res.body)}`).toBe(404);
      expect(errorCode(res), `跨组织假设 ${name} 错误码`).toBe('NOT_FOUND');
      assertIndistinguishable(ghostRes, res, `hypothesis ${name}`);
      assertNoLeak(res, [hypothesisA, orgA, projectA, ownerA.userId], `hypothesis ${name}`);
    }
    // 零副作用：假设状态未被推进、statement 未被改写、绝未固化 workflow 定义
    const own = data<{ status: string; statement: string }>(await api.get(`${P}/creative-loop/hypotheses/${hypothesisA}`, ownerA.cookie));
    expect(own.status).toBe('draft');
    expect(own.statement).toContain('提升主图对比度');
    expect(await h.prisma.workflow.count({ where: { userId: ownerA.userId, name: `creative-loop:${hypothesisA}` } })).toBe(0);
    // 列表租户隔离
    const listB = data<{ hypotheses: IdRow[] }>(await api.get(`${P}/creative-loop/hypotheses`, ownerB.cookie)).hypotheses;
    expect(listB.some((x) => x.id === hypothesisA)).toBe(false);
  });

  // ───────────────────── ⑥ 残差面（审批/聊天/绩效/目录/评审审核）─────────────────────
  it('⑥ 残差面：审批·会话·聊天·绩效洞察用户级隔离；平台目录登录可读零泄漏；评审审核非成员 404 同形（BUG-16）', async () => {
    const ghost = ghostId();

    // (a) 审批列表：`where` 只钉 userId（他人审批绝不出现在 B 的列表）
    const listApprovalsB = data<Array<{ id: string; userId: string }>>(await api.get(`${P}/approvals`, ownerB.cookie));
    expect(listApprovalsB.some((r) => r.id === approvalA)).toBe(false);
    expect(listApprovalsB.every((r) => r.userId === ownerB.userId)).toBe(true);
    const listApprovalsA = data<Array<{ id: string }>>(await api.get(`${P}/approvals`, ownerA.cookie));
    expect(listApprovalsA.some((r) => r.id === approvalA)).toBe(true); // 归属锚

    // (b) 会话列表：他人会话绝不出现；POST /conversations 只建自己的会话
    const listConvB = data<IdRow[]>(await api.get(`${P}/conversations`, ownerB.cookie));
    expect(listConvB.some((c) => c.id === conversationA)).toBe(false);
    const createdB = data<IdRow>(await post(`${P}/conversations`, ownerB.cookie, {}));
    expect((await h.prisma.conversation.findUnique({ where: { id: createdB.id } }))?.userId).toBe(ownerB.userId);

    // (c) POST /chat：跨用户会话 → 404「对话不存在」（SSE 开始前即裁决，走统一 JSON 信封）
    const foreignChat = await post(`${P}/chat`, ownerB.cookie, { conversationId: conversationA, message: '越权发消息' });
    const missingChat = await post(`${P}/chat`, ownerB.cookie, { conversationId: ghost, message: '越权发消息' });
    expect(foreignChat.status).toBe(404);
    expect(errorCode(foreignChat)).toBe('NOT_FOUND');
    assertIndistinguishable(missingChat, foreignChat, 'chat 跨用户会话');
    // 零副作用：A 的会话里绝不出现越权消息
    expect(await h.prisma.message.count({ where: { conversationId: conversationA } })).toBe(0);

    // (d) 绩效洞察：userId 钉死（A 的绩效事实绝不出现在 B 的洞察里）
    const insightsB = await api.get(`${P}/feedback/performance/insights`, ownerB.cookie);
    expect(insightsB.status).toBe(200);
    assertNoLeak(insightsB, [markerCampaign, projectA], 'feedback insights 跨用户');
    const insightsA = await api.get(`${P}/feedback/performance/insights`, ownerA.cookie);
    expect(JSON.stringify(insightsA.body)).toContain(markerCampaign); // 归属锚

    // (e) 平台目录：登录即可读，且零组织/租户数据泄漏
    for (const [label, path] of [['billing plans', `${P}/billing/plans`], ['marketplace categories', `${P}/marketplace/categories`]] as Array<[string, string]>) {
      const res = await api.get(path, ownerB.cookie);
      expect(res.status, label).toBe(200);
      assertNoLeak(res, [orgA, ownerA.userId, markerCampaign], label);
    }

    // (f) 评审审核：非成员 404 必须与幽灵评审**逐字相同**（BUG-16；此前复用条目级文案 = 评审 id 存在性 oracle）
    const foreignModeration = await post(`${P}/marketplace/reviews/${reviewA}/moderation`, ownerB.cookie, { status: 'approved' });
    const missingModeration = await post(`${P}/marketplace/reviews/${ghost}/moderation`, ownerB.cookie, { status: 'approved' });
    expect(foreignModeration.status).toBe(404);
    expect(errorCode(foreignModeration)).toBe('NOT_FOUND');
    assertIndistinguishable(missingModeration, foreignModeration, 'review moderation 非成员');
    assertNoLeak(foreignModeration, [reviewA, publicationA, extA, orgA], 'review moderation 非成员');
    expect((await h.prisma.extensionReview.findUnique({ where: { id: reviewA } }))?.moderationStatus).toBe('pending');
    // 本组织成员但非治理角色 → 403（member/viewer 均无治理权）
    const viewerModeration = await post(`${P}/marketplace/reviews/${reviewA}/moderation`, viewerA.cookie, { status: 'approved' });
    expect(viewerModeration.status).toBe(403);
    expect(errorCode(viewerModeration)).toBe('FORBIDDEN');
    expect((await h.prisma.extensionReview.findUnique({ where: { id: reviewA } }))?.moderationStatus).toBe('pending');
    // 正向锚：条目所属组织 owner 放行且状态真的推进
    const okModeration = await post(`${P}/marketplace/reviews/${reviewA}/moderation`, ownerA.cookie, { status: 'approved' });
    expect(okModeration.status).toBe(201);
    expect((await h.prisma.extensionReview.findUnique({ where: { id: reviewA } }))?.moderationStatus).toBe('approved');
  });
});
