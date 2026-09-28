import { Inject, Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AppError, ErrorCode } from '../../common/errors/app-error';
import { CaseInputDto, CreateDatasetDto } from './evaluation.dto';

/** 版本化 case 行的确定性读取顺序（createdAt 同刻时按 id 稳定排序——绝无随机序） */
const CASE_ORDER = [{ createdAt: 'asc' as const }, { id: 'asc' as const }];

/**
 * M9-P1 数据集 / 用例（服务层）：
 * - **版本化 copy-on-write**：case 变更 → dataset.version + 1，新行以新版本写入；
 *   旧版本行**永不删除/永不改动**（历史 run 锁定的 (datasetId, datasetVersion) 因此永远可复现）；
 * - 元数据（name/description）变更不 bump 版本（不改变评测事实）；
 * - 读路径一律以 organizationId 为作用域（防跨组织 IDOR；命中不到即 404）。
 */
@Injectable()
export class EvaluationDatasetsService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  async create(userId: string, organizationId: string, dto: CreateDatasetDto) {
    const dataset = await this.prisma.evaluationDataset.create({
      data: { organizationId, userId, name: dto.name, description: dto.description ?? null, version: 1 },
    });
    const cases = dto.cases ?? [];
    if (cases.length > 0) await this.insertCases(dataset.id, 1, cases);
    return this.get(organizationId, dataset.id);
  }

  async list(organizationId: string, limit = 50) {
    const rows = await this.prisma.evaluationDataset.findMany({
      where: { organizationId },
      orderBy: { createdAt: 'desc' },
      take: limit,
      include: { _count: { select: { cases: true, runs: true } } },
    });
    // case 数量按**当前版本**统计：单次 groupBy（_count.cases 含全部历史版本行，仅作粗看）
    const counts = rows.length === 0 ? [] : await this.prisma.evaluationCase.groupBy({
      by: ['datasetId', 'version'],
      where: { datasetId: { in: rows.map((r) => r.id) } },
      _count: { _all: true },
    });
    const byId = new Map(counts.map((c) => [`${c.datasetId}:${c.version}`, c._count._all]));
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      description: r.description,
      version: r.version,
      caseCount: byId.get(`${r.id}:${r.version}`) ?? 0,
      runCount: r._count.runs,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
    }));
  }

  /** 资源归属（控制器裁决用：不存在 → null；非成员 → 由调用方 404 防枚举） */
  async scope(id: string): Promise<{ id: string; organizationId: string } | null> {
    return this.prisma.evaluationDataset.findUnique({ where: { id }, select: { id: true, organizationId: true } });
  }

  async get(organizationId: string, id: string) {
    const dataset = await this.prisma.evaluationDataset.findFirst({ where: { id, organizationId } });
    if (!dataset) throw new AppError(ErrorCode.NOT_FOUND, '数据集不存在');
    const cases = await this.prisma.evaluationCase.findMany({
      where: { datasetId: id, version: dataset.version },
      orderBy: CASE_ORDER,
    });
    return { ...dataset, cases };
  }

  /** 仅元数据（不 bump 版本——版本语义严格等于「case 集合」） */
  async updateMetadata(organizationId: string, id: string, dto: { name?: string; description?: string | null }) {
    await this.requireDataset(organizationId, id);
    await this.prisma.evaluationDataset.update({
      where: { id },
      data: {
        ...(dto.name !== undefined ? { name: dto.name } : {}),
        ...(dto.description !== undefined ? { description: dto.description } : {}),
      },
    });
    return this.get(organizationId, id);
  }

  /**
   * 替换**当前版本**的全部 case（copy-on-write）：
   * 新版本 = 旧版本 + 1；新行整批写入；旧版本行原样保留（历史 run 不受影响）。
   * 返回新版本号与新的 case 列表。
   */
  async replaceCases(organizationId: string, id: string, cases: CaseInputDto[]) {
    const dataset = await this.requireDataset(organizationId, id);
    const nextVersion = dataset.version + 1;
    // 先 bump 版本（唯一事实）再写行：即使写入失败，version 已前进的旧版本 case 仍完整可读
    await this.prisma.evaluationDataset.update({ where: { id }, data: { version: nextVersion } });
    await this.insertCases(id, nextVersion, cases);
    return { datasetId: id, version: nextVersion, caseCount: cases.length };
  }

  /** 版本清单（版本 → case 数；历史版本行永不删除，评测可复现的依据） */
  async versions(organizationId: string, id: string) {
    const dataset = await this.requireDataset(organizationId, id);
    const grouped = await this.prisma.evaluationCase.groupBy({
      by: ['version'],
      where: { datasetId: id },
      _count: { _all: true },
      orderBy: { version: 'asc' },
    });
    return {
      datasetId: id,
      currentVersion: dataset.version,
      versions: grouped.map((g) => ({ version: g.version, caseCount: g._count._all })),
    };
  }

  /** run 创建时锁定 case 集合（按 (datasetId, datasetVersion) 精确读取） */
  async casesOfVersion(datasetId: string, version: number) {
    return this.prisma.evaluationCase.findMany({ where: { datasetId, version }, orderBy: CASE_ORDER });
  }

  private async requireDataset(organizationId: string, id: string) {
    const dataset = await this.prisma.evaluationDataset.findFirst({ where: { id, organizationId } });
    if (!dataset) throw new AppError(ErrorCode.NOT_FOUND, '数据集不存在');
    return dataset;
  }

  private async insertCases(datasetId: string, version: number, cases: CaseInputDto[]) {
    await this.prisma.evaluationCase.createMany({
      data: cases.map((c) => ({
        datasetId,
        version,
        input: c.input as never,
        expected: (c.expected ?? null) as never,
        tags: (c.tags ?? null) as never,
      })),
    });
  }
}
