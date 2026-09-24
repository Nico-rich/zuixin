import { Inject, Injectable, Logger } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { ZodSchema } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { AgentEvent, AppError, ErrorCode } from '@ai-agent/shared';
import { ModelResolverService } from '../../providers/llm/model-resolver.service';
import { LLMManagerService } from '../../providers/llm/llm-manager.service';
import { ResolvedLLM } from '../../providers/llm/llm-manager.service';
import { ChatMessage, ToolDefinitionWire } from '../../providers/llm/llm.types';
import { ToolRegistry } from '../tools/tool-registry.service';
import { ToolContext } from '../tools/tool.types';
import { mapProviderError, ProviderLikeError } from '../../common/errors/provider-error';
import { AGENT_RUNTIME_PERSISTENCE, AgentRuntimePersistence } from './runtime-persistence';

export interface AgentLoopAgentConfig {
  id: string;
  systemPrompt?: string;
  modelId?: string | null;
  tools: string[];                 // 允许的工具清单（服务端权限边界）
  /** 该 Agent 的任务是否必须依赖工具（true 时模型不支持工具调用 → NO_TOOL_CAPABILITY 终态，不伪装完成） */
  requiresTools?: boolean;
  temperature?: number;
  maxTokens?: number;
  maxSteps?: number;               // 默认 8
  /** AgentVersion 快照 id：Run 创建时锁定，此后永不改变 */
  versionId?: string;
  /** Knowledge 自动检索开关（KnowledgeSource 触发机制；默认关闭） */
  knowledgeEnabled?: boolean;
  /** 上下文 token 预算（AgentVersion config 覆盖 limits 默认；服务端配置，用户不可改） */
  contextBudgetTokens?: number;
}

/** Engine 输入上下文：身份全部由服务端（Sync Driver）构建，用户输入不可指定 */
export interface AgentRuntimeContext {
  userId: string;
  projectId?: string;
  conversationId?: string;
  messageId: string;
  userMessage: string;
  history: ChatMessage[];
  agent: AgentLoopAgentConfig;
  /** 相对 deadline（ms）；缺省取 limits.agentRunTimeoutMs，再缺省 120s。P3 分层超时不动本字段 */
  deadlineMs?: number;
  signal: AbortSignal;
}

/** Engine 结构化结果（不携带 Prisma model，不含内部敏感信息） */
export interface AgentRunOutcome {
  runId: string;
  status: 'completed' | 'failed' | 'cancelled' | 'timeout';
  /** 最终回答全文（text.delta 累积；Sync Driver/Chat 仍自持 buffer，行为冻结） */
  content: string;
  errorCode?: string;
  /** 安全错误摘要 */
  errorMessage?: string;
  /** 本次 run 创建的生成任务引用（task.created 转发过的 taskId） */
  taskRefs: string[];
}

const DEFAULT_MAX_STEPS = 8;
const DEFAULT_DEADLINE_MS = 120_000;
const DEFAULT_TOOL_TIMEOUT_MS = 30_000;
/** Tool Result 内容预算（确定性截断，防止多工具结果无限增长；消息配对不受影响） */
const TOOL_RESULT_MAX_CHARS = 4000;
const TOOL_RESULTS_TOTAL_MAX_CHARS = 8000;
/** final 步骤的 stepIndex（run 内唯一，避免与真实循环步冲突） */
const FINAL_STEP_INDEX = 999;

/**
 * AgentRuntime Engine（M6-P2 抽取）：
 * - 不依赖 HTTP/SSE/Chat/Controller/前端；事件经 AsyncGenerator 产出（SSE 写入留在 Driver 侧）；
 * - 不直接操作 Provider（经 LLMManager/ModelResolver 抽象）与 DB（经 AgentRuntimePersistence 边界）；
 * - transcript checkpoint：初始上下文 seed → 每回合 assistant 快照 → 每工具 tool 结果（[B]~[J] 边界）；
 * - 终态保证：completed/failed/cancelled/timeout，条件更新禁止终态复活；
 * - 取消：signal.aborted 识别为 cancellation（不伪装 provider failure）。
 * P3 Async Driver 复用同一引擎；P2 不实现 resume/waiting/lease。
 */
@Injectable()
export class AgentRuntimeEngine {
  private readonly logger = new Logger('AgentRuntime');

  constructor(
    @Inject(AGENT_RUNTIME_PERSISTENCE) private readonly persistence: AgentRuntimePersistence,
    @Inject(ToolRegistry) private readonly registry: ToolRegistry,
    @Inject(ModelResolverService) private readonly modelResolver: ModelResolverService,
    @Inject(LLMManagerService) private readonly llmManager: LLMManagerService,
  ) {}

  async *run(ctx: AgentRuntimeContext): AsyncGenerator<AgentEvent, AgentRunOutcome, void> {
    const maxSteps = ctx.agent.maxSteps ?? DEFAULT_MAX_STEPS;
    // 超时配置来自 system_settings.limits.agentRunTimeoutMs（与清扫阈值同源，不写死；P2 只保留同步语义）
    const limits = await this.persistence.getSystemSetting('limits');
    const configuredTimeout = (limits as { agentRunTimeoutMs?: number } | null)?.agentRunTimeoutMs;
    const deadline = Date.now() + (ctx.deadlineMs ?? configuredTimeout ?? DEFAULT_DEADLINE_MS);
    const run = await this.persistence.createRun({
      userId: ctx.userId, agentId: ctx.agent.id,
      agentVersionId: ctx.agent.versionId, // 锁定版本快照，永不改变
      projectId: ctx.projectId, conversationId: ctx.conversationId,
      maxSteps, metadata: { agentTools: ctx.agent.tools },
    });
    const runId = run.id;
    yield { type: 'run.created', runId, agentId: ctx.agent.id };
    yield { type: 'agent.start', agentId: ctx.agent.id, runId };
    yield { type: 'status', stage: 'agent', message: '正在分析需求…' };

    const messages: ChatMessage[] = [
      ...(ctx.agent.systemPrompt ? [{ role: 'system' as const, content: ctx.agent.systemPrompt }] : []),
      ...ctx.history,
      { role: 'user' as const, content: ctx.userMessage },
    ];
    // transcript seed：初始上下文（system + history + user）——durable 重放基座（CP0）
    for (const m of messages) {
      await this.persistence.appendMessage(ctx.userId, runId, {
        role: m.role as never,
        content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content),
      }).catch((err) => this.logger.warn(`transcript seed 失败: ${(err as Error).message}`));
    }

    const toolDefs = this.toolDefinitions(ctx.agent.tools);
    let finalStatus: 'completed' | 'failed' | 'cancelled' | 'timeout' = 'completed';
    let errorCode: string | undefined;
    let errorMessage: string | undefined;
    let lastToolSignature: string | null = null;
    let lastTurnHadToolCalls = false;
    let content = '';
    const taskRefs: string[] = [];

    try {
      for (let step = 0; step < maxSteps; step++) {
        if (ctx.signal.aborted) { finalStatus = 'cancelled'; break; }
        if (Date.now() >= deadline) { finalStatus = 'timeout'; errorCode = ErrorCode.AGENT_RUN_TIMEOUT; break; }

        const resolved = await this.resolveLLM(ctx.agent);
        // Tool Calling 能力降级（MUST-3）：capabilities.functionCalling === false 时不发送 tools；
        // requiresTools 的 Agent 直接 NO_TOOL_CAPABILITY 终态——绝不伪装完成。
        const supportsTools = resolved.capabilities?.['functionCalling'] !== false;
        if (toolDefs.length && !supportsTools && ctx.agent.requiresTools) {
          finalStatus = 'failed';
          errorCode = ErrorCode.NO_TOOL_CAPABILITY;
          yield { type: 'status', stage: 'agent', message: '当前模型不支持工具调用，无法完成该任务' };
          break;
        }
        const toolsToSend = toolDefs.length && supportsTools ? toolDefs : undefined;
        const turnStarted = Date.now();
        // 每回合 LLM 用量落库（M5-P4：成功/失败均记录——失败回合可能已计费，必须可观测）
        let toolCalls: Array<{ id: string; name: string; arguments: string }> | undefined;
        let turnText = '';
        try {
          const stream = resolved.adapter.stream({
            model: resolved.apiModelId, messages, temperature: ctx.agent.temperature ?? 0.7,
            maxTokens: ctx.agent.maxTokens, tools: toolsToSend, signal: ctx.signal,
          });
          for await (const chunk of stream) {
            if (chunk.type === 'text') {
              content += chunk.text; turnText += chunk.text;
              yield { type: 'text.delta', text: chunk.text };
            } else if (chunk.type === 'tool_calls') toolCalls = chunk.toolCalls;
          }
        } catch (err) {
          // M6-A8：用户取消 → cancelled（绝不伪装成 provider failure）；中断回合仍记 usage（可能已计费）
          if (ctx.signal.aborted) {
            finalStatus = 'cancelled';
            await this.persistence.recordChatUsage({
              userId: ctx.userId, conversationId: ctx.conversationId, messageId: ctx.messageId,
              providerId: resolved.providerId, modelId: resolved.modelId, runId,
              inputTokens: 0, outputTokens: 0, latencyMs: Date.now() - turnStarted,
              status: 'failed', errorCode: ErrorCode.AGENT_CANCELLED,
            });
            break;
          }
          const appErr = err instanceof AppError ? err : mapProviderError(err as ProviderLikeError);
          await this.persistence.recordChatUsage({
            userId: ctx.userId, conversationId: ctx.conversationId, messageId: ctx.messageId,
            providerId: resolved.providerId, modelId: resolved.modelId, runId,
            inputTokens: 0, outputTokens: 0, latencyMs: Date.now() - turnStarted,
            status: 'failed', errorCode: appErr.code,
          });
          throw err;
        }
        await this.persistence.recordChatUsage({
          userId: ctx.userId, conversationId: ctx.conversationId, messageId: ctx.messageId,
          providerId: resolved.providerId, modelId: resolved.modelId, runId,
          inputTokens: 0, outputTokens: 0, latencyMs: Date.now() - turnStarted, status: 'success',
        });
        lastTurnHadToolCalls = !!toolCalls?.length;
        // transcript checkpoint（CP1）：assistant 回合快照——含 tool_calls 决策事实，resume 不重打 LLM
        await this.persistence.appendMessage(ctx.userId, runId, {
          role: 'assistant', content: turnText,
          toolCalls: toolCalls?.length ? toolCalls.map((t) => ({ id: t.id, name: t.name, arguments: t.arguments })) : undefined,
        }).catch((err) => this.logger.warn(`transcript assistant 落库失败: ${(err as Error).message}`));

        if (!toolCalls?.length) break; // final 回答已流式输出

        // 循环检测：连续两次相同 Tool 同参数
        const signature = toolCalls.map((t) => `${t.name}:${t.arguments}`).sort().join('|');
        if (signature === lastToolSignature) {
          finalStatus = 'failed'; errorCode = ErrorCode.AGENT_LOOP_DETECTED;
          yield { type: 'status', stage: 'agent', message: '检测到重复操作，已停止' };
          break;
        }
        lastToolSignature = signature;

        // CP2：step 行先建（UNIQUE(runId, stepIndex) 幂等锚点）
        const stepRow = await this.persistence.createStep({ runId, stepIndex: step, type: 'tool_call', status: 'running' });
        yield { type: 'run.progress', runId, currentStep: step + 1, maxSteps };

        // B1 修复：assistant tool_calls 消息每回合 push 一次（非逐工具重复）
        messages.push({ role: 'assistant', content: '', tool_calls: toolCalls });

        for (const [toolIndex, call] of toolCalls.entries()) {
          yield { type: 'status', stage: 'tool', message: `正在调用 ${call.name}…` };
          yield { type: 'tool.start', toolName: call.name, runId };
          const result = await this.executeToolCall(ctx, runId, stepRow.id, toolIndex, call, ctx.signal);
          // 生成类工具 → 转发 task.created（前端 TaskCard 依赖，与 Image/Video Agent 行为一致）
          const taskId = (result.output as { taskId?: string } | undefined)?.taskId;
          if (result.status === 'completed' && taskId && (call.name === 'image.generate' || call.name === 'video.generate')) {
            taskRefs.push(taskId);
            yield { type: 'task.created', taskId, kind: call.name === 'image.generate' ? 'image' : 'video' };
          }
          // 回喂模型（无论成败——失败让模型看到错误并修正）
          // P6 Tool Result Budget：内容纳入确定性截断（不破坏 assistant tool_call / tool result 消息配对）
          const toolContent = this.truncateToolResult(JSON.stringify(result.output ?? result.error ?? {}));
          messages.push({ role: 'tool', content: toolContent, tool_call_id: call.id });
          // transcript checkpoint（CP4）：tool 结果（截断后内容与喂给 LLM 的一致）
          await this.persistence.appendMessage(ctx.userId, runId, {
            role: 'tool', content: toolContent, toolCallId: call.id,
          }).catch((err) => this.logger.warn(`transcript tool 落库失败: ${(err as Error).message}`));
          this.compactToolResults(messages);
          yield { type: 'tool.end', toolName: call.name, runId, status: result.status, outputSummary: result.outputSummary };
        }
        await this.persistence.updateStep(stepRow.id, { status: 'completed', completedAt: new Date(), output: { toolCount: toolCalls.length } });
        await this.persistence.updateCurrentStep(runId, step + 1);
      }
      if (finalStatus === 'completed' && ctx.signal.aborted) finalStatus = 'cancelled';
      // MUST-2：maxSteps 耗尽且最后一轮仍是工具调用 → 硬失败，不得伪装 completed
      if (finalStatus === 'completed' && lastTurnHadToolCalls) {
        finalStatus = 'failed';
        errorCode = ErrorCode.AGENT_MAX_STEPS;
        yield { type: 'status', stage: 'agent', message: '任务过于复杂，已达到最大步骤数' };
      }

      await this.persistence.createStep({
        runId, stepIndex: FINAL_STEP_INDEX, type: 'final',
        status: finalStatus === 'completed' ? 'completed' : 'failed',
        output: { finalStatus },
      });
    } catch (err) {
      // 取消在回合内已被识别；此处仅为兜底（例如 createStep 阶段 signal 已 abort）
      if (ctx.signal.aborted) {
        finalStatus = 'cancelled';
        errorCode = undefined;
      } else {
        const appErr = err instanceof AppError ? err : mapProviderError(err as ProviderLikeError);
        finalStatus = appErr.code === ErrorCode.AGENT_RUN_TIMEOUT ? 'timeout' : 'failed';
        errorCode = appErr.code;
        yield { type: 'error', code: appErr.code, message: appErr.message };
      }
    } finally {
      // 条件更新：终态不可复活（状态机锁定）
      await this.persistence.finalizeRun(runId, {
        status: finalStatus, errorCode: errorCode ?? null, errorMessage: errorCode ? this.messageFor(errorCode) : null,
        completedAt: new Date(),
      });
      yield { type: 'agent.end', agentId: ctx.agent.id, runId, status: finalStatus };
      yield { type: 'run.completed', runId, status: finalStatus };
    }

    return {
      runId, status: finalStatus, content, errorCode,
      errorMessage: errorCode ? this.messageFor(errorCode) : undefined,
      taskRefs,
    };
  }

  /** 单个 Tool 执行：权限校验 → 幂等查重 → execute（超时包裹）→ ToolCall 落库（P2 保持 M5 顺序） */
  private async executeToolCall(
    ctx: AgentRuntimeContext, runId: string, stepId: string, toolIndex: number,
    call: { id: string; name: string; arguments: string }, signal: AbortSignal,
  ): Promise<{ status: 'completed' | 'failed'; output?: unknown; error?: string; outputSummary?: string }> {
    const tool = this.registry.get(call.name);
    const idempotencyKey = createHash('sha256').update(`${runId}:${stepId}:${toolIndex}:${call.name}:${call.arguments}`).digest('hex');

    // 权限边界 1：Tool 必须在 Agent 允许清单内（LLM 输出不能扩大权限）
    if (!tool || !ctx.agent.tools.includes(call.name)) {
      await this.persistence.createToolCall({
        runStepId: stepId, toolName: call.name, idempotencyKey, input: JSON.parse(call.arguments || '{}'),
        status: 'failed', errorCode: ErrorCode.TOOL_DENIED, errorMessage: '无权限调用该工具',
      }).catch(() => undefined);
      return { status: 'failed', error: '无权限调用该工具', outputSummary: `${call.name}：无权限` };
    }
    // 权限边界 2：审批/高权限工具在 M4 一律拒绝（M7 接审批状态机）
    if (tool.requiresApproval || tool.permission === 'external_action') {
      await this.persistence.createToolCall({
        runStepId: stepId, toolName: call.name, idempotencyKey, input: JSON.parse(call.arguments || '{}'),
        status: 'failed', errorCode: ErrorCode.TOOL_DENIED, errorMessage: '该工具需要审批（M7 上线）',
      }).catch(() => undefined);
      return { status: 'failed', error: '该工具需要审批，当前不可用', outputSummary: `${call.name}：需要审批` };
    }

    // 幂等查重：同一 (runStepId, idempotencyKey) 已完成 → 复用输出，不重复执行
    const existing = await this.persistence.findToolCall(stepId, idempotencyKey);
    if (existing?.status === 'completed' && existing.output != null) {
      return { status: 'completed', output: existing.output, outputSummary: '（复用已执行结果）' };
    }

    // 输入校验（strictObject 已拒绝身份字段；此处兜底非法 JSON）
    let parsedInput: unknown;
    try {
      parsedInput = tool.inputSchema.parse(JSON.parse(call.arguments || '{}'));
    } catch (err) {
      const msg = `参数校验失败: ${(err as Error).message}`;
      await this.persistence.createToolCall({
        runStepId: stepId, toolName: call.name, idempotencyKey, input: JSON.parse(call.arguments || '{}'),
        status: 'failed', errorCode: ErrorCode.VALIDATION_ERROR, errorMessage: msg,
      }).catch(() => undefined);
      return { status: 'failed', error: msg, outputSummary: `${call.name}：参数非法` };
    }

    // 执行前先落 ToolCall 行（running）——行 id 作为 toolCallId 注入执行上下文（FK 追溯真实行）；
    // 执行后更新该行终态。并发重试撞唯一约束 → 查重复用。
    let toolCallId: string;
    try {
      const row = await this.persistence.createToolCall({
        runStepId: stepId, toolName: call.name, idempotencyKey, input: parsedInput, status: 'running',
      });
      toolCallId = row.id;
    } catch (err) {
      if ((err as { code?: string }).code === 'P2002') {
        const existingRow = await this.persistence.findToolCall(stepId, idempotencyKey);
        if (existingRow?.status === 'completed' && existingRow.output != null) {
          return { status: 'completed', output: existingRow.output, outputSummary: '（复用已执行结果）' };
        }
      }
      throw err;
    }

    const toolCtx: ToolContext = {
      userId: ctx.userId, projectId: ctx.projectId, conversationId: ctx.conversationId,
      messageId: ctx.messageId, agentRunId: runId, agentRunStepId: stepId,
      toolCallId, idempotencyKey, signal,
    };
    const startedAt = Date.now();
    try {
      const combinedSignal = AbortSignal.any([signal, AbortSignal.timeout(tool.timeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS)]);
      const output = await tool.execute(parsedInput, { ...toolCtx, signal: combinedSignal });
      await this.persistence.updateToolCall(toolCallId, {
        output, status: 'completed', completedAt: new Date(), durationMs: Date.now() - startedAt,
      }).catch((err) => this.logger.warn(`ToolCall 完成更新失败（幂等兜底）: ${(err as Error).message}`));
      return { status: 'completed', output, outputSummary: this.summarize(call.name, output) };
    } catch (err) {
      // M5 行为冻结：工具层失败一律回喂模型（含取消中断）——取消在下一步步首检查中被识别
      const appErr = err instanceof AppError ? err : new AppError(ErrorCode.PROVIDER_UNKNOWN, (err as Error).message);
      await this.persistence.updateToolCall(toolCallId, {
        status: 'failed', errorCode: appErr.code, errorMessage: appErr.message, completedAt: new Date(), durationMs: Date.now() - startedAt,
      }).catch((e) => this.logger.warn(`ToolCall 失败更新异常: ${(e as Error).message}`));
      return { status: 'failed', error: appErr.message, outputSummary: `${call.name}：执行失败` };
    }
  }

  private toolDefinitions(allowed: string[]): ToolDefinitionWire[] {
    return this.registry.listForAgent(allowed).map((t): ToolDefinitionWire => ({
      type: 'function',
      function: {
        name: t.name, description: t.description,
        parameters: toJsonSchemaParams(t.inputSchema),
      },
    }));
  }

  private async resolveLLM(agent: AgentLoopAgentConfig): Promise<ResolvedLLM> {
    if (agent.modelId) return this.llmManager.resolve(agent.modelId);
    return this.modelResolver.resolveDefaultLLM();
  }

  /**
   * Tool Result 确定性截断（P6）：
   * 单条 > TOOL_RESULT_MAX_CHARS → 截断到上限（保留头部）；
   * 累计 tool 消息内容 > TOOL_RESULTS_TOTAL_MAX_CHARS → 从最旧的 tool 消息截断到 500 字符并加标记。
   * 只截内容不删消息——assistant tool_call / tool result 配对永远完整，provider message sequence 合法。
   */
  private truncateToolResult(content: string): string {
    let truncated = content;
    if (truncated.length > TOOL_RESULT_MAX_CHARS) {
      truncated = truncated.slice(0, TOOL_RESULT_MAX_CHARS) + `…（已截断，共 ${content.length} 字符）`;
    }
    return truncated;
  }

  /** 累计截断：tool 结果内容总量超限时从最旧截断（只缩内容，不删消息，配对完整） */
  private compactToolResults(messages: ChatMessage[]): void {
    const toolIdx: number[] = [];
    let total = 0;
    for (let i = 0; i < messages.length; i++) {
      if (messages[i].role === 'tool') { toolIdx.push(i); total += messages[i].content.length; }
    }
    if (total <= TOOL_RESULTS_TOTAL_MAX_CHARS) return;
    for (const i of toolIdx) {
      const m = messages[i];
      if (m.content.length > 500) {
        messages[i] = { ...m, content: m.content.slice(0, 500) + '…（历史工具结果已截断）' };
        total -= m.content.length - messages[i].content.length;
      }
      if (total <= TOOL_RESULTS_TOTAL_MAX_CHARS) break;
    }
  }

  private summarize(name: string, output: unknown): string {
    const o = output as Record<string, unknown>;
    if (name === 'image.generate' || name === 'video.generate') return `已创建生成任务 ${o?.taskId ?? ''}`;
    if (name === 'artifact.create') return `已创建制品 ${o?.artifactId ?? ''}`;
    if (name === 'memory.create_candidate') return `已记录记忆候选 ${o?.memoryId ?? ''}`;
    return '执行完成';
  }

  private messageFor(code: string): string {
    switch (code) {
      case ErrorCode.AGENT_MAX_STEPS: return '任务过于复杂，已达到最大步骤数';
      case ErrorCode.AGENT_RUN_TIMEOUT: return '执行超时';
      case ErrorCode.AGENT_LOOP_DETECTED: return '检测到重复操作，已停止';
      default: return '执行失败';
    }
  }
}

/** 非泛型边界：切断 zod-to-json-schema 的深层类型实例化 */
function toJsonSchemaParams(schema: ZodSchema): Record<string, unknown> {
  return zodToJsonSchema(schema as never) as Record<string, unknown>;
}
