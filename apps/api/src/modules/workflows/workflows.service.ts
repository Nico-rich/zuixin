import { Inject, Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AppError, ErrorCode } from '../../common/errors/app-error';
import { WorkflowDefinition, validateDefinition } from './workflow-types';
import { WorkflowTriggersService } from './workflow-triggers.service';

/**
 * M7-P6 Workflow 读写（版本不可变：编辑 = 新版本；Run 锁定 versionId）：
 * - create：v1(draft) + 定义校验（跳转目标/必填字段）；
 * - update：最新 draft 未发布 → 原版本修改；已发布 → 新版本（version+1，draft）；
 * - publish：最新版本定义校验 → published（workflow.status=published）；触发器随发布注册（webhook/schedule/event）；
 * - archive：终态归档（runs 仍可读）。
 */
@Injectable()
export class WorkflowsService {
  private readonly logger = new Logger('Workflows');

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(WorkflowTriggersService) private readonly triggers: WorkflowTriggersService,
  ) {}

  private requireDefinition(def: unknown): WorkflowDefinition {
    const d = (def ?? {}) as WorkflowDefinition;
    const err = validateDefinition(d);
    if (err) throw new AppError(ErrorCode.VALIDATION_ERROR, err);
    return d;
  }

  private async requireOwned(userId: string, id: string) {
    const w = await this.prisma.workflow.findFirst({
      where: { id, userId },
      include: { versions: { orderBy: { version: 'desc' } } },
    });
    if (!w) throw new AppError(ErrorCode.NOT_FOUND, '工作流不存在');
    return w;
  }

  async list(userId: string) {
    return this.prisma.workflow.findMany({
      where: { userId },
      orderBy: { updatedAt: 'desc' },
      include: {
        versions: { orderBy: { version: 'desc' }, take: 1, select: { id: true, version: true, status: true } },
        _count: { select: { runs: true } },
      },
    });
  }

  async get(userId: string, id: string) {
    const w = await this.requireOwned(userId, id);
    return w;
  }

  async create(userId: string, input: { name: string; description?: string; projectId?: string | null; definition: WorkflowDefinition }) {
    const definition = this.requireDefinition(input.definition);
    if (input.projectId) {
      const p = await this.prisma.project.findFirst({ where: { id: input.projectId, userId, deletedAt: null } });
      if (!p) throw new AppError(ErrorCode.NOT_FOUND, '项目不存在');
    }
    const w = await this.prisma.workflow.create({
      data: {
        userId, projectId: input.projectId ?? null, name: input.name, description: input.description,
        versions: { create: { version: 1, status: 'draft', definition: definition as never } },
      },
      include: { versions: true },
    });
    return w;
  }

  /** 编辑：最新版本未发布 → 原版本覆盖（draft 可改）；已发布 → 新版本（不可变历史保留） */
  async update(userId: string, id: string, input: { name?: string; description?: string; definition?: WorkflowDefinition }) {
    const w = await this.requireOwned(userId, id);
    const definition = input.definition ? this.requireDefinition(input.definition) : undefined;
    const latest = w.versions[0];
    if (latest && latest.status === 'draft' && definition) {
      await this.prisma.workflowVersion.update({
        where: { id: latest.id },
        data: { definition: definition as never },
      });
    } else if (definition) {
      await this.prisma.workflowVersion.create({
        data: { workflowId: id, version: (latest?.version ?? 0) + 1, status: 'draft', definition: definition as never },
      });
    }
    return this.prisma.workflow.update({
      where: { id },
      data: {
        ...(input.name ? { name: input.name } : {}),
        ...(input.description !== undefined ? { description: input.description } : {}),
      },
      include: { versions: { orderBy: { version: 'desc' } } },
    });
  }

  /** 发布：最新 draft 版本 → published（先定义校验）；触发器随发布生效（webhook 凭据/schedule/event） */
  async publish(userId: string, id: string) {
    const w = await this.requireOwned(userId, id);
    const latest = w.versions[0];
    if (!latest) throw new AppError(ErrorCode.WORKFLOW_NOT_PUBLISHED, '工作流尚无版本');
    const definition = this.requireDefinition(latest.definition);
    await this.prisma.workflowVersion.update({
      where: { id: latest.id },
      data: { status: 'published', definition: definition as never },
    });
    await this.prisma.workflow.update({ where: { id }, data: { status: 'published' } });
    // 触发器注册（webhook 凭据 secret 仅此响应返回一次；后续发布 secret=null）
    const { webhook } = await this.triggers.registerTriggers(id, definition);
    this.logger.log({ workflowId: id, version: latest.version }, '工作流已发布');
    const fresh = await this.requireOwned(userId, id);
    return { ...fresh, triggerInfo: { webhook } };
  }

  async archive(userId: string, id: string) {
    const w = await this.requireOwned(userId, id);
    if (w.status === 'archived') return w;
    const latest = w.versions.find((v) => v.status === 'published') ?? w.versions[0];
    if (latest) {
      await this.triggers.unregisterTriggers(id, (latest.definition ?? { triggers: [], steps: [] }) as unknown as WorkflowDefinition);
    }
    await this.prisma.workflow.update({ where: { id }, data: { status: 'archived' } });
    this.logger.log({ workflowId: id }, '工作流已归档');
    return this.requireOwned(userId, id);
  }

  async remove(userId: string, id: string) {
    const w = await this.requireOwned(userId, id);
    await this.prisma.workflow.delete({ where: { id: w.id } });
    return { deleted: true };
  }
}
