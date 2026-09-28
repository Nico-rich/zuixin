/**
 * M10-P15 · Knowledge / Memories / Attachments 域 IDOR 矩阵（含 BUG-15 的 e2e 回归锁定）。
 *
 * 这三个模块**没有组织/RBAC 层**（无 `@Roles`、无 `AuthorizationService`），归属一律是
 * `userId` 级谓词 —— 因此矩阵的横轴是"跨用户"而非"跨组织/跨角色"：
 * ① 文档：跨用户 get/reindex/delete → 404「文档不存在」，与幽灵 id 零信息差（同码同文案）；
 * ② 记忆：跨用户 patch/delete → 404「记忆不存在」，同上；
 * ③ 附件：跨用户 get → 404「附件不存在」，同上；
 * ④ 父资源（projectId / attachmentId）一律服务端归属裁决：他人项目/附件 → 404，
 *    与"不存在"不可区分（`{id, userId}` 谓词，不是 org membership）；
 * ⑤ 列表租户隔离：`where` 由 `userId` 钉死 —— 带他人 projectId 只得到空集，绝不跨用户；
 * ⑥ BUG-15：`POST /feedback`（及 `/feedback/performance`）此前把请求体 `projectId` **原样落库**
 *    （跨租户引用注入）→ 修复后非本人项目 404「项目不存在」。
 *
 * 说明：本文件用**直插行**（prisma）造资源，因为 404 判定发生在任何存储/检索之前；
 * 正向锚点用 `expect(status).not.toBe(404)`（不把"存储不可用"误读为"归属裁决生效"）。
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { INestApplication } from '@nestjs/common';
import {
  Actor, assertIndistinguishable, assertNoLeak, createActor, createIdorApp, data, errorCode,
  ghostId, http, HttpApi, IdorApp,
} from './support/idor-harness';

const P = '/api/v1';

interface IdRow { id: string }

describe('M10-P15 IDOR 矩阵 · knowledge / memories / attachments', () => {
  let h: IdorApp;
  let app: INestApplication;
  let api: HttpApi;

  let userA: Actor; let userB: Actor;
  let docId: string; let memoryId: string; let attachmentId: string;
  let projectA: string; let projectB: string;

  const post = (path: string, cookie: string, body: unknown = {}) => api.post(path, cookie).send(body as object);

  beforeAll(async () => {
    h = await createIdorApp();
    app = h.app;
    api = http(app);
    userA = await createActor(h, 'kb-a');
    userB = await createActor(h, 'kb-b');

    // 项目直插（项目端点已由 orgs/projects 矩阵覆盖；此处只需归属锚）
    projectA = (await h.prisma.project.create({ data: { userId: userA.userId, name: 'A 项目' } })).id;
    projectB = (await h.prisma.project.create({ data: { userId: userB.userId, name: 'B 项目' } })).id;

    // 文档：A 的（直插，status ready —— 跨用户 404 在 findFirst 处即成立，无需真索引）
    docId = (await h.prisma.document.create({
      data: { userId: userA.userId, projectId: projectA, name: 'A 的私密文档', sourceType: 'text', mimeType: 'text/plain', status: 'ready', contentHash: 'h-a' },
    })).id;
    // 记忆：A 的
    memoryId = (await h.prisma.memory.create({
      data: { userId: userA.userId, scope: 'user', category: 'preference', content: 'A 的私密记忆内容', status: 'candidate' },
    })).id;
    // 附件：走真实上传面（存储对象必须真实存在，否则正向锚会挂在取流处）
    const uploaded = await api.post(`${P}/attachments`, userA.cookie)
      .attach('file', Buffer.from('m10p15 附件内容'), { filename: 'm10p15-a.txt', contentType: 'text/plain' });
    expect(uploaded.status, `上传失败：${JSON.stringify(uploaded.body)}`).toBe(201);
    attachmentId = data<IdRow>(uploaded).id;
  });

  afterAll(async () => { await app?.close(); });

  // ───────────────────────── ① 文档 ─────────────────────────
  it('① 文档：跨用户 get/reindex/delete → 404，与幽灵 id 零信息差；零副作用', async () => {
    const ghost = ghostId();
    const probes: Array<[string, () => Promise<{ status: number; body: unknown }>, () => Promise<{ status: number; body: unknown }>]> = [
      ['get', () => api.get(`${P}/knowledge/documents/${docId}`, userB.cookie), () => api.get(`${P}/knowledge/documents/${ghost}`, userB.cookie)],
      ['reindex', () => post(`${P}/knowledge/documents/${docId}/reindex`, userB.cookie), () => post(`${P}/knowledge/documents/${ghost}/reindex`, userB.cookie)],
      ['delete', () => api.delete(`${P}/knowledge/documents/${docId}`, userB.cookie), () => api.delete(`${P}/knowledge/documents/${ghost}`, userB.cookie)],
    ];
    for (const [name, foreignFn, ghostFn] of probes) {
      const foreign = await foreignFn();
      const missing = await ghostFn();
      expect(foreign.status, `跨用户 ${name}`).toBe(404);
      expect(errorCode(foreign), `跨用户 ${name} 错误码`).toBe('NOT_FOUND');
      assertIndistinguishable(missing, foreign, `knowledge document ${name}`);
      assertNoLeak(foreign, [docId, 'A 的私密文档', projectA, userA.userId], `knowledge document ${name}`);
    }
    // 零副作用：文档仍在（他人 delete 绝不落库）
    expect(await h.prisma.document.count({ where: { id: docId } })).toBe(1);
    // 正向锚：本人读不是 404（证明上面 404 来自归属裁决而非资源缺失/路由错误）
    expect((await api.get(`${P}/knowledge/documents/${docId}`, userA.cookie)).status).not.toBe(404);
  });

  // ───────────────────────── ② 记忆 ─────────────────────────
  it('② 记忆：跨用户 patch/delete → 404，与幽灵 id 零信息差；零副作用', async () => {
    const ghost = ghostId();
    const foreignPatch = await api.patch(`${P}/memories/${memoryId}`, userB.cookie).send({ content: 'hijack 内容' });
    const missingPatch = await api.patch(`${P}/memories/${ghost}`, userB.cookie).send({ content: 'hijack 内容' });
    expect(foreignPatch.status).toBe(404);
    expect(errorCode(foreignPatch)).toBe('NOT_FOUND');
    assertIndistinguishable(missingPatch, foreignPatch, 'memory patch');
    assertNoLeak(foreignPatch, [memoryId, 'A 的私密记忆内容', userA.userId], 'memory patch');

    const foreignDelete = await api.delete(`${P}/memories/${memoryId}`, userB.cookie);
    const missingDelete = await api.delete(`${P}/memories/${ghost}`, userB.cookie);
    expect(foreignDelete.status).toBe(404);
    assertIndistinguishable(missingDelete, foreignDelete, 'memory delete');
    // 零副作用：内容未被改写、行仍在
    const row = await h.prisma.memory.findUnique({ where: { id: memoryId } });
    expect(row?.content).toBe('A 的私密记忆内容');
    // 正向锚：本人 patch 生效
    const own = await api.patch(`${P}/memories/${memoryId}`, userA.cookie).send({ content: 'A 更新后的记忆' });
    expect(own.status).not.toBe(404);
  });

  // ───────────────────────── ③ 附件 ─────────────────────────
  it('③ 附件：跨用户 get → 404，与幽灵 id 零信息差', async () => {
    const ghost = ghostId();
    const foreign = await api.get(`${P}/attachments/${attachmentId}`, userB.cookie);
    const missing = await api.get(`${P}/attachments/${ghost}`, userB.cookie);
    expect(foreign.status).toBe(404);
    expect(errorCode(foreign)).toBe('NOT_FOUND');
    assertIndistinguishable(missing, foreign, 'attachment get');
    assertNoLeak(foreign, [attachmentId, 'm10p15-a.txt', userA.userId], 'attachment get');
    // 正向锚：本人读 200 且拿到真实字节（证明上面 404 来自归属裁决，而非附件不可用）
    const own = await api.get(`${P}/attachments/${attachmentId}`, userA.cookie);
    expect(own.status).toBe(200);
    expect(own.text).toContain('m10p15 附件内容');
  });

  // ───────────────────────── ④ 父资源归属裁决 ─────────────────────────
  it('④ 父资源：他人 projectId / attachmentId → 404，且与"不存在"同码同文案', async () => {
    // 文档挂他人项目
    const foreignProject = await post(`${P}/knowledge/documents`, userB.cookie,
      { name: 'B 试图挂到 A 项目', sourceType: 'text', content: '内容', projectId: projectA });
    const ghostProject = await post(`${P}/knowledge/documents`, userB.cookie,
      { name: 'B 挂幽灵项目', sourceType: 'text', content: '内容', projectId: ghostId() });
    expect(foreignProject.status).toBe(404);
    expect(errorCode(foreignProject)).toBe('NOT_FOUND');
    assertIndistinguishable(ghostProject, foreignProject, 'document projectId');
    expect(await h.prisma.document.count({ where: { userId: userB.userId } })).toBe(0); // 零落库

    // 文档引用他人附件（file 源）
    const foreignAttachment = await post(`${P}/knowledge/documents`, userB.cookie,
      { name: 'B 试图读 A 附件', sourceType: 'file', attachmentId });
    const ghostAttachment = await post(`${P}/knowledge/documents`, userB.cookie,
      { name: 'B 读幽灵附件', sourceType: 'file', attachmentId: ghostId() });
    expect(foreignAttachment.status).toBe(404);
    expect(errorCode(foreignAttachment)).toBe('NOT_FOUND');
    assertIndistinguishable(ghostAttachment, foreignAttachment, 'document attachmentId');

    // 记忆挂他人项目（scope=project 必须带 projectId）
    const foreignMemory = await post(`${P}/memories`, userB.cookie,
      { scope: 'project', projectId: projectA, content: 'B 试图挂到 A 项目', category: 'project_context' });
    const ghostMemory = await post(`${P}/memories`, userB.cookie,
      { scope: 'project', projectId: ghostId(), content: 'B 挂幽灵项目', category: 'project_context' });
    expect(foreignMemory.status).toBe(404);
    expect(errorCode(foreignMemory)).toBe('NOT_FOUND');
    assertIndistinguishable(ghostMemory, foreignMemory, 'memory projectId');

    // 正向锚：自己的项目必须放行（归属谓词只认 userId，不漏杀本人资源）
    const ownDoc = await post(`${P}/knowledge/documents`, userB.cookie,
      { name: 'B 自己的文档', sourceType: 'text', content: 'B 的文档内容', projectId: projectB });
    expect(ownDoc.status).not.toBe(404);
  });

  // ───────────────────────── ⑤ 列表租户隔离 ─────────────────────────
  it('⑤ 列表：带他人 projectId 只得到空集；本用户列表绝不含他人行', async () => {
    // 文档：他人 projectId → 空（`where` 由 userId 钉死）
    const foreignList = data<IdRow[]>(await api.get(`${P}/knowledge/documents?projectId=${projectA}`, userB.cookie));
    expect(foreignList.some((d) => d.id === docId)).toBe(false);
    expect(foreignList).toEqual([]);
    // 幽灵 projectId 与真实他人 projectId 响应**逐字节同形**（否则 = 项目存在性 oracle）
    expect(JSON.stringify(data<IdRow[]>(await api.get(`${P}/knowledge/documents?projectId=${ghostId()}`, userB.cookie))))
      .toBe(JSON.stringify(foreignList));

    // 记忆：本用户列表不含 A 的记忆
    const mine = data<IdRow[]>(await api.get(`${P}/memories`, userB.cookie));
    expect(mine.some((m) => m.id === memoryId)).toBe(false);
    const ownList = data<IdRow[]>(await api.get(`${P}/memories`, userA.cookie));
    expect(ownList.some((m) => m.id === memoryId)).toBe(true); // 归属锚：A 自己看得见
  });

  // ───────────────────────── ⑥ BUG-15：feedback projectId ─────────────────────────
  it('⑥ BUG-15：feedback 的 projectId 必须服务端归属裁决 —— 他人项目 → 404（此前原样落库）', async () => {
    const before = await h.prisma.feedback.count({ where: { userId: userB.userId } });
    const foreign = await post(`${P}/feedback`, userB.cookie,
      { subjectType: 'artifact', subjectId: 'subj-1', rating: 5, projectId: projectA });
    const ghost = await post(`${P}/feedback`, userB.cookie,
      { subjectType: 'artifact', subjectId: 'subj-1', rating: 5, projectId: ghostId() });
    expect(foreign.status).toBe(404);
    expect(errorCode(foreign)).toBe('NOT_FOUND');
    assertIndistinguishable(ghost, foreign, 'feedback projectId');
    // 零副作用：跨租户引用绝不落库（"归属链断裂 + 跨租户引用注入"此前真实存在）
    expect(await h.prisma.feedback.count({ where: { userId: userB.userId } })).toBe(before);
    expect(await h.prisma.feedback.count({ where: { projectId: projectA } })).toBe(0);

    // performance 面同一裁决
    const foreignPerf = await post(`${P}/feedback/performance`, userB.cookie, {
      projectId: projectA,
      metrics: { impressions: 1, clicks: 0, spend: 0, conversions: 0, revenue: 0, orders: 0 },
    });
    expect(foreignPerf.status).toBe(404);
    assertNoLeak(foreignPerf, [projectA], 'feedback performance projectId');
    expect(await h.prisma.creativePerformance.count({ where: { projectId: projectA } })).toBe(0);

    // 正向锚：本人项目必须放行（不漏杀正常路径）
    const own = await post(`${P}/feedback`, userB.cookie,
      { subjectType: 'artifact', subjectId: 'subj-1', rating: 5, projectId: projectB });
    expect(own.status).not.toBe(404);
    // 省略 projectId（个人面）同样不受影响
    const personal = await post(`${P}/feedback`, userB.cookie, { subjectType: 'artifact', subjectId: 'subj-2', rating: 3 });
    expect(personal.status).not.toBe(404);
  });
});
