import { Inject, Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../modules/prisma/prisma.service';
import { TraceContext } from './trace-context';

export type MetricUnit = 'count' | 'ms' | 'percent';

export type RunMetricKind = 'agent_run' | 'workflow_run';

export interface MetricFilter {
  name?: string;
  organizationId?: string;
  limit?: number;
}

export interface RunAttribution {
  organizationId: string | null;
  userId: string | null;
}

/**
 * M11-P8（维度2#10）：**保留/归档**两类周期作业的观测面（本节唯一新增指标，绝不动既有采样/读取路径）。
 * 两者都是**平台级**事实（organizationId 显式 null——不是任何租户的数据），value = 本次执行的行数（含 0）：
 * - `event_archive_count`：EventEnvelope 归档周期任务每次执行归档（published → consumed）的行数；
 * - `metric_sample_purge_count`：MetricSample 保留策略每次执行删除的超期样本行数。
 * 0 值样本是**活性信号**（"任务还在跑、只是没活儿"）——导出面（monitoring/alerts.yml，P10）如要告警，
 * 应基于"样本缺失/停止增长"而非阈值（指标名对齐后导出器一落地即可用）。
 */
export const RETENTION_METRIC_NAMES = {
  eventArchiveCount: 'event_archive_count',
  metricSamplePurgeCount: 'metric_sample_purge_count',
} as const;

/**
 * M8-P3 指标采样（MetricSample，append-only 观测事实）：
 * - recordMetric 一律 best-effort：观测写入失败绝不阻断主流程（仅 warn）；
 * - organizationId 缺省从 TraceContext 取（HTTP/Worker 上下文已建立），HTTP 样本由中间件按 userId 归属；
 * - 读取见 ObservabilityService.list（userId 首条件；组织维度须先过 membership）。
 */
@Injectable()
export class ObservabilityService {
  private readonly logger = new Logger('Observability');

  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  /**
   * 采样一次指标（best-effort）。labels 自动补当前 traceId（便于与审计/日志关联）。
   * organizationId 显式传入优先；未传则取 TraceContext.current()?.organizationId。
   */
  async recordMetric(
    name: string,
    value: number,
    unit: MetricUnit = 'count',
    labels?: Record<string, unknown>,
    organizationId?: string | null,
  ): Promise<void> {
    const ctx = TraceContext.current();
    const orgId = organizationId !== undefined ? organizationId : (ctx?.organizationId ?? null);
    const payload: Record<string, unknown> = { ...(labels ?? {}) };
    if (ctx?.traceId && payload.traceId === undefined) payload.traceId = ctx.traceId;
    try {
      await this.prisma.metricSample.create({
        data: {
          name, value, unit,
          labels: (Object.keys(payload).length ? payload : null) as never,
          organizationId: orgId ?? null,
        },
      });
    } catch (err) {
      this.logger.warn(`指标写入失败 name=${name}: ${(err as Error).message}`); // best-effort
    }
  }

  /**
   * M10-P2 D12：provider 启动配置校验失败（degraded）**计数**——本 Phase 唯一新增的观测面，
   * 不改动其他 tracing 行为（采样/归属/读取路径全部原样）。
   * 语义：一次 refresh 中一个 provider 构建失败 = 一条 `provider_degraded`（value=1, count），
   * labels 携带 type/providerId/adapter/reason 便于按 provider 定位；organizationId 显式 null——
   * provider 是**平台级配置**（非租户数据），绝不借用调用者 trace 上下文的组织归属。
   * best-effort：recordMetric 内部吞异常，观测失败绝不影响 provider 加载结果。
   */
  async recordProviderDegraded(input: {
    type: string; providerId: string; providerName: string; adapter: string; reason: string;
  }): Promise<void> {
    await this.recordMetric('provider_degraded', 1, 'count', {
      type: input.type, providerId: input.providerId, providerName: input.providerName,
      adapter: input.adapter, reason: input.reason,
    }, null);
  }

  /**
   * Worker 侧：run 执行时长采样（agent_run_duration_ms / workflow_duration_ms）。
   * 归属（organizationId + userId）由 run 行解析——AgentRun/WorkflowRun 无 organizationId 列，
   * AgentRun 走 project.organizationId，WorkflowRun 走 workflow.organizationId（与 Billing 归因同源）。
   */
  async recordRunDuration(kind: RunMetricKind, runId: string, durationMs: number, extra: Record<string, unknown> = {}): Promise<void> {
    const attribution = await this.attributeRun(kind, runId);
    const labels: Record<string, unknown> = { runId, ...extra };
    if (attribution.userId) labels.userId = attribution.userId;
    await this.recordMetric(
      kind === 'agent_run' ? 'agent_run_duration_ms' : 'workflow_duration_ms',
      durationMs, 'ms', labels, attribution.organizationId,
    );
  }

  /** run 归属解析（best-effort：解析失败降级为无组织标签，绝不影响采样本身） */
  private async attributeRun(kind: RunMetricKind, runId: string): Promise<RunAttribution> {
    try {
      if (kind === 'agent_run') {
        const run = await this.prisma.agentRun.findUnique({
          where: { id: runId },
          select: { userId: true, project: { select: { organizationId: true } } },
        });
        const organizationId = run?.project?.organizationId ?? await this.personalOrganizationId(run?.userId);
        return { organizationId, userId: run?.userId ?? null };
      }
      const run = await this.prisma.workflowRun.findUnique({
        where: { id: runId },
        select: { userId: true, workflow: { select: { organizationId: true } } },
      });
      const organizationId = run?.workflow?.organizationId ?? await this.personalOrganizationId(run?.userId);
      return { organizationId, userId: run?.userId ?? null };
    } catch {
      return { organizationId: null, userId: null };
    }
  }

  /** 个人组织兜底（与 BillingService.organizationFor 同源语义；只读——观测路径绝不写库） */
  private async personalOrganizationId(userId?: string | null): Promise<string | null> {
    if (!userId) return null;
    const org = await this.prisma.organization.findFirst({
      where: { ownerUserId: userId, isPersonal: true, deletedAt: null },
      select: { id: true },
    });
    return org?.id ?? null;
  }

  /**
   * 指标读取（userId 首条件，绝不返回他人样本）：
   * - 无 organizationId：仅本人在 HTTP/Worker 上下文里产生的样本（labels.userId = 本人）；
   * - 有 organizationId：调用方必须先过 membership（控制器负责）；返回该组织样本 ∪ 本人样本。
   */
  async list(userId: string, filters: MetricFilter = {}) {
    const take = Math.min(Math.max(filters.limit ?? 100, 1), 500);
    const own = { labels: { path: ['userId'], equals: userId } };
    const named = filters.name ? [{ name: filters.name }] : [];
    const where = filters.organizationId
      ? { AND: [...named, { OR: [{ organizationId: filters.organizationId }, own] }] }
      : { AND: [...named, own] };
    return this.prisma.metricSample.findMany({
      where: where as never,
      orderBy: { sampledAt: 'desc' },
      take,
    });
  }
}
