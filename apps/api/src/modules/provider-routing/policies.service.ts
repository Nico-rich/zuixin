import { Inject, Injectable, Logger } from '@nestjs/common';
import { Prisma, ProviderPolicy } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { OrganizationsService } from '../organizations/organizations.service';
import { AppError, ErrorCode } from '../../common/errors/app-error';

/** 策略操作者（来自 JWT：userId + 平台角色） */
export interface PolicyActor { userId: string; role?: string }

export interface UpsertPolicyInput {
  organizationId?: string | null;
  providerId: string;
  allow?: boolean;
  priority?: number;
  costCeilingPerRequest?: number | null;
  costCeilingMonthly?: number | null;
  dataPolicy?: Record<string, unknown> | null;
  enabled?: boolean;
}

/**
 * M8-P7 组织 Provider 策略（allow/deny + 优先级 + 成本上限 + 数据政策）。
 *
 * 权限：组织级策略 = `member.write`（owner/admin——组织管理者，与 member.write 语义一致：
 * 策略能影响成本与数据流向，普通 member 不可改）；平台级策略（organizationId=null，作用于
 * 无组织上下文的调用）= 平台管理员（JWT role=admin）。读 = `organization.read`（成员可读）。
 * deny 是硬剔除：组织禁止的 provider 绝不承载该组织的数据（route() 里 reasonCode=policy_deny）。
 */
@Injectable()
export class ProviderPoliciesService {
  private readonly logger = new Logger('ProviderPolicies');

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(OrganizationsService) private readonly orgs: OrganizationsService,
  ) {}

  async upsert(actor: PolicyActor, input: UpsertPolicyInput): Promise<ProviderPolicy> {
    const organizationId = input.organizationId ?? null;
    if (organizationId) await this.orgs.requirePermission(actor.userId, organizationId, 'member.write');
    else this.requirePlatformAdmin(actor);

    const provider = await this.prisma.provider.findUnique({ where: { id: input.providerId }, select: { id: true } });
    if (!provider) throw new AppError(ErrorCode.NOT_FOUND, `provider 不存在：${input.providerId}`);
    this.assertNonNegative(input.costCeilingPerRequest, 'costCeilingPerRequest');
    this.assertNonNegative(input.costCeilingMonthly, 'costCeilingMonthly');
    this.assertNonNegative(input.priority, 'priority');

    const data = {
      allow: input.allow ?? true,
      priority: input.priority ?? 100,
      costCeilingPerRequest: input.costCeilingPerRequest ?? null,
      costCeilingMonthly: input.costCeilingMonthly ?? null,
      dataPolicy: (input.dataPolicy ?? null) as Prisma.InputJsonValue,
      enabled: input.enabled ?? true,
    };

    const existing = await this.findExisting(organizationId, input.providerId);
    if (existing) return this.prisma.providerPolicy.update({ where: { id: existing.id }, data });
    try {
      return await this.prisma.providerPolicy.create({
        data: { organizationId, providerId: input.providerId, ...data },
      });
    } catch (err) {
      // 并发 upsert 撞唯一键 → 复用已写入行（幂等）
      if ((err as { code?: string }).code === 'P2002') {
        const won = await this.findExisting(organizationId, input.providerId);
        if (won) return this.prisma.providerPolicy.update({ where: { id: won.id }, data });
      }
      throw err;
    }
  }

  /** 组织级策略清单（缺省 organizationId 时由 controller 传个人组织 id） */
  async list(actor: PolicyActor, organizationId: string): Promise<ProviderPolicy[]> {
    await this.orgs.requirePermission(actor.userId, organizationId, 'organization.read');
    return this.listByScope(organizationId);
  }

  /** 平台级策略清单（organizationId=null；仅平台管理员） */
  async listPlatform(actor: PolicyActor): Promise<ProviderPolicy[]> {
    this.requirePlatformAdmin(actor);
    return this.listByScope(null);
  }

  private listByScope(organizationId: string | null): Promise<ProviderPolicy[]> {
    return this.prisma.providerPolicy.findMany({
      where: { organizationId },
      orderBy: [{ priority: 'asc' }, { providerId: 'asc' }],
    });
  }

  /** 平台级：ProviderPolicy.organizationId 可空 → 复合唯一键含 null，findUnique 不可用，用 findFirst */
  private findExisting(organizationId: string | null, providerId: string): Promise<ProviderPolicy | null> {
    return this.prisma.providerPolicy.findFirst({ where: { organizationId, providerId } });
  }

  private requirePlatformAdmin(actor: PolicyActor): void {
    if (actor.role !== 'admin') throw new AppError(ErrorCode.FORBIDDEN, '平台级策略仅管理员可操作');
  }

  private assertNonNegative(value: number | null | undefined, field: string): void {
    if (value == null) return;
    if (!Number.isFinite(value) || value < 0) throw new AppError(ErrorCode.VALIDATION_ERROR, `${field} 必须为非负数`);
  }
}
