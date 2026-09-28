import { Inject, Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AppError, ErrorCode } from '../../common/errors/app-error';
import { validateEvaluatorConfig } from './evaluators/evaluator-registry';
import { CreateEvaluatorDto } from './evaluation.dto';

/**
 * M9-P1 评测器 CRUD（服务层）：
 * - config 一律经注册表 validate（非法配置绝不入库——避免运行期"看似评测实则未评"）；
 * - 类型不可变（update 只改 name/config；type 改动 = 换评测语义 → 请新建评测器，历史结果因此始终可解释）；
 * - 删除受保护：已被 EvaluationResult 引用 → 拒绝（EvaluationResult 是只读事实，级联删除会销毁历史）。
 */
@Injectable()
export class EvaluationEvaluatorsService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  async create(userId: string, organizationId: string, dto: CreateEvaluatorDto) {
    validateEvaluatorConfig(dto.type, dto.config);
    return this.prisma.evaluator.create({
      data: { organizationId, userId, name: dto.name, type: dto.type, config: dto.config as never },
    });
  }

  async list(organizationId: string) {
    return this.prisma.evaluator.findMany({ where: { organizationId }, orderBy: { createdAt: 'desc' } });
  }

  /** 资源归属（控制器裁决用） */
  async scope(id: string): Promise<{ id: string; organizationId: string } | null> {
    return this.prisma.evaluator.findUnique({ where: { id }, select: { id: true, organizationId: true } });
  }

  async get(organizationId: string, id: string) {
    const row = await this.prisma.evaluator.findFirst({ where: { id, organizationId } });
    if (!row) throw new AppError(ErrorCode.NOT_FOUND, '评测器不存在');
    return row;
  }

  /** run 创建时的绑定解析：全部 id 必须属于该组织（任一不明 → 404 防跨组织引用） */
  async requireByIds(organizationId: string, ids: string[]): Promise<Array<{ id: string; name: string; type: string; config: unknown }>> {
    if (ids.length === 0) return [];
    const rows = await this.prisma.evaluator.findMany({
      where: { id: { in: ids }, organizationId },
      select: { id: true, name: true, type: true, config: true },
    });
    if (rows.length !== new Set(ids).size) throw new AppError(ErrorCode.NOT_FOUND, '评测器不存在或不属于该组织');
    return rows;
  }

  async update(organizationId: string, id: string, dto: { name?: string; config?: Record<string, unknown> }) {
    const existing = await this.get(organizationId, id);
    if (dto.config !== undefined) validateEvaluatorConfig(existing.type, dto.config);
    return this.prisma.evaluator.update({
      where: { id },
      data: {
        ...(dto.name !== undefined ? { name: dto.name } : {}),
        ...(dto.config !== undefined ? { config: dto.config as never } : {}),
      },
    });
  }

  /** 删除（仅当无任何结果引用——历史事实不可销毁） */
  async remove(organizationId: string, id: string) {
    await this.get(organizationId, id);
    const used = await this.prisma.evaluationResult.count({ where: { evaluatorId: id } });
    if (used > 0) {
      throw new AppError(ErrorCode.VALIDATION_ERROR, `该评测器已被 ${used} 条评测结果引用，不可删除（历史事实只读）`);
    }
    await this.prisma.evaluator.delete({ where: { id } });
    return { id, deleted: true };
  }
}
