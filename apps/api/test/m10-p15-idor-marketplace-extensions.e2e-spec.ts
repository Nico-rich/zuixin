/**
 * M10-P15 · Marketplace + Extensions 域 IDOR/RBAC 枚举矩阵（含 BUG-4 的 e2e 回归锁定）。
 *
 * 覆盖：
 * ① 条目可见性：组织私有（draft）跨组织读 → 404；已发布条目 → 公开可读（200）且不泄漏归属组织；
 * ② 跨组织写条目（patch/publish/withdraw/revise）→ 404（可见性折 404 防枚举），与幽灵 id 零信息差；
 * ③ 审核权（owner/admin 专属）：非成员 → 404、组织内 member/viewer → 403、
 *    **禁用组织 → 403 ORG_DISABLED**（BUG-4：此前审核权只判成员身份 → 禁用组织仍可裁决）；
 * ④ 组织级裁决：列表/安装面带他组织 organizationId → 403（与"组织不存在"同码，不区分）；
 * ⑤ 扩展写面：跨组织 install/enable/disable/uninstall/publish → 403；
 * ⑥ 白名单：非 owner/admin 增删 → 403；跨组织删 → 403。
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { INestApplication } from '@nestjs/common';
import {
  Actor, assertIndistinguishable, assertNoLeak, createActor, createIdorApp, data, errorCode,
  ghostId, http, HttpApi, IdorApp,
} from './support/idor-harness';

const P = '/api/v1';

interface IdRow { id: string }

describe('M10-P15 IDOR 矩阵 · marketplace / extensions', () => {
  let h: IdorApp;
  let app: INestApplication;
  let api: HttpApi;

  let ownerA: Actor; let memberA: Actor; let viewerA: Actor; let ownerB: Actor;
  let orgA: string; let orgB: string;
  let extensionId: string; let versionId: string;
  let publishedPublicationId: string;
  /** 第二条扩展（一扩展一条目：草稿条目的"私有面"探针必须挂在自己独占的扩展上） */
  let draftPublicationId: string;

  const post = (path: string, cookie: string, body: unknown = {}) => api.post(path, cookie).send(body as object);

  beforeAll(async () => {
    h = await createIdorApp();
    app = h.app;
    api = http(app);
    ownerA = await createActor(h, 'mk-a');
    memberA = await createActor(h, 'mk-member');
    viewerA = await createActor(h, 'mk-viewer');
    ownerB = await createActor(h, 'mk-b');
    orgA = ownerA.personalOrgId;
    orgB = ownerB.personalOrgId;
    await h.prisma.organizationMember.create({ data: { organizationId: orgA, userId: memberA.userId, role: 'member' } });
    await h.prisma.organizationMember.create({ data: { organizationId: orgA, userId: viewerA.userId, role: 'viewer' } });

    const stamp = Date.now();
    const created = await post(`${P}/extensions`, ownerA.cookie, {
      organizationId: orgA, name: 'M10P15 扩展', slug: `m10p15-${stamp}`, kind: 'tool',
      manifest: {
        manifestVersion: 1, kind: 'tool', permissions: ['tool.execute'],
        tool: { name: `ext.m10p15-${stamp}.search`, description: 'x', baseTool: 'knowledge.search' },
      },
    });
    expect(created.status).toBe(201);
    const body = data<{ extension: IdRow; version: IdRow }>(created);
    extensionId = body.extension.id;
    versionId = body.version.id;

    const published = await post(`${P}/extensions/${extensionId}/publish`, ownerA.cookie, { versionId });
    expect([200, 201]).toContain(published.status);

    const pub = await post(`${P}/marketplace/publications`, ownerA.cookie,
      { extensionId, category: 'knowledge', description: 'M10P15 上架条目描述文本' });
    expect(pub.status).toBe(201);
    publishedPublicationId = data<IdRow>(pub).id;
    const up = await post(`${P}/marketplace/publications/${publishedPublicationId}/publish`, ownerA.cookie);
    expect([200, 201]).toContain(up.status);

    // 私有面（草稿条目）探针：一扩展一条目 ⇒ 另建一条扩展承载草稿条目
    const draftExt = await post(`${P}/extensions`, ownerA.cookie, {
      organizationId: orgA, name: 'M10P15 扩展（草稿）', slug: `m10p15-draft-${stamp}`, kind: 'tool',
      manifest: {
        manifestVersion: 1, kind: 'tool', permissions: ['tool.execute'],
        tool: { name: `ext.m10p15-draft-${stamp}.search`, description: 'x', baseTool: 'knowledge.search' },
      },
    });
    expect(draftExt.status).toBe(201);
    const draftBody = data<{ extension: IdRow; version: IdRow }>(draftExt);
    expect([200, 201]).toContain((await post(`${P}/extensions/${draftBody.extension.id}/publish`, ownerA.cookie,
      { versionId: draftBody.version.id })).status);
    const draft = await post(`${P}/marketplace/publications`, ownerA.cookie,
      { extensionId: draftBody.extension.id, category: 'knowledge', description: '私有草稿条目（未发布）描述文本' });
    expect(draft.status).toBe(201);
    draftPublicationId = data<IdRow>(draft).id;
  });

  afterAll(async () => { await app?.close(); });

  // ───────────────────────── ① 可见性 ─────────────────────────
  it('① 组织私有（未发布）条目跨组织读 → 404；已发布条目公开可读且不泄漏归属组织', async () => {
    const ghost = ghostId();
    const foreignDraft = await api.get(`${P}/marketplace/publications/${draftPublicationId}`, ownerB.cookie);
    const missing = await api.get(`${P}/marketplace/publications/${ghost}`, ownerB.cookie);
    expect(foreignDraft.status).toBe(404);
    assertIndistinguishable(missing, foreignDraft, 'marketplace 私有条目');
    assertNoLeak(foreignDraft, [draftPublicationId, '私有草稿条目', orgA], 'marketplace 私有条目');

    // 同一 404 口径在评审面同样成立（未发布条目的评审列表不得成为存在性 oracle）
    const foreignReviews = await api.get(`${P}/marketplace/publications/${draftPublicationId}/reviews`, ownerB.cookie);
    const missingReviews = await api.get(`${P}/marketplace/publications/${ghost}/reviews`, ownerB.cookie);
    expect(foreignReviews.status).toBe(404);
    assertIndistinguishable(missingReviews, foreignReviews, 'marketplace 私有条目评审列表');

    // 已发布 → 任何登录者可见（公开面）。**发布者身份是设计上的公开元数据**
    // （m9-p6-marketplace.e2e-spec.ts:238 冻结断言 `publisher.organizationId` 可见），
    // 但公开可见性**绝不携带任何写/治理能力**，也绝不夹带未发布条目的内容。
    const publicRead = await api.get(`${P}/marketplace/publications/${publishedPublicationId}`, ownerB.cookie);
    expect(publicRead.status).toBe(200);
    const view = data<{ publisher: { organizationId: string }; viewer: { canManage: boolean; canModerate: boolean } }>(publicRead);
    expect(view.publisher.organizationId).toBe(orgA); // 公开元数据（冻结口径）
    expect(view.viewer).toMatchObject({ canManage: false, canModerate: false }); // 跨组织只读：零写权/零治理权
    assertNoLeak(publicRead, [draftPublicationId, '私有草稿条目', memberA.userId], 'marketplace 公开条目');
  });

  // ───────────────────────── ② 跨组织写条目 ─────────────────────────
  it('② 跨组织写条目（patch/publish/withdraw/revise）→ 404，与幽灵 id 零信息差', async () => {
    const ghost = ghostId();
    const writes: Array<[string, () => Promise<{ status: number; body: unknown }>]> = [
      ['patch', () => api.patch(`${P}/marketplace/publications/${publishedPublicationId}`, ownerB.cookie).send({ description: 'hijack 描述文本' })],
      ['publish', () => post(`${P}/marketplace/publications/${publishedPublicationId}/publish`, ownerB.cookie)],
      ['withdraw', () => post(`${P}/marketplace/publications/${publishedPublicationId}/withdraw`, ownerB.cookie)],
      ['revise', () => post(`${P}/marketplace/publications/${publishedPublicationId}/revise`, ownerB.cookie)],
      ['ghost patch', () => api.patch(`${P}/marketplace/publications/${ghost}`, ownerB.cookie).send({ description: 'hijack 描述文本' })],
    ];
    const r = await Promise.all(writes.map(([, fn]) => fn()));
    for (let i = 0; i < 4; i += 1) {
      expect(r[i].status, `跨组织 ${writes[i][0]}`).toBe(404);
      expect(errorCode(r[i]), `跨组织 ${writes[i][0]} 错误码`).toBe('NOT_FOUND');
      assertIndistinguishable(r[4], r[i], `marketplace ${writes[i][0]}`);
      assertNoLeak(r[i], [publishedPublicationId, 'hijack'], `marketplace ${writes[i][0]}`);
    }
    // 零副作用：条目仍是 published 且描述未被改写
    const still = data<{ status: string; description: string }>(await api.get(`${P}/marketplace/publications/${publishedPublicationId}`, ownerA.cookie));
    expect(still.status).toBe('published');
    expect(still.description).toContain('M10P15');
  });

  // ───────────────────────── ③ 审核权（BUG-4） ─────────────────────────
  it('③ 审核权：非成员 → 404；组织内 member/viewer → 403；禁用组织 → 403 ORG_DISABLED', async () => {
    const before = await h.prisma.extensionPublication.findUnique({ where: { id: publishedPublicationId }, select: { status: true } });

    // 非成员（他组织 owner）→ 404（与"条目不存在"不可区分）
    const foreign = await post(`${P}/marketplace/publications/${publishedPublicationId}/reject`, ownerB.cookie, { reason: '无权驳回的理由' });
    const missing = await post(`${P}/marketplace/publications/${ghostId()}/reject`, ownerB.cookie, { reason: '无权驳回的理由' });
    expect(foreign.status).toBe(404);
    assertIndistinguishable(missing, foreign, 'marketplace reject');

    // 组织内 member / viewer：是成员但非 owner/admin → 403（审核权是 owner/admin 专属）
    for (const cookie of [memberA.cookie, viewerA.cookie]) {
      const res = await post(`${P}/marketplace/publications/${publishedPublicationId}/reject`, cookie, { reason: '普通成员不得驳回的理由' });
      expect(res.status).toBe(403);
      expect(errorCode(res)).toBe('FORBIDDEN');
    }
    expect((await h.prisma.extensionPublication.findUnique({ where: { id: publishedPublicationId }, select: { status: true } }))?.status)
      .toBe(before?.status); // 越权判定绝不改变条目状态

    // M10-P15（BUG-4）：禁用组织 → 审核面同样冻结（此前只判成员身份 → 禁用组织仍能裁决）
    await h.prisma.organization.update({ where: { id: orgA }, data: { status: 'disabled' } });
    const disabled = await post(`${P}/marketplace/publications/${publishedPublicationId}/reject`, ownerA.cookie, { reason: '禁用组织不得驳回的理由' });
    expect(disabled.status).toBe(403);
    expect(errorCode(disabled)).toBe('ORG_DISABLED');
    await h.prisma.organization.update({ where: { id: orgA }, data: { status: 'active' } });
  });

  // ───────────────────────── ④ 组织级裁决 ─────────────────────────
  it('④ 列表/安装面带他组织（或不存在）organizationId → 403（同码，不区分组织存在性）', async () => {
    const ghost = ghostId();
    for (const orgId of [orgB, ghost]) {
      const list = await api.get(`${P}/marketplace/publications?organizationId=${orgId}&status=draft`, ownerA.cookie);
      expect(list.status, '私有面列表').toBe(403);
      expect(errorCode(list)).toBe('FORBIDDEN');

      const installations = await api.get(`${P}/extensions/installations?organizationId=${orgId}`, ownerA.cookie);
      expect(installations.status, '安装列表').toBe(403);

      const catalog = await api.get(`${P}/extensions/catalog?organizationId=${orgId}`, ownerA.cookie);
      expect(catalog.status, '扩展目录').toBe(403);
    }
  });

  // ───────────────────────── ⑤ 扩展写面 ─────────────────────────
  it('⑤ 扩展写面：跨组织 install/enable/disable/uninstall → 403；安装列表只含本组织', async () => {
    const writes: Array<[string, () => Promise<{ status: number; body: unknown }>]> = [
      ['install', () => post(`${P}/extensions/${extensionId}/install`, ownerB.cookie, { organizationId: orgA })],
      ['enable', () => post(`${P}/extensions/${extensionId}/enable`, ownerB.cookie, { organizationId: orgA })],
      ['disable', () => post(`${P}/extensions/${extensionId}/disable`, ownerB.cookie, { organizationId: orgA })],
      ['uninstall', () => post(`${P}/extensions/${extensionId}/uninstall`, ownerB.cookie, { organizationId: orgA })],
    ];
    for (const [name, fn] of writes) {
      const res = await fn();
      expect(res.status, `跨组织 ${name}`).toBe(403);
      expect(errorCode(res), `跨组织 ${name} 错误码`).toBe('FORBIDDEN');
      assertNoLeak(res, [extensionId], `扩展 ${name} 响应`);
    }
    // 组织内 viewer（无 agent.write）→ 403；install 侧零副作用
    const viewerInstall = await post(`${P}/extensions/${extensionId}/install`, viewerA.cookie, { organizationId: orgA });
    expect(viewerInstall.status).toBe(403);
    expect(await h.prisma.extensionInstallation.count({ where: { extensionId, organizationId: orgA } })).toBe(0);

    // 归属锚：ownerA 自行安装 → 201，且安装列表按组织隔离（响应体为**裸数组**，非包装对象）
    const ok = await post(`${P}/extensions/${extensionId}/install`, ownerA.cookie, { organizationId: orgA });
    expect([200, 201]).toContain(ok.status);
    const mine = data<Array<{ organizationId: string }>>(await api.get(`${P}/extensions/installations?organizationId=${orgA}`, ownerA.cookie));
    expect(Array.isArray(mine)).toBe(true);
    expect(mine.some((i) => i.organizationId === orgA)).toBe(true);
    const theirs = data<Array<{ organizationId: string }>>(await api.get(`${P}/extensions/installations?organizationId=${orgB}`, ownerB.cookie));
    expect(theirs.every((i) => i.organizationId === orgB)).toBe(true);
    expect(theirs.some((i) => i.organizationId === orgA)).toBe(false); // 他组织安装绝不出现在本组织列表
  });

  // ───────────────────────── ⑥ 白名单 ─────────────────────────
  it('⑥ 白名单：组织内 member 增删 → 403；非所有者的成员读私有扩展白名单 → 403', async () => {
    const add = await post(`${P}/extensions/${extensionId}/allowlist`, memberA.cookie, { organizationId: orgA });
    expect(add.status).toBe(403);
    expect(await h.prisma.extensionOrgAllowlist.count({ where: { extensionId, organizationId: orgA } })).toBe(0);

    const ownerAdd = await post(`${P}/extensions/${extensionId}/allowlist`, ownerA.cookie, { organizationId: orgA });
    expect([200, 201]).toContain(ownerAdd.status);

    // 跨组织（ownerB 既非扩展所有者、也非目标组织治理者）→ 403
    const foreignDelete = await api.delete(`${P}/extensions/${extensionId}/allowlist/${orgA}`, ownerB.cookie);
    expect(foreignDelete.status).toBe(403);
    expect(await h.prisma.extensionOrgAllowlist.count({ where: { extensionId, organizationId: orgA } })).toBe(1);

    // 非成员的读：私有扩展的白名单属组织私有资源
    const foreignRead = await api.get(`${P}/extensions/${extensionId}/allowlist`, ownerB.cookie);
    expect([403, 404]).toContain(foreignRead.status);
    assertNoLeak(foreignRead, [orgA], '白名单跨组织读');
  });
});
