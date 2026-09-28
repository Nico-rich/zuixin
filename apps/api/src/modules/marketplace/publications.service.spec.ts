import { describe, it, expect, vi } from 'vitest';
import { OrganizationRole } from '@prisma/client';
import { PublicationsService } from './publications.service';
import { AuthorizationService } from '../organizations/authorization.service';
import { MarketplaceAccessService } from './marketplace-access.service';
import { checksumOf, parseManifest, signChecksum } from '../extensions/manifest';

/**
 * M9-P6 发布条目服务单测：上架门禁（平台校验复算/签名/归属）+ 状态机 + 条件更新（CAS）+ RBAC 委托。
 * 断言重点 = "未通过平台校验的扩展绝不进市场""非法推进绝不落库""门禁失败时零写入"。
 *
 * 门禁用**真实** checksum/签名函数（manifest.ts 导出）构造通过/失败样本：
 * 密钥不一致 → 签名无效；manifest 与 checksum 不同源 → 篡改判定。
 */
const KEY = 'unit-test-platform-key';
process.env.ENCRYPTION_KEY = KEY;

const SLUG = 'mkt-tool';
const ORG = 'org-1';

function manifestOf(slug = SLUG) {
  return {
    manifestVersion: 1, kind: 'tool', permissions: ['tool.execute'],
    tool: { name: `ext.${slug}.search`, description: 'd', baseTool: 'knowledge.search' },
  } as unknown as Record<string, unknown>;
}

/** 构造"已通过 M8-P6 平台发布校验"的版本行（checksum 与签名均可复算通过） */
function publishedVersion(slug = SLUG, over: { checksum?: string; signature?: string | null; status?: string } = {}) {
  const manifest = manifestOf(slug);
  const parsed = parseManifest(manifest, { slug });
  return {
    id: 'v1', extensionId: 'ext-1', version: 1, status: over.status ?? 'published',
    manifest, checksum: over.checksum ?? parsed.checksum,
    signature: over.signature === undefined ? signChecksum(parsed.checksum, KEY) : over.signature,
  };
}

function extRow(over: Record<string, unknown> = {}) {
  return {
    id: 'ext-1', organizationId: ORG, ownerUserId: 'u1', name: '知识检索扩展', slug: SLUG,
    description: 'd', kind: 'tool', status: 'published', createdAt: new Date(), updatedAt: new Date(),
    ...over,
  };
}

function pubRow(over: Record<string, unknown> = {}) {
  return {
    id: 'pub-1', organizationId: ORG, userId: 'u1', extensionId: 'ext-1', status: 'draft',
    category: 'knowledge', description: '面向组织知识库的只读检索扩展', changelog: null, compatibility: null,
    createdAt: new Date('2026-01-01T00:00:00Z'), updatedAt: new Date('2026-01-01T00:00:00Z'),
    ...over,
  };
}

function makeHarness(opts: {
  ext?: unknown; version?: unknown; pub?: unknown; existing?: unknown;
  casCount?: number; requireWrite?: () => Promise<unknown>; platformAdmin?: boolean; personalOrg?: string;
} = {}) {
  const state = { pub: opts.pub === undefined ? pubRow() : opts.pub };
  const prisma = {
    extension: { findUnique: vi.fn(async () => (opts.ext === undefined ? extRow() : opts.ext)) },
    extensionVersion: { findFirst: vi.fn(async () => (opts.version === undefined ? publishedVersion() : opts.version)) },
    extensionPublication: {
      findUnique: vi.fn(async (args: { where: { id?: string; extensionId?: string } }) => {
        if (args.where.extensionId) return opts.existing ?? null;
        return state.pub;
      }),
      create: vi.fn(async (args: { data: Record<string, unknown> }) => ({ ...pubRow(), ...args.data })),
      update: vi.fn(async (args: { data: Record<string, unknown> }) => ({ ...(state.pub as object), ...args.data })),
      updateMany: vi.fn(async () => ({ count: opts.casCount ?? 1 })),
    },
  };
  const orgs = { ensurePersonalOrganization: vi.fn(async () => ({ id: opts.personalOrg ?? 'personal-u1' })) };
  const access = {
    requireWrite: vi.fn(opts.requireWrite ?? (async () => 'owner')),
    isPlatformAdmin: vi.fn(async () => opts.platformAdmin ?? false),
    assertPublicationWrite: vi.fn(async () => 'owner'),
    assertModerationRights: vi.fn(async () => 'owner'),
  };
  const audit = { write: vi.fn(async () => undefined) };
  const service = new PublicationsService(prisma as never, orgs as never, access as never, audit as never);
  return { service, prisma, orgs, access, audit };
}

/**
 * M10-P6：**真实**治理判定接线（prisma 只提供假行；AuthorizationService 矩阵与
 * MarketplaceAccessService 判定均为真实实现）——驳回端点"走显式治理判定"的契约在此锁死。
 */
function makeWiredHarness(role: OrganizationRole | null) {
  const prisma = {
    organization: { findFirst: vi.fn(async () => ({ id: ORG })) },
    organizationMember: { findUnique: vi.fn(async () => (role === null ? null : { role })) },
    user: { findUnique: vi.fn(async () => ({ role: 'user' })) },
    extensionPublication: {
      findUnique: vi.fn(async () => pubRow({ status: 'published' })),
      updateMany: vi.fn(async () => ({ count: 1 })),
    },
    extension: { findUnique: vi.fn(async () => extRow()) },
    extensionVersion: { findFirst: vi.fn(async () => publishedVersion()) },
  };
  const orgs = { ensurePersonalOrganization: vi.fn(async () => ({ id: 'personal-u1' })) };
  const auth = new AuthorizationService(prisma as never);
  const access = new MarketplaceAccessService(prisma as never, auth as never);
  const audit = { write: vi.fn(async () => undefined) };
  const service = new PublicationsService(prisma as never, orgs as never, access as never, audit as never);
  return { service, prisma, orgs, auth, access, audit };
}

describe('PublicationsService（上架门禁 + 状态机）', () => {
  it('门禁①：扩展不存在 → 404（不泄露存在性）', async () => {
    const h = makeHarness({ ext: null });
    await expect(h.service.assertPublishable('u1', 'ext-x')).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('门禁②：扩展未发布（draft/deprecated/archived）→ 400，绝不进市场', async () => {
    for (const status of ['draft', 'deprecated', 'archived']) {
      const h = makeHarness({ ext: extRow({ status }) });
      await expect(h.service.assertPublishable('u1', 'ext-1')).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    }
  });

  it('门禁③：无 published 版本行 → 400（draft 版本不可上架）', async () => {
    const h = makeHarness({ version: null });
    await expect(h.service.assertPublishable('u1', 'ext-1'))
      .rejects.toMatchObject({ code: 'VALIDATION_ERROR', message: expect.stringContaining('尚无已发布版本') });
  });

  it('门禁③：checksum 与 manifest 不同源（被篡改）→ 400', async () => {
    const h = makeHarness({ version: { ...publishedVersion(), checksum: checksumOf({ tampered: true }) } });
    await expect(h.service.assertPublishable('u1', 'ext-1'))
      .rejects.toMatchObject({ code: 'VALIDATION_ERROR', message: expect.stringContaining('篡改') });
  });

  it('门禁③：签名与平台密钥不匹配（伪造/未签名）→ 400', async () => {
    const parsed = parseManifest(manifestOf(), { slug: SLUG });
    const forged = makeHarness({ version: { ...publishedVersion(), signature: signChecksum(parsed.checksum, 'attacker-key') } });
    await expect(forged.service.assertPublishable('u1', 'ext-1'))
      .rejects.toMatchObject({ code: 'VALIDATION_ERROR', message: expect.stringContaining('签名无效') });
    const unsigned = makeHarness({ version: { ...publishedVersion(), signature: null } });
    await expect(unsigned.service.assertPublishable('u1', 'ext-1'))
      .rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });

  it('门禁④：组织私有扩展 → 该组织 agent.write（RBAC 委托）；非成员 403 原样上抛', async () => {
    const h = makeHarness();
    const gate = await h.service.assertPublishable('u1', 'ext-1');
    expect(h.access.requireWrite).toHaveBeenCalledWith('u1', ORG);
    expect(gate).toMatchObject({
      extensionId: 'ext-1', versionId: 'v1', versionNumber: 1, publisherOrganizationId: ORG, permissions: ['tool.execute'],
    });
    const denied = makeHarness({
      requireWrite: async () => { throw Object.assign(new Error('权限不足'), { code: 'FORBIDDEN' }); },
    });
    await expect(denied.service.assertPublishable('u1', 'ext-1')).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('门禁④：平台级扩展（organizationId=null）仅平台管理员可上架；发布者组织=个人组织', async () => {
    const denied = makeHarness({ ext: extRow({ organizationId: null }), platformAdmin: false });
    await expect(denied.service.assertPublishable('u1', 'ext-1')).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(denied.orgs.ensurePersonalOrganization).not.toHaveBeenCalled();

    const allowed = makeHarness({ ext: extRow({ organizationId: null }), platformAdmin: true, personalOrg: 'personal-u1' });
    const gate = await allowed.service.assertPublishable('u1', 'ext-1');
    expect(gate.publisherOrganizationId).toBe('personal-u1');
  });

  it('create：门禁通过后落 draft（发布者组织由服务端推导，绝不接受请求体）', async () => {
    const h = makeHarness();
    const created = await h.service.create('u1', {
      extensionId: 'ext-1', category: 'knowledge', description: '面向组织知识库的只读检索扩展',
      changelog: [{ version: '1.0.0', notes: '首个版本' }],
    });
    expect(h.prisma.extensionPublication.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ organizationId: ORG, userId: 'u1', status: 'draft', category: 'knowledge' }),
    });
    expect(created).toMatchObject({ status: 'draft', organizationId: ORG, extensionId: 'ext-1' });
    expect(h.audit.write).toHaveBeenCalledWith(expect.objectContaining({ action: 'marketplace.publication.create' }));
  });

  it('create：一扩展一条目（已存在 → 400，绝不覆盖）', async () => {
    const h = makeHarness({ existing: pubRow({ id: 'pub-existing' }) });
    await expect(h.service.create('u1', { extensionId: 'ext-1', category: 'knowledge', description: '描述描述描述描述' }))
      .rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    expect(h.prisma.extensionPublication.create).not.toHaveBeenCalled();
  });

  it('create：门禁失败时零写入（未通过平台校验的扩展绝不落库）', async () => {
    const h = makeHarness({ ext: extRow({ status: 'draft' }) });
    await expect(h.service.create('u1', { extensionId: 'ext-1', category: 'knowledge', description: '描述描述描述描述' }))
      .rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    expect(h.prisma.extensionPublication.create).not.toHaveBeenCalled();
    expect(h.audit.write).not.toHaveBeenCalled();
  });

  it('publish：draft→published，重跑门禁并 CAS 落库（锚定当前状态）', async () => {
    const h = makeHarness();
    const updated = await h.service.publish('u1', 'pub-1');
    // M10-P15（BUG-13）：书写权的 404 必须复用调用方"发布条目不存在"的文案
    // （文案不一致 ⇒ 可用错误文案区分"行不存在"与"行存在但非成员" ⇒ 存在性 oracle）
    expect(h.access.assertPublicationWrite).toHaveBeenCalledWith('u1', expect.objectContaining({ id: 'pub-1' }), '发布条目不存在');
    expect(h.prisma.extensionPublication.updateMany).toHaveBeenCalledWith({
      where: { id: 'pub-1', status: 'draft' }, data: { status: 'published' },
    });
    expect(updated).toMatchObject({ id: 'pub-1' });
    expect(h.audit.write).toHaveBeenCalledWith(expect.objectContaining({ action: 'marketplace.publication.publish' }));
  });

  it('publish：rejected 无直达边（必须先 revise）→ 400 且零写入', async () => {
    const h = makeHarness({ pub: pubRow({ status: 'rejected' }) });
    await expect(h.service.publish('u1', 'pub-1')).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    expect(h.prisma.extensionPublication.updateMany).not.toHaveBeenCalled();
  });

  it('publish：CAS 失配（并发/状态已变）→ 400，绝不盲目覆盖', async () => {
    const h = makeHarness({ casCount: 0 });
    await expect(h.service.publish('u1', 'pub-1')).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });

  it('publish：发布者组织与扩展归属漂移（借壳上架）→ 400', async () => {
    const h = makeHarness({ pub: pubRow({ organizationId: 'org-other' }), requireWrite: async () => 'owner' });
    await expect(h.service.publish('u1', 'pub-1')).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });

  it('withdraw：published→draft（作者侧下架）；draft 上撤回 → 400', async () => {
    const h = makeHarness({ pub: pubRow({ status: 'published' }) });
    await h.service.withdraw('u1', 'pub-1');
    expect(h.prisma.extensionPublication.updateMany).toHaveBeenCalledWith({
      where: { id: 'pub-1', status: 'published' }, data: { status: 'draft' },
    });
    const noop = makeHarness({ pub: pubRow({ status: 'draft' }) });
    await expect(noop.service.withdraw('u1', 'pub-1')).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });

  it('revise：rejected→draft；published 上修订 → 400', async () => {
    const h = makeHarness({ pub: pubRow({ status: 'rejected' }) });
    await h.service.revise('u1', 'pub-1');
    expect(h.prisma.extensionPublication.updateMany).toHaveBeenCalledWith({
      where: { id: 'pub-1', status: 'rejected' }, data: { status: 'draft' },
    });
    const noop = makeHarness({ pub: pubRow({ status: 'published' }) });
    await expect(noop.service.revise('u1', 'pub-1')).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });

  it('reject：仅审核权（owner/admin 或平台管理员）可下架；published→rejected', async () => {
    const h = makeHarness({ pub: pubRow({ status: 'published' }) });
    await h.service.reject('u1', 'pub-1', { reason: '分类与内容不符' });
    expect(h.access.assertModerationRights).toHaveBeenCalledTimes(1);
    expect(h.prisma.extensionPublication.updateMany).toHaveBeenCalledWith({
      where: { id: 'pub-1', status: 'published' }, data: { status: 'rejected' },
    });

    const denied = makeHarness({
      pub: pubRow({ status: 'published' }),
      requireWrite: async () => 'owner',
    });
    denied.access.assertModerationRights = vi.fn(async () => { throw Object.assign(new Error('资源不存在'), { code: 'NOT_FOUND' }); });
    await expect(denied.service.reject('u1', 'pub-1', { reason: '理由理由' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(denied.prisma.extensionPublication.updateMany).not.toHaveBeenCalled();
  });

  it('update：已上架条目禁止直接编辑（须先撤回）→ 400 且零写入', async () => {
    const h = makeHarness({ pub: pubRow({ status: 'published' }) });
    await expect(h.service.update('u1', 'pub-1', { description: '改一下描述内容' }))
      .rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    expect(h.prisma.extensionPublication.update).not.toHaveBeenCalled();
    expect(h.audit.write).not.toHaveBeenCalled();
  });

  it('update：draft 可编辑（仅改提交的字段）；rejected 可编辑（修订期）', async () => {
    const h = makeHarness({ pub: pubRow({ status: 'draft' }) });
    await h.service.update('u1', 'pub-1', { category: 'analytics' });
    expect(h.prisma.extensionPublication.update).toHaveBeenCalledWith({
      where: { id: 'pub-1' }, data: { category: 'analytics' },
    });
    const rejected = makeHarness({ pub: pubRow({ status: 'rejected' }) });
    await rejected.service.update('u1', 'pub-1', { changelog: null });
    expect(rejected.prisma.extensionPublication.update).toHaveBeenCalledWith({
      where: { id: 'pub-1' }, data: { changelog: expect.anything() },
    });
  });

  it('读路径：条目不存在 → 404（防枚举）', async () => {
    const h = makeHarness({ pub: null });
    await expect(h.service.getRowForAccess('pub-x')).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('reject × 真实治理判定（M10-P6）：owner/admin 可驳回；member/viewer 403；非成员 404', async () => {
    for (const role of ['owner', 'admin'] as const) {
      const h = makeWiredHarness(role);
      await expect(h.service.reject('u-mod', 'pub-1', { reason: '分类与内容不符' })).resolves.toMatchObject({ id: 'pub-1' });
      expect(h.prisma.extensionPublication.updateMany).toHaveBeenCalledWith({
        where: { id: 'pub-1', status: 'published' }, data: { status: 'rejected' },
      });
    }
    for (const role of ['member', 'viewer'] as const) {
      const h = makeWiredHarness(role);
      await expect(h.service.reject('u-x', 'pub-1', { reason: '越权驳回' }))
        .rejects.toMatchObject({ code: 'FORBIDDEN' });
      expect(h.prisma.extensionPublication.updateMany).not.toHaveBeenCalled();
      expect(h.audit.write).not.toHaveBeenCalled();
    }
    const outsider = makeWiredHarness(null);
    await expect(outsider.service.reject('u-out', 'pub-1', { reason: '局外人驳回' }))
      .rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(outsider.prisma.extensionPublication.updateMany).not.toHaveBeenCalled();
  });
});
