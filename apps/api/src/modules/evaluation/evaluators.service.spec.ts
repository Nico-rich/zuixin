import { describe, it, expect, vi } from 'vitest';
import { EvaluationEvaluatorsService } from './evaluators.service';

function makeHarness(over: { row?: Record<string, unknown> | null } = {}) {
  const row = over.row === undefined ? { id: 'ev1', organizationId: 'org1', name: 'EV', type: 'exact_match', config: {} } : over.row;
  const prisma = {
    evaluator: {
      create: vi.fn(async (args: { data: Record<string, unknown> }) => ({ id: 'ev-new', ...args.data })),
      findMany: vi.fn(async () => (row ? [row] : [])),
      findFirst: vi.fn(async () => row),
      findUnique: vi.fn(async () => (row ? { id: row.id, organizationId: row.organizationId } : null)),
      update: vi.fn(async (args: { data: Record<string, unknown> }) => ({ ...row, ...args.data })),
      delete: vi.fn(async () => row),
    },
    evaluationResult: { count: vi.fn(async () => 0) },
  };
  return { service: new EvaluationEvaluatorsService(prisma as never), prisma, row };
}

describe('EvaluationEvaluatorsService.create', () => {
  it('配置经注册表校验后入库（合法配置）', async () => {
    const { service, prisma } = makeHarness();
    await service.create('u1', 'org1', { name: 'EV', type: 'exact_match', config: { trim: false } });
    expect(prisma.evaluator.create).toHaveBeenCalledWith({
      data: { organizationId: 'org1', userId: 'u1', name: 'EV', type: 'exact_match', config: { trim: false } },
    });
    expect(prisma.evaluator.create).toHaveBeenCalledTimes(1);
  });

  it('非法配置**绝不入库**（未注册类型 / 空规则 / 无占位符 prompt）', async () => {
    const { service, prisma } = makeHarness();
    await expect(service.create('u1', 'org1', { name: 'x', type: 'vibes', config: {} } as never)).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    await expect(service.create('u1', 'org1', { name: 'x', type: 'rule', config: { rules: [] } })).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    await expect(service.create('u1', 'org1', { name: 'x', type: 'llm_judge', config: { prompt: '无占位符' } })).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    await expect(service.create('u1', 'org1', { name: 'x', type: 'exact_match', config: [] as never })).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    expect(prisma.evaluator.create).not.toHaveBeenCalled();
  });
});

describe('EvaluationEvaluatorsService.update / remove', () => {
  it('update 只改 name/config：type 不可变（历史结果因此始终可解释）', async () => {
    const { service, prisma } = makeHarness();
    await service.update('org1', 'ev1', { name: '新名', config: { trim: true } });
    expect(prisma.evaluator.update).toHaveBeenCalledWith({ where: { id: 'ev1' }, data: { name: '新名', config: { trim: true } } });
    // 断言绝不写 type（update 的 dto 类型里也没有 type）
    const data = (prisma.evaluator.update.mock.calls[0][0] as { data: Record<string, unknown> }).data;
    expect(data).not.toHaveProperty('type');
  });

  it('update 的 config 按**既有 type** 重新校验（非法 → 拒绝，不写库）', async () => {
    const { service, prisma } = makeHarness({ row: { id: 'ev1', organizationId: 'org1', name: 'EV', type: 'rule', config: { rules: [{ type: 'contains', value: 'x' }] } } });
    await expect(service.update('org1', 'ev1', { config: { rules: [] } })).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    expect(prisma.evaluator.update).not.toHaveBeenCalled();
  });

  it('remove：被任何结果引用 → 拒绝删除（历史事实只读，绝不级联销毁）', async () => {
    const { service, prisma } = makeHarness();
    (prisma.evaluationResult.count as ReturnType<typeof vi.fn>).mockResolvedValue(3);
    await expect(service.remove('org1', 'ev1')).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    expect(prisma.evaluator.delete).not.toHaveBeenCalled();
  });

  it('remove：无引用时可删除', async () => {
    const { service, prisma } = makeHarness();
    expect(await service.remove('org1', 'ev1')).toEqual({ id: 'ev1', deleted: true });
    expect(prisma.evaluator.delete).toHaveBeenCalledWith({ where: { id: 'ev1' } });
  });

  it('跨组织/不存在 → 404（作用域一律 organizationId）', async () => {
    const { service, prisma } = makeHarness({ row: null });
    await expect(service.update('org1', 'ev1', { name: 'x' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(service.remove('org1', 'ev1')).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(prisma.evaluator.delete).not.toHaveBeenCalled();
  });
});

describe('EvaluationEvaluatorsService.requireByIds（run 绑定的解析面）', () => {
  it('全部命中 → 返回（id/name/type/config）', async () => {
    const { service, prisma } = makeHarness();
    (prisma.evaluator.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([{ id: 'ev1', name: 'EV', type: 'exact_match', config: {} }]);
    expect(await service.requireByIds('org1', ['ev1'])).toHaveLength(1);
    expect(prisma.evaluator.findMany).toHaveBeenCalledWith({
      where: { id: { in: ['ev1'] }, organizationId: 'org1' },
      select: { id: true, name: true, type: true, config: true },
    });
  });

  it('任一 id 不属于该组织 → 404（绝不静默丢弃未命中的评测器）', async () => {
    const { service, prisma } = makeHarness();
    (prisma.evaluator.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([{ id: 'ev1' }]);
    await expect(service.requireByIds('org1', ['ev1', 'ev-cross-org'])).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('重复 id 不误判缺失（按去重后数量比对）', async () => {
    const { service, prisma } = makeHarness();
    (prisma.evaluator.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([{ id: 'ev1' }]);
    expect(await service.requireByIds('org1', ['ev1', 'ev1'])).toHaveLength(1);
  });

  it('空列表 → 不查库，返回空（不绑定任何评测器是允许的配置）', async () => {
    const { service, prisma } = makeHarness();
    expect(await service.requireByIds('org1', [])).toEqual([]);
    expect(prisma.evaluator.findMany).not.toHaveBeenCalled();
  });
});
