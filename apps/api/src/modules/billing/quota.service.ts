import { Inject, Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AppError, ErrorCode } from '../../common/errors/app-error';
import { BillingService, LedgerKind } from './billing.service';
import { OrganizationsService } from '../organizations/organizations.service';

/** 配额键 → entitlement 键映射 */
const ENTITLEMENT_KEY: Record<LedgerKind, string> = {
  llm_tokens: 'llmTokensMonthly', llm_cost: 'llmTokensMonthly',
  image_generation: 'imageMonthly', video_seconds: 'videoSecondsMonthly',
  external_api_call: 'externalApiMonthly', agent_run: 'agentRunsMonthly',
  workflow_run: 'workflowRunsMonthly', storage: 'storageMb', seat: 'seats',
};

const DAILY_KEY: Record<string, string> = {
  agent_run: 'agentRunsDaily', workflow_run: 'workflowRunsDaily',
};

/**
 * M8-P2 Quota（服务端裁决；LLM 绝不决定是否超额）：
 * - monthly：ledger 当月聚合 vs entitlement；daily：当日聚合 vs daily entitlement；
 * - concurrent：org 范围内活跃 run（queued/running/waiting）计数 vs concurrent entitlement；
 * - 超额 → QUOTA_EXCEEDED（429）；计划未定义配额（entitlement 缺失）→ 不限。
 */
@Injectable()
export class QuotaService {
  private readonly logger = new Logger('Quota');

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(BillingService) private readonly billing: BillingService,
    @Inject(OrganizationsService) private readonly orgs: OrganizationsService,
  ) {}

  private periodOf(d = new Date()): string {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  }

  /** 断言配额（超额抛 QUOTA_EXCEEDED；返回 consumed/total 供审计） */
  async assertQuota(userId: string, projectId: string | null | undefined, kind: LedgerKind, quantity = 1): Promise<{ organizationId: string; consumed: number; total: number }> {
    const organizationId = await this.billing.organizationFor(userId, projectId);
    const { entitlements } = await this.billing.ensureSubscription(organizationId);

    const key = ENTITLEMENT_KEY[kind];
    const monthlyLimit = entitlements[key];
    if (monthlyLimit != null) {
      const agg = await this.prisma.usageLedgerEntry.aggregate({
        where: { organizationId, period: this.periodOf(), kind },
        _sum: { quantity: true },
      });
      const consumed = agg._sum.quantity ?? 0;
      if (consumed + quantity > monthlyLimit) {
        throw new AppError(ErrorCode.QUOTA_EXCEEDED, `本月 ${kind} 配额已用尽（${consumed}/${monthlyLimit}）`);
      }
    }

    const dailyKey = DAILY_KEY[kind];
    const dailyLimit = dailyKey ? entitlements[dailyKey] : undefined;
    if (dailyLimit != null) {
      const dayStart = new Date(); dayStart.setHours(0, 0, 0, 0);
      const agg = await this.prisma.usageLedgerEntry.aggregate({
        where: { organizationId, kind, createdAt: { gte: dayStart } },
        _sum: { quantity: true },
      });
      const consumedDaily = agg._sum.quantity ?? 0;
      if (consumedDaily + quantity > dailyLimit) {
        throw new AppError(ErrorCode.QUOTA_EXCEEDED, `今日 ${kind} 配额已用尽（${consumedDaily}/${dailyLimit}）`);
      }
    }

    // concurrent：org 活跃 run 计数（agent/workflow 两域）
    if (kind === 'agent_run' && entitlements.concurrentAgentRuns != null) {
      const active = await this.countActiveAgentRuns(organizationId);
      if (active >= entitlements.concurrentAgentRuns) {
        throw new AppError(ErrorCode.QUOTA_EXCEEDED, `并发 AgentRun 配额已用尽（${active}/${entitlements.concurrentAgentRuns}）`);
      }
    }
    if (kind === 'workflow_run' && entitlements.concurrentWorkflowRuns != null) {
      const active = await this.prisma.workflowRun.count({
        where: {
          status: { in: ['queued', 'running', 'waiting'] },
          workflow: { organizationId },
        },
      });
      if (active >= entitlements.concurrentWorkflowRuns) {
        throw new AppError(ErrorCode.QUOTA_EXCEEDED, `并发 WorkflowRun 配额已用尽（${active}/${entitlements.concurrentWorkflowRuns}）`);
      }
    }
    return { organizationId, consumed: 0, total: monthlyLimit ?? 0 };
  }

  /** org 活跃 AgentRun：项目组织 = org 或 run 用户个人组织 = org */
  private async countActiveAgentRuns(organizationId: string): Promise<number> {
    const personalOwner = await this.prisma.organization.findFirst({
      where: { id: organizationId, isPersonal: true },
      select: { ownerUserId: true },
    });
    return this.prisma.agentRun.count({
      where: {
        status: { in: ['queued', 'running', 'waiting'] },
        OR: [
          { project: { organizationId } },
          ...(personalOwner ? [{ userId: personalOwner.ownerUserId, projectId: null }] : []),
        ],
      },
    });
  }
}
