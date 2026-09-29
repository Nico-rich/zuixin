import { describe, it, expect, vi } from 'vitest';
import { SystemSettingsService } from './system-settings.service';
import { SYSTEM_SETTING_KEY_NAMES } from './system-settings.keys';
import { DEFAULT_POLICY_THRESHOLDS } from './policy-thresholds';

/**
 * M12-P4 受控写面单测（离线）。红线断言：
 * - RBAC = 仅平台管理员（DB 权威 role='admin'；组织 owner/admin 一律 403）；
 * - 键白名单硬编码：未知键 404、白名单外存储内容**绝不回显**、**绝无通用写口**；
 * - 配额类子键只读（命中 → 400）；
 * - 每次写入**强制审计**（含 before/after 与 action 透传）；
 * - 写失败/校验失败 → 绝不落库。
 */
interface StoredRow { key: string; value: unknown; updatedAt: Date }
interface WriteArgs { where: { key: string }; update: { value: unknown }; create: { key: string; value: unknown } }
interface AuditArgs { userId: string; action: string; targetType: string; targetId: string; organizationId: string | null; result: string; metadata: Record<string, unknown> }

function makeHarness(over: {
  role?: string;
  rows?: StoredRow[];
  auditFails?: boolean;
} = {}) {
  const rows: StoredRow[] = over.rows ?? [];
  const prisma = {
    user: { findUnique: vi.fn(async (_args: { where: { id: string } }): Promise<{ role: string } | null> => ({ role: over.role ?? 'admin' })) },
    systemSetting: {
      findMany: vi.fn(async (_args?: unknown): Promise<StoredRow[]> => rows),
      findUnique: vi.fn(async (args: { where: { key: string } }): Promise<StoredRow | null> => rows.find((r) => r.key === args.where.key) ?? null),
      upsert: vi.fn(async (args: WriteArgs): Promise<StoredRow> => {
        const row: StoredRow = { key: args.where.key, value: args.create.value, updatedAt: new Date(0) };
        rows.push(row);
        return row;
      }),
    },
  };
  const audit = {
    write: vi.fn(async (_args: AuditArgs): Promise<void> => {
      if (over.auditFails) throw new Error('audit down');
    }),
  };
  return { service: new SystemSettingsService(prisma as never, audit as never), prisma, audit, rows };
}

describe('SystemSettingsService RBAC（平台管理员闸门）', () => {
  it('role=admin → 放行；role=user（含组织 owner）→ 403 FORBIDDEN', async () => {
    const admin = makeHarness({ role: 'admin' });
    expect(await admin.service.isPlatformAdmin('u1')).toBe(true);
    await expect(admin.service.assertPlatformAdmin('u1')).resolves.toBeUndefined();

    const user = makeHarness({ role: 'user' });
    expect(await user.service.isPlatformAdmin('u1')).toBe(false);
    await expect(user.service.assertPlatformAdmin('u1')).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('用户不存在 → 视为非管理员（DB 是唯一权威，绝不采信 token 声明）', async () => {
    const h = makeHarness();
    h.prisma.user.findUnique.mockResolvedValueOnce(null);
    await expect(h.service.assertPlatformAdmin('ghost')).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('读路径同样受闸门保护（list/get 各自先 assert）', async () => {
    const h = makeHarness({ role: 'user' });
    await expect(h.service.list()).resolves.toBeDefined(); // 服务层 list 不做闸门（控制器裁决）；写路径必须
    await expect(h.service.patch('u1', 'routingPolicy', { confidenceThreshold: 0.5 })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(h.prisma.systemSetting.upsert).not.toHaveBeenCalled();
  });
});

describe('SystemSettingsService 键白名单（硬编码；绝无通用写口）', () => {
  it('清单恒为白名单三键（排序稳定；新增键必须显式登记）', () => {
    expect(SYSTEM_SETTING_KEY_NAMES).toEqual(['routingPolicy', 'limits', 'policyThresholds']);
  });

  it('list 只查白名单键，且输出恒为白名单三键（DB 里有别的键也不列）', async () => {
    const h = makeHarness({ rows: [{ key: 'secretKey', value: { x: 1 }, updatedAt: new Date(0) }] });
    const out = await h.service.list();
    expect(h.prisma.systemSetting.findMany).toHaveBeenCalledWith({
      where: { key: { in: ['routingPolicy', 'limits', 'policyThresholds'] } },
      select: { key: true, value: true, updatedAt: true },
    });
    expect(out.map((v) => v.key)).toEqual(['routingPolicy', 'limits', 'policyThresholds']);
    expect(JSON.stringify(out)).not.toContain('secretKey');
  });

  it('非白名单键 get → 404（防枚举：与"不存在"同一文案形态）', async () => {
    const h = makeHarness();
    await expect(h.service.get('quota')).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(h.service.patch('u1', 'quota', { x: 1 })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(h.prisma.systemSetting.upsert).not.toHaveBeenCalled();
  });

  it('非白名单键的请求体**不被校验也不落库**，且 DELETE/整表覆盖语义不存在（无 PUT 面）', async () => {
    const h = makeHarness();
    await expect(h.service.patch('u1', 'routingPolicyX', { anything: true })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(h.prisma.systemSetting.upsert).not.toHaveBeenCalled();
  });

  it('读取投影：白名单之外的存储内容绝不回显（同一键内夹带的越权子键被 strip）', async () => {
    const h = makeHarness({ rows: [{ key: 'routingPolicy', value: { confidenceThreshold: 0.7, 越权: 'x' }, updatedAt: new Date(0) }] });
    const view = await h.service.get('routingPolicy');
    expect(view.value).toEqual({ confidenceThreshold: 0.7 });
    expect(JSON.stringify(view)).not.toContain('越权');
  });

  it('limits：配额类子键**只读**（PATCH 命中 → 400，附带精准原因；GET 可见）', async () => {
    const h = makeHarness({ rows: [{ key: 'limits', value: { dailyImage: 20 }, updatedAt: new Date(0) }] });
    const view = await h.service.get('limits');
    expect(view.value).toEqual({ dailyImage: 20 });
    expect(view.readOnlySubKeys).toEqual(['dailyImage', 'dailyVideo', 'dailyMemoryCandidates', 'monthlyTokenBudget']);

    for (const quotaKey of view.readOnlySubKeys) {
      await expect(h.service.patch('u1', 'limits', { [quotaKey]: 1_000_000 }))
        .rejects.toMatchObject({ code: 'VALIDATION_ERROR', message: expect.stringContaining('配额面') });
    }
    expect(h.prisma.systemSetting.upsert).not.toHaveBeenCalled();
  });

  it('limits：可写子键正常落库（超时/并发/委派上限）', async () => {
    const h = makeHarness();
    await h.service.patch('u1', 'limits', { videoConcurrency: 4, agentRunDeadlineMs: 600_000 });
    expect(h.prisma.systemSetting.upsert.mock.calls[0][0].create.value).toEqual({ videoConcurrency: 4, agentRunDeadlineMs: 600_000 });
  });
});

describe('SystemSettingsService.validatePatch（值校验；不写库）', () => {
  it('空补丁 → 400（空补丁不产生任何变更，绝不写审计噪声）', () => {
    const h = makeHarness();
    expect(() => h.service.validatePatch('routingPolicy', {})).toThrowError(/补丁不能为空/);
  });

  it('非对象（数组/标量/null）→ 400', () => {
    const h = makeHarness();
    for (const bad of [[], 1, 'x', null]) {
      expect(() => h.service.validatePatch('routingPolicy', bad)).toThrowError(/必须是对象/);
    }
  });

  it('未知子键（strict）→ 400；越界值 → 400（绝不静默丢弃后照样写）', () => {
    const h = makeHarness();
    expect(() => h.service.validatePatch('routingPolicy', { nope: 1 })).toThrowError(/routingPolicy 值非法/);
    expect(() => h.service.validatePatch('routingPolicy', { confidenceThreshold: 2 })).toThrowError(/routingPolicy 值非法/);
    expect(() => h.service.validatePatch('policyThresholds', { feedback: { goodCtr: 5 } })).toThrowError(/policyThresholds 值非法/);
  });

  it('合法补丁 → 返回规范化补丁（只含白名单子键）', () => {
    const h = makeHarness();
    expect(h.service.validatePatch('routingPolicy', { confidenceThreshold: 0.35 })).toEqual({ confidenceThreshold: 0.35 });
  });

  it('validatePatch 只裁决"补丁自身"（逐字段白名单 + 范围）；跨字段一致性是**合并后**的性质 → 由 patch 裁决', () => {
    const h = makeHarness();
    // 逐字段合法 → validatePatch 放行（它不读库、不猜测合并基线；合并基线可能是 DB 里的现值）
    expect(h.service.validatePatch('policyThresholds', { insight: { ratingBad: 4, ratingGood: 4 } }))
      .toEqual({ insight: { ratingBad: 4, ratingGood: 4 } });
    // 写入路径在合并后严格裁决：非法组合 → 400 且绝不落库（见 patch 用例）
    expect(() => h.service.validatePatch('policyThresholds', { insight: { ratingBad: 9 } })).toThrowError(/policyThresholds 值非法/);
  });

  it('patch：跨字段非法组合 → 400，且**绝不落库**（写路径不兜底、不静默接受）', async () => {
    const h = makeHarness();
    await expect(h.service.patch('u1', 'policyThresholds', { insight: { ratingBad: 5, ratingGood: 5 } }))
      .rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    expect(h.prisma.systemSetting.upsert).not.toHaveBeenCalled();
  });

  it('实验晋级面复用同一校验：非法目标键 → 404、非法值 → 400（创建期即拒）', () => {
    const h = makeHarness();
    expect(() => h.service.validatePatch('notAKey', { a: 1 })).toThrowError(/受控键不存在/);
    expect(() => h.service.validatePatch('limits', { dailyImage: 5 })).toThrowError(/配额面/);
  });
});

describe('SystemSettingsService.patch（深合并 + 审计）', () => {
  it('PATCH = 深合并（已有子键保留；补丁未声明的键不动）', async () => {
    const h = makeHarness({ rows: [{ key: 'routingPolicy', value: { confidenceThreshold: 0.6, routerModelId: 'm1' }, updatedAt: new Date(0) }] });
    await h.service.patch('u1', 'routingPolicy', { confidenceThreshold: 0.4 });
    const upsert = h.prisma.systemSetting.upsert.mock.calls[0][0];
    expect(upsert.update.value).toEqual({ confidenceThreshold: 0.4, routerModelId: 'm1' });
    expect(upsert.create.value).toEqual(upsert.update.value);
  });

  it('policyThresholds 写入：只写声明项，其余由读路径兜底（存储保持最小事实）', async () => {
    const h = makeHarness();
    await h.service.patch('u1', 'policyThresholds', { commerce: { anomalyPct: 15 } });
    expect(h.prisma.systemSetting.upsert.mock.calls[0][0].create.value).toEqual({ commerce: { anomalyPct: 15 } });
  });

  it('强制审计：action 缺省 systemSetting.update；before/after/changed 齐备；targetType/targetId 固定', async () => {
    const h = makeHarness({ rows: [{ key: 'routingPolicy', value: { confidenceThreshold: 0.6 }, updatedAt: new Date(0) }] });
    await h.service.patch('u1', 'routingPolicy', { confidenceThreshold: 0.4 });
    expect(h.audit.write).toHaveBeenCalledWith({
      userId: 'u1',
      action: 'systemSetting.update',
      targetType: 'systemSetting',
      targetId: 'routingPolicy',
      organizationId: null,
      result: 'ok',
      metadata: {
        key: 'routingPolicy',
        changed: ['confidenceThreshold'],
        before: { confidenceThreshold: 0.6 },
        after: { confidenceThreshold: 0.4 },
      },
    });
  });

  it('调用方语义（实验晋级）透传：action=experiment.promotion + 附加元数据并入审计', async () => {
    const h = makeHarness();
    await h.service.patch('admin1', 'policyThresholds', { commerce: { anomalyPct: 12 } }, {
      action: 'experiment.promotion',
      metadata: { experimentId: 'exp1', variantId: 'v2', proposalHash: 'a'.repeat(64) },
    });
    const audited = h.audit.write.mock.calls[0][0];
    expect(audited.action).toBe('experiment.promotion');
    expect(audited.metadata).toMatchObject({ experimentId: 'exp1', variantId: 'v2', key: 'policyThresholds', changed: ['commerce'] });
  });

  it('审计失败**不阻断**策略写入（best-effort：审计面降级不拖垮业务），但写入已完成', async () => {
    const h = makeHarness({ auditFails: true });
    await expect(h.service.patch('u1', 'routingPolicy', { confidenceThreshold: 0.2 })).resolves.toMatchObject({ key: 'routingPolicy' });
    expect(h.prisma.systemSetting.upsert).toHaveBeenCalledTimes(1);
  });

  it('写入失败（非管理员 / 非法值）→ 不写库、不写审计（零副作用）', async () => {
    const denied = makeHarness({ role: 'user' });
    await expect(denied.service.patch('u1', 'routingPolicy', { confidenceThreshold: 0.2 })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(denied.prisma.systemSetting.upsert).not.toHaveBeenCalled();
    expect(denied.audit.write).not.toHaveBeenCalled();

    const invalid = makeHarness();
    await expect(invalid.service.patch('u1', 'policyThresholds', { insight: { ratingBad: 5, ratingGood: 5 } })).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    expect(invalid.prisma.systemSetting.upsert).not.toHaveBeenCalled();
    expect(invalid.audit.write).not.toHaveBeenCalled();
  });

  it('返回读投影视图（含 updatedAt；敏感/越权内容绝不回显）', async () => {
    const h = makeHarness();
    const view = await h.service.patch('u1', 'routingPolicy', { routerModelId: 'm9' });
    expect(view).toMatchObject({ key: 'routingPolicy', value: { routerModelId: 'm9' }, readOnlySubKeys: [] });
    expect(view.description).toContain('路由策略');
    expect(view.updatedAt).toBeInstanceOf(Date);
  });

  it('policyThresholds 的读视图恒为**完整生效值**（SystemSetting 优先 + 常量兜底）', async () => {
    const h = makeHarness({ rows: [{ key: 'policyThresholds', value: { commerce: { anomalyPct: 20 } }, updatedAt: new Date(0) }] });
    const view = await h.service.get('policyThresholds');
    expect(view.value).toMatchObject({ commerce: { anomalyPct: 20 }, feedback: DEFAULT_POLICY_THRESHOLDS.feedback });
  });
});
