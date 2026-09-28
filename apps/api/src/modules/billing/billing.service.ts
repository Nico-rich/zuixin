import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AppError, ErrorCode } from '../../common/errors/app-error';
import { OrganizationsService } from '../organizations/organizations.service';

export type LedgerKind =
  | 'llm_tokens' | 'llm_cost' | 'image_generation' | 'video_seconds'
  | 'external_api_call' | 'agent_run' | 'workflow_run' | 'storage' | 'seat'
  | 'attachment_upload'; // M10 W0 预置（P7 每用户附件配额——A7 消费，A10 不碰）

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
  /** Pre-M9 T1：调用方已知的组织归属（UsageRecord 镜像直传——绝不运行时重解析产生归属漂移） */
  organizationId?: string;
}

/**
 * Pre-M9 R1 价格目录（模型默认价，单位：LLM=CNY/百万 token；媒体=CNY/单张或 CNY/秒）。
 * 只在"三价格字段全为 0"的初始行上写入——后台改价后的行绝不覆盖。
 */
const PRICE_CATALOG: Record<string, { input?: number; output?: number; unit?: number }> = {
  'mock-echo': { input: 2, output: 6 },
  'mock-router-1': { input: 2, output: 6 },
  'qwen-turbo': { input: 2, output: 6 },
  'qwen-plus': { input: 4, output: 12 },
  'qwen-max': { input: 40, output: 120 },
  'mock-image-1': { unit: 0.15 },
  'gpt-image-1': { unit: 0.5 },
  'cogview-4': { unit: 0.15 },
  'wanx2.1-t2i-turbo': { unit: 0.2 },
  'mock-video-1': { unit: 0.05 },
  'wanx2.1-t2v-turbo': { unit: 0.3 },
};

const DEFAULT_ENTITLEMENTS = {
  agentRunsMonthly: 100_000, agentRunsDaily: 50_000, concurrentAgentRuns: 50,
  workflowRunsMonthly: 100_000, workflowRunsDaily: 50_000, concurrentWorkflowRuns: 50,
  llmTokensMonthly: 1_000_000_000, imageMonthly: 1_000_000,
  videoSecondsMonthly: 1_000_000, externalApiMonthly: 1_000_000,
  storageMb: 100_000, seats: 100,
  // M10 W0 预置（P7 附件配额；A7 消费）
  attachmentsMonthly: 100_000, attachmentsDaily: 5_000,
  // Pre-M9 A3：媒体日限并入计划权益（原 systemSetting 全局日限 50/10 语义保留为 free 默认）
  imageDaily: 50, videoDaily: 10,
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

  /** 种子计划（幂等 upsert）+ 模型初始价格目录（仅全零行；后台改价绝不覆盖） */
  async onModuleInit(): Promise<void> {
    for (const plan of PLANS) {
      await this.prisma.plan.upsert({
        where: { code: plan.code },
        create: { code: plan.code, name: plan.name, monthlyPrice: plan.monthlyPrice, yearlyPrice: plan.yearlyPrice, entitlements: plan.entitlements as never },
        update: { entitlements: plan.entitlements as never },
      }).catch(() => undefined);
    }
    for (const [apiModelId, price] of Object.entries(PRICE_CATALOG)) {
      await this.prisma.model.updateMany({
        where: { apiModelId, inputPrice: 0, outputPrice: 0, unitPrice: 0 },
        data: {
          ...(price.input != null ? { inputPrice: price.input } : {}),
          ...(price.output != null ? { outputPrice: price.output } : {}),
          ...(price.unit != null ? { unitPrice: price.unit } : {}),
        },
      }).catch(() => undefined);
    }
    this.logger.log('Billing 计划与价格目录已就绪');
  }

  /** Pre-M9 A4：period 统一 UTC 基准（与 Analytics 一致——绝不本地时区漂移） */
  private periodOf(d = new Date()): string {
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
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
    try {
      await this.prisma.subscription.create({
        data: {
          organizationId, planId: free!.id, status: 'active',
          currentPeriodStart: now, currentPeriodEnd: new Date(now.getTime() + 30 * 86400_000),
        },
      });
    } catch (err) {
      // Pre-M9 测试补强（多实例 e2e 实抓）：并发懒创建竞态——唯一键 P2002 → 复用赢家行（同 ensurePersonalOrganization 模式）
      if ((err as { code?: string }).code === 'P2002') {
        const won = await this.prisma.subscription.findUnique({ where: { organizationId }, include: { plan: true } });
        if (won) {
          return { planId: won.planId, plan: won.plan.code, entitlements: won.plan.entitlements as Record<string, number>, status: won.status };
        }
      }
      throw err;
    }
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

  /** 计量入账（append-only + 幂等键唯一——P2002 重复键绝不重复计量；organizationId 已解析时直传）。
   *  opts.strict：非 P2002 失败**上抛**（调用方必须感知"无账单事实"并选择重试/回滚）——
   *  M10 Final Audit H3：附件上传属 ledger-only kind（无 UsageRecord 兜底），写失败时静默吞账本
   *  会让"对象已入库、预留已释放、无任何账单事实"结构性不可发现。 */
  async recordUsage(input: RecordUsageInput, opts?: { strict?: boolean }): Promise<void> {
    const organizationId = input.organizationId ?? await this.organizationFor(input.userId, input.projectId);
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
      if (opts?.strict) throw err;
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

  /**
   * 支付事件入账（Mock provider；provider+eventId 唯一 → 重复事件幂等）。
   *
   * Pre-M9 G8：支付事件与发票终态**必须同生同死**。原实现是两次独立写：
   * ①崩在两次写之间（或发票更新失败）→ 事件已入账而发票永远停在 open（用户已付款却显示欠费，
   *   且重投的 P2002 分支只返回 duplicate、**从不补齐发票** → 漂移永久化）；
   * ②事务化后：事件写入与发票 paid 原子提交；任一失败整体回滚（事件不落库，重试可重入）。
   * 重复投递（P2002：并发双投 / 崩溃后重放 / provider 重复回调）→ 幂等返回，并**幂等补齐**发票终态
   * （只动 open 行，绝不覆盖 void/draft 等其它状态）。
   */
  async applyPayment(organizationId: string, invoiceId: string, amount: number): Promise<{ paymentEventId: string; duplicate: boolean }> {
    const eventId = `mock-pay-${invoiceId}-${amount}`;
    const paidAt = new Date();
    try {
      const event = await this.prisma.$transaction(async (tx) => {
        const created = await tx.paymentEvent.create({
          data: { organizationId, provider: 'mock', providerEventId: eventId, type: 'payment.succeeded', amount, currency: 'CNY', invoiceId },
        });
        const paid = await tx.invoice.updateMany({ where: { id: invoiceId, status: 'open' }, data: { status: 'paid', paidAt } });
        // 发票不存在/非 open：整体回滚（绝不留"已收款但无发票终态"的事件）
        if (paid.count === 0) throw new AppError(ErrorCode.NOT_FOUND, `发票不可支付（不存在或非 open）: ${invoiceId}`);
        return created;
      });
      return { paymentEventId: event.id, duplicate: false };
    } catch (err) {
      if ((err as { code?: string }).code !== 'P2002') throw err;
      // 重复支付事件：绝不重复入账，但必须把发票补齐（幂等：只动 open 行）
      const existing = await this.prisma.paymentEvent
        .findUnique({ where: { provider_providerEventId: { provider: 'mock', providerEventId: eventId } } })
        .catch(() => null);
      await this.prisma.invoice.updateMany({ where: { id: invoiceId, status: 'open' }, data: { status: 'paid', paidAt } })
        .catch((e) => this.logger.warn({ invoiceId, err: (e as Error).message }, '支付事件已入账但发票补齐失败（重试/对账可修复）'));
      this.logger.warn({ invoiceId, eventId }, '支付事件重复投递：幂等返回并补齐发票终态');
      return { paymentEventId: existing?.id ?? eventId, duplicate: true };
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
