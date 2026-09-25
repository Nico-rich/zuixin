import { Inject, Injectable } from '@nestjs/common';
import { PrismaService } from '../../modules/prisma/prisma.service';
import { AgentRuntimeEngine, AgentRuntimeContext, AgentRunOutcome } from '../../core/agent-loop/agent-runtime-engine';
import { ContextAssembler } from '../../core/context/context-assembler';
import { ContextBudgetService, scopePriority } from '../../core/context/context-budget.service';
import { MemoryBlock } from '../../core/context/types';
import { ChatMessage } from '../../providers/llm/llm.types';
import { AgentRunLeaseService } from '../../core/agent-run-lease/agent-run-lease.service';
import { EventBusService, agentRunChannel } from '../../core/events/event-bus.service';
import { planResume } from '../../core/agent-loop/resume-planner';
import { BillingService } from '../../modules/billing/billing.service';
import { QuotaService } from '../../modules/billing/quota.service';

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
    @Inject(ContextBudgetService) private readonly budget: ContextBudgetService,
    @Inject(AgentRunLeaseService) private readonly lease: AgentRunLeaseService,
    @Inject(EventBusService) private readonly events: EventBusService,
    @Inject(BillingService) private readonly billing: BillingService,
    @Inject(QuotaService) private readonly quota: QuotaService,
  ) {}

  async execute(runId: string, signal: AbortSignal, controls: { active: boolean }): Promise<AgentRunOutcome> {
    const run = await this.prisma.agentRun.findUnique({ where: { id: runId }, include: { agentVersion: true } });
    if (!run || run.status !== 'running') {
      // 已被取消/终态/他人处理 → 幂等退出
      return { runId, status: run?.status === 'cancelled' ? 'cancelled' : 'failed', content: '', taskRefs: [], approvalRefs: [], delegationRefs: [] };
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
    // P3：续跑重放**必须**过 ContextBudgetService（与首跑同一裁剪语义）——resumePlan 仍取全量 transcript；
    // 被裁剪的只是发给 LLM 的 messages（绝不裁剪 transcript 本身，Durable Resume 事实层完整无损）。
    const history: ChatMessage[] = continuation
      ? await this.budgetReplayHistory(this.replayHistory(transcript), cfg.contextBudgetTokens)
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
      // Pre-M9 T1：组织归属每 run 解析一次（项目组织 > 个人组织），usage 写入直传
      organizationId: await this.billing.organizationFor(run.userId, run.projectId),
      conversationId: run.conversationId ?? undefined,
      messageId: metadata.assistantMessageId, // 真实 Message 行或 undefined——绝不传 runId 冒充（GenerationTask.messageId FK）
      userMessage,
      history,
      agent: {
        id: run.agentId, systemPrompt: version.systemPrompt, modelId: version.modelId,
        // M7-P7：委派子 run 的权限子集快照（child ⊆ parent，服务端计算）；无则原版本清单
        tools: ((metadata as { delegationTools?: string[] }).delegationTools ?? version.tools as string[]) ?? [],
        temperature: version.temperature,
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
    try {
      while (true) {
        const { done, value } = await generator.next();
        if (done) { outcome = value; break; }
        // M6-P6：engine 事件 → run 观察通道（SSE 实时通知；DB Timeline 投影仍是历史事实来源）
        // P5：publish 只入缓冲（≤10ms 窗口批量 pipeline 发出）——事件风暴下不再一事件一往返
        await this.events.publish(agentRunChannel(runId), value as Record<string, unknown>).catch(() => undefined);
      }

      // M8-P2 + Pre-M9 D1：run 终态计量只剩离散事件 agent_run（幂等键 = run id——重放绝不重复计量）；
      // llm_tokens/llm_cost/image/video 账本行由 UsageService 在每条 UsageRecord 写入时派生镜像（严格投影，杜绝漂移）。
      if (outcome.status !== 'waiting') {
        await this.billing.recordUsage({
          userId: run.userId, projectId: run.projectId, kind: 'agent_run', quantity: 1,
          runId, idempotencyKey: `run:${runId}:agent-run`,
        }).catch(() => undefined);
        // Pre-M9 C1：终态释放配额预留（释放丢失由 TTL 兜底——期间保守多计，绝不漏计）
        await this.quota.release(runId, 'agent_run').catch(() => undefined);
      }
      if (outcome.status === 'waiting') {
        // P4 waiting：run 仍存活（已落库 waiting+waitingOnTaskId），assistant Message 保持 streaming，无终态写
        const taskId = outcome.taskRefs[0];
        const approvalId = outcome.approvalRefs[0]; // M7-P1：审批等待（与任务等待互斥）
        const delegationId = outcome.delegationRefs[0]; // M7-P7：委派等待
        await this.events.publish(agentRunChannel(runId), { type: 'run.waiting', runId, taskId, approvalId, delegationId }).catch(() => undefined);
      } else {
        await this.finalizeAssistantMessage(run, metadata.assistantMessageId, outcome);
      }
      return outcome;
    } finally {
      // P5：流结束 / 异常路径**强制冲刷**——最后一批事件绝不因 10ms 窗口未到而滞留
      // （SSE 客户端可能在 run 终态后立即断开；异常时同样保证已产生的观察事件送达）
      await this.events.flush().catch(() => undefined);
    }
  }

  /** P3 最小续跑重放：transcript（去掉 seq0 user 与全部 system 行）→ LLM messages 顺序。
   *  system 行（systemPrompt + M7-P9 运行时护栏）由 engine 每次重建——绝不重复注入。 */
  private replayHistory(transcript: Array<{ role: string; content: string; toolCallId: string | null; toolCalls: unknown }>): ChatMessage[] {
    const rows = transcript.filter((r) => r.role !== 'user' && r.role !== 'system');
    return rows.map((r) => ({
      role: r.role as ChatMessage['role'],
      content: r.content,
      tool_call_id: r.toolCallId ?? undefined,
      tool_calls: (r.toolCalls as Array<{ id: string; name: string; arguments: string }> | null) ?? undefined,
    }));
  }

  /**
   * P3 续跑重放上下文预算（原实现全量重放：160KB 级 transcript 直灌首个 LLM 调用）：
   * - 预算来源与首跑同源（ContextAssembler.resolveBudgetTokens：AgentVersion 配置 > limits > 8000）；
   * - 裁剪单位 = 「回合单元」= assistant(tool_calls) + 其后的 tool 结果——**绝不拆散配对**
   *   （孤立 tool 消息会被 provider 拒绝；tool decision 是续跑事实，不可半保留）；
   * - 保留策略与首跑 recent_messages 组一致（priority=5）：从最新向前保留、预算不足整单元丢弃，
   *   输出保持时间正序；
   * - 兜底合法性：若裁剪后首条仍是 tool 结果（其 assistant 决策被丢弃）→ 连同丢弃；
   * - 绝不触碰 ctx.userMessage（engine 单独追加，恒保留）与 resumePlan（早已按全量 transcript 计算）。
   */
  private async budgetReplayHistory(history: ChatMessage[], configured?: number): Promise<ChatMessage[]> {
    if (!history.length) return history;
    const maxTokens = await this.context.resolveBudgetTokens(configured);
    const units = this.groupReplayUnits(history);
    const blocks: MemoryBlock[] = units.map((unit, unitIndex) => ({
      scope: 'conversation',
      role: unit[0].role,
      content: unit.map((m) => (typeof m.content === 'string' ? m.content : '')).join('\n'),
      priority: scopePriority('conversation'), // 与首跑最近消息同组：从最新向前保留
      source: { replayUnit: unitIndex }, // 回填下标（预算服务返回块集合 → 还原回合单元）
    }));
    const kept = this.budget.apply(blocks, { maxTokens }).blocks
      .map((b) => units[(b.source as { replayUnit?: number } | undefined)?.replayUnit ?? -1])
      .filter((unit): unit is ChatMessage[] => Array.isArray(unit));
    const messages = kept.flat();
    let start = 0;
    while (start < messages.length && messages[start].role === 'tool') start++; // 孤立 tool 结果 → 丢弃
    return messages.slice(start);
  }

  /** 回合单元切分：tool 结果恒依附其前的 assistant 决策（同单元生死，绝不产生无主 tool 消息） */
  private groupReplayUnits(history: ChatMessage[]): ChatMessage[][] {
    const units: ChatMessage[][] = [];
    for (const message of history) {
      const current = units[units.length - 1];
      if (current && message.role === 'tool') { current.push(message); continue; }
      units.push([message]);
    }
    return units;
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
