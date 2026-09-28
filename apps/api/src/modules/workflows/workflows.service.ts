import { Inject, Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AppError, ErrorCode } from '../../common/errors/app-error';
import { WorkflowDefinition, validateDefinition } from './workflow-types';
import { WorkflowTriggersService } from './workflow-triggers.service';
import { OrganizationsService } from '../organizations/organizations.service';

/**
 * M7-P6 Workflow 读写（版本不可变：编辑 = 新版本；Run 锁定 versionId）：
 * - create：v1(draft) + 定义校验（跳转目标/必填字段）；
 * - update：最新 draft 未发布 → 原版本修改；已发布 → 新版本（version+1，draft）；
 * - publish：最新版本定义校验 → published（workflow.status=published）；触发器随发布注册（webhook/schedule/event）；
 * - archive：终态归档（runs 仍可读）。
 *
 * Pre-M9 权限修复：读路径 = requireOwned（本人或组织成员可见，viewer 可读）；写路径 = requireWritable
 * （组织内再按 workflow.write 裁决——与 Project RBAC 语义一致：member 起可写、viewer 403）。
 */
@Injectable()
export class WorkflowsService {
  private readonly logger = new Logger('Workflows');

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(WorkflowTriggersService) private readonly triggers: WorkflowTriggersService,
    @Inject(OrganizationsService) private readonly orgs: OrganizationsService,
  ) {}

  private requireDefinition(def: unknown): WorkflowDefinition {
    const d = (def ?? {}) as WorkflowDefinition;
    const err = validateDefinition(d);
    if (err) throw new AppError(ErrorCode.VALIDATION_ERROR, err);
    return d;
  }

  private async requireOwned(userId: string, id: string) {
    // M8-P1：本人或所属组织成员可见（跨组织 404 防枚举）
    const w = await this.prisma.workflow.findFirst({
      where: {
        id,
        OR: [
          { userId },
          { organization: { deletedAt: null, members: { some: { userId } } } },
        ],
      },
      include: { versions: { orderBy: { version: 'desc' } } },
    });
    if (!w) throw new AppError(ErrorCode.NOT_FOUND, '工作流不存在');
    return w;
  }

  /**
   * 写路径校验（Pre-M9 修复）：requireOwned 只保证"可见"——viewer 也是组织成员，写操作必须再按
   * workflow.write 裁决（语义与 Project RBAC 一致：member 起可写、viewer 403）。
   * 顺序：先归属（不存在/跨组织 → 404 反枚举），再组织角色（组织内角色不足 → 403），最后才落操作。
   */
  private async requireWritable(userId: string, id: string) {
    const w = await this.requireOwned(userId, id);
    if (w.organizationId) {
      await this.orgs.requirePermission(userId, w.organizationId, 'workflow.write');
    } else if (w.userId !== userId) {
      // 无组织归属的历史行（M8-P1 之前的个人流程）：仅创建者本人可写，其余一律 404 反枚举
      throw new AppError(ErrorCode.NOT_FOUND, '工作流不存在');
    }
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

  async create(userId: string, input: { name: string; description?: string; projectId?: string | null; organizationId?: string | null; definition: WorkflowDefinition }) {
    const definition = this.requireDefinition(input.definition);
    let projectOrgId: string | null = null;
    if (input.projectId) {
      const p = await this.prisma.project.findFirst({ where: { id: input.projectId, userId, deletedAt: null } });
      if (!p) throw new AppError(ErrorCode.NOT_FOUND, '项目不存在');
      projectOrgId = p.organizationId;
    }
    // M8-P1：工作流挂组织（显式组织需权限校验；缺省 = 项目组织或个人组织）
    let organizationId: string;
    if (input.organizationId) {
      organizationId = input.organizationId;
    } else if (projectOrgId) {
      organizationId = projectOrgId;
    } else {
      organizationId = (await this.orgs.ensurePersonalOrganization(userId)).id;
    }
    // Pre-M9 修复：创建也是写操作 → 一律按 workflow.write 裁决（viewer 是成员但不可写 → 403；
    // 个人组织恒为 owner；requireMembership 不足以拦住 viewer）
    await this.orgs.requirePermission(userId, organizationId, 'workflow.write');
    const w = await this.prisma.workflow.create({
      data: {
        userId, organizationId, projectId: input.projectId ?? null, name: input.name, description: input.description,
        versions: { create: { version: 1, status: 'draft', definition: definition as never } },
      },
      include: { versions: true },
    });
    return w;
  }

  /** 编辑：最新版本未发布 → 原版本覆盖（draft 可改）；已发布 → 新版本（不可变历史保留） */
  async update(userId: string, id: string, input: { name?: string; description?: string; definition?: WorkflowDefinition }) {
    const w = await this.requireWritable(userId, id);
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
    const w = await this.requireWritable(userId, id);
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
    const w = await this.requireWritable(userId, id);
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
    const w = await this.requireWritable(userId, id);
    await this.prisma.workflow.delete({ where: { id: w.id } });
    return { deleted: true };
  }

  /**
   * M10-P5 SA-18：webhook secret 轮换（**RBAC = org owner/admin**，比 workflow.write 更严）。
   * 顺序：先 requireWritable（归属 404 反枚举 + 组织写权限 403）→ 再组织角色（member/admin 之外一律 403）；
   * 无组织归属的历史个人流程行 → 仅创建者本人可达（与 requireWritable 同一兜底）。
   * 返回值中的 secret 明文**仅此一次**（DB 只存密文信封；见 WorkflowTriggersService.rotateWebhook）。
   */
  async rotateWebhookSecret(userId: string, id: string) {
    const w = await this.requireWritable(userId, id);
    if (w.organizationId) {
      const role = await this.orgs.requireMembership(userId, w.organizationId);
      if (role !== 'owner' && role !== 'admin') {
        throw new AppError(ErrorCode.FORBIDDEN, 'webhook 密钥轮换需要组织所有者或管理员权限');
      }
    }
    return this.triggers.rotateWebhook(id, userId);
  }
}
