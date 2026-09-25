import { describe, it, expect, vi, beforeEach } from 'vitest';
import { WorkflowsService } from './workflows.service';
import { AppError, ErrorCode } from '../../common/errors/app-error';

const DEFINITION = { triggers: [{ type: 'manual' }], steps: [{ id: 'out', type: 'output', output: { ok: true } }] };
/** 行含最新 draft 版本（publish 需要可发布的版本；update 命中"draft 原地改"） */
const ROW = {
  id: 'wf-1', userId: 'owner-1', organizationId: 'org-1', name: 'w', status: 'draft',
  versions: [{ id: 'v1', version: 1, status: 'draft', definition: DEFINITION }],
};

/**
 * Pre-M9 写路径 RBAC 单测（与 test/pre-m9-workflow-rbac.e2e-spec.ts 互补）：
 * 重点锁死"校验先于操作"——权限不足/跨组织时绝不产生任何写入副作用；
 * requireOwned 只保证可见（viewer 也是成员），写操作必须再经 workflow.write 裁决。
 */
function makeService(row: Record<string, unknown> | null = ROW) {
  const prisma = {
    workflow: {
      findFirst: vi.fn(async () => row),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({ id: 'wf-1', ...data })),
      update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({ id: 'wf-1', ...data })),
      delete: vi.fn(async () => ({ id: 'wf-1' })),
    },
    workflowVersion: {
      update: vi.fn(async () => ({ id: 'v1' })),
      create: vi.fn(async () => ({ id: 'v2' })),
    },
    project: { findFirst: vi.fn(async () => null) },
  };
  const triggers = {
    registerTriggers: vi.fn(async () => ({ webhook: null })),
    unregisterTriggers: vi.fn(async () => undefined),
  };
  const orgs = {
    requirePermission: vi.fn(async () => 'owner'),
    requireMembership: vi.fn(async () => 'owner'),
    ensurePersonalOrganization: vi.fn(async () => ({ id: 'personal-org-1' })),
  };
  const svc = new WorkflowsService(prisma as never, triggers as never, orgs as never);
  return { svc, prisma, triggers, orgs };
}

describe('WorkflowsService 写路径 RBAC（Pre-M9：viewer/member 可写修复）', () => {
  beforeEach(() => vi.clearAllMocks());

  it('viewer（成员但无 workflow.write）→ 403，且校验先于操作：零写入', async () => {
    const { svc, prisma, triggers, orgs } = makeService();
    orgs.requirePermission.mockRejectedValueOnce(new AppError(ErrorCode.FORBIDDEN, '权限不足'));
    await expect(svc.update('viewer-1', 'wf-1', { name: 'x' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(orgs.requirePermission).toHaveBeenCalledWith('viewer-1', 'org-1', 'workflow.write');
    expect(prisma.workflowVersion.update).not.toHaveBeenCalled();
    expect(prisma.workflow.update).not.toHaveBeenCalled();

    orgs.requirePermission.mockRejectedValueOnce(new AppError(ErrorCode.FORBIDDEN, '权限不足'));
    await expect(svc.publish('viewer-1', 'wf-1')).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(triggers.registerTriggers).not.toHaveBeenCalled();

    orgs.requirePermission.mockRejectedValueOnce(new AppError(ErrorCode.FORBIDDEN, '权限不足'));
    await expect(svc.archive('viewer-1', 'wf-1')).rejects.toMatchObject({ code: 'FORBIDDEN' });

    orgs.requirePermission.mockRejectedValueOnce(new AppError(ErrorCode.FORBIDDEN, '权限不足'));
    await expect(svc.remove('viewer-1', 'wf-1')).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(prisma.workflow.delete).not.toHaveBeenCalled();
  });

  it('member（有 workflow.write）→ 允许写（update 落版本；publish 注册触发器）', async () => {
    const { svc, prisma, triggers } = makeService();
    await svc.update('member-1', 'wf-1', { name: 'x', definition: DEFINITION as never });
    expect(prisma.workflowVersion.update).toHaveBeenCalled(); // 最新版本仍是 draft → 原地改（版本不可变语义不变）
    await svc.publish('member-1', 'wf-1');
    expect(triggers.registerTriggers).toHaveBeenCalledWith('wf-1', expect.anything());
    await svc.remove('member-1', 'wf-1');
    expect(prisma.workflow.delete).toHaveBeenCalledWith({ where: { id: 'wf-1' } });
  });

  it('非成员/不存在 → 404 反枚举（在权限裁决之前，绝不泄露存在性）', async () => {
    const { svc, prisma, orgs } = makeService(null);
    await expect(svc.publish('outsider-1', 'wf-1')).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(orgs.requirePermission).not.toHaveBeenCalled(); // 组织角色查询都不发生
    expect(prisma.workflow.update).not.toHaveBeenCalled();
  });

  it('个人流程（无 organizationId）→ 不查组织权限；仅创建者本人可写', async () => {
    const { svc, prisma, orgs } = makeService({ ...ROW, organizationId: null });
    await svc.remove('owner-1', 'wf-1');
    expect(orgs.requirePermission).not.toHaveBeenCalled();
    expect(prisma.workflow.delete).toHaveBeenCalled();

    // 防御分支：无组织归属却不是本人（requireOwned 之外的历史行）→ 404
    const legacy = makeService({ ...ROW, organizationId: null, userId: 'someone-else' });
    await expect(legacy.svc.remove('owner-1', 'wf-1')).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(legacy.prisma.workflow.delete).not.toHaveBeenCalled();
  });

  it('create：显式组织与个人组织都按 workflow.write 裁决（viewer 建流 403）', async () => {
    const { svc, prisma, orgs } = makeService();
    await svc.create('member-1', { name: 'n', organizationId: 'org-1', definition: DEFINITION as never });
    expect(orgs.requirePermission).toHaveBeenCalledWith('member-1', 'org-1', 'workflow.write');

    await svc.create('member-1', { name: 'n', definition: DEFINITION as never }); // 缺省 → 个人组织
    expect(orgs.ensurePersonalOrganization).toHaveBeenCalledWith('member-1');
    expect(orgs.requirePermission).toHaveBeenLastCalledWith('member-1', 'personal-org-1', 'workflow.write');

    orgs.requirePermission.mockRejectedValueOnce(new AppError(ErrorCode.FORBIDDEN, '权限不足'));
    await expect(svc.create('viewer-1', { name: 'n', organizationId: 'org-1', definition: DEFINITION as never }))
      .rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(prisma.workflow.create).toHaveBeenCalledTimes(2); // viewer 那一次绝不落库
  });
});
