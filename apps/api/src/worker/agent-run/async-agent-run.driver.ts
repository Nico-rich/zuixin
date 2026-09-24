import { Inject, Injectable } from '@nestjs/common';
import { PrismaService } from '../../modules/prisma/prisma.service';
import { AgentRuntimeEngine, AgentRuntimeContext, AgentRunOutcome } from '../../core/agent-loop/agent-runtime-engine';
import { ContextAssembler } from '../../core/context/context-assembler';
import { ChatMessage } from '../../providers/llm/llm.types';
import { AgentRunLeaseService } from '../../core/agent-run-lease/agent-run-lease.service';
import { EventBusService, agentRunChannel } from '../../core/events/event-bus.service';
import { planResume } from '../../core/agent-loop/resume-planner';

/**
 * M6-P4 Async Driver（Worker 侧）：
 * 从 DB 加载 run/version/transcript（身份与配置的最终事实来源——不信任 job payload）→
 * ResumePlanner 计算续跑计划（llm/tools/final）→ 构建 RuntimeContext → 驱动 AgentRuntimeEngine →
 * 按 run 终态落 assistant Message → 释放 lease。
 * P4 durable resume：transcript 为唯一重放输入；waiting 由 Engine 落库，本 Driver 只透传 outcome。
 */
@Injectable()
export class AsyncAgentRunDriver {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(AgentRuntimeEngine) private readonly engine: AgentRuntimeEngine,
    @Inject(ContextAssembler) private readonly context: ContextAssembler,
    @Inject(AgentRunLeaseService) private readonly lease: AgentRunLeaseService,
    @Inject(EventBusService) private readonly events: EventBusService,
  ) {}

  async execute(runId: string, signal: AbortSignal, controls: { active: boolean }): Promise<AgentRunOutcome> {
    const run = await this.prisma.agentRun.findUnique({ where: { id: runId }, include: { agentVersion: true } });
    if (!run || run.status !== 'running') {
      // 已被取消/终态/他人处理 → 幂等退出
      return { runId, status: run?.status === 'cancelled' ? 'cancelled' : 'failed', content: '', taskRefs: [] };
    }
    const version = run.agentVersion;
    if (!version) throw new Error(`run ${runId} 无 agentVersion 快照`);

    const transcript = await this.prisma.agentRunMessage.findMany({ where: { runId }, orderBy: { sequence: 'asc' } });
    const userRow = transcript.find((r) => r.role === 'user');
    if (!userRow) throw new Error(`run ${runId} transcript 缺初始用户消息`);
    const userMessage = userRow.content;
    const metadata = (run.metadata ?? {}) as { assistantMessageId?: string };
    const continuation = transcript.length > 1; // 除 seq0 用户消息外已有内容 = 崩溃续跑
    // P4 durable resume：transcript + currentStep → 续跑计划（已持久化 tool decision 绝不重打 LLM）
    const resumePlan = planResume(transcript, run.currentStep);

    const cfg = (version.config ?? {}) as {
      maxSteps?: number; requiresTools?: boolean; knowledge?: { enabled?: boolean }; contextBudgetTokens?: number;
    };
    // 历史：首次执行 = ContextAssembler 组装；续跑 = transcript 重放（不重新组装，避免上下文漂移）
    const history: ChatMessage[] = continuation
      ? this.replayHistory(transcript)
      : run.conversationId
        ? (await this.context.assemble({
            userId: run.userId,
            conversationId: run.conversationId,
            projectId: run.projectId ?? undefined,
            userMessage,
            excludeMessageId: metadata.assistantMessageId,
            knowledge: { enabled: cfg.knowledge?.enabled ?? false },
            budgetTokens: cfg.contextBudgetTokens,
          })).messages
        : [];

    const ctx: AgentRuntimeContext = {
      userId: run.userId,
      projectId: run.projectId ?? undefined,
      conversationId: run.conversationId ?? undefined,
      messageId: metadata.assistantMessageId, // 真实 Message 行或 undefined——绝不传 runId 冒充（GenerationTask.messageId FK）
      userMessage,
      history,
      agent: {
        id: run.agentId, systemPrompt: version.systemPrompt, modelId: version.modelId,
        tools: (version.tools as string[]) ?? [], temperature: version.temperature,
        maxTokens: version.maxTokens ?? undefined, maxSteps: cfg.maxSteps,
        requiresTools: cfg.requiresTools,
        versionId: version.id,
        knowledgeEnabled: cfg.knowledge?.enabled ?? false,
        contextBudgetTokens: cfg.contextBudgetTokens,
      },
      deadlineMs: await this.remainingDeadlineMs(run.startedAt),
      signal,
      runId,
      startStep: resumePlan.startStep,
      seedTranscript: !continuation,
      workerId: run.workerId ?? undefined,
      controls,
      resume: resumePlan,
    };

    const generator = this.engine.run(ctx);
    let outcome: AgentRunOutcome = undefined as never;
    while (true) {
      const { done, value } = await generator.next();
      if (done) { outcome = value; break; }
      // M6-P6：engine 事件 → run 观察通道（SSE 实时通知；DB Timeline 投影仍是历史事实来源）
      await this.events.publish(agentRunChannel(runId), value as Record<string, unknown>).catch(() => undefined);
    }

    if (outcome.status === 'waiting') {
      // P4 waiting：run 仍存活（已落库 waiting+waitingOnTaskId），assistant Message 保持 streaming，无终态写
      const taskId = outcome.taskRefs[0];
      await this.events.publish(agentRunChannel(runId), { type: 'run.waiting', runId, taskId }).catch(() => undefined);
    } else {
      await this.finalizeAssistantMessage(run, metadata.assistantMessageId, outcome);
    }
    return outcome;
  }

  /** P3 最小续跑重放：transcript（去掉 seq0 user 与开头 system 行）→ LLM messages 顺序 */
  private replayHistory(transcript: Array<{ role: string; content: string; toolCallId: string | null; toolCalls: unknown }>): ChatMessage[] {
    const rows = transcript.filter((r) => r.role !== 'user');
    const withoutSystem = rows[0]?.role === 'system' ? rows.slice(1) : rows; // systemPrompt 由 engine 前插
    return withoutSystem.map((r) => ({
      role: r.role as ChatMessage['role'],
      content: r.content,
      tool_call_id: r.toolCallId ?? undefined,
      tool_calls: (r.toolCalls as Array<{ id: string; name: string; arguments: string }> | null) ?? undefined,
    }));
  }

  /** assistant Message 终态落库（fencing：仅当 run 已终态且仍是我的 workerId——绝不覆盖他人结果） */
  private async finalizeAssistantMessage(
    run: { id: string; workerId: string | null },
    assistantMessageId: string | undefined,
    outcome: AgentRunOutcome,
  ): Promise<void> {
    if (!assistantMessageId) return;
    const fresh = await this.prisma.agentRun.findUnique({ where: { id: run.id }, select: { status: true, workerId: true } });
    if (!fresh || fresh.status === 'running' || fresh.workerId !== run.workerId) return; // 未终态 / 被接管 → 不写
    const map: Record<string, { status: 'completed' | 'failed' | 'cancelled'; errorCode?: string | null }> = {
      completed: { status: 'completed' },
      cancelled: { status: 'cancelled' },
      failed: { status: 'failed', errorCode: outcome.errorCode ?? null },
      timeout: { status: 'failed', errorCode: outcome.errorCode ?? 'AGENT_RUN_TIMEOUT' },
    };
    const final = map[outcome.status] ?? { status: 'failed', errorCode: outcome.errorCode ?? null };
    await this.prisma.message.update({
      where: { id: assistantMessageId },
      data: {
        content: final.status === 'completed' ? outcome.content : outcome.content.slice(0, 2000),
        status: final.status, errorCode: final.errorCode ?? null,
      },
    }).catch(() => undefined);
  }

  /** run 剩余 deadline（绝对语义：自 startedAt；lease TTL / heartbeat / LLM / tool 超时互不混用） */
  private async remainingDeadlineMs(startedAt: Date): Promise<number> {
    const deadlineMs = await this.lease.runDeadlineMs();
    const remaining = deadlineMs - (Date.now() - startedAt.getTime());
    return Math.max(1, remaining);
  }
}
