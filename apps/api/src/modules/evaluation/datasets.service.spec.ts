import { describe, it, expect, vi } from 'vitest';
import { EvaluationDatasetsService } from './datasets.service';

/**
 * 数据集版本化单测：**copy-on-write** 是历史 run 可复现的结构保证——
 * 断言重点：bump 版本、旧版本行永不改动/永不删除、元数据变更不 bump。
 */
function makeHarness(over: { dataset?: Record<string, unknown>; cases?: unknown[] } = {}) {
  const dataset = over.dataset ?? { id: 'ds1', organizationId: 'org1', name: 'DS', description: null, version: 1 };
  const prisma = {
    evaluationDataset: {
      create: vi.fn(async (args: { data: Record<string, unknown> }) => ({ ...dataset, ...args.data })),
      findFirst: vi.fn(async () => dataset),
      findMany: vi.fn(async () => [dataset]),
      update: vi.fn(async (args: { data: Record<string, unknown> }) => ({ ...dataset, ...args.data })),
    },
    evaluationCase: {
      findMany: vi.fn(async () => over.cases ?? []),
      createMany: vi.fn(async () => ({ count: 1 })),
      groupBy: vi.fn(async () => []),
      // 以下方法存在即视为违规（旧版本行绝不可被改动/删除）
      update: vi.fn(async () => { throw new Error('旧版本 case 行绝不可 update'); }),
      updateMany: vi.fn(async () => { throw new Error('旧版本 case 行绝不可 updateMany'); }),
      delete: vi.fn(async () => { throw new Error('旧版本 case 行绝不可 delete'); }),
      deleteMany: vi.fn(async () => { throw new Error('旧版本 case 行绝不可 deleteMany'); }),
    },
  };
  const service = new EvaluationDatasetsService(prisma as never);
  return { service, prisma, dataset };
}

describe('EvaluationDatasetsService.create', () => {
  it('建集即 version=1 并写入 case（版本与数据同批）', async () => {
    const { service, prisma } = makeHarness();
    await service.create('u1', 'org1', { name: 'DS', cases: [{ input: 'a' }, { input: 'b' }] });
    expect(prisma.evaluationDataset.create).toHaveBeenCalledWith({
      data: { organizationId: 'org1', userId: 'u1', name: 'DS', description: null, version: 1 },
    });
    const rows = ((prisma.evaluationCase.createMany.mock.calls[0] as unknown as [{ data: Array<{ version: number; datasetId: string }> }])[0]).data;
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.version === 1 && r.datasetId === 'ds1')).toBe(true);
  });

  it('无 case 时不写行（空数据集允许存在，但不可用于创建 run）', async () => {
    const { service, prisma } = makeHarness();
    await service.create('u1', 'org1', { name: 'DS' });
    expect(prisma.evaluationCase.createMany).not.toHaveBeenCalled();
  });
});

describe('EvaluationDatasetsService.replaceCases（copy-on-write）', () => {
  it('版本 +1、新行整批写入新版本；旧版本行绝不 update/delete', async () => {
    const { service, prisma } = makeHarness({ dataset: { id: 'ds1', organizationId: 'org1', version: 2 } });
    const out = await service.replaceCases('org1', 'ds1', [{ input: 'x' }, { input: 'y' }, { input: 'z' }]);
    expect(out).toEqual({ datasetId: 'ds1', version: 3, caseCount: 3 });
    expect(prisma.evaluationDataset.update).toHaveBeenCalledWith({ where: { id: 'ds1' }, data: { version: 3 } });
    const rows = ((prisma.evaluationCase.createMany.mock.calls[0] as unknown as [{ data: Array<{ version: number }> }])[0]).data;
    expect(rows.map((r) => r.version)).toEqual([3, 3, 3]);
    // 历史版本行只读：任何 update/delete 都是 bug（此处 mock 一旦被调用即抛错）
    expect(prisma.evaluationCase.update).not.toHaveBeenCalled();
    expect(prisma.evaluationCase.updateMany).not.toHaveBeenCalled();
    expect(prisma.evaluationCase.deleteMany).not.toHaveBeenCalled();
  });

  it('先 bump 版本再写行：即使写入失败，新版本号也不会与旧行混淆（版本是唯一事实）', async () => {
    const { service, prisma } = makeHarness({ dataset: { id: 'ds1', organizationId: 'org1', version: 1 } });
    (prisma.evaluationCase.createMany as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('db down'));
    await expect(service.replaceCases('org1', 'ds1', [{ input: 'x' }])).rejects.toThrow('db down');
    expect(prisma.evaluationDataset.update).toHaveBeenCalledWith({ where: { id: 'ds1' }, data: { version: 2 } });
  });

  it('跨组织/不存在 → 404（IDOR 防护）', async () => {
    const { service, prisma } = makeHarness();
    (prisma.evaluationDataset.findFirst as ReturnType<typeof vi.fn>).mockResolvedValueOnce(null);
    await expect(service.replaceCases('org-other', 'ds1', [{ input: 'x' }])).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(prisma.evaluationDataset.update).not.toHaveBeenCalled();
  });
});

describe('EvaluationDatasetsService 读路径', () => {
  it('get 只读**当前版本** case（历史版本不混入）', async () => {
    const { service, prisma } = makeHarness({ dataset: { id: 'ds1', organizationId: 'org1', version: 4 } });
    await service.get('org1', 'ds1');
    expect(prisma.evaluationCase.findMany).toHaveBeenCalledWith({
      where: { datasetId: 'ds1', version: 4 },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
  });

  it('casesOfVersion：按 run 锁定的 (datasetId, datasetVersion) 精确读取（可复现性入口）', async () => {
    const { service, prisma } = makeHarness();
    await service.casesOfVersion('ds1', 2);
    expect(prisma.evaluationCase.findMany).toHaveBeenCalledWith({
      where: { datasetId: 'ds1', version: 2 },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
  });

  it('updateMetadata 不 bump 版本（版本语义严格等于 case 集合）', async () => {
    const { service, prisma } = makeHarness({ dataset: { id: 'ds1', organizationId: 'org1', version: 5 } });
    await service.updateMetadata('org1', 'ds1', { name: '新名字' });
    expect(prisma.evaluationDataset.update).toHaveBeenCalledWith({ where: { id: 'ds1' }, data: { name: '新名字' } });
  });

  it('list：case 数量按当前版本统计（单次 groupBy，无 N+1）', async () => {
    const { service, prisma } = makeHarness();
    (prisma.evaluationDataset.findMany as ReturnType<typeof vi.fn>).mockImplementation(async (args: { include?: unknown }) => [
      { id: 'ds1', name: 'DS', description: null, version: 2, createdAt: new Date(0), updatedAt: new Date(0), ...(args?.include ? { _count: { cases: 9, runs: 3 } } : {}) },
    ]);
    (prisma.evaluationCase.groupBy as ReturnType<typeof vi.fn>).mockResolvedValue([{ datasetId: 'ds1', version: 2, _count: { _all: 4 } }]);
    const rows = await service.list('org1');
    expect(prisma.evaluationCase.groupBy).toHaveBeenCalledTimes(1);
    expect(rows[0]).toMatchObject({ id: 'ds1', version: 2, caseCount: 4, runCount: 3 });
  });

  it('versions：历史版本清单（version → case 数），供审计与可复现性核对', async () => {
    const { service, prisma } = makeHarness({ dataset: { id: 'ds1', organizationId: 'org1', version: 2 } });
    (prisma.evaluationCase.groupBy as ReturnType<typeof vi.fn>).mockResolvedValue([
      { version: 1, _count: { _all: 2 } }, { version: 2, _count: { _all: 5 } },
    ]);
    expect(await service.versions('org1', 'ds1')).toEqual({
      datasetId: 'ds1', currentVersion: 2,
      versions: [{ version: 1, caseCount: 2 }, { version: 2, caseCount: 5 }],
    });
  });
});
