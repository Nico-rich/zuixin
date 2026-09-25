import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AuthorizationService, OrgPermission } from './authorization.service';

function makeService() {
  const prisma = {
    organization: { findFirst: vi.fn() },
    organizationMember: { findUnique: vi.fn() },
  };
  const svc = new AuthorizationService(prisma as never);
  return { svc, prisma };
}

function allow(svc: AuthorizationService, prisma: ReturnType<typeof makeService>['prisma'], role: string) {
  prisma.organization.findFirst.mockResolvedValue({ id: 'org-1' });
  prisma.organizationMember.findUnique.mockResolvedValue({ role });
}

describe('AuthorizationService（M8-P1 RBAC 矩阵，deny-by-default）', () => {
  beforeEach(() => vi.clearAllMocks());

  const ALL: OrgPermission[] = [
    'organization.read', 'organization.write', 'member.read', 'member.write',
    'project.read', 'project.write', 'agent.read', 'agent.write',
    'workflow.read', 'workflow.write', 'connection.read', 'connection.write',
    'billing.read', 'billing.write',
  ];

  it('owner：全部权限', async () => {
    const { svc, prisma } = makeService();
    allow(svc, prisma, 'owner');
    for (const p of ALL) await expect(svc.authorize('u1', 'org-1', p)).resolves.toBe('owner');
  });

  it('admin：除 organization.write / billing.write 外全部', async () => {
    const { svc, prisma } = makeService();
    allow(svc, prisma, 'admin');
    for (const p of ALL) {
      if (p === 'organization.write' || p === 'billing.write') {
        await expect(svc.authorize('u1', 'org-1', p)).rejects.toMatchObject({ code: 'FORBIDDEN' });
      } else {
        await expect(svc.authorize('u1', 'org-1', p)).resolves.toBe('admin');
      }
    }
  });

  it('member：资源读写 + billing.read；无 member.write/organization.write/billing.write', async () => {
    const { svc, prisma } = makeService();
    allow(svc, prisma, 'member');
    for (const p of ['project.write', 'workflow.write', 'connection.write', 'agent.write', 'billing.read', 'organization.read'] as OrgPermission[]) {
      await expect(svc.authorize('u1', 'org-1', p)).resolves.toBe('member');
    }
    for (const p of ['member.write', 'organization.write', 'billing.write'] as OrgPermission[]) {
      await expect(svc.authorize('u1', 'org-1', p)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    }
  });

  it('viewer：只读；写一律拒绝', async () => {
    const { svc, prisma } = makeService();
    allow(svc, prisma, 'viewer');
    for (const p of ['project.read', 'workflow.read', 'connection.read', 'agent.read', 'organization.read'] as OrgPermission[]) {
      await expect(svc.authorize('u1', 'org-1', p)).resolves.toBe('viewer');
    }
    for (const p of ['project.write', 'workflow.write', 'connection.write', 'member.read', 'member.write', 'billing.read'] as OrgPermission[]) {
      await expect(svc.authorize('u1', 'org-1', p)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    }
  });

  it('非成员 → 403；组织已删除 → 403；组织不存在 → 403（防枚举统一拒绝）', async () => {
    const { svc, prisma } = makeService();
    prisma.organization.findFirst.mockResolvedValue({ id: 'org-1' });
    prisma.organizationMember.findUnique.mockResolvedValue(null);
    await expect(svc.authorize('u1', 'org-1', 'project.read')).rejects.toMatchObject({ code: 'FORBIDDEN' });
    prisma.organization.findFirst.mockResolvedValue(null); // 已删除/不存在
    await expect(svc.authorize('u1', 'org-1', 'project.read')).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
});
