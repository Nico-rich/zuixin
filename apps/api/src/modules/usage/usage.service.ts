import { Inject, Injectable } from '@nestjs/common';
import { UsageKind, UsageStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AppError, ErrorCode } from '../../common/errors/app-error';
import { BillingService } from '../billing/billing.service';
import { OrganizationsService } from '../organizations/organizations.service';

export interface ChatUsageInput {
  userId: string; conversationId?: string; messageId?: string;
  providerId: string; modelId: string;
  inputTokens: number; outputTokens: number;
  latencyMs: number; status: 'success' | 'failed'; errorCode?: string;
  runId?: string;   // AgentRun 关联（按 Run 聚合成本）
  /** Pre-M9 T1：调用方已知的组织归属（引擎持久层每 run 解析一次传入）；缺省由事实链解析 */
  organizationId?: string;
  /** 项目 id（账本镜像的 projectId 列；引擎外调用方传入） */
  projectId?: string | null;
}

export interface MediaUsageInput {
  userId: string; conversationId?: string; messageId?: string; taskId: string;
  kind: 'image' | 'video';
  providerId: string; modelId: string;
  imageCount: number; videoSeconds: number;
  latencyMs: number; status: 'success' | 'failed'; errorCode?: string;
  runId?: string;   // AgentRun 归因（Tool 路径传入；非 Agent 场景为空）
  organizationId?: string;
  projectId?: string | null;
}

/** 成本计算（R1 统一公式——全库唯一计价点：UsageRecord.estimatedCost 只在这里产生） */
export function computeCost(input: { inputTokens: number; outputTokens: number; inputPrice?: number | null; outputPrice?: number | null }): number {
  const inCost = (input.inputTokens * (input.inputPrice ?? 0)) / 1_000_000;
  const outCost = (input.outputTokens * (input.outputPrice ?? 0)) / 1_000_000;
  return Math.round((inCost + outCost) * 1_000_000) / 1_000_000;
}

/**
 * M0-M5 用量事实层（UsageRecord 唯一写入点）+ Pre-M9 计费正确性：
 * - T1：organizationId 必填——写入时从 run/task/conversation/message/用户个人组织事实链解析
 *   （与 pre_m9_billing_foundation 迁移回填链同语义；调用方已知时直接传入，避免重复查询）；
 * - D1：每一条 UsageRecord 派生对应账本镜像行（usageRecordId 关联 + 幂等键含记录 id）
 *   ——账本自此是严格投影而非"驱动侧另行聚合"，漂移被结构性消除（对账见 BillingReconciliationService）；
 * - R1：estimatedCost 由模型价格目录统一计算（Model.inputPrice/outputPrice/unitPrice；后台可改价）。
 */
@Injectable()
export class UsageService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(BillingService) private readonly billing: BillingService,
    @Inject(OrganizationsService) private readonly orgs: OrganizationsService,
  ) {}

  /** 记录 LLM 调用用量（成本由模型价格目录计算） */
  async recordChatUsage(input: ChatUsageInput): Promise<void> {
    const model = await this.prisma.model.findUnique({ where: { id: input.modelId } }).catch(() => null);
    const estimatedCost = model
      ? computeCost({ inputTokens: input.inputTokens, outputTokens: input.outputTokens, inputPrice: model.inputPrice, outputPrice: model.outputPrice })
      : 0;
    const organizationId = input.organizationId ?? await this.resolveOrganizationId(input);
    const record = await this.prisma.usageRecord.create({
      data: {
        userId: input.userId, organizationId, conversationId: input.conversationId, messageId: input.messageId,
        providerId: input.providerId, modelId: input.modelId, runId: input.runId,
        kind: UsageKind.llm_chat,
        inputTokens: input.inputTokens, outputTokens: input.outputTokens,
        latencyMs: input.latencyMs, estimatedCost,
        status: input.status === 'success' ? UsageStatus.success : UsageStatus.failed,
        errorCode: input.errorCode,
      },
    });
    await this.mirrorLedger({
      recordId: record.id, organizationId, projectId: input.projectId,
      kind: 'llm_chat', userId: input.userId, runId: input.runId ?? null, taskId: null,
      quantities: [{ key: 'llm_tokens', value: input.inputTokens + input.outputTokens }, { key: 'llm_cost', value: estimatedCost }],
    });
  }

  /** 记录媒体用量（image/video 统一走 usage_records，不另建表）并按 unitPrice 估算成本 */
  async recordMediaUsage(input: MediaUsageInput): Promise<void> {
    const model = input.modelId ? await this.prisma.model.findUnique({ where: { id: input.modelId } }).catch(() => null) : null;
    const units = input.kind === 'image' ? input.imageCount : input.videoSeconds;
    const estimatedCost = model ? Math.round(units * model.unitPrice * 1_000_000) / 1_000_000 : 0;
    const organizationId = input.organizationId ?? await this.resolveOrganizationId(input);
    const record = await this.prisma.usageRecord.create({
      data: {
        userId: input.userId, organizationId, conversationId: input.conversationId, messageId: input.messageId, taskId: input.taskId,
        providerId: input.providerId || undefined, modelId: input.modelId || undefined,
        runId: input.runId,
        kind: input.kind === 'image' ? UsageKind.image : UsageKind.video,
        imageCount: input.imageCount, videoSeconds: input.videoSeconds,
        latencyMs: input.latencyMs, estimatedCost,
        status: input.status === 'success' ? UsageStatus.success : UsageStatus.failed,
        errorCode: input.errorCode,
      },
    });
    await this.mirrorLedger({
      recordId: record.id, organizationId, projectId: input.projectId,
      kind: input.kind, userId: input.userId, runId: input.runId ?? null, taskId: input.taskId,
      // 失败/超时 attempt 也占用 provider 资源：镜像按 attempt 至少 1 单位（usage 事实列仍记 0——事实与计费语义分离）
      quantities: [{ key: input.kind === 'image' ? 'image_generation' : 'video_seconds', value: Math.max(units, 1) }],
    });
  }

  /**
   * 账本镜像（D1）：零量行跳过（失败调用无 token/成本不产生空账本行）；
   * 幂等键 = ur:{recordId}:{kind}——同一条记录重放绝不重复计量。
   */
  private async mirrorLedger(input: {
    recordId: string; organizationId: string; projectId?: string | null; kind: string;
    userId: string; runId: string | null; taskId: string | null;
    quantities: Array<{ key: string; value: number }>;
  }): Promise<void> {
    for (const q of input.quantities) {
      if (q.value <= 0) continue;
      await this.billing.recordUsage({
        userId: input.userId, projectId: input.projectId, kind: q.key as never, quantity: q.value,
        runId: input.runId ?? undefined, taskId: input.taskId ?? undefined,
        usageRecordId: input.recordId, organizationId: input.organizationId,
        idempotencyKey: `ur:${input.recordId}:${q.key}`,
      }).catch(() => undefined);
    }
  }

  /**
   * T1 组织归因链（与迁移回填链同语义，单一事实源）：
   * run→项目组织 > task→run 链 > conversation→项目组织 > message→conversation 链 > 用户个人组织。
   */
  async resolveOrganizationId(input: {
    userId: string; runId?: string | null; taskId?: string | null;
    conversationId?: string | null; messageId?: string | null;
  }): Promise<string> {
    if (input.runId) {
      const run = await this.prisma.agentRun.findUnique({
        where: { id: input.runId },
        select: { userId: true, project: { select: { organizationId: true } } },
      }).catch(() => null);
      if (run?.project?.organizationId) return run.project.organizationId;
      if (run) return (await this.orgs.ensurePersonalOrganization(run.userId)).id;
    }
    if (input.taskId) {
      const task = await this.prisma.generationTask.findUnique({
        where: { id: input.taskId },
        select: { userId: true, runId: true },
      }).catch(() => null);
      if (task?.runId) {
        return this.resolveOrganizationId({ userId: task.userId, runId: task.runId });
      }
      if (task) return (await this.orgs.ensurePersonalOrganization(task.userId)).id;
    }
    if (input.conversationId) {
      const conversation = await this.prisma.conversation.findUnique({
        where: { id: input.conversationId },
        select: { userId: true, project: { select: { organizationId: true } } },
      }).catch(() => null);
      if (conversation?.project?.organizationId) return conversation.project.organizationId;
      if (conversation) return (await this.orgs.ensurePersonalOrganization(conversation.userId)).id;
    }
    if (input.messageId) {
      const message = await this.prisma.message.findUnique({
        where: { id: input.messageId },
        select: { conversationId: true },
      }).catch(() => null);
      if (message?.conversationId) {
        return this.resolveOrganizationId({ userId: input.userId, conversationId: message.conversationId });
      }
    }
    return (await this.orgs.ensurePersonalOrganization(input.userId)).id;
  }
}

/** 一次 AgentRun 的用量聚合（执行成本可观测，非 Billing） */
export interface RunUsageAggregate {
  runId: string;
  durationMs: number;
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
  llmCost: number;
  imageCost: number;
  videoCost: number;
  totalCost: number;
  llmRounds: number;
  imageCount: number;
  videoSeconds: number;
  failedCalls: number;
  byKind: Array<{ kind: string; count: number; cost: number; tokens: number }>;
}

/** 聚合查询（服务端投影，usage_records 按 runId 汇总；归属校验 userId） */
export async function aggregateRunUsage(
  prisma: PrismaService, userId: string, runId: string,
): Promise<RunUsageAggregate> {
  const run = await prisma.agentRun.findFirst({ where: { id: runId, userId } });
  if (!run) throw new AppError(ErrorCode.NOT_FOUND, '运行不存在');
  const rows = await prisma.usageRecord.findMany({ where: { runId, userId } });
  const agg: RunUsageAggregate = {
    runId,
    durationMs: run.completedAt ? run.completedAt.getTime() - run.startedAt.getTime() : Date.now() - run.startedAt.getTime(),
    totalTokens: 0, inputTokens: 0, outputTokens: 0,
    llmCost: 0, imageCost: 0, videoCost: 0, totalCost: 0,
    llmRounds: 0, imageCount: 0, videoSeconds: 0, failedCalls: 0,
    byKind: [],
  };
  const byKind = new Map<string, { count: number; cost: number; tokens: number }>();
  for (const r of rows) {
    agg.totalTokens += r.inputTokens + r.outputTokens;
    agg.inputTokens += r.inputTokens;
    agg.outputTokens += r.outputTokens;
    agg.totalCost += r.estimatedCost;
    if (r.status === 'failed') agg.failedCalls++;
    const kind = r.kind;
    const entry = byKind.get(kind) ?? { count: 0, cost: 0, tokens: 0 };
    entry.count++;
    entry.cost += r.estimatedCost;
    entry.tokens += r.inputTokens + r.outputTokens;
    byKind.set(kind, entry);
    if (kind === 'llm_chat') { agg.llmRounds++; agg.llmCost += r.estimatedCost; }
    if (kind === 'image') { agg.imageCount += r.imageCount; agg.imageCost += r.estimatedCost; }
    if (kind === 'video') { agg.videoSeconds += r.videoSeconds; agg.videoCost += r.estimatedCost; }
  }
  agg.byKind = [...byKind.entries()].map(([kind, v]) => ({ kind, ...v }));
  return agg;
}
