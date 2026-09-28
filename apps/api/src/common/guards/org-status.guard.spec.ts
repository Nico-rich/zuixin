import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ExecutionContext, HttpException } from '@nestjs/common';
import { OrgStatusGuard, ORG_STATUS_PARAM_KEY, ORG_STATUS_SKIP_KEY, orgDisabledError } from './org-status.guard';

/**
 * M10-P14（X-21）OrgStatusGuard 单测：组织上下文解析、禁用拒绝、豁免语义。
 * （e2e 覆盖真实 HTTP 面：pre-m10-org-status-extension-allowlist.e2e-spec.ts）
 */
function makeCtx(req: Record<string, unknown>): ExecutionContext {
  return {
    getHandler: () => ({}),
    getClass: () => ({}),
    switchToHttp: () => ({ getRequest: () => req }),
  } as unknown as ExecutionContext;
}

function makeGuard(opts: { skip?: boolean; idParam?: string; org?: { status: string } | null; user?: { userId: string; role: string } } = {}) {
  const prisma = {
    organization: {
      findFirst: vi.fn().mockResolvedValue(opts.org === undefined ? { status: 'active' } : opts.org),
    },
  };
  const reflector = {
    getAllAndOverride: vi.fn((key: string) => (key === ORG_STATUS_SKIP_KEY ? opts.skip : key === ORG_STATUS_PARAM_KEY ? opts.idParam : undefined)),
  };
  const guard = new OrgStatusGuard(prisma as never, reflector as never);
  return { guard, prisma, reflector };
}

describe('OrgStatusGuard（M10-P14 组织禁用态）', () => {
  beforeEach(() => vi.clearAllMocks());

  it('请求不含组织上下文 → 放行且不查库（组织列表/创建、邀请接受等）', async () => {
    const { guard, prisma } = makeGuard();
    await expect(guard.canActivate(makeCtx({ params: {}, query: {}, body: {} }))).resolves.toBe(true);
    await expect(guard.canActivate(makeCtx({ params: { id: 'ext-1' }, query: {}, body: {} }))).resolves.toBe(true);
    expect(prisma.organization.findFirst).not.toHaveBeenCalled();
  });

  it('未声明 @OrgStatusIdParam 时 params.id 绝不当作组织 id（extensions 的 :id 是扩展 id）', async () => {
    const { guard, prisma } = makeGuard();
    await guard.canActivate(makeCtx({ params: { id: 'ext-1' }, user: { userId: 'u1', role: 'user' } }));
    expect(prisma.organization.findFirst).not.toHaveBeenCalled();
  });

  it('组织 active → 放行（params.organizationId / query.organizationId / body.organizationId 三来源）', async () => {
    const { guard, prisma } = makeGuard({ org: { status: 'active' } });
    await expect(guard.canActivate(makeCtx({ params: { organizationId: 'org-1' }, query: {}, body: {} }))).resolves.toBe(true);
    await expect(guard.canActivate(makeCtx({ params: {}, query: { organizationId: 'org-1' }, body: {} }))).resolves.toBe(true);
    await expect(guard.canActivate(makeCtx({ params: {}, query: {}, body: { organizationId: 'org-1' } }))).resolves.toBe(true);
    expect(prisma.organization.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'org-1', deletedAt: null }, select: { status: true },
    }));
  });

  it("声明 @OrgStatusIdParam('id') 后 params.id 参与判定（organizations 控制器的 :id = 组织 id）", async () => {
    const { guard } = makeGuard({ idParam: 'id', org: { status: 'active' } });
    await expect(guard.canActivate(makeCtx({ params: { id: 'org-9' }, query: {}, body: {} }))).resolves.toBe(true);
  });

  it('组织禁用 → 403 + 稳定错误码 ORG_DISABLED（绝不泄漏组织数据）', async () => {
    const { guard } = makeGuard({ idParam: 'id', org: { status: 'disabled' } });
    let caught: HttpException | undefined;
    try {
      await guard.canActivate(makeCtx({ params: { id: 'org-1' }, query: {}, body: {}, user: { userId: 'u1', role: 'user' } }));
    } catch (err) {
      caught = err as HttpException;
    }
    expect(caught).toBeInstanceOf(HttpException);
    expect(caught!.getStatus()).toBe(403);
    expect(caught!.getResponse()).toMatchObject({ code: 'ORG_DISABLED' });
  });

  it('组织不存在/已软删 → 放行（交由端点既有 404/403 裁决，不改变既有语义）', async () => {
    const { guard } = makeGuard({ idParam: 'id', org: null });
    await expect(guard.canActivate(makeCtx({ params: { id: 'nope' }, query: {}, body: {} }))).resolves.toBe(true);
  });

  it('@SkipOrgStatusCheck 豁免（治理端点：禁用/启用自身必须可达）', async () => {
    const { guard, prisma } = makeGuard({ skip: true, idParam: 'id', org: { status: 'disabled' } });
    await expect(guard.canActivate(makeCtx({ params: { id: 'org-1' }, query: {}, body: {} }))).resolves.toBe(true);
    expect(prisma.organization.findFirst).not.toHaveBeenCalled();
  });

  it('无角色豁免：平台管理员（user.role=admin）同样被冻结拒绝（治理可达性靠显式 Skip，而非角色旁路）', async () => {
    const { guard, prisma } = makeGuard({ idParam: 'id', org: { status: 'disabled' } });
    const err = await guard.canActivate(makeCtx({ params: { id: 'org-1' }, query: {}, body: {}, user: { userId: 'admin', role: 'admin' } }))
      .catch((e) => e);
    expect(err.getStatus()).toBe(403);
    expect(err.getResponse()).toMatchObject({ code: 'ORG_DISABLED' });
    expect(prisma.organization.findFirst).toHaveBeenCalledTimes(1);

    // 治理端点由 metadata 豁免（不依赖角色）→ 平台管理员的恢复能力有保障
    const skipped = makeGuard({ skip: true, idParam: 'id', org: { status: 'disabled' } });
    await expect(skipped.guard.canActivate(makeCtx({ params: { id: 'org-1' }, query: {}, body: {}, user: { userId: 'admin', role: 'admin' } })))
      .resolves.toBe(true);
  });

  it('空串/null/非字符串组织上下文一律忽略（绝不退化成"任意组织"判定）', async () => {
    const { guard, prisma } = makeGuard();
    await guard.canActivate(makeCtx({ params: { organizationId: '' }, query: { orgId: null }, body: { organizationId: 42 } }));
    expect(prisma.organization.findFirst).not.toHaveBeenCalled();
  });

  it('orgDisabledError：403 + ORG_DISABLED（守卫与服务层共用同一错误构造）', () => {
    const err = orgDisabledError('组织已被禁用，无法访问其资源');
    expect(err.getStatus()).toBe(403);
    expect(err.getResponse()).toEqual({ code: 'ORG_DISABLED', message: '组织已被禁用，无法访问其资源' });
  });
});
