import { Inject, Injectable } from '@nestjs/common';
import { PrismaService } from '../../modules/prisma/prisma.service';
import { UsageService } from '../../modules/usage/usage.service';
import { AgentRunMessagesService } from '../../modules/agent-runs/agent-run-messages.service';
import { AgentRuntimePersistence, CreateRunInput, ToolCallRecord } from './runtime-persistence';

/** AgentRuntimePersistence 的 Prisma 实现（P2：sync 路径；P3 的 claim/resume 复用同一批原语） */
@Injectable()
export class PrismaRuntimePersistence implements AgentRuntimePersistence {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(UsageService) private readonly usage: UsageService,
    @Inject(AgentRunMessagesService) private readonly messages: AgentRunMessagesService,
  ) {}

  createRun(input: CreateRunInput) {
    return this.prisma.agentRun.create({
      data: {
        userId: input.userId, agentId: input.agentId,
        agentVersionId: input.agentVersionId,
        projectId: input.projectId, conversationId: input.conversationId,
        maxSteps: input.maxSteps, metadata: input.metadata as never,
      },
    });
  }

  createStep(data: { runId: string; stepIndex: number; type: string; status?: string; output?: unknown }) {
    return this.prisma.agentRunStep.create({ data: data as never });
  }

  async updateStep(stepId: string, data: { status?: string; completedAt?: Date; output?: unknown }): Promise<void> {
    await this.prisma.agentRunStep.update({ where: { id: stepId }, data: data as never });
  }

  async getSystemSetting(key: string): Promise<Record<string, unknown> | null> {
    const row = await this.prisma.systemSetting.findUnique({ where: { key } });
    return (row?.value as Record<string, unknown> | null) ?? null;
  }

  async createToolCall(data: Parameters<AgentRuntimePersistence['createToolCall']>[0]) {
    const row = await this.prisma.toolCall.create({
      data: {
        runStepId: data.runStepId, toolName: data.toolName, idempotencyKey: data.idempotencyKey,
        input: data.input as never, output: data.output as never,
        status: data.status ?? 'running',
        errorCode: data.errorCode, errorMessage: data.errorMessage,
        completedAt: data.completedAt ?? (data.status === 'running' ? null : new Date()),
      },
    });
    return { id: row.id };
  }

  async findToolCall(runStepId: string, idempotencyKey: string): Promise<ToolCallRecord | null> {
    const row = await this.prisma.toolCall.findUnique({ where: { runStepId_idempotencyKey: { runStepId, idempotencyKey } } });
    return row ? { id: row.id, status: row.status, output: row.output } : null;
  }

  async updateToolCall(id: string, data: Parameters<AgentRuntimePersistence['updateToolCall']>[1]): Promise<void> {
    await this.prisma.toolCall.update({ where: { id }, data: data as never });
  }

  appendMessage(userId: string, runId: string, message: Parameters<AgentRuntimePersistence['appendMessage']>[2]) {
    return this.messages.append(userId, runId, message);
  }

  async recordChatUsage(input: Parameters<AgentRuntimePersistence['recordChatUsage']>[0]) {
    await this.usage.recordChatUsage({
      userId: input.userId, conversationId: input.conversationId ?? '', messageId: input.messageId,
      providerId: input.providerId, modelId: input.modelId, runId: input.runId,
      inputTokens: input.inputTokens, outputTokens: input.outputTokens,
      latencyMs: input.latencyMs, status: input.status, errorCode: input.errorCode,
    }).catch(() => undefined);
  }

  finalizeRun(runId: string, data: Parameters<AgentRuntimePersistence['finalizeRun']>[1]) {
    return this.prisma.agentRun.updateMany({
      where: {
        id: runId, status: 'running',
        ...(data.workerId ? { workerId: data.workerId } : {}), // M6 fencing：旧 worker 不得写终态
      },
      data: {
        status: data.status as never, errorCode: data.errorCode ?? undefined, errorMessage: data.errorMessage ?? undefined,
        completedAt: data.completedAt,
      },
    });
  }

  async updateCurrentStep(runId: string, step: number, workerId?: string): Promise<void> {
    await this.prisma.agentRun.update({
      where: { id: runId, ...(workerId ? { workerId } : {}) },
      data: { currentStep: step },
    });
  }

  async findStep(runId: string, stepIndex: number): Promise<{ id: string } | null> {
    const row = await this.prisma.agentRunStep.findUnique({ where: { runId_stepIndex: { runId, stepIndex } } });
    return row ? { id: row.id } : null;
  }
}
