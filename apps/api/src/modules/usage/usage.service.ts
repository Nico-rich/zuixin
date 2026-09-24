import { Inject, Injectable } from '@nestjs/common';
import { UsageKind, UsageStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AppError, ErrorCode } from '../../common/errors/app-error';

export interface ChatUsageInput {
  userId: string; conversationId: string; messageId: string;
  providerId: string; modelId: string;
  inputTokens: number; outputTokens: number;
  latencyMs: number; status: 'success' | 'failed'; errorCode?: string;
  runId?: string;   // AgentRun 关联（按 Run 聚合成本）
}

export interface MediaUsageInput {
  userId: string; conversationId?: string; messageId?: string; taskId: string;
  kind: 'image' | 'video';
  providerId: string; modelId: string;
  imageCount: number; videoSeconds: number;
  latencyMs: number; status: 'success' | 'failed'; errorCode?: string;
  runId?: string;   // AgentRun 归因（Tool 路径传入；非 Agent 场景为空）
}

@Injectable()
export class UsageService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  /** 记录 LLM 调用用量并按后台配置价格估算成本（M5 后台可改单价） */
  async recordChatUsage(input: ChatUsageInput): Promise<void> {
    const model = await this.prisma.model.findUnique({ where: { id: input.modelId } });
    const estimatedCost = model
      ? (input.inputTokens * model.inputPrice + input.outputTokens * model.outputPrice) / 1_000_000
      : 0;
    await this.prisma.usageRecord.create({
      data: {
        userId: input.userId, conversationId: input.conversationId, messageId: input.messageId,
        providerId: input.providerId, modelId: input.modelId, runId: input.runId,
        kind: UsageKind.llm_chat,
        inputTokens: input.inputTokens, outputTokens: input.outputTokens,
        latencyMs: input.latencyMs, estimatedCost,
        status: input.status === 'success' ? UsageStatus.success : UsageStatus.failed,
        errorCode: input.errorCode,
      },
    });
  }

  /** 记录媒体用量（image/video 统一走 usage_records，不另建表）并按 unitPrice 估算成本 */
  async recordMediaUsage(input: MediaUsageInput): Promise<void> {
    const model = input.modelId ? await this.prisma.model.findUnique({ where: { id: input.modelId } }).catch(() => null) : null;
    const units = input.kind === 'image' ? input.imageCount : input.videoSeconds;
    const estimatedCost = model ? units * model.unitPrice : 0;
    await this.prisma.usageRecord.create({
      data: {
        userId: input.userId, conversationId: input.conversationId, messageId: input.messageId, taskId: input.taskId,
        providerId: input.providerId || undefined, modelId: input.modelId || undefined,
        runId: input.runId,
        kind: input.kind === 'image' ? UsageKind.image : UsageKind.video,
        imageCount: input.imageCount, videoSeconds: input.videoSeconds,
        latencyMs: input.latencyMs, estimatedCost,
        status: input.status === 'success' ? UsageStatus.success : UsageStatus.failed,
        errorCode: input.errorCode,
      },
    });
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
