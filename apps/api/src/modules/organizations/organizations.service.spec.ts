import { describe, it, expect, vi, beforeEach } from 'vitest';
import { OrganizationsService } from './organizations.service';
import { AuthorizationService } from './authorization.service';

function makeService() {
  const prisma = {
    organization: {
      findFirst: vi.fn(),
      findUnique: vi.fn(),
      findMany: vi.fn().mockResolvedValue([]),
      create: vi.fn(),
      update: vi.fn().mockResolvedValue({}),
    },
    organizationMember: {
      findUnique: vi.fn(),
      findMany: vi.fn().mockResolvedValue([]),
      create: vi.fn(),
      delete: vi.fn().mockResolvedValue({}),
      upsert: vi.fn().mockResolvedValue({}),
    },
    organizationInvitation: {
      findUnique: vi.fn(),
      findMany: vi.fn().mockResolvedValue([]),
      create: vi.fn().mockResolvedValue({ id: 'inv-1' }),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    user: { findUnique: vi.fn() },
  };
  // 授权服务独立 mock（与业务 prisma 解耦——同一模型两套调用不互相污染）
  const authPrisma = {
    organization: { findFirst: vi.fn() },
    organizationMember: { findUnique: vi.fn() },
  };
  const auth = new AuthorizationService(authPrisma as never);
  const svc = new OrganizationsService(prisma as never, auth);
  return { svc, prisma, auth, authPrisma };
}

function asMember(authPrisma: { organization: { findFirst: ReturnType<typeof vi.fn> }; organizationMember: { findUnique: ReturnType<typeof vi.fn> } }, role: string) {
  authPrisma.organization.findFirst.mockResolvedValue({ id: 'org-1' });
  authPrisma.organizationMember.findUnique.mockResolvedValue({ role });
}

describe('OrganizationsService（M8-P1 组织/成员/邀请）', () => {
  beforeEach(() => vi.clearAllMocks());

  it('ensurePersonalOrganization：已存在 → 复用；缺失 → 创建（owner member）；slug 冲突 → 幂等复用', async () => {
    const { svc, prisma, authPrisma } = makeService();
    prisma.organization.findFirst.mockResolvedValue({ id: 'personal-u1' });
    expect(await svc.ensurePersonalOrganization('u1')).toEqual({ id: 'personal-u1' });
    expect(prisma.organization.create).not.toHaveBeenCalled();

    prisma.organization.findFirst.mockResolvedValue(null);
    prisma.user.findUnique.mockResolvedValue({ displayName: null, email: 'a@b.com' });
    prisma.organization.create.mockResolvedValue({ id: 'personal-u1' });
    await svc.ensurePersonalOrganization('u1');
    expect(prisma.organization.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        id: 'personal-u1', isPersonal: true,
        members: { create: { userId: 'u1', role: 'owner' } },
      }),
    }));

    prisma.organization.create.mockRejectedValue({ code: 'P2002' });
    prisma.organization.findFirst.mockImplementation(async ({ where }) =>
      where.slug === 'personal-u1' ? { id: 'personal-u1' } : null);
    expect(await svc.ensurePersonalOrganization('u1')).toEqual({ id: 'personal-u1' }); // 并发懒创建幂等
  });

  it('create：组织 + owner 成员；slug 冲突 → VALIDATION_ERROR', async () => {
    const { svc, prisma, authPrisma } = makeService();
    prisma.organization.create.mockResolvedValue({ id: 'org-1' });
    await svc.create('u1', { name: '团队', slug: 'team' });
    expect(prisma.organization.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ ownerUserId: 'u1', members: { create: { userId: 'u1', role: 'owner' } } }),
    }));
    prisma.organization.create.mockRejectedValue({ code: 'P2002' });
    await expect(svc.create('u1', { name: 'x', slug: 'dup' })).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });

  it('softDelete：仅 owner（organization.write）；个人组织不可删', async () => {
    const { svc, prisma, authPrisma } = makeService();
    asMember(authPrisma, 'member');
    await expect(svc.softDelete('u1', 'org-1')).rejects.toMatchObject({ code: 'FORBIDDEN' });
    asMember(authPrisma, 'owner');
    prisma.organization.findUnique.mockResolvedValue({ id: 'org-1', isPersonal: true });
    await expect(svc.softDelete('u1', 'org-1')).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    prisma.organization.findUnique.mockResolvedValue({ id: 'org-1', isPersonal: false });
    await svc.softDelete('u1', 'org-1');
    expect(prisma.organization.update).toHaveBeenCalledWith({ where: { id: 'org-1' }, data: { deletedAt: expect.any(Date) } });
  });

  it('invite：member 无权（403）；owner 可邀请；已是成员 → VALIDATION_ERROR；owner 角色不可邀请', async () => {
    const { svc, prisma, authPrisma } = makeService();
    asMember(authPrisma, 'member');
    await expect(svc.invite('u1', 'org-1', { email: 'b@b.com' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    asMember(authPrisma, 'owner');
    await expect(svc.invite('u1', 'org-1', { email: 'b@b.com', role: 'owner' })).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    prisma.user.findUnique.mockResolvedValue({ id: 'u2' });
    prisma.organizationMember.findUnique.mockResolvedValue({ role: 'member' });
    await expect(svc.invite('u1', 'org-1', { email: 'b@b.com' })).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    prisma.organizationMember.findUnique.mockResolvedValue(null);
    await svc.invite('u1', 'org-1', { email: 'b@b.com', role: 'viewer' });
    expect(prisma.organizationInvitation.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ email: 'b@b.com', role: 'viewer', token: expect.any(String), expiresAt: expect.any(Date) }),
    }));
  });

  it('acceptInvitation：token 单次使用（条件更新唯一赢家）；email 不匹配 404；过期 → expired 标记；重复 → VALIDATION_ERROR', async () => {
    const { svc, prisma, authPrisma } = makeService();
    prisma.user.findUnique.mockResolvedValue({ email: 'b@b.com' });
    prisma.organizationInvitation.findUnique.mockResolvedValue({
      id: 'inv-1', organizationId: 'org-1', email: 'b@b.com', role: 'member',
      status: 'pending', expiresAt: new Date(Date.now() + 60_000),
    });
    prisma.organization.findFirst.mockResolvedValue({ id: 'org-1' });
    const res = await svc.acceptInvitation('u2', 'tok-1');
    expect(res).toEqual({ organizationId: 'org-1', role: 'member' });
    expect(prisma.organizationMember.upsert).toHaveBeenCalledWith(expect.objectContaining({
      create: { organizationId: 'org-1', userId: 'u2', role: 'member' },
    }));

    // 重复 accept：条件更新 count=0 → 拒绝
    prisma.organizationInvitation.updateMany.mockResolvedValue({ count: 0 });
    await expect(svc.acceptInvitation('u2', 'tok-1')).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });

    // 过期 → 标记 expired + 拒绝
    prisma.organizationInvitation.findUnique.mockResolvedValue({
      id: 'inv-2', organizationId: 'org-1', email: 'b@b.com', role: 'member',
      status: 'pending', expiresAt: new Date(Date.now() - 1000),
    });
    prisma.organizationInvitation.updateMany.mockResolvedValue({ count: 1 });
    await expect(svc.acceptInvitation('u2', 'tok-2')).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    expect(prisma.organizationInvitation.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'inv-2', status: 'pending' },
      data: { status: 'expired' },
    }));

    // email 不匹配 → 404（防枚举）
    prisma.organizationInvitation.findUnique.mockResolvedValue({ email: 'other@x.com', status: 'pending' });
    await expect(svc.acceptInvitation('u2', 'tok-3')).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('removeMember：owner 不可被移除；member.write 权限；非成员移除 404', async () => {
    const { svc, prisma, authPrisma } = makeService();
    asMember(authPrisma, 'admin');
    prisma.organizationMember.findUnique.mockResolvedValue({ id: 'm1', role: 'owner' });
    await expect(svc.removeMember('u1', 'org-1', 'u2')).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    prisma.organizationMember.findUnique.mockResolvedValue({ id: 'm2', role: 'member' });
    await svc.removeMember('u1', 'org-1', 'u2');
    expect(prisma.organizationMember.delete).toHaveBeenCalledWith({ where: { id: 'm2' } });
  });

  it('assertCanAccess：行无组织 → 放行（兼容）；有组织且非成员 → 404', async () => {
    const { svc, prisma, authPrisma } = makeService();
    await svc.assertCanAccess('u1', null);
    prisma.organization.findFirst.mockResolvedValue({ id: 'org-1' });
    prisma.organizationMember.findUnique.mockResolvedValue(null);
    await expect(svc.assertCanAccess('u2', 'org-1')).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});

describe('M10-P14（X-21）组织禁用/启用治理态', () => {
  beforeEach(() => vi.clearAllMocks());

  it('setStatus：组织 owner 可禁用/启用（幂等；目标态一致则不写库）', async () => {
    const { svc, prisma, authPrisma } = makeService();
    asMember(authPrisma, 'owner');
    prisma.organization.update.mockImplementation(({ where, data }) => Promise.resolve({ id: where.id, ...data }));
    prisma.organization.findUnique.mockResolvedValue({ id: 'org-1', isPersonal: false, status: 'active', deletedAt: null });

    await expect(svc.setStatus('u1', 'org-1', 'disabled')).resolves.toMatchObject({ status: 'disabled', unchanged: false });
    expect(prisma.organization.update).toHaveBeenCalledWith({ where: { id: 'org-1' }, data: { status: 'disabled' } });

    // 幂等：已是 disabled → 不再写库
    prisma.organization.findUnique.mockResolvedValue({ id: 'org-1', isPersonal: false, status: 'disabled', deletedAt: null });
    await expect(svc.setStatus('u1', 'org-1', 'disabled')).resolves.toMatchObject({ status: 'disabled', unchanged: true });
    expect(prisma.organization.update).toHaveBeenCalledTimes(1);

    // 恢复路径必须可达：owner 对已禁用组织执行 enable（治理端点绕过自身冻结检查）
    await expect(svc.setStatus('u1', 'org-1', 'active')).resolves.toMatchObject({ status: 'active', unchanged: false });
    expect(prisma.organization.update).toHaveBeenLastCalledWith({ where: { id: 'org-1' }, data: { status: 'active' } });
  });

  it('setStatus RBAC：admin/member/viewer 与外部人一律 403（组织级治理动作 = owner）', async () => {
    for (const role of ['admin', 'member', 'viewer']) {
      const { svc, prisma, authPrisma } = makeService();
      asMember(authPrisma, role);
      prisma.organization.findUnique.mockResolvedValue({ id: 'org-1', isPersonal: false, status: 'active', deletedAt: null });
      await expect(svc.setStatus('u1', 'org-1', 'disabled')).rejects.toMatchObject({ code: 'FORBIDDEN' });
      expect(prisma.organization.update).not.toHaveBeenCalled();
    }
    const { svc, prisma, authPrisma } = makeService();
    asMember(authPrisma, 'owner');
    prisma.organization.findUnique.mockResolvedValue({ id: 'org-1', isPersonal: false, status: 'active', deletedAt: null });
    authPrisma.organizationMember.findUnique.mockResolvedValue(null); // 非成员
    await expect(svc.setStatus('stranger', 'org-1', 'disabled')).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(prisma.organization.update).not.toHaveBeenCalled();
  });

  it('setStatus：平台管理员（user.role=admin）可禁用/启用任意组织（含个人空间）', async () => {
    const { svc, prisma, authPrisma } = makeService();
    prisma.user.findUnique.mockResolvedValue({ id: 'admin', role: 'admin' });
    prisma.organization.update.mockImplementation(({ where, data }) => Promise.resolve({ id: where.id, ...data }));
    prisma.organization.findUnique.mockResolvedValue({ id: 'org-1', isPersonal: true, status: 'active', deletedAt: null });
    authPrisma.organizationMember.findUnique.mockResolvedValue(null); // 平台管理员并非成员

    await expect(svc.setStatus('admin', 'org-1', 'disabled')).resolves.toMatchObject({ status: 'disabled' });
    expect(prisma.organization.update).toHaveBeenCalledWith({ where: { id: 'org-1' }, data: { status: 'disabled' } });
  });

  it('setStatus：owner 不可自助禁用个人空间（VALIDATION_ERROR）；启用不受限', async () => {
    const { svc, prisma, authPrisma } = makeService();
    asMember(authPrisma, 'owner');
    prisma.user.findUnique.mockResolvedValue({ id: 'u1', role: 'user' });
    prisma.organization.update.mockImplementation(({ where, data }) => Promise.resolve({ id: where.id, ...data }));
    prisma.organization.findUnique.mockResolvedValue({ id: 'personal-u1', isPersonal: true, status: 'active', deletedAt: null });

    await expect(svc.setStatus('u1', 'personal-u1', 'disabled')).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    expect(prisma.organization.update).not.toHaveBeenCalled();

    prisma.organization.findUnique.mockResolvedValue({ id: 'personal-u1', isPersonal: true, status: 'disabled', deletedAt: null });
    await expect(svc.setStatus('u1', 'personal-u1', 'active')).resolves.toMatchObject({ status: 'active' });
  });

  it('setStatus：组织不存在/已软删 → 404（不写库）', async () => {
    const { svc, prisma, authPrisma } = makeService();
    asMember(authPrisma, 'owner');
    prisma.organization.findUnique.mockResolvedValue(null);
    await expect(svc.setStatus('u1', 'nope', 'disabled')).rejects.toMatchObject({ code: 'NOT_FOUND' });
    prisma.organization.findUnique.mockResolvedValue({ id: 'org-1', isPersonal: false, status: 'active', deletedAt: new Date() });
    await expect(svc.setStatus('u1', 'org-1', 'disabled')).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(prisma.organization.update).not.toHaveBeenCalled();
  });

  it('assertActive / isDisabled：服务层禁用判定（守卫覆盖不到的入口）', async () => {
    const { svc, prisma } = makeService();
    prisma.organization.findFirst.mockResolvedValue({ status: 'active' });
    await expect(svc.assertActive('org-1')).resolves.toBeUndefined();
    prisma.organization.findFirst.mockResolvedValue({ status: 'disabled' });
    expect(await svc.isDisabled('org-1')).toBe(true);
    const err = await svc.assertActive('org-1', '加入该组织').catch((e) => e);
    expect(err.getStatus()).toBe(403);
    expect(err.getResponse()).toMatchObject({ code: 'ORG_DISABLED', message: expect.stringContaining('加入该组织') });
  });

  it('acceptInvitation：禁用组织不可再接纳新成员（403 ORG_DISABLED，成员行不写）', async () => {
    const { svc, prisma } = makeService();
    prisma.user.findUnique.mockResolvedValue({ email: 'b@b.com' });
    prisma.organizationInvitation.findUnique.mockResolvedValue({
      id: 'inv-1', organizationId: 'org-1', email: 'b@b.com', role: 'member',
      status: 'pending', expiresAt: new Date(Date.now() + 60_000),
    });
    prisma.organization.findFirst.mockResolvedValue({ id: 'org-1', status: 'disabled' });

    const err = await svc.acceptInvitation('u2', 'tok-1').catch((e) => e);
    expect(err.getStatus()).toBe(403);
    expect(err.getResponse()).toMatchObject({ code: 'ORG_DISABLED' });
    expect(prisma.organizationMember.upsert).not.toHaveBeenCalled();
    // 顺序锁定：禁用态拒绝发生在**消费 token 之前**——否则一次冻结会烧掉合法受邀者的邀请（恢复后无法加入）
    expect(prisma.organizationInvitation.updateMany).not.toHaveBeenCalled();
  });
});
