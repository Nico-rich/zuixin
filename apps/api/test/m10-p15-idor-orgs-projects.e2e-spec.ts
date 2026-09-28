import { INestApplication } from '@nestjs/common';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  Actor, HttpApi, HttpMethod, IdorApp, addMember, assertDoesNotEcho, assertIndistinguishable, assertNoLeak,
  createActor, createIdorApp, createOrg, data, errorCode, ghostId, http,
} from './support/idor-harness';

/**
 * M10-P15 全端点 IDOR/RBAC 矩阵 —— 域 1：organizations（含邀请/成员/角色）+ projects + agents（平台目录）。
 *
 * 审计来源 SA-5 / X-17：M8-P8 的 IDOR 抽样**未覆盖**组织邀请与角色变更（m8-security-audit §2 遗留风险
 * 第 12 条「组织邀请/角色变更/API Key 等未枚举端点的 IDOR —— 属抽样之外」）。本域逐端点补齐。
 *
 * 判定口径（服务端最终决定，绝不依赖客户端传参）：
 * - **跨组织**（非成员）→ `AuthorizationService.require` → 403 `FORBIDDEN`「无权访问该组织」；
 *   组织不存在时 `membership()` 同样返回 null → **同状态码同文案**（不可枚举组织存在性）；
 * - **角色越权**（成员但权限不足）→ 403 `FORBIDDEN`「权限不足」；
 * - **行级资源**（projects）→ 404 `NOT_FOUND`「不存在」（防枚举，绝不泄露行存在性）；
 * - **平台目录**（agents）→ `RolesGuard` 校验平台 `admin`，非管理员 403；匿名 401。
 *
 * 真实基础设施：PostgreSQL（真实行）+ Redis（`REDIS_URL=redis://localhost:6379/41`，worktree 隔离铁律）。
 */
describe('M10-P15 IDOR/RBAC 矩阵 · organizations / projects / agents (e2e)', () => {
  let app: INestApplication;
  let h: IdorApp;
  let api: HttpApi;

  let ownerA: Actor;
  let adminA: Actor;
  let memberA: Actor;
  let viewerA: Actor;
  let outsider: Actor;
  let platformAdmin: Actor;
  let invitee: Actor;

  let orgA = '';       // 团队组织（ownerA 拥有）
  let orgB = '';       // outsider 拥有的另一租户组织
  let projectA = '';   // 挂在 orgA 的项目（ownerA 创建）
  let projectOther = ''; // 挂在 orgA、但由 memberA 创建（用于角色越权断言）

  const cleanupOrgIds: string[] = [];
  const cleanupUserIds: string[] = [];

  beforeAll(async () => {
    h = await createIdorApp();
    app = h.app;
    api = http(app);

    ownerA = await createActor(h, 'org-owner-a');
    adminA = await createActor(h, 'org-admin-a');
    memberA = await createActor(h, 'org-member-a');
    viewerA = await createActor(h, 'org-viewer-a');
    outsider = await createActor(h, 'org-outsider');
    platformAdmin = await createActor(h, 'org-platform-admin', { platformRole: 'admin' });
    invitee = await createActor(h, 'org-invitee');
    cleanupUserIds.push(ownerA.userId, adminA.userId, memberA.userId, viewerA.userId, outsider.userId, platformAdmin.userId, invitee.userId);

    orgA = await createOrg(h, ownerA.userId, 'P15 组织 A');
    orgB = await createOrg(h, outsider.userId, 'P15 组织 B');
    cleanupOrgIds.push(orgA, orgB, ownerA.personalOrgId, outsider.personalOrgId, invitee.personalOrgId);

    await addMember(h, orgA, adminA.userId, 'admin');
    await addMember(h, orgA, memberA.userId, 'member');
    await addMember(h, orgA, viewerA.userId, 'viewer');

    // 组织项目：ownerA 建一个、memberA 建一个（同组织内的行级归属差异）
    const p1 = await api.post('/api/v1/projects', ownerA.cookie).send({ name: 'P15 项目(owner)', organizationId: orgA });
    expect(p1.status).toBe(201);
    projectA = data<{ id: string }>(p1).id;
    const p2 = await api.post('/api/v1/projects', memberA.cookie).send({ name: 'P15 项目(member)', organizationId: orgA });
    expect(p2.status).toBe(201);
    projectOther = data<{ id: string }>(p2).id;
  });

  afterAll(async () => {
    // 只清本 spec 造的行（按唯一 id 收敛；绝不做全局 deleteMany）
    await h.prisma.project.deleteMany({ where: { id: { in: [projectA, projectOther] } } }).catch(() => undefined);
    for (const orgId of cleanupOrgIds) {
      await h.prisma.organizationInvitation.deleteMany({ where: { organizationId: orgId } }).catch(() => undefined);
      await h.prisma.organizationMember.deleteMany({ where: { organizationId: orgId } }).catch(() => undefined);
      await h.prisma.organization.delete({ where: { id: orgId } }).catch(() => undefined);
    }
    await h.prisma.user.deleteMany({ where: { id: { in: cleanupUserIds } } }).catch(() => undefined);
    await app.close();
  });

  // ═══════════════════════════ ① 匿名面 ═══════════════════════════

  it('① 匿名：组织/项目/平台目录全部 401（无任何端点漏鉴权）', async () => {
    const probes: Array<[HttpMethod, string]> = [
      ['get', '/api/v1/organizations'],
      ['post', '/api/v1/organizations'],
      ['get', `/api/v1/organizations/${orgA}`],
      ['patch', `/api/v1/organizations/${orgA}`],
      ['delete', `/api/v1/organizations/${orgA}`],
      ['post', `/api/v1/organizations/${orgA}/disable`],
      ['post', `/api/v1/organizations/${orgA}/enable`],
      ['get', `/api/v1/organizations/${orgA}/members`],
      ['delete', `/api/v1/organizations/${orgA}/members/${memberA.userId}`],
      ['post', `/api/v1/organizations/${orgA}/invitations`],
      ['get', `/api/v1/organizations/${orgA}/invitations`],
      ['post', '/api/v1/invitations/abcdef0123456789abcdef01/accept'],
      ['post', '/api/v1/invitations/abcdef0123456789abcdef01/revoke'],
      ['get', '/api/v1/projects'],
      ['post', '/api/v1/projects'],
      ['get', `/api/v1/projects/${projectA}`],
      ['patch', `/api/v1/projects/${projectA}`],
      ['delete', `/api/v1/projects/${projectA}`],
      ['get', '/api/v1/agents'],
      ['get', `/api/v1/agents/${ghostId()}`],
      ['get', `/api/v1/agents/${ghostId()}/versions`],
      ['post', '/api/v1/agents'],
      ['patch', `/api/v1/agents/${ghostId()}/draft`],
      ['post', `/api/v1/agents/${ghostId()}/publish`],
      ['post', `/api/v1/agents/${ghostId()}/rollback`],
      ['patch', `/api/v1/agents/${ghostId()}/enabled`],
    ];
    for (const [method, path] of probes) {
      const res = await api.call(method, path, null).send({});
      expect(res.status, `${method.toUpperCase()} ${path} 应 401`).toBe(401);
      expect(errorCode(res), `${method.toUpperCase()} ${path}`).toBe('UNAUTHORIZED');
    }
  });

  // ═══════════════════════ ② 组织读/写：跨组织 ═══════════════════════

  it('② 组织读/写跨组织：outsider 对 orgA 的 GET/PATCH/DELETE 一律 403 FORBIDDEN（读与写同口径）', async () => {
    const get = await api.get(`/api/v1/organizations/${orgA}`, outsider.cookie);
    expect(get.status).toBe(403);
    expect(errorCode(get)).toBe('FORBIDDEN');

    const patch = await api.patch(`/api/v1/organizations/${orgA}`, outsider.cookie).send({ name: '劫持' });
    expect(patch.status).toBe(403);
    expect(errorCode(patch)).toBe('FORBIDDEN');

    const del = await api.delete(`/api/v1/organizations/${orgA}`, outsider.cookie);
    expect(del.status).toBe(403);

    // 零副作用：名称与删除标记均未变
    const row = await h.prisma.organization.findUnique({ where: { id: orgA } });
    expect(row?.name).toBe('P15 组织 A');
    expect(row?.deletedAt).toBeNull();
  });

  it('②b 组织 id 枚举防泄漏：不存在组织 与 他人组织 的响应完全一致（状态码+错误码+文案）', async () => {
    const missing = await api.get(`/api/v1/organizations/${ghostId()}`, outsider.cookie);
    const foreign = await api.get(`/api/v1/organizations/${orgA}`, outsider.cookie);
    assertIndistinguishable(missing, foreign, 'GET /organizations/:id');
    expect(missing.status).toBe(403);
    assertNoLeak(missing, [orgA, ownerA.userId, ownerA.email]);
    assertNoLeak(foreign, [ownerA.email]);
  });

  // ═══════════════════════ ③ 组织角色越权（成员面） ═══════════════════════

  it('③ member/viewer 越权：改组织、删组织、禁用/启用、邀请、移除成员、读成员名册 全部 403', async () => {
    const denied: Array<[string, () => Promise<{ status: number; body: unknown }>]> = [
      ['member PATCH 组织', () => api.patch(`/api/v1/organizations/${orgA}`, memberA.cookie).send({ name: 'x' })],
      ['member DELETE 组织', () => api.delete(`/api/v1/organizations/${orgA}`, memberA.cookie)],
      ['member disable', () => api.post(`/api/v1/organizations/${orgA}/disable`, memberA.cookie).send({})],
      ['member enable', () => api.post(`/api/v1/organizations/${orgA}/enable`, memberA.cookie).send({})],
      ['member 邀请（member.write）', () => api.post(`/api/v1/organizations/${orgA}/invitations`, memberA.cookie).send({ email: invitee.email, role: 'member' })],
      ['member 移除他人', () => api.delete(`/api/v1/organizations/${orgA}/members/${viewerA.userId}`, memberA.cookie)],
      ['viewer PATCH 组织', () => api.patch(`/api/v1/organizations/${orgA}`, viewerA.cookie).send({ name: 'x' })],
      ['viewer DELETE 组织', () => api.delete(`/api/v1/organizations/${orgA}`, viewerA.cookie)],
      ['viewer 邀请', () => api.post(`/api/v1/organizations/${orgA}/invitations`, viewerA.cookie).send({ email: invitee.email })],
      ['viewer 移除他人', () => api.delete(`/api/v1/organizations/${orgA}/members/${memberA.userId}`, viewerA.cookie)],
      // viewer 无 member.read：成员名册与邀请列表都必须拒绝（矩阵 deny-by-default）
      ['viewer 读成员名册', () => api.get(`/api/v1/organizations/${orgA}/members`, viewerA.cookie)],
      ['viewer 读邀请列表', () => api.get(`/api/v1/organizations/${orgA}/invitations`, viewerA.cookie)],
    ];
    for (const [label, run] of denied) {
      const res = await run();
      expect(res.status, `${label} 应 403`).toBe(403);
      expect(errorCode(res), label).toBe('FORBIDDEN');
    }
    // admin 有 member.read/member.write 但无 organization.write → 读通过、改组织被拒
    const adminMembers = await api.get(`/api/v1/organizations/${orgA}/members`, adminA.cookie);
    expect(adminMembers.status).toBe(200);
    const adminPatch = await api.patch(`/api/v1/organizations/${orgA}`, adminA.cookie).send({ name: 'x' });
    expect(adminPatch.status).toBe(403);
    // 零副作用
    const after = await h.prisma.organization.findUnique({ where: { id: orgA }, include: { members: true } });
    expect(after?.name).toBe('P15 组织 A');
    expect(after?.deletedAt).toBeNull();
    expect(after?.members).toHaveLength(4); // owner/admin/member/viewer 全部仍在
    expect(after?.status).toBe('active');
  });

  it('③b 移除成员：owner 不可被移除（组织至少保留一名 owner）；移除非成员 404；owner 移除 viewer 生效', async () => {
    // memberA 尝试移除 ownerA 会被 member.write 拦在前面（403）——用 ownerA 自身验证"最后一名 owner"规则
    const removeOwner = await api.delete(`/api/v1/organizations/${orgA}/members/${ownerA.userId}`, ownerA.cookie);
    expect(removeOwner.status).toBe(400);
    expect(errorCode(removeOwner)).toBe('VALIDATION_ERROR');

    const rogue = await createActor(h, 'org-rogue');
    cleanupUserIds.push(rogue.userId);
    const removeStranger = await api.delete(`/api/v1/organizations/${orgA}/members/${rogue.userId}`, ownerA.cookie);
    expect(removeStranger.status).toBe(404);
    expect(errorCode(removeStranger)).toBe('NOT_FOUND');

    // owner 移除 viewer：生效且被移除者立刻失去组织读（403）
    const view = await createActor(h, 'org-viewer-tmp');
    cleanupUserIds.push(view.userId);
    await addMember(h, orgA, view.userId, 'viewer');
    expect((await api.get(`/api/v1/organizations/${orgA}`, view.cookie)).status).toBe(200);
    const removed = await api.delete(`/api/v1/organizations/${orgA}/members/${view.userId}`, ownerA.cookie);
    expect(removed.status).toBe(200);
    expect((await api.get(`/api/v1/organizations/${orgA}`, view.cookie)).status).toBe(403);
  });

  // ═══════════════════════ ④ 组织治理态（M10-P14 冻结） ═══════════════════════

  it('④ 禁用/启用：跨组织与成员一律 403；平台管理员可禁用他人组织；个人空间不可被 owner 自助禁用', async () => {
    const outsiderDisable = await api.post(`/api/v1/organizations/${orgA}/disable`, outsider.cookie).send({});
    expect(outsiderDisable.status).toBe(403);
    const memberDisable = await api.post(`/api/v1/organizations/${orgA}/disable`, memberA.cookie).send({});
    expect(memberDisable.status).toBe(403);
    expect((await h.prisma.organization.findUnique({ where: { id: orgA } }))?.status).toBe('active');

    // 个人空间：owner 自助禁用 → 400（账号默认工作区）
    const personal = await api.post(`/api/v1/organizations/${ownerA.personalOrgId}/disable`, ownerA.cookie).send({});
    expect(personal.status).toBe(400);
    expect(errorCode(personal)).toBe('VALIDATION_ERROR');

    // 平台管理员的"平台级禁用"是显式豁免端点（治理动作），对他人组织可用
    const outsiderDisableByAdmin = await api.post(`/api/v1/organizations/${orgB}/disable`, platformAdmin.cookie).send({});
    expect(outsiderDisableByAdmin.status).toBe(201);
    // 恢复（冻结必须可恢复）
    const reEnable = await api.post(`/api/v1/organizations/${orgB}/enable`, platformAdmin.cookie).send({});
    expect(reEnable.status).toBe(201);
    expect((await h.prisma.organization.findUnique({ where: { id: orgB } }))?.status).toBe('active');
  });

  // ═══════════════════════ ⑤ 邀请流 IDOR ═══════════════════════

  it('⑤ 邀请：跨组织不可发/不可读；收件人邮箱不符不可接受；revoke 归属由邀请行解析（不信客户端）', async () => {
    const crossInvite = await api.post(`/api/v1/organizations/${orgA}/invitations`, outsider.cookie).send({ email: invitee.email });
    expect(crossInvite.status).toBe(403);
    const crossList = await api.get(`/api/v1/organizations/${orgA}/invitations`, outsider.cookie);
    expect(crossList.status).toBe(403);
    const crossRemove = await api.delete(`/api/v1/organizations/${orgA}/members/${memberA.userId}`, outsider.cookie);
    expect(crossRemove.status).toBe(403);

    // ownerA 邀请 invitee → 仅 ownerA 侧可读；邀请不授予 owner 角色
    const invite = await api.post(`/api/v1/organizations/${orgA}/invitations`, ownerA.cookie).send({ email: invitee.email, role: 'member' });
    expect(invite.status).toBe(201);
    const token = data<{ token: string; invitationId: string }>(invite).token;
    expect(typeof token).toBe('string');

    const ownerRoleRejected = await api.post(`/api/v1/organizations/${orgA}/invitations`, ownerA.cookie).send({ email: `${invitee.email}x`, role: 'owner' });
    expect(ownerRoleRejected.status).toBe(400);

    // 名单面：outsider 的邀请列表不得含 orgA 的邀请（列表不串租户）
    const outsiderList = await api.get(`/api/v1/organizations/${orgB}/invitations`, outsider.cookie);
    expect(outsiderList.status).toBe(200);
    expect(data<Array<{ id: string }>>(outsiderList).some((i) => i.id === data<{ invitationId: string }>(invite).invitationId)).toBe(false);

    // 邮箱不符（memberA 用自己的账号接受 invitee 的邀请）→ 404：「不存在」与「别人的」不可区分
    const wrongEmail = await api.post(`/api/v1/invitations/${token}/accept`, memberA.cookie).send({});
    expect(wrongEmail.status).toBe(404);
    const missing = await api.post(`/api/v1/invitations/${'f'.repeat(48)}/accept`, memberA.cookie).send({});
    assertIndistinguishable(missing, wrongEmail, 'POST /invitations/:token/accept');
    assertDoesNotEcho(wrongEmail, token, '接受他人邀请');
    // 邀请未被消费（错误邮箱绝不烧 token）
    expect((await h.prisma.organizationInvitation.findUnique({ where: { token } }))?.status).toBe('pending');

    // 非成员 revoke 他人组织的邀请 → 403（组织归属从邀请行解析，客户端无法借传参转移）
    const crossRevoke = await api.post(`/api/v1/invitations/${token}/revoke`, outsider.cookie).send({});
    expect(crossRevoke.status).toBe(403);
    expect((await h.prisma.organizationInvitation.findUnique({ where: { token } }))?.status).toBe('pending');

    // 正主接受 → 201 且成为成员；重复接受 400（单次使用）
    const accept = await api.post(`/api/v1/invitations/${token}/accept`, invitee.cookie).send({});
    expect(accept.status).toBe(201);
    expect(data<{ organizationId: string; role: string }>(accept).organizationId).toBe(orgA);
    expect(data<{ role: string }>(accept).role).toBe('member');
    expect((await api.post(`/api/v1/invitations/${token}/accept`, invitee.cookie).send({})).status).toBe(400);
    // 新成员不是 owner：改组织仍被拒
    expect((await api.patch(`/api/v1/organizations/${orgA}`, invitee.cookie).send({ name: 'x' })).status).toBe(403);
  });

  it('⑤b 组织列表不串租户：outsider 的列表不含 orgA；orgA 成员的列表含 orgA 且不含 orgB', async () => {
    const outsiderList = await api.get('/api/v1/organizations', outsider.cookie);
    expect(outsiderList.status).toBe(200);
    const outsiderIds = data<Array<{ id: string }>>(outsiderList).map((o) => o.id);
    expect(outsiderIds).not.toContain(orgA);
    expect(outsiderIds).not.toContain(ownerA.personalOrgId);

    const memberList = await api.get('/api/v1/organizations', memberA.cookie);
    const memberIds = data<Array<{ id: string }>>(memberList).map((o) => o.id);
    expect(memberIds).toContain(orgA);
    expect(memberIds).not.toContain(orgB);
    assertNoLeak(memberList, [outsider.email]);
  });

  // ═══════════════════════ ⑥ projects：行级 404 与 RBAC ═══════════════════════

  it('⑥ 项目跨组织：outsider 读/改/删 orgA 项目 → 404；不存在 id 与存在 id 不可区分', async () => {
    for (const [label, run] of [
      ['GET', () => api.get(`/api/v1/projects/${projectA}`, outsider.cookie)],
      ['PATCH', () => api.patch(`/api/v1/projects/${projectA}`, outsider.cookie).send({ name: 'x' })],
      ['DELETE', () => api.delete(`/api/v1/projects/${projectA}`, outsider.cookie)],
    ] as Array<[string, () => Promise<{ status: number; body: unknown }>]>) {
      const res = await run();
      expect(res.status, `${label} 跨组织应 404`).toBe(404);
      expect(errorCode(res), label).toBe('NOT_FOUND');
      assertDoesNotEcho(res, projectA, `${label} 项目响应`);
    }
    const missing = await api.get(`/api/v1/projects/${ghostId()}`, outsider.cookie);
    assertIndistinguishable(missing, await api.get(`/api/v1/projects/${projectA}`, outsider.cookie), 'GET /projects/:id');

    // 列表隔离：outsider 的项目列表不含 orgA 的项目
    const list = await api.get('/api/v1/projects', outsider.cookie);
    expect(data<Array<{ id: string }>>(list).map((p) => p.id)).not.toContain(projectA);
    // 未被改动
    expect((await h.prisma.project.findUnique({ where: { id: projectA } }))?.name).toBe('P15 项目(owner)');
  });

  it('⑥b 项目 RBAC：viewer 不可建项目（403）；member 可建；viewer 不可改名/删除组织内他人项目（403）', async () => {
    // 建：viewer 无 project.write（既有 e2e 已锁定）
    const viewerCreate = await api.post('/api/v1/projects', viewerA.cookie).send({ name: 'viewer 项目', organizationId: orgA });
    expect(viewerCreate.status).toBe(403);
    const memberCreate = await api.post('/api/v1/projects', memberA.cookie).send({ name: 'member 项目', organizationId: orgA });
    expect(memberCreate.status).toBe(201);
    const created = data<{ id: string }>(memberCreate).id;
    await h.prisma.project.delete({ where: { id: created } }).catch(() => undefined);

    // 写：viewer 只读 → 改名/删除必须 403（与 create 同口径；否则 viewer 可破坏他人数据）
    const viewerPatch = await api.patch(`/api/v1/projects/${projectA}`, viewerA.cookie).send({ name: 'viewer 改名' });
    expect(viewerPatch.status, 'viewer 改名他人组织项目应 403').toBe(403);
    expect(errorCode(viewerPatch)).toBe('FORBIDDEN');

    const viewerDelete = await api.delete(`/api/v1/projects/${projectA}`, viewerA.cookie);
    expect(viewerDelete.status, 'viewer 删除他人组织项目应 403').toBe(403);
    expect(errorCode(viewerDelete)).toBe('FORBIDDEN');

    // 零副作用
    const row = await h.prisma.project.findUnique({ where: { id: projectA } });
    expect(row?.name).toBe('P15 项目(owner)');
    expect(row?.deletedAt).toBeNull();

    // 读：viewer 可读（project.read）
    expect((await api.get(`/api/v1/projects/${projectA}`, viewerA.cookie)).status).toBe(200);
    // member 有 project.write：可改自己的项目
    const memberPatch = await api.patch(`/api/v1/projects/${projectOther}`, memberA.cookie).send({ name: 'P15 项目(member·改名)' });
    expect(memberPatch.status).toBe(200);
    // 还原
    await api.patch(`/api/v1/projects/${projectOther}`, memberA.cookie).send({ name: 'P15 项目(member)' });
  });

  it('⑥c 项目 organizationId 归属：非成员挂组织建项目 403；viewer 挂组织建项目 403；不存在组织 403', async () => {
    const foreign = await api.post('/api/v1/projects', outsider.cookie).send({ name: 'x', organizationId: orgA });
    expect(foreign.status).toBe(403);
    const missingOrg = await api.post('/api/v1/projects', outsider.cookie).send({ name: 'x', organizationId: ghostId() });
    assertIndistinguishable(missingOrg, foreign, 'POST /projects (organizationId)');
    const viewerOrg = await api.post('/api/v1/projects', viewerA.cookie).send({ name: 'x', organizationId: orgA });
    expect(viewerOrg.status).toBe(403);
    // 零落库
    expect(await h.prisma.project.count({ where: { name: 'x' } })).toBe(0);
  });

  // ═══════════════════════ ⑦ agents（平台目录） ═══════════════════════

  it('⑦ 平台目录 agents：普通用户（含组织 owner/admin）一律 403；平台管理员 201/200；不存在 id 不泄漏', async () => {
    const probes: Array<[string, () => Promise<{ status: number; body: unknown }>]> = [
      ['普通用户 list', () => api.get('/api/v1/agents', memberA.cookie)],
      ['组织 owner list', () => api.get('/api/v1/agents', ownerA.cookie)],
      ['组织 admin list', () => api.get('/api/v1/agents', adminA.cookie)],
      ['普通用户 create', () => api.post('/api/v1/agents', memberA.cookie).send({ slug: 'p15-x', name: 'x', kind: 'chat', systemPrompt: 'x' })],
      ['普通用户 draft', () => api.patch(`/api/v1/agents/${ghostId()}/draft`, ownerA.cookie).send({})],
      ['普通用户 publish', () => api.post(`/api/v1/agents/${ghostId()}/publish`, ownerA.cookie).send({})],
      ['普通用户 rollback', () => api.post(`/api/v1/agents/${ghostId()}/rollback`, ownerA.cookie).send({ versionId: ghostId() })],
      ['普通用户 enabled', () => api.patch(`/api/v1/agents/${ghostId()}/enabled`, ownerA.cookie).send({ enabled: false })],
    ];
    for (const [label, run] of probes) {
      const res = await run();
      expect(res.status, `${label} 应 403`).toBe(403);
      expect(errorCode(res), label).toBe('FORBIDDEN');
    }

    // 平台管理员：目录可读（跨租户读是平台治理面的设计语义，非 IDOR）
    const adminList = await api.get('/api/v1/agents', platformAdmin.cookie);
    expect(adminList.status).toBe(200);
    // 平台管理员写：创建 → 草稿 → 发布 → 回滚链路可达。
    // 注意响应形状：POST /agents 返回 `{ agent, draftVersion }`（id 在 agent 上，不是顶层——
    // 早前矩阵误取顶层 `.id` 得到 undefined，被 `GET :id` 的 200(null) 掩盖成"通过"）。
    const slug = `p15-agent-${Date.now()}`;
    const create = await api.post('/api/v1/agents', platformAdmin.cookie)
      .send({ slug, name: 'P15 Agent', kind: 'chat', systemPrompt: '你是一个测试助手', tools: [] });
    expect(create.status).toBe(201);
    const created = data<{ agent: { id: string; slug: string }; draftVersion: { id: string; status: string } }>(create);
    const agentId = created.agent.id;
    expect(agentId).toMatch(/^[0-9a-f]{8}-/);
    expect(created.draftVersion.status).toBe('draft');
    let otherId: string | undefined;
    try {
      const detail = await api.get(`/api/v1/agents/${agentId}`, platformAdmin.cookie);
      expect(detail.status).toBe(200);
      expect(data<{ id: string; slug: string }>(detail).id).toBe(agentId);
      // 不存在的 id：读路径返回 null（不落 404/不回显、无行内容）——存在性与不存在性对管理员无信息差
      const missingDetail = await api.get(`/api/v1/agents/${ghostId()}`, platformAdmin.cookie);
      expect(missingDetail.status).toBe(200);
      expect(data(missingDetail)).toBeNull();
      assertDoesNotEcho(missingDetail, agentId, 'GET /agents/:id');

      // 草稿不可回滚（状态规则）：400，且 activeVersionId 不变
      const rollbackDraft = await api.post(`/api/v1/agents/${agentId}/rollback`, platformAdmin.cookie)
        .send({ versionId: created.draftVersion.id });
      expect(rollbackDraft.status).toBe(400);

      const publish = await api.post(`/api/v1/agents/${agentId}/publish`, platformAdmin.cookie).send({});
      expect(publish.status, `publish body=${JSON.stringify(publish.body)}`).toBe(201);
      const published = data<{ id: string; status: string }>(publish);
      expect(published.id).toBe(created.draftVersion.id);
      expect(published.status).toBe('published');

      // rollback 的 versionId 必须**属于该 agent**（行级归属）：借用别的 agent 的已发布版本 → 404
      const other = await api.post('/api/v1/agents', platformAdmin.cookie)
        .send({ slug: `${slug}-b`, name: 'P15 Agent B', kind: 'chat', systemPrompt: 'x', tools: [] });
      expect(other.status).toBe(201);
      otherId = data<{ agent: { id: string } }>(other).agent.id;
      const otherPublish = await api.post(`/api/v1/agents/${otherId}/publish`, platformAdmin.cookie).send({});
      expect(otherPublish.status).toBe(201);
      const foreignVersionId = data<{ id: string }>(otherPublish).id;

      const crossRollback = await api.post(`/api/v1/agents/${agentId}/rollback`, platformAdmin.cookie)
        .send({ versionId: foreignVersionId });
      expect(crossRollback.status, '借用他 agent 版本回滚应 404（行级归属）').toBe(404);
      expect(errorCode(crossRollback)).toBe('NOT_FOUND');
      assertDoesNotEcho(crossRollback, foreignVersionId, 'POST /agents/:id/rollback');
      // 他 agent 的版本 vs 完全不存在的版本：两者响应必须零信息差（防枚举）
      const ghostRollback = await api.post(`/api/v1/agents/${agentId}/rollback`, platformAdmin.cookie)
        .send({ versionId: ghostId() });
      assertIndistinguishable(ghostRollback, crossRollback, 'POST /agents/:id/rollback (versionId)');
      // 零副作用：A 的 activeVersionId 仍指向自己的已发布版本
      const after = await h.prisma.agent.findUnique({ where: { id: agentId }, select: { activeVersionId: true } });
      expect(after?.activeVersionId).toBe(published.id);
    } finally {
      // AgentVersion → Agent 为 onDelete: Cascade，删 agent 即清版本
      if (otherId) await h.prisma.agent.delete({ where: { id: otherId } }).catch(() => undefined);
      await h.prisma.agent.delete({ where: { id: agentId } }).catch(() => undefined);
    }
  });
});
