import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ProviderPoliciesService } from './policies.service';
import { AppError } from '../../common/errors/app-error';

const ACTOR = { userId: 'u-owner', role: 'user' };
const ADMIN = { userId: 'u-admin', role: 'admin' };

function makeSut(existing: Record<string, unknown> | null = null) {
  const calls: Array<{ op: string; args: unknown }> = [];
  const prisma = {
    provider: { findUnique: vi.fn(async (): Promise<{ id: string } | null> => ({ id: 'p-a' })) },
    providerPolicy: {
      findFirst: vi.fn(async () => existing),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        calls.push({ op: 'create', args: data });
        return { id: 'pol-new', ...data };
      }),
      update: vi.fn(async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        calls.push({ op: 'update', args: data });
        return { id: where.id, ...data };
      }),
      findMany: vi.fn(async () => []),
    },
  };
  const orgs = {
    requirePermission: vi.fn(async (userId: string, organizationId: string, action: string) => {
      if (userId === 'u-member') throw new AppError('FORBIDDEN', '权限不足');
      return 'owner';
    }),
  };
  const svc = new ProviderPoliciesService(prisma as never, orgs as never);
  return { svc, prisma, orgs, calls };
}

describe('M8-P7 ProviderPoliciesService（组织策略 RBAC + 幂等 upsert）', () => {
  beforeEach(() => vi.clearAllMocks());

  it('组织级 upsert：经 member.write（组织管理者 owner/admin）授权', async () => {
    const { svc, orgs, calls } = makeSut();
    const row = await svc.upsert(ACTOR, { organizationId: 'org-1', providerId: 'p-a', allow: false, priority: 5 });
    expect(orgs.requirePermission).toHaveBeenCalledWith('u-owner', 'org-1', 'member.write');
    expect(calls[0].args).toMatchObject({ allow: false, priority: 5, organizationId: 'org-1' });
    expect(row).toMatchObject({ providerId: 'p-a' });
  });

  it('非组织管理者（member.write 被拒）→ 透传 FORBIDDEN，不写库', async () => {
    const { svc, calls } = makeSut();
    await expect(svc.upsert({ userId: 'u-member', role: 'user' }, { organizationId: 'org-1', providerId: 'p-a' }))
      .rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(calls).toHaveLength(0);
  });

  it('幂等 upsert：已有策略 → update（不新建重复行）', async () => {
    const { svc, calls } = makeSut({ id: 'pol-1', providerId: 'p-a' });
    const row = await svc.upsert(ACTOR, { organizationId: 'org-1', providerId: 'p-a', costCeilingPerRequest: 0.5 });
    expect(calls).toEqual([{ op: 'update', args: expect.objectContaining({ costCeilingPerRequest: 0.5 }) }]);
    expect(row).toMatchObject({ id: 'pol-1' });
  });

  it('并发 create 撞唯一键（P2002）→ 复用已写入行（幂等续跑）', async () => {
    const { svc, prisma } = makeSut(null);
    prisma.providerPolicy.create.mockRejectedValueOnce(Object.assign(new Error('unique'), { code: 'P2002' }));
    prisma.providerPolicy.findFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: 'pol-race', providerId: 'p-a' });
    const row = await svc.upsert(ACTOR, { organizationId: 'org-1', providerId: 'p-a' });
    expect(row).toMatchObject({ id: 'pol-race' });
    expect(prisma.providerPolicy.findFirst).toHaveBeenLastCalledWith({ where: { organizationId: 'org-1', providerId: 'p-a' } });
  });

  it('平台级策略（organizationId=null）仅管理员；平台级用 findFirst（复合唯一键含 null）', async () => {
    const denied = makeSut();
    await expect(denied.svc.upsert(ACTOR, { organizationId: null, providerId: 'p-a' }))
      .rejects.toMatchObject({ code: 'FORBIDDEN' });

    const ok = makeSut();
    const row = await ok.svc.upsert(ADMIN, { organizationId: null, providerId: 'p-a', allow: true });
    expect(row).toMatchObject({ organizationId: null, providerId: 'p-a' });
    expect(ok.prisma.providerPolicy.findFirst).toHaveBeenCalledWith({ where: { organizationId: null, providerId: 'p-a' } });
    expect(ok.orgs.requirePermission).not.toHaveBeenCalled();
  });

  it('provider 不存在 → NOT_FOUND；负成本上限/非法优先级 → VALIDATION_ERROR', async () => {
    const missing = makeSut();
    missing.prisma.provider.findUnique.mockResolvedValue(null);
    await expect(missing.svc.upsert(ACTOR, { organizationId: 'org-1', providerId: 'p-x' }))
      .rejects.toMatchObject({ code: 'NOT_FOUND' });

    const { svc } = makeSut();
    await expect(svc.upsert(ACTOR, { organizationId: 'org-1', providerId: 'p-a', costCeilingPerRequest: -1 }))
      .rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    await expect(svc.upsert(ACTOR, { organizationId: 'org-1', providerId: 'p-a', priority: -5 }))
      .rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });

  it('读取：组织级需 organization.read；平台级清单仅管理员', async () => {
    const { svc, orgs } = makeSut();
    await svc.list(ACTOR, 'org-1');
    expect(orgs.requirePermission).toHaveBeenCalledWith('u-owner', 'org-1', 'organization.read');

    await expect(svc.listPlatform(ACTOR)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(svc.listPlatform(ADMIN)).resolves.toEqual([]);
  });
});
