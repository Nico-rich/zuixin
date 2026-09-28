import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { PrismaService } from '../prisma/prisma.service';
import { AppError, ErrorCode } from '../../common/errors/app-error';
import { BillingService, LedgerKind } from './billing.service';
import { OrganizationsService } from '../organizations/organizations.service';
import { AGENT_RUN_QUEUE } from '../../core/queue/queue.module';

/** M8-P9 背压水位（与 HealthService 的 queue.maxDepth 同源同默认值——同一环境变量） */
const DEFAULT_QUEUE_MAX_DEPTH = 1_000;

/** Pre-M9 C1：预留 TTL（终态释放丢失时兜底自愈；期间保守多计，绝不漏计） */
const RESERVATION_TTL_MS = 60 * 60_000;

function queueMaxDepth(): number {
  const n = Number(process.env.AGENT_RUN_QUEUE_MAX_DEPTH);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_QUEUE_MAX_DEPTH;
}

/** 配额键 → entitlement 键映射（llm_cost 是派生成本，绝不按 token 配额裁决——故不在映射中） */
const ENTITLEMENT_KEY: Partial<Record<LedgerKind, string>> = {
  llm_tokens: 'llmTokensMonthly',
  image_generation: 'imageMonthly', video_seconds: 'videoSecondsMonthly',
  external_api_call: 'externalApiMonthly', agent_run: 'agentRunsMonthly',
  workflow_run: 'workflowRunsMonthly', storage: 'storageMb', seat: 'seats',
  attachment_upload: 'attachmentsMonthly', // M10 W0 预置（P7）
};

const DAILY_KEY: Record<string, string> = {
  agent_run: 'agentRunsDaily', workflow_run: 'workflowRunsDaily',
  // Pre-M9 A3：媒体日限读计划权益（imageDaily/videoDaily——套餐升级即放宽）
  image_generation: 'imageDaily', video_seconds: 'videoDaily',
  attachment_upload: 'attachmentsDaily', // M10 W0 预置（P7）
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
    // M8-P9 背压：复用进程内 agent-run 队列连接读深度计数（@Optional：未装配 QueueModule 的
    // 单测/子模块自动降级为"不检查"，绝不因缺 provider 启动失败）
    @Optional() @InjectQueue(AGENT_RUN_QUEUE) private readonly agentRunQueue?: Queue,
  ) {}

  /** Pre-M9 A4：UTC 基准（与 Billing/Analytics 一致） */
  private periodOf(d = new Date()): string {
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
  }

  private dayOf(d = new Date()): string {
    return d.toISOString().slice(0, 10);
  }

  /** 断言配额（超额抛 QUOTA_EXCEEDED；返回 consumed/total 供审计）。
   *  Pre-M9 C1：refId 给定时**先预留、后计数、超限回滚**——并发断言各自先落预留行（唯一键
   *  org+kind+refId），随后计数把全部并发预留纳入消耗（同瞬并发也精确准入）；
   *  终态必须 release（TTL 1h 兜底自愈）。 */
  async assertQuota(userId: string, projectId: string | null | undefined, kind: LedgerKind, quantity = 1, refId?: string): Promise<{ organizationId: string; consumed: number; total: number; reservationId: string | null }> {
    // M8-P9 背压先于一切：队列积压已超水位时直接拒绝（最便宜的检查；
    // per-org 并发配额（下方）管"单个租户别占满"，全局队列深度管"整个系统别再收了"）
    if (kind === 'agent_run') await this.assertQueueDepth();
    const organizationId = await this.billing.organizationFor(userId, projectId);
    const { entitlements } = await this.billing.ensureSubscription(organizationId);

    // C1：预留先行（本行立即计入下方计数——并发请求的预留互相可见，准入精确）
    let reservationId: string | null = null;
    if (refId) {
      reservationId = (await this.reserve(organizationId, kind, quantity, refId)).id;
    }

    const key = ENTITLEMENT_KEY[kind];
    const monthlyLimit = key ? entitlements[key] : undefined;
    try {
      // 预留先行时自己的行已计入 openReservations；无预留的调用按 quantity 补计（off-by-one 修正）
      const ownQuantity = reservationId ? 0 : quantity;
      if (monthlyLimit != null) {
        const [agg, reserved] = await Promise.all([
          this.prisma.usageLedgerEntry.aggregate({
            where: { organizationId, period: this.periodOf(), kind },
            _sum: { quantity: true },
          }),
          this.openReservations(organizationId, kind, this.periodOf()),
        ]);
        const consumed = (agg._sum.quantity ?? 0) + reserved;
        if (consumed + ownQuantity > monthlyLimit) {
          throw new AppError(ErrorCode.QUOTA_EXCEEDED, `本月 ${kind} 配额已用尽（${consumed}/${monthlyLimit}）`);
        }
      }

      const dailyKey = DAILY_KEY[kind];
      const dailyLimit = dailyKey ? entitlements[dailyKey] : undefined;
      if (dailyLimit != null) {
        const dayStart = new Date(); dayStart.setHours(0, 0, 0, 0);
        const [agg, reservedDaily] = await Promise.all([
          this.prisma.usageLedgerEntry.aggregate({
            where: { organizationId, kind, createdAt: { gte: dayStart } },
            _sum: { quantity: true },
          }),
          this.openReservations(organizationId, kind, this.dayOf()),
        ]);
        const consumedDaily = (agg._sum.quantity ?? 0) + reservedDaily;
        if (consumedDaily + ownQuantity > dailyLimit) {
          throw new AppError(ErrorCode.QUOTA_EXCEEDED, `今日 ${kind} 配额已用尽（${consumedDaily}/${dailyLimit}）`);
        }
      }
    } catch (err) {
      // 超限 → 回滚自己的预留行（绝不残留占用）；并发输家各自回滚，赢家行保留
      if (reservationId) {
        await this.prisma.quotaReservation.deleteMany({ where: { id: reservationId } }).catch(() => undefined);
      }
      throw err;
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
    return { organizationId, consumed: 0, total: monthlyLimit ?? 0, reservationId };
  }

  /** 释放预留（run/message 终态调用；幂等——行不存在不报错） */
  async release(refId: string, kind: LedgerKind): Promise<void> {
    await this.prisma.quotaReservation.deleteMany({ where: { refId, kind } }).catch(() => undefined);
  }

  /** 未过期预留量（period 传月 key 或日 key；expiresAt > now 才计入——TTL 兜底自愈） */
  private async openReservations(organizationId: string, kind: LedgerKind, periodOrDay: string): Promise<number> {
    const agg = await this.prisma.quotaReservation.aggregate({
      where: {
        organizationId, kind, expiresAt: { gt: new Date() },
        OR: [{ period: periodOrDay }, { day: periodOrDay }],
      },
      _sum: { quantity: true },
    });
    return agg._sum.quantity ?? 0;
  }

  /** 创建预留行（UNIQUE(org,kind,refId)；并发同键 P2002 → 复用） */
  private async reserve(organizationId: string, kind: LedgerKind, quantity: number, refId: string): Promise<{ id: string }> {
    const now = new Date();
    try {
      return await this.prisma.quotaReservation.create({
        data: {
          organizationId, kind, quantity, refId,
          period: this.periodOf(now), day: this.dayOf(now),
          expiresAt: new Date(now.getTime() + RESERVATION_TTL_MS),
        },
      });
    } catch (err) {
      if ((err as { code?: string }).code === 'P2002') {
        const won = await this.prisma.quotaReservation.findUnique({
          where: { organizationId_kind_refId: { organizationId, kind, refId } },
        });
        if (won) return won;
      }
      throw err;
    }
  }

  /**
   * M8-P9 背压：全局执行队列深度（waiting + active）≥ 水位 → 429 QUOTA_EXCEEDED。
   *
   * 与 per-org 并发配额互补：并发配额防止**单个租户**占满 worker，本检查防止**所有租户合计**
   * 把队列堆到不可恢复（积压越深，恢复时间越长，且 BullMQ 的 job 保留/重试会放大内存占用）。
   *
   * 绝不误拒（fail-open）：队列未装配 / Redis 不可达 / 探测超时 → 放行并 warn。
   * 理由：拒绝全部请求造成的伤害大于接受积压；Redis 故障时真正该熔断的是 Redis 依赖方，
   * 而不是在入口新造一次全站 429。
   */
  async assertQueueDepth(): Promise<{ depth: number; maxDepth: number; skipped?: 'queue-not-wired' | 'queue-unavailable' }> {
    const maxDepth = queueMaxDepth();
    if (!this.agentRunQueue) return { depth: 0, maxDepth, skipped: 'queue-not-wired' };
    let counts: Record<string, number>;
    try {
      counts = await this.withProbeTimeout(this.agentRunQueue.getJobCounts('waiting', 'active'), 1_000);
    } catch (err) {
      this.logger.warn(`队列深度探测失败，背压降级放行: ${(err as Error).message}`);
      return { depth: 0, maxDepth, skipped: 'queue-unavailable' };
    }
    const depth = (counts.waiting ?? 0) + (counts.active ?? 0);
    if (depth >= maxDepth) {
      throw new AppError(ErrorCode.QUOTA_EXCEEDED, `系统繁忙：执行队列积压 ${depth}/${maxDepth}，请稍后重试`);
    }
    return { depth, maxDepth };
  }

  /** 硬超时（探测绝不挂住请求路径；超时后原 promise 的 reject 已被吞掉，不产生 unhandled rejection） */
  private withProbeTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        reject(new Error(`队列深度探测超时（>${ms}ms）`));
      }, ms);
      timer.unref?.();
      p.then(
        (v) => { if (settled) return; settled = true; clearTimeout(timer); resolve(v); },
        (e) => { if (settled) return; settled = true; clearTimeout(timer); reject(e); },
      );
    });
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
