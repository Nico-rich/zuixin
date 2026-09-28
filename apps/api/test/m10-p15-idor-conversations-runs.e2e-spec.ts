/**
 * M10-P15 · 会话 / 消息 / 任务 / Run / 用量 / 审批 / 连接 / 外部动作 域 IDOR 矩阵
 * （含 BUG-14 的 e2e 回归锁定）。
 *
 * 这批模块的归属是 **`userId` 级**（无组织层）→ 横轴是"跨用户"：
 * ① 会话：跨用户 get/patch/delete/messages → 404「对话不存在」，与幽灵 id 零信息差；
 * ② 消息：跨用户 patch/delete → 404「消息不存在」（本人非 user 角色的消息另是 403，属自身语义）；
 * ③ 任务：跨用户 get/cancel → 404「任务不存在」；列表按会话归属裁决 → 404「对话不存在」；
 * ④ Run：跨用户 get/timeline/cancel/retry/**events(SSE)** → 404「运行不存在」，与幽灵 id 零信息差；
 * ⑤ 用量/审批/外部动作：跨用户 404（「运行不存在」「审批不存在」「外部动作不存在」）且零副作用；
 * ⑥ 连接：跨用户 get/refresh/revoke/delete → 404；**BUG-14** —— 读面必须与写面同谓词
 *    （仅 `{ id, userId }`）：同组织的其他成员读同事连接一律 404（此前组织成员分支可读）。
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { INestApplication } from '@nestjs/common';
import {
  Actor, assertIndistinguishable, assertNoLeak, createActor, createIdorApp, data, errorCode,
  ghostId, http, HttpApi, IdorApp,
} from './support/idor-harness';

const P = '/api/v1';

interface IdRow { id: string }

describe('M10-P15 IDOR 矩阵 · conversations / messages / tasks / runs / approvals / connections', () => {
  let h: IdorApp;
  let app: INestApplication;
  let api: HttpApi;

  let userA: Actor; let userB: Actor; let userC: Actor;
  let conversationId: string; let messageId: string; let taskId: string;
  let runId: string; let approvalId: string; let externalActionId: string; let connectionId: string;

  const post = (path: string, cookie: string, body: unknown = {}) => api.post(path, cookie).send(body as object);

  beforeAll(async () => {
    h = await createIdorApp();
    app = h.app;
    api = http(app);
    userA = await createActor(h, 'cv-a');
    userB = await createActor(h, 'cv-b');
    userC = await createActor(h, 'cv-c');

    // ── A 的资源（直插：跨用户 404 在任何业务读取之前即成立）──
    conversationId = (await h.prisma.conversation.create({
      data: { userId: userA.userId, title: 'A 的私密会话' },
    })).id;
    messageId = (await h.prisma.message.create({
      data: { conversationId, userId: userA.userId, role: 'user', content: 'A 的私密消息内容' },
    })).id;
    taskId = (await h.prisma.generationTask.create({
      data: { userId: userA.userId, conversationId, type: 'image', input: { prompt: 'A 的任务提示词' } },
    })).id;
    const agent = await h.prisma.agent.create({ data: { slug: `m10p15-run-${Date.now()}`, name: 'M10P15 run agent', scope: 'system' } });
    runId = (await h.prisma.agentRun.create({
      data: { userId: userA.userId, agentId: agent.id, conversationId, status: 'completed', completedAt: new Date() },
    })).id;
    approvalId = (await h.prisma.approval.create({
      data: { userId: userA.userId, agentRunId: runId, status: 'requested', reason: 'A 的私密审批理由' },
    })).id;
    externalActionId = (await h.prisma.externalAction.create({
      data: {
        userId: userA.userId, agentRunId: runId, provider: 'mock', actionType: 'success',
        permission: 'external_action', riskLevel: 'low', input: { secret: 'A 的外部动作入参' },
        idempotencyKey: `m10p15-ea-${Date.now()}`,
      },
    })).id;

    // ── A 的 OAuth 连接（走真实 mock provider 流程）──
    const start = await post(`${P}/connections/mock/start`, userA.cookie);
    expect(start.status).toBe(201);
    const cb = await api.get(`${P}/connections/mock/callback?state=${data<{ state: string }>(start).state}&code=m10p15-code`, userA.cookie);
    expect(cb.status).toBe(200);
    connectionId = data<IdRow>(cb).id;

    // BUG-14 前提：C 是 A **个人组织**的成员（邀请面未拦个人组织 ⇒ 该分支真实可达）
    await h.prisma.organizationMember.create({
      data: { organizationId: userA.personalOrgId, userId: userC.userId, role: 'member' },
    });
  });

  afterAll(async () => { await app?.close(); });

  // ───────────────────────── ① 会话 ─────────────────────────
  it('① 会话：跨用户 get/patch/delete/messages → 404「对话不存在」，与幽灵 id 零信息差；零副作用', async () => {
    const ghost = ghostId();
    const probes: Array<[string, () => Promise<{ status: number; body: unknown }>, () => Promise<{ status: number; body: unknown }>]> = [
      ['get', () => api.get(`${P}/conversations/${conversationId}`, userB.cookie), () => api.get(`${P}/conversations/${ghost}`, userB.cookie)],
      ['patch', () => api.patch(`${P}/conversations/${conversationId}`, userB.cookie).send({ title: 'hijack 标题' }), () => api.patch(`${P}/conversations/${ghost}`, userB.cookie).send({ title: 'hijack 标题' })],
      ['messages', () => api.get(`${P}/conversations/${conversationId}/messages`, userB.cookie), () => api.get(`${P}/conversations/${ghost}/messages`, userB.cookie)],
      ['delete', () => api.delete(`${P}/conversations/${conversationId}`, userB.cookie), () => api.delete(`${P}/conversations/${ghost}`, userB.cookie)],
    ];
    for (const [name, foreignFn, ghostFn] of probes) {
      const foreign = await foreignFn();
      const missing = await ghostFn();
      expect(foreign.status, `跨用户 ${name}`).toBe(404);
      expect(errorCode(foreign), `跨用户 ${name} 错误码`).toBe('NOT_FOUND');
      assertIndistinguishable(missing, foreign, `conversation ${name}`);
      assertNoLeak(foreign, [conversationId, 'A 的私密会话', 'A 的私密消息内容', userA.userId], `conversation ${name}`);
    }
    // 零副作用：会话仍在、标题未被改写、未软删
    const row = await h.prisma.conversation.findUnique({ where: { id: conversationId } });
    expect(row?.title).toBe('A 的私密会话');
    expect(row?.deletedAt).toBeNull();
  });

  // ───────────────────────── ② 消息（chat 编辑/删除）─────────────────────────
  it('② 消息：跨用户 patch/delete → 404「消息不存在」，与幽灵 id 零信息差；零副作用', async () => {
    const ghost = ghostId();
    const foreignPatch = await api.patch(`${P}/chat/messages/${messageId}`, userB.cookie).send({ content: 'hijack 消息' });
    const ghostPatch = await api.patch(`${P}/chat/messages/${ghost}`, userB.cookie).send({ content: 'hijack 消息' });
    expect(foreignPatch.status).toBe(404);
    expect(errorCode(foreignPatch)).toBe('NOT_FOUND');
    assertIndistinguishable(ghostPatch, foreignPatch, 'chat message edit');
    assertNoLeak(foreignPatch, [messageId, 'A 的私密消息内容', userA.userId], 'chat message edit');

    const foreignDelete = await api.delete(`${P}/chat/messages/${messageId}`, userB.cookie);
    const ghostDelete = await api.delete(`${P}/chat/messages/${ghost}`, userB.cookie);
    expect(foreignDelete.status).toBe(404);
    assertIndistinguishable(ghostDelete, foreignDelete, 'chat message delete');

    // 零副作用：内容未被改写、行未被删除
    const row = await h.prisma.message.findUnique({ where: { id: messageId } });
    expect(row?.content).toBe('A 的私密消息内容');
    expect(row?.editedAt).toBeNull();

    // 正向锚：本人编辑 200 且内容真的变了（证明 404 来自归属裁决而非路由/校验错误）
    const own = await api.patch(`${P}/chat/messages/${messageId}`, userA.cookie).send({ content: 'A 更新后的消息内容' });
    expect(own.status).toBe(200);
    expect((await h.prisma.message.findUnique({ where: { id: messageId } }))?.content).toBe('A 更新后的消息内容');
  });

  // ───────────────────────── ③ 任务 ─────────────────────────
  it('③ 任务：跨用户 get/cancel → 404「任务不存在」；列表按会话归属 → 404「对话不存在」', async () => {
    const ghost = ghostId();
    const probes: Array<[string, () => Promise<{ status: number; body: unknown }>, () => Promise<{ status: number; body: unknown }>]> = [
      ['get', () => api.get(`${P}/tasks/${taskId}`, userB.cookie), () => api.get(`${P}/tasks/${ghost}`, userB.cookie)],
      ['cancel', () => post(`${P}/tasks/${taskId}/cancel`, userB.cookie), () => post(`${P}/tasks/${ghost}/cancel`, userB.cookie)],
    ];
    for (const [name, foreignFn, ghostFn] of probes) {
      const foreign = await foreignFn();
      const missing = await ghostFn();
      expect(foreign.status, `跨用户 task ${name}`).toBe(404);
      expect(errorCode(foreign)).toBe('NOT_FOUND');
      assertIndistinguishable(missing, foreign, `task ${name}`);
      assertNoLeak(foreign, [taskId, 'A 的任务提示词', userA.userId], `task ${name}`);
    }
    // 列表：会话归属先裁决（他人会话 → 404「对话不存在」，与幽灵会话同码同文案）
    const foreignList = await api.get(`${P}/tasks?conversationId=${conversationId}`, userB.cookie);
    const ghostList = await api.get(`${P}/tasks?conversationId=${ghost}`, userB.cookie);
    expect(foreignList.status).toBe(404);
    assertIndistinguishable(ghostList, foreignList, 'task list conversationId');
    // 零副作用：任务状态未变
    expect((await h.prisma.generationTask.findUnique({ where: { id: taskId } }))?.status).toBe('pending');
  });

  // ───────────────────────── ④ Run ─────────────────────────
  it('④ Run：跨用户 get/timeline/cancel/retry/events → 404「运行不存在」，与幽灵 id 零信息差', async () => {
    const ghost = ghostId();
    const probes: Array<[string, () => Promise<{ status: number; body: unknown }>, () => Promise<{ status: number; body: unknown }>]> = [
      ['get', () => api.get(`${P}/agent-runs/${runId}`, userB.cookie), () => api.get(`${P}/agent-runs/${ghost}`, userB.cookie)],
      ['timeline', () => api.get(`${P}/agent-runs/${runId}/timeline`, userB.cookie), () => api.get(`${P}/agent-runs/${ghost}/timeline`, userB.cookie)],
      ['cancel', () => post(`${P}/agent-runs/${runId}/cancel`, userB.cookie), () => post(`${P}/agent-runs/${ghost}/cancel`, userB.cookie)],
      ['retry', () => post(`${P}/agent-runs/${runId}/retry`, userB.cookie), () => post(`${P}/agent-runs/${ghost}/retry`, userB.cookie)],
      ['events(SSE)', () => api.get(`${P}/agent-runs/${runId}/events`, userB.cookie), () => api.get(`${P}/agent-runs/${ghost}/events`, userB.cookie)],
    ];
    for (const [name, foreignFn, ghostFn] of probes) {
      const foreign = await foreignFn();
      const missing = await ghostFn();
      expect(foreign.status, `跨用户 run ${name}`).toBe(404);
      expect(errorCode(foreign), `跨用户 run ${name} 错误码`).toBe('NOT_FOUND');
      assertIndistinguishable(missing, foreign, `agent-run ${name}`);
      assertNoLeak(foreign, [runId, userA.userId], `agent-run ${name}`);
    }
    // 列表：他人会话 → 404「对话不存在」（与幽灵会话同形）
    const foreignList = await api.get(`${P}/agent-runs?conversationId=${conversationId}`, userB.cookie);
    const ghostList = await api.get(`${P}/agent-runs?conversationId=${ghostId()}`, userB.cookie);
    expect(foreignList.status).toBe(404);
    assertIndistinguishable(ghostList, foreignList, 'agent-run list conversationId');
    // 零副作用：run 仍为 completed（跨用户 cancel/retry 绝不动他人的 run）
    expect((await h.prisma.agentRun.findUnique({ where: { id: runId } }))?.status).toBe('completed');
    expect(await h.prisma.agentRun.count({ where: { retryOfRunId: runId } })).toBe(0);
    // 正向锚：本人读 200
    expect((await api.get(`${P}/agent-runs/${runId}`, userA.cookie)).status).toBe(200);
  });

  // ───────────────────────── ⑤ 用量 / 审批 / 外部动作 ─────────────────────────
  it('⑤ 用量/审批/外部动作：跨用户一律 404 且零副作用', async () => {
    const ghost = ghostId();

    // 用量
    const usage = await api.get(`${P}/usage/agent-runs/${runId}`, userB.cookie);
    const usageGhost = await api.get(`${P}/usage/agent-runs/${ghost}`, userB.cookie);
    expect(usage.status).toBe(404);
    assertIndistinguishable(usageGhost, usage, 'usage agent-run');
    assertNoLeak(usage, [runId, userA.userId], 'usage agent-run');

    // 审批：读 + 三个决定面
    const approvalProbes: Array<[string, () => Promise<{ status: number; body: unknown }>]> = [
      ['get', () => api.get(`${P}/approvals/${approvalId}`, userB.cookie)],
      ['approve', () => post(`${P}/approvals/${approvalId}/approve`, userB.cookie)],
      ['reject', () => post(`${P}/approvals/${approvalId}/reject`, userB.cookie)],
      ['cancel', () => post(`${P}/approvals/${approvalId}/cancel`, userB.cookie)],
    ];
    const ghostApproval = await api.get(`${P}/approvals/${ghost}`, userB.cookie);
    for (const [name, fn] of approvalProbes) {
      const res = await fn();
      expect(res.status, `跨用户 approval ${name}`).toBe(404);
      expect(errorCode(res), `跨用户 approval ${name} 错误码`).toBe('NOT_FOUND');
      assertIndistinguishable(ghostApproval, res, `approval ${name}`);
      assertNoLeak(res, [approvalId, 'A 的私密审批理由', userA.userId], `approval ${name}`);
    }
    // 零副作用：审批仍是 requested、无裁决时间戳（越权决定绝不落库）
    const ap = await h.prisma.approval.findUnique({ where: { id: approvalId } });
    expect(ap?.status).toBe('requested');
    expect(ap?.approvedAt).toBeNull();
    expect(ap?.rejectedAt).toBeNull();
    expect(ap?.cancelledAt).toBeNull();

    // 外部动作：详情 404；列表按 userId 钉死（带他人 runId 只得到空集）
    const ea = await api.get(`${P}/external-actions/${externalActionId}`, userB.cookie);
    const eaGhost = await api.get(`${P}/external-actions/${ghost}`, userB.cookie);
    expect(ea.status).toBe(404);
    assertIndistinguishable(eaGhost, ea, 'external action get');
    assertNoLeak(ea, [externalActionId, 'A 的外部动作入参', userA.userId], 'external action get');
    const list = data<IdRow[]>(await api.get(`${P}/external-actions?agentRunId=${runId}`, userB.cookie));
    expect(list.some((r) => r.id === externalActionId)).toBe(false);
    expect(JSON.stringify(list)).toBe(JSON.stringify(data<IdRow[]>(await api.get(`${P}/external-actions?agentRunId=${ghost}`, userB.cookie))));
  });

  // ───────────────────────── ⑥ 连接（含 BUG-14）─────────────────────────
  it('⑥ 连接：跨用户 get/refresh/revoke/delete → 404；**组织成员同样 404**（BUG-14：读面不得宽于写面）', async () => {
    const ghost = ghostId();
    const probes: Array<[string, () => Promise<{ status: number; body: unknown }>, () => Promise<{ status: number; body: unknown }>]> = [
      ['get', () => api.get(`${P}/connections/${connectionId}`, userB.cookie), () => api.get(`${P}/connections/${ghost}`, userB.cookie)],
      ['refresh', () => post(`${P}/connections/${connectionId}/refresh`, userB.cookie), () => post(`${P}/connections/${ghost}/refresh`, userB.cookie)],
      ['revoke', () => post(`${P}/connections/${connectionId}/revoke`, userB.cookie), () => post(`${P}/connections/${ghost}/revoke`, userB.cookie)],
      ['delete', () => api.delete(`${P}/connections/${connectionId}`, userB.cookie), () => api.delete(`${P}/connections/${ghost}`, userB.cookie)],
    ];
    for (const [name, foreignFn, ghostFn] of probes) {
      const foreign = await foreignFn();
      const missing = await ghostFn();
      expect(foreign.status, `跨用户 connection ${name}`).toBe(404);
      expect(errorCode(foreign), `跨用户 connection ${name} 错误码`).toBe('NOT_FOUND');
      assertIndistinguishable(missing, foreign, `connection ${name}`);
      assertNoLeak(foreign, [connectionId, 'mock-account-m10p15-code', userA.userId], `connection ${name}`);
    }
    // BUG-14：C ∈ A 的个人组织（成员身份真实存在）—— 组织成员分支此前可读到同事连接
    const orgMember = await api.get(`${P}/connections/${connectionId}`, userC.cookie);
    const orgMemberGhost = await api.get(`${P}/connections/${ghost}`, userC.cookie);
    expect(orgMember.status, '组织成员读同事连接').toBe(404);
    expect(errorCode(orgMember)).toBe('NOT_FOUND');
    assertIndistinguishable(orgMemberGhost, orgMember, 'connection 组织成员读');
    assertNoLeak(orgMember, [connectionId, 'mock-account-m10p15-code'], 'connection 组织成员读');
    // 列表同样只含本人
    const cList = data<IdRow[]>(await api.get(`${P}/connections`, userC.cookie));
    expect(cList.some((c) => c.id === connectionId)).toBe(false);
    // 连接仍在且未被吊销（跨用户 revoke/delete 零副作用）
    const row = await h.prisma.connection.findUnique({ where: { id: connectionId } });
    expect(row?.status).toBe('active');
    // 正向锚：本人读 200
    expect((await api.get(`${P}/connections/${connectionId}`, userA.cookie)).status).toBe(200);
  });
});
