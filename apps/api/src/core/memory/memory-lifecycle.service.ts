import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit, Optional } from '@nestjs/common';
import { MemoryStatus, type Prisma } from '@prisma/client';
import { PrismaService } from '../../modules/prisma/prisma.service';
import { ObservabilityService } from '../tracing/observability.service';
import { SchedulerService } from '../../modules/scheduler/scheduler.service';
import { RecurringJobProvisioner } from '../../modules/scheduler/recurring-job-provisioner';
import { canAutoPromote, MEMORY_LIFECYCLE_KEY, memoryOrigin, mergeMemoryMetadata, metaTime } from './memory-provenance';

/**
 * M12-P3 **结果驱动的记忆生命周期**（审计："lastUsedAt 只写不用；无衰减/淘汰 cron"）。
 *
 * 改造前记忆只有"摄取期一次定生死"：LLM 自报 confidence 达阈值即 active 并永久留在上下文，
 * 此后无论被引用与否都**只增不减**（`lastUsedAt` 写了没人读）。本服务补上"用结果反推"的收尾环节，
 * 全部判定由**服务端规则**给出——**LLM 输出绝不参与**（红线：LLM 不得决定治理判定）：
 *
 * ① **结果验证提升（verified）**：一条 active 记忆"被用过"（`lastUsedAt`）之后，同用户（项目级记忆要求
 *    同项目）出现一次**成功执行** → importance 上调并把"这次使用已被验证"记进 metadata（同一 use 只验证一次，
 *    幂等）。"成功执行"= `AgentRun.status='completed'` **且**该 run 有成功的 `UsageRecord`（真实模型调用事实）。
 * ② **衰减降级（decay→demote）**：长期没有出现（`lastUsedAt` 早于窗口，或从未被用过且创建已久）→ 按步长衰减
 *    importance；衰减到地板线即 `status: active → candidate`（**退出上下文**，行保留、可人工恢复）。
 *    期间出现**失败执行**（`failed`/`timeout`）→ 本次衰减步长加倍（负向结果加速降级）。
 * ③ **淘汰（evict）**：已被降级（`lifecycle.demotedAt`）且又过了一个淘汰窗口仍无人恢复 → `status: rejected`
 *    （永久退出上下文；行保留供审计与人工回溯，**绝不物理删行**）。
 * ④ **结果验证升格（promote）**：`status='candidate'` 且来源可信（`canAutoPromote`）者，若创建后的验证窗口内
 *    出现成功执行证据 → 升为 active（把"反馈派生记忆永远进不了上下文"这条断链补上，且**不以 LLM 自评分为依据**）。
 *
 * 证据面（全部是**既有事实**，不新增表/列/队列）：`AgentRun`（结果）+ `UsageRecord`（真实调用计量）。
 *
 * **明确排除 `Feedback` 行作为提升证据**（与审计风险 2 同源）：`Feedback` 表没有任何"人/机来源"列，
 * `feedback.submit` 又是 Agent 可调用的工具——用评分驱动提升等于让 LLM 给自己打分自证
 * （即审计 R1 "Agent 经 performance.capture 伪造绩效自证"的同一模式）。故评分**只**作为它自己派生出的
 * 那条记忆的 `origin` 标注（人工 HTTP → user；工具调用 → agent），绝不作为其它记忆的提升依据。
 *
 * 边界与安全：
 * - **周期触发走既有 Scheduler**（ScheduledJob + repeatable job；`RecurringJobProvisioner` 范式）——
 *   绝不新开队列、绝不新增基础设施（红线：禁第三套 Scheduler）；
 * - **有界执行**：用户轮转（滚动 offset）+ 单用户批量上限 + 单次写入预算；未处理完的留给下个周期；
 * - **幂等 + CAS**：所有写入都是 `updateMany({ where: { id, updatedAt, status } })`（乐观锁）——
 *   并发/重复执行只有一个赢家，绝不覆盖期间的用户改动；
 * - **人工优先**：用户显式把记忆改回 active（`PATCH /memories/:id`）会记 `lifecycle.userAffirmedAt`，
 *   窗口内**绝不**被服务端再次降级（人工裁决 > 服务端衰减；红线：LLM 不决定治理判定）；
 * - **来源闸门**：④ 只对 `canAutoPromote` 为真的候选生效（LLM 来源候选**绝不**自动升格，只进人工面）。
 */
export const MEMORY_LIFECYCLE_HANDLER = 'memory.lifecycle';
/** 平台周期作业身份（幂等键稳定且**版本化**：语义变更才换 v2，绝不无声换键产生第二个作业） */
export const MEMORY_LIFECYCLE_IDEMPOTENCY_KEY = 'platform:memory-lifecycle:v1';
/** 周期：每日 04:37（UTC）——避开保留策略（03:23）与归档，错开整点与 UTC 日界 */
export const MEMORY_LIFECYCLE_CRON = '37 4 * * *';
export const MEMORY_LIFECYCLE_JOB_NAME = '记忆生命周期（结果验证提升 / 长期未用衰减淘汰）';
/** 生命周期活性指标（value = 本次写入行数，含 0——0 是"在跑但没活儿"的活性信号） */
export const MEMORY_LIFECYCLE_METRIC = 'memory_lifecycle_sweep_count';

/** 多久没被上下文用过算"长期未使用"（env MEMORY_STALE_DAYS） */
export const DEFAULT_MEMORY_STALE_DAYS = 30;
/** 降级后再过多久仍无人恢复 → 淘汰（env MEMORY_EVICT_DAYS） */
export const DEFAULT_MEMORY_EVICT_DAYS = 30;
/** 执行结果与"使用/创建"时刻的最大关联窗口（超出即不视为相关执行） */
export const DEFAULT_MEMORY_VERIFY_WINDOW_MS = 7 * 24 * 60 * 60 * 1_000;
/** 验证有效 → importance 上调步长 */
export const DEFAULT_MEMORY_VERIFY_BOOST = 10;
/** 长期未用 → importance 衰减步长（失败执行时加倍） */
export const DEFAULT_MEMORY_DECAY_STEP = 10;
/** 衰减地板线：触线即降级 (active → candidate) */
export const DEFAULT_MEMORY_DECAY_FLOOR = 20;
/** 候选升格的静默期（刚落的候选不立刻升格，留人工否决的时间窗） */
export const DEFAULT_MEMORY_PROMOTE_QUIET_MS = 60 * 60 * 1_000;
/** 候选升格的回看窗口（更老的候选只能人工裁决——证据窗口早已过去） */
export const DEFAULT_MEMORY_PROMOTE_LOOKBACK_MS = 30 * 24 * 60 * 60 * 1_000;
/** 单次执行的用户轮转预算 / 单用户单类批量 / 写入预算（有界执行，不长时间占用 worker） */
export const DEFAULT_MEMORY_USER_BUDGET = 500;
export const DEFAULT_MEMORY_PER_USER_BATCH = 200;
export const DEFAULT_MEMORY_WRITE_BUDGET = 500;

const DAY_MS = 24 * 60 * 60 * 1_000;
/** 单个用户一次拉取的成功执行证据上限 */
const RUN_BATCH = 500;

export interface MemoryLifecycleRunOptions {
  /** 注入"当前时间"（测试确定性；生产绝不用） */
  now?: Date;
  staleDays?: number;
  evictDays?: number;
  verifyWindowMs?: number;
  promoteQuietMs?: number;
  promoteLookbackMs?: number;
  userBudget?: number;
  perUserBatch?: number;
  maxWrites?: number;
}

export interface MemoryLifecycleRunResult {
  /** 结果验证通过的 active 记忆数（importance 上调或仅记录验证时刻） */
  verified: number;
  /** 候选被结果证据升格为 active 的行数 */
  promoted: number;
  /** 因长期未用被下调 importance 的行数 */
  decayed: number;
  /** 衰减触地板 → 降级为 candidate 的行数（退出上下文） */
  demoted: number;
  /** 降级后长期无人恢复 → 淘汰为 rejected 的行数 */
  evicted: number;
  /** 本次载入的记忆行数（含未命中判定） */
  scanned: number;
  /** 参与轮转的用户数 */
  users: number;
  /** 实际写入行数（CAS 成功的写入） */
  writes: number;
  /** 因预算用尽而截断（下个周期继续） */
  truncated: boolean;
  /** 生效的"长期未使用"截止时刻 */
  staleCutoff: Date;
  /** 生效的"淘汰"截止时刻 */
  evictCutoff: Date;
}

/** 生命周期判定需要的最小行事实 */
type LifecycleRow = {
  id: string; status: MemoryStatus; content: string; category: string; importance: number;
  projectId: string | null; lastUsedAt: Date | null; createdAt: Date; updatedAt: Date;
  metadata: unknown; source: string | null;
};

/** 成功执行证据（AgentRun + 计量） */
type RunFact = { id: string; projectId: string | null; completedAt: Date };

function clampInt(value: number | undefined, fallback: number, min: number, max: number): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(Math.max(Math.trunc(n), min), max);
}

/** env 天数旋钮（非法/非正 → 默认） */
function envDays(name: string, fallback: number): number {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : fallback;
}

@Injectable()
export class MemoryLifecycleService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger('MemoryLifecycle');
  private readonly provisioner: RecurringJobProvisioner;
  /** 用户轮转游标（进程内；跨周期滚动，避免大用户量下总是同一批用户被处理） */
  private userOffset = 0;

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(SchedulerService) private readonly scheduler: SchedulerService,
    @Optional() @Inject(ObservabilityService) private readonly metrics?: ObservabilityService,
  ) {
    this.provisioner = new RecurringJobProvisioner({
      prisma,
      scheduler,
      logger: this.logger,
      spec: {
        name: MEMORY_LIFECYCLE_JOB_NAME,
        handler: MEMORY_LIFECYCLE_HANDLER,
        cron: MEMORY_LIFECYCLE_CRON,
        idempotencyKey: MEMORY_LIFECYCLE_IDEMPOTENCY_KEY,
        // 单次执行有界（用户轮转 + 写入预算）；超过退避重投 3 次仍失败 → dead（运维面可见）
        timeoutMs: 600_000, maxAttempts: 3, backoffMs: 5_000,
        inactiveHint: '自动记忆生命周期当前停用，需运维显式 resume',
      },
    });
  }

  /**
   * 启动：① 注册 handler（纯内存；未注册的 handler 在 worker 侧一律判失败）；
   * ② 开通平台周期作业（周期性探测 + 退避重试；绝不阻塞启动）。
   *
   * 注：本服务由 MemoryModule 提供，该模块被 API 进程（MemoriesModule/ChatModule…）与 Worker 进程
   * （AgentRunWorkerModule → ContextModule）共同导入 → 两个进程都注册 handler 并探测开通；
   * 真实执行方是持有 scheduler 队列的 worker。开通受 idempotencyKey 唯一约束保护（并发只有一个赢家）。
   */
  async onModuleInit(): Promise<void> {
    this.scheduler.registerHandler(MEMORY_LIFECYCLE_HANDLER, () => this.sweep().then(() => undefined));
    await this.provisioner.start();
  }

  onModuleDestroy(): void {
    this.provisioner.stop();
  }

  /** 单次生命周期巡逻（幂等、有界；绝不抛错给调度器——异常走 rejected 由 worker 记 lastError） */
  async sweep(opts: MemoryLifecycleRunOptions = {}): Promise<MemoryLifecycleRunResult> {
    const now = opts.now ?? new Date();
    const staleDays = clampInt(opts.staleDays, envDays('MEMORY_STALE_DAYS', DEFAULT_MEMORY_STALE_DAYS), 1, 3_650);
    const evictDays = clampInt(opts.evictDays, envDays('MEMORY_EVICT_DAYS', DEFAULT_MEMORY_EVICT_DAYS), 1, 3_650);
    const verifyWindowMs = clampInt(opts.verifyWindowMs, DEFAULT_MEMORY_VERIFY_WINDOW_MS, 60_000, 90 * DAY_MS);
    const promoteQuietMs = clampInt(opts.promoteQuietMs, DEFAULT_MEMORY_PROMOTE_QUIET_MS, 0, 30 * DAY_MS);
    const promoteLookbackMs = clampInt(opts.promoteLookbackMs, DEFAULT_MEMORY_PROMOTE_LOOKBACK_MS, verifyWindowMs, 365 * DAY_MS);
    const userBudget = clampInt(opts.userBudget, DEFAULT_MEMORY_USER_BUDGET, 1, 5_000);
    const perUserBatch = clampInt(opts.perUserBatch, DEFAULT_MEMORY_PER_USER_BATCH, 1, 2_000);
    const maxWrites = clampInt(opts.maxWrites, DEFAULT_MEMORY_WRITE_BUDGET, 1, 10_000);

    const staleCutoff = new Date(now.getTime() - staleDays * DAY_MS);
    const evictCutoff = new Date(now.getTime() - evictDays * DAY_MS);
    const result: MemoryLifecycleRunResult = {
      verified: 0, promoted: 0, decayed: 0, demoted: 0, evicted: 0,
      scanned: 0, users: 0, writes: 0, truncated: false, staleCutoff, evictCutoff,
    };

    for (const userId of await this.rotateUsers(userBudget)) {
      if (result.writes >= maxWrites) { result.truncated = true; break; }
      result.users += 1;
      await this.sweepUser(userId, {
        now, staleCutoff, evictCutoff, verifyWindowMs, promoteQuietMs, promoteLookbackMs,
        perUserBatch, maxWrites, result,
      });
    }

    if (result.writes > 0) {
      this.logger.log({ ...result }, '记忆生命周期巡逻完成');
    } else {
      // 0 写入也留痕：区分"任务在跑但没活儿"与"任务没跑"（M11-P8 同口径）
      this.logger.debug({ users: result.users, scanned: result.scanned }, '记忆生命周期巡逻完成：无待处置记忆');
    }
    await this.metrics?.recordMetric(MEMORY_LIFECYCLE_METRIC, result.writes, 'count', {
      verified: result.verified, promoted: result.promoted, decayed: result.decayed,
      demoted: result.demoted, evicted: result.evicted, users: result.users, truncated: result.truncated,
    }, null).catch(() => undefined);
    return result;
  }

  // ===== 内部实现 =====

  /** 用户轮转：只枚举"有 active/candidate 记忆"的用户（滚动 offset，跨周期公平覆盖） */
  private async rotateUsers(budget: number): Promise<string[]> {
    const groups = await this.prisma.memory.groupBy({
      by: ['userId'],
      where: { status: { in: ['active', 'candidate'] } },
      orderBy: { userId: 'asc' },
      skip: this.userOffset,
      take: budget,
    });
    this.userOffset = groups.length < budget ? 0 : this.userOffset + groups.length;
    return groups.map((g) => g.userId);
  }

  private async sweepUser(userId: string, ctx: {
    now: Date; staleCutoff: Date; evictCutoff: Date; verifyWindowMs: number;
    promoteQuietMs: number; promoteLookbackMs: number; perUserBatch: number; maxWrites: number;
    result: MemoryLifecycleRunResult;
  }): Promise<void> {
    const rows = await this.loadRows(userId, ctx);
    ctx.result.scanned += rows.active.length + rows.candidates.length;
    if (!rows.active.length && !rows.candidates.length) return;

    // 证据面：窗口内该用户全部**成功执行**（completed AgentRun + 成功计量事实）
    const windowStart = new Date(Math.min(
      ...rows.active.map((r) => (r.lastUsedAt ?? r.createdAt).getTime()),
      ...rows.candidates.map((r) => r.createdAt.getTime()),
      ctx.now.getTime(),
    ) - ctx.verifyWindowMs);
    const evidence = await this.loadEvidence(userId, windowStart, ctx.now);

    for (const row of rows.active) await this.applyActive(userId, row, evidence, ctx);
    for (const row of rows.candidates) await this.applyCandidate(userId, row, evidence, ctx);
  }

  /** 载入判定所需的记忆行（active 分"新鲜/陈旧"两段查询，命中 [userId, scope, status] 索引） */
  private async loadRows(userId: string, ctx: {
    now: Date; staleCutoff: Date; perUserBatch: number;
  }): Promise<{ active: LifecycleRow[]; candidates: LifecycleRow[] }> {
    const select = {
      id: true, status: true, content: true, category: true, importance: true,
      projectId: true, lastUsedAt: true, createdAt: true, updatedAt: true, metadata: true, source: true,
    } as const;
    const [fresh, stale, candidates] = await Promise.all([
      // 近期被用过：进入"结果验证"面
      this.prisma.memory.findMany({
        where: { userId, status: 'active', lastUsedAt: { gte: ctx.staleCutoff, lte: ctx.now } },
        orderBy: [{ lastUsedAt: 'desc' }], take: ctx.perUserBatch, select,
      }),
      // 长期未用（含从未用过）：进入"衰减/降级"面
      this.prisma.memory.findMany({
        where: {
          userId, status: 'active', createdAt: { lt: ctx.staleCutoff },
          OR: [{ lastUsedAt: null }, { lastUsedAt: { lt: ctx.staleCutoff } }],
        },
        orderBy: [{ lastUsedAt: 'asc' }], take: ctx.perUserBatch, select,
      }),
      // 候选：淘汰（历史降级）与结果升格（来源可信 + 创建于回看窗口内）都在这里分流
      this.prisma.memory.findMany({
        where: { userId, status: 'candidate' },
        orderBy: [{ updatedAt: 'asc' }], take: ctx.perUserBatch, select,
      }),
    ]);
    return { active: [...fresh, ...stale], candidates };
  }

  /**
   * 成功执行证据：`AgentRun.status='completed'` **且**该 run 有 `UsageRecord.status='success'`
   * （真实模型调用计量 —— 只有 run 行而没有计量事实的"空 run"不算数）。
   * 失败证据：`failed`/`timeout` 的 run（用于加速衰减；**绝不**用于提升）。
   */
  private async loadEvidence(userId: string, since: Date, now: Date): Promise<{ ok: RunFact[]; failed: RunFact[] }> {
    const runs = await this.prisma.agentRun.findMany({
      where: { userId, status: { in: ['completed', 'failed', 'timeout'] }, completedAt: { gte: since, lte: now } },
      orderBy: { completedAt: 'desc' }, take: RUN_BATCH,
      select: { id: true, projectId: true, completedAt: true, status: true },
    });
    const completed = runs.filter((r) => r.status === 'completed');
    const ids = completed.map((r) => r.id);
    const used = ids.length
      ? await this.prisma.usageRecord.findMany({ where: { runId: { in: ids }, status: 'success' }, select: { runId: true }, take: ids.length })
      : [];
    const withUsage = new Set(used.map((u) => u.runId));
    const toFact = (r: { id: string; projectId: string | null; completedAt: Date | null }): RunFact =>
      ({ id: r.id, projectId: r.projectId, completedAt: r.completedAt as Date });
    return {
      ok: completed.filter((r) => withUsage.has(r.id) && r.completedAt).map(toFact),
      failed: runs.filter((r) => r.status !== 'completed' && r.completedAt).map(toFact),
    };
  }

  /** 项目级记忆要求同项目证据；用户级记忆接受该用户的任意项目证据 */
  private relevant(row: LifecycleRow, fact: RunFact): boolean {
    return row.projectId === null || fact.projectId === row.projectId;
  }

  /** 找一条"相关且落在窗口内"的成功执行（reference 之后 verifyWindowMs 之内） */
  private matchedRun(row: LifecycleRow, reference: Date, evidence: { ok: RunFact[] }, windowMs: number): RunFact | null {
    const end = reference.getTime() + windowMs;
    return evidence.ok.find((f) => this.relevant(row, f)
      && f.completedAt.getTime() > reference.getTime() && f.completedAt.getTime() <= end) ?? null;
  }

  private hasFailure(row: LifecycleRow, reference: Date, evidence: { failed: RunFact[] }, windowMs: number): boolean {
    const end = reference.getTime() + windowMs;
    return evidence.failed.some((f) => this.relevant(row, f)
      && f.completedAt.getTime() > reference.getTime() && f.completedAt.getTime() <= end);
  }

  /** ① 结果验证提升 + ② 衰减降级（同一条 active 行不可能同时落在两个面：查询谓词互斥） */
  private async applyActive(userId: string, row: LifecycleRow, evidence: {
    ok: RunFact[]; failed: RunFact[];
  }, ctx: {
    now: Date; staleCutoff: Date; evictCutoff: Date; verifyWindowMs: number;
    promoteQuietMs: number; promoteLookbackMs: number; perUserBatch: number; maxWrites: number;
    result: MemoryLifecycleRunResult;
  }): Promise<void> {
    if (this.budgetExhausted(ctx)) return;
    const userAffirmedAt = metaTime(row.metadata, 'userAffirmedAt');

    if (row.lastUsedAt && row.lastUsedAt >= ctx.staleCutoff) {
      // ① 结果验证面：同一次使用只验证一次（lastVerifiedUseAt 幂等锚）
      const verifiedUseAt = metaTime(row.metadata, 'lastVerifiedUseAt');
      if (verifiedUseAt && verifiedUseAt.getTime() >= row.lastUsedAt.getTime()) return;
      const hit = this.matchedRun(row, row.lastUsedAt, evidence, ctx.verifyWindowMs);
      if (!hit) return;
      const importance = Math.min(100, row.importance + DEFAULT_MEMORY_VERIFY_BOOST);
      const ok = await this.casWrite(row, {
        importance,
        metadata: mergeMemoryMetadata(row.metadata, {
          [MEMORY_LIFECYCLE_KEY]: {
            lastVerifiedAt: ctx.now.toISOString(),
            lastVerifiedUseAt: row.lastUsedAt.toISOString(),
            lastVerifiedRunId: hit.id,
          },
        }),
      });
      if (ok) {
        ctx.result.verified += 1;
        ctx.result.writes += 1;
        this.logger.debug({ userId, memoryId: row.id, runId: hit.id, importance }, '记忆结果验证通过 → importance 上调');
      }
      return;
    }

    // ② 衰减面：人工显式恢复（userAffirmedAt）在窗口内 → 服务端绝不覆盖人工裁决
    if (userAffirmedAt && userAffirmedAt.getTime() >= ctx.staleCutoff.getTime()) return;
    const reference = row.lastUsedAt ?? row.createdAt;
    const step = DEFAULT_MEMORY_DECAY_STEP * (this.hasFailure(row, reference, evidence, ctx.verifyWindowMs) ? 2 : 1);
    const next = row.importance - step;
    if (next <= DEFAULT_MEMORY_DECAY_FLOOR) {
      const ok = await this.casWrite(row, {
        status: MemoryStatus.candidate,
        importance: Math.max(0, next),
        metadata: mergeMemoryMetadata(row.metadata, {
          [MEMORY_LIFECYCLE_KEY]: { demotedAt: ctx.now.toISOString(), demoteReason: 'stale' },
        }),
      });
      if (ok) {
        ctx.result.demoted += 1;
        ctx.result.writes += 1;
        this.logger.log({ userId, memoryId: row.id, importance: Math.max(0, next) }, '记忆长期未用 → 降级为候选（退出上下文，可人工恢复）');
      }
      return;
    }
    const ok = await this.casWrite(row, {
      importance: next,
      metadata: mergeMemoryMetadata(row.metadata, {
        [MEMORY_LIFECYCLE_KEY]: { decayedAt: ctx.now.toISOString(), decayStep: step },
      }),
    });
    if (ok) {
      ctx.result.decayed += 1;
      ctx.result.writes += 1;
    }
  }

  /** ③ 淘汰（已降级且过期） + ④ 结果升格（来源可信 + 证据充分） */
  private async applyCandidate(userId: string, row: LifecycleRow, evidence: {
    ok: RunFact[]; failed: RunFact[];
  }, ctx: {
    now: Date; staleCutoff: Date; evictCutoff: Date; verifyWindowMs: number;
    promoteQuietMs: number; promoteLookbackMs: number; perUserBatch: number; maxWrites: number;
    result: MemoryLifecycleRunResult;
  }): Promise<void> {
    if (this.budgetExhausted(ctx)) return;
    const demotedAt = metaTime(row.metadata, 'demotedAt');
    // ③ 淘汰：降级后一个淘汰窗口仍无人恢复
    if (demotedAt && demotedAt.getTime() <= ctx.evictCutoff.getTime()) {
      const ok = await this.casWrite(row, {
        status: MemoryStatus.rejected,
        metadata: mergeMemoryMetadata(row.metadata, {
          [MEMORY_LIFECYCLE_KEY]: { evictedAt: ctx.now.toISOString() },
        }),
      });
      if (ok) {
        ctx.result.evicted += 1;
        ctx.result.writes += 1;
        this.logger.log({ userId, memoryId: row.id }, '记忆降级后长期无人恢复 → 淘汰（行保留，绝不物理删除）');
      }
      return;
    }
    // 已降级过的行绝不自动复活（避免"降级→升格"抖动）；人工恢复走 PATCH /memories/:id
    if (demotedAt) return;
    // ④ 结果升格：来源闸门（LLM 来源绝不自动升格）+ 静默期 + 创建后窗口内的成功执行证据
    if (!canAutoPromote({ source: row.source, metadata: row.metadata })) return;
    const age = ctx.now.getTime() - row.createdAt.getTime();
    if (age < ctx.promoteQuietMs || age > ctx.promoteLookbackMs) return;
    const hit = this.matchedRun(row, row.createdAt, evidence, ctx.verifyWindowMs);
    if (!hit) return;
    const ok = await this.casWrite(row, {
      status: MemoryStatus.active,
      metadata: mergeMemoryMetadata(row.metadata, {
        [MEMORY_LIFECYCLE_KEY]: {
          promotedBy: 'outcome',
          promotedAt: ctx.now.toISOString(),
          promotedByRunId: hit.id,
        },
      }),
    });
    if (ok) {
      ctx.result.promoted += 1;
      ctx.result.writes += 1;
      this.logger.log({ userId, memoryId: row.id, runId: hit.id, origin: memoryOrigin({ source: row.source, metadata: row.metadata }) }, '候选获得结果证据 → 升格 active');
    }
  }

  /**
   * 写入预算：用尽即置 `truncated` 并让调用方**立即返回**（有界执行）。
   * 逐行检查（不只是逐用户）——单用户批量上限也不允许把预算撑爆：剩余行留给下个周期。
   */
  private budgetExhausted(ctx: { maxWrites: number; result: MemoryLifecycleRunResult }): boolean {
    if (ctx.result.writes < ctx.maxWrites) return false;
    ctx.result.truncated = true;
    return true;
  }

  /**
   * CAS 写入：条件含 `updatedAt`（乐观锁）与状态——并发巡逻/用户同时在改时只有一个赢家，
   * 绝不覆盖期间发生的改动（红线：CAS+version）。返回是否真正写入。
   */
  private async casWrite(row: LifecycleRow, data: Prisma.MemoryUpdateManyMutationInput): Promise<boolean> {
    const res = await this.prisma.memory.updateMany({
      where: { id: row.id, updatedAt: row.updatedAt, status: row.status },
      data,
    });
    return res.count > 0;
  }
}
