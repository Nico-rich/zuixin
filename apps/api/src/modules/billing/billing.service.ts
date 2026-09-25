import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AppError, ErrorCode } from '../../common/errors/app-error';
import { OrganizationsService } from '../organizations/organizations.service';

export type LedgerKind =
  | 'llm_tokens' | 'llm_cost' | 'image_generation' | 'video_seconds'
  | 'external_api_call' | 'agent_run' | 'workflow_run' | 'storage' | 'seat';

export interface RecordUsageInput {
  userId: string;
  projectId?: string | null;
  kind: LedgerKind;
  quantity?: number;
  runId?: string;
  taskId?: string;
  toolCallId?: string;
  usageRecordId?: string;
  idempotencyKey: string;
  metadata?: Record<string, unknown>;
}

const DEFAULT_ENTITLEMENTS = {
  agentRunsMonthly: 100_000, agentRunsDaily: 50_000, concurrentAgentRuns: 50,
  workflowRunsMonthly: 100_000, workflowRunsDaily: 50_000, concurrentWorkflowRuns: 50,
  llmTokensMonthly: 1_000_000_000, imageMonthly: 1_000_000,
  videoSecondsMonthly: 1_000_000, externalApiMonthly: 1_000_000,
  storageMb: 100_000, seats: 100,
};

const PLANS = [
  { code: 'free', name: 'Free', monthlyPrice: 0, yearlyPrice: 0, entitlements: { ...DEFAULT_ENTITLEMENTS } },
  { code: 'pro', name: 'Pro', monthlyPrice: 99, yearlyPrice: 990, entitlements: { ...DEFAULT_ENTITLEMENTS, seats: 5, concurrentAgentRuns: 10 } },
  { code: 'team', name: 'Team', monthlyPrice: 499, yearlyPrice: 4990, entitlements: { ...DEFAULT_ENTITLEMENTS, seats: 20, concurrentAgentRuns: 40 } },
  { code: 'enterprise', name: 'Enterprise', monthlyPrice: 1999, yearlyPrice: 19990, entitlements: { ...DEFAULT_ENTITLEMENTS, seats: 200, concurrentAgentRuns: 200 } },
];

/**
 * M8-P2 Billing（计量统一入口；UsageRecord 仍是原始事实——ledger 只做组织级归集，绝不重复计费）：
 * - Plan/Subscription/Entitlement：每组织一订阅（缺省 free，宽限额保证存量行为不漂移）；
 * - UsageLedgerEntry：append-only + 幂等键唯一（同键绝不重复计量）+ period 月度归集；
 * - Invoice/PaymentEvent：MockBillingProvider 驱动；PaymentEvent (provider,eventId) 唯一幂等；
 * - 配额裁决在 QuotaService（LLM 绝不决定是否超额）。
 */
@Injectable()
export class BillingService implements OnModuleInit {
  private readonly logger = new Logger('Billing');

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(OrganizationsService) private readonly orgs: OrganizationsService,
  ) {}

  /** 种子计划（幂等 upsert） */
  async onModuleInit(): Promise<void> {
    for (const plan of PLANS) {
      await this.prisma.plan.upsert({
        where: { code: plan.code },
        create: { code: plan.code, name: plan.name, monthlyPrice: plan.monthlyPrice, yearlyPrice: plan.yearlyPrice, entitlements: plan.entitlements as never },
        update: { entitlements: plan.entitlements as never },
      }).catch(() => undefined);
    }
    this.logger.log('Billing 计划已就绪');
  }

  private periodOf(d = new Date()): string {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  }

  /** 每组织一订阅（缺省 free）；expired/cancelled → 免费额度语义 */
  async ensureSubscription(organizationId: string): Promise<{ planId: string; plan: string; entitlements: Record<string, number>; status: string }> {
    const existing = await this.prisma.subscription.findUnique({ where: { organizationId }, include: { plan: true } });
    if (existing) {
      const effective = existing.status === 'active' ? existing.plan : await this.prisma.plan.findUnique({ where: { code: 'free' } });
      return { planId: effective!.id, plan: effective!.code, entitlements: effective!.entitlements as Record<string, number>, status: existing.status };
    }
    const free = await this.prisma.plan.findUnique({ where: { code: 'free' } });
    const now = new Date();
    await this.prisma.subscription.create({
      data: {
        organizationId, planId: free!.id, status: 'active',
        currentPeriodStart: now, currentPeriodEnd: new Date(now.getTime() + 30 * 86400_000),
      },
    });
    return { planId: free!.id, plan: 'free', entitlements: free!.entitlements as Record<string, number>, status: 'active' };
  }

  /** 订阅组织归属（run 级计量入口）：项目组织 > 个人组织 */
  async organizationFor(userId: string, projectId?: string | null): Promise<string> {
    if (projectId) {
      const project = await this.prisma.project.findFirst({ where: { id: projectId }, select: { organizationId: true } });
      if (project?.organizationId) return project.organizationId;
    }
    return (await this.orgs.ensurePersonalOrganization(userId)).id;
  }

  /** 计量入账（append-only + 幂等键唯一——P2002 重复键绝不重复计量） */
  async recordUsage(input: RecordUsageInput): Promise<void> {
    const organizationId = await this.organizationFor(input.userId, input.projectId);
    try {
      await this.prisma.usageLedgerEntry.create({
        data: {
          organizationId, userId: input.userId, projectId: input.projectId ?? null,
          kind: input.kind, quantity: input.quantity ?? 1, unit: input.kind === 'llm_cost' ? 'cny' : 'count',
          runId: input.runId, taskId: input.taskId, toolCallId: input.toolCallId,
          usageRecordId: input.usageRecordId,
          idempotencyKey: input.idempotencyKey, period: this.periodOf(),
          metadata: (input.metadata ?? null) as never,
        },
      });
    } catch (err) {
      if ((err as { code?: string }).code === 'P2002') return; // 幂等：绝不重复计量
      this.logger.warn(`计量入账失败: ${(err as Error).message}`);
    }
  }

  /** 组织用量聚合（period 缺省当前月；分层：facts 原始 + derived 服务端计算） */
  async usage(organizationId: string, period?: string) {
    const entries = await this.prisma.usageLedgerEntry.findMany({
      where: { organizationId, period: period ?? this.periodOf() },
      select: { kind: true, quantity: true },
    });
    const facts: Record<string, number> = {};
    for (const e of entries) facts[e.kind] = (facts[e.kind] ?? 0) + e.quantity;
    return {
      organizationId, period: period ?? this.periodOf(),
      facts,
      derived: {
        totalUsageKinds: Object.keys(facts).length,
        llmCost: facts['llm_cost'] ?? 0,
      },
      layering: { facts: 'ledger-aggregate', derived: 'service-computed' },
    };
  }

  async subscribe(userId: string, organizationId: string, planId: string): Promise<Record<string, unknown>> {
    const plan = await this.prisma.plan.findUnique({ where: { id: planId } });
    if (!plan || !plan.active) throw new AppError(ErrorCode.NOT_FOUND, '计划不存在');
    const now = new Date();
    const subscription = await this.prisma.subscription.upsert({
      where: { organizationId },
      create: {
        organizationId, planId, status: 'active',
        currentPeriodStart: now, currentPeriodEnd: new Date(now.getTime() + 30 * 86400_000),
      },
      update: {
        planId, status: 'active', cancelledAt: null,
        currentPeriodStart: now, currentPeriodEnd: new Date(now.getTime() + 30 * 86400_000),
      },
      include: { plan: true },
    });
    // Mock 计费：开票 + 支付事件（provider,eventId 幂等）
    const invoice = await this.prisma.invoice.create({
      data: {
        organizationId, subscriptionId: subscription.id,
        number: `INV-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        status: 'open', amount: plan.monthlyPrice, currency: 'CNY',
        periodStart: now, periodEnd: new Date(now.getTime() + 30 * 86400_000),
      },
    });
    await this.applyPayment(organizationId, invoice.id, plan.monthlyPrice);
    this.logger.log({ organizationId, planCode: plan.code }, '订阅已生效');
    return {
      subscriptionId: subscription.id, plan: plan.code, status: 'active',
      invoice: { id: invoice.id, number: invoice.number, amount: plan.monthlyPrice, status: 'paid' },
      entitlements: plan.entitlements as Record<string, number>,
    };
  }

  /** 支付事件入账（Mock provider；provider+eventId 唯一 → 重复事件幂等） */
  async applyPayment(organizationId: string, invoiceId: string, amount: number): Promise<{ paymentEventId: string; duplicate: boolean }> {
    const eventId = `mock-pay-${invoiceId}-${amount}`;
    try {
      const event = await this.prisma.paymentEvent.create({
        data: { organizationId, provider: 'mock', providerEventId: eventId, type: 'payment.succeeded', amount, currency: 'CNY', invoiceId },
      });
      await this.prisma.invoice.update({ where: { id: invoiceId }, data: { status: 'paid', paidAt: new Date() } });
      return { paymentEventId: event.id, duplicate: false };
    } catch (err) {
      if ((err as { code?: string }).code === 'P2002') {
        // 重复支付事件：幂等返回（绝不重复入账）
        return { paymentEventId: eventId, duplicate: true };
      }
      throw err;
    }
  }

  async plans() {
    return this.prisma.plan.findMany({ where: { active: true }, orderBy: { monthlyPrice: 'asc' } });
  }

  async subscription(userId: string, organizationId: string) {
    const sub = await this.prisma.subscription.findUnique({ where: { organizationId }, include: { plan: true } });
    if (!sub) {
      const ensured = await this.ensureSubscription(organizationId);
      return { organizationId, plan: ensured.plan, status: ensured.status, entitlements: ensured.entitlements, currentPeriodEnd: null };
    }
    return { organizationId, plan: sub.plan.code, status: sub.status, entitlements: sub.plan.entitlements, currentPeriodEnd: sub.currentPeriodEnd };
  }

  async invoices(organizationId: string) {
    return this.prisma.invoice.findMany({ where: { organizationId }, orderBy: { createdAt: 'desc' }, take: 50 });
  }
}
