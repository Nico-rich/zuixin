import { Inject, Injectable, Logger } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { ZodSchema } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { AgentEvent, AppError, ErrorCode } from '@ai-agent/shared';
import { PrismaService } from '../../modules/prisma/prisma.service';
import { UsageService } from '../../modules/usage/usage.service';
import { ModelResolverService } from '../../providers/llm/model-resolver.service';
import { LLMManagerService } from '../../providers/llm/llm-manager.service';
import { ResolvedLLM } from '../../providers/llm/llm-manager.service';
import { ChatMessage, ToolDefinitionWire } from '../../providers/llm/llm.types';
import { ToolRegistry } from '../tools/tool-registry.service';
import { ToolContext } from '../tools/tool.types';
import { mapProviderError, ProviderLikeError } from '../../common/errors/provider-error';

export interface AgentLoopAgentConfig {
  id: string;
  systemPrompt?: string;
  modelId?: string | null;
  tools: string[];                 // 允许的工具清单（服务端权限边界）
  temperature?: number;
  maxTokens?: number;
  maxSteps?: number;               // 默认 8
}

export interface AgentLoopInput {
  userId: string;
  projectId?: string;
  conversationId?: string;
  messageId: string;
  userMessage: string;
  history: ChatMessage[];
  agent: AgentLoopAgentConfig;
  deadlineMs?: number;             // 默认 120s
  signal: AbortSignal;
}

const DEFAULT_MAX_STEPS = 8;
const DEFAULT_DEADLINE_MS = 120_000;
const DEFAULT_TOOL_TIMEOUT_MS = 30_000;

/**
 * 通用 Agent Loop（决策者）：
 * 上下文 → LLM（工具定义）→ tool_calls? → 校验/权限/执行/回喂 → 重复 → final。
 * - 不保存模型内部 chain-of-thought（step type=reasoning 不落 LLM 推理内容）；
 * - 终态保证：completed/failed/cancelled/timeout，条件更新禁止终态复活；
 * - 循环检测：连续两次同 Tool 同参数 → AGENT_LOOP_DETECTED；
 * - 身份与权限：ToolContext 由本服务注入，Tool 输入不允许身份字段。
 */
@Injectable()
export class AgentLoopService {
  private readonly logger = new Logger('AgentLoop');

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(ToolRegistry) private readonly registry: ToolRegistry,
    @Inject(ModelResolverService) private readonly modelResolver: ModelResolverService,
    @Inject(LLMManagerService) private readonly llmManager: LLMManagerService,
    @Inject(UsageService) private readonly usage: UsageService,
  ) {}

  async *execute(input: AgentLoopInput): AsyncIterable<AgentEvent> {
    const maxSteps = input.agent.maxSteps ?? DEFAULT_MAX_STEPS;
    const deadline = Date.now() + (input.deadlineMs ?? DEFAULT_DEADLINE_MS);
    const run = await this.prisma.agentRun.create({
      data: {
        userId: input.userId, agentId: input.agent.id,
        projectId: input.projectId, conversationId: input.conversationId,
        maxSteps, metadata: { agentTools: input.agent.tools },
      },
    });
    yield { type: 'run.created', runId: run.id, agentId: input.agent.id };
    yield { type: 'agent.start', agentId: input.agent.id, runId: run.id };
    yield { type: 'status', stage: 'agent', message: '正在分析需求…' };

    const messages: ChatMessage[] = [
      ...(input.agent.systemPrompt ? [{ role: 'system' as const, content: input.agent.systemPrompt }] : []),
      ...input.history,
      { role: 'user' as const, content: input.userMessage },
    ];
    const toolDefs = this.toolDefinitions(input.agent.tools);
    let finalStatus: 'completed' | 'failed' | 'cancelled' | 'timeout' = 'completed';
    let errorCode: string | undefined;
    let lastToolSignature: string | null = null;

    try {
      for (let step = 0; step < maxSteps; step++) {
        if (input.signal.aborted) { finalStatus = 'cancelled'; break; }
        if (Date.now() >= deadline) { finalStatus = 'timeout'; errorCode = ErrorCode.AGENT_RUN_TIMEOUT; break; }

        const resolved = await this.resolveLLM(input.agent);
        const turnStarted = Date.now();
        const stream = resolved.adapter.stream({
          model: resolved.apiModelId, messages, temperature: input.agent.temperature ?? 0.7,
          maxTokens: input.agent.maxTokens, tools: toolDefs.length ? toolDefs : undefined, signal: input.signal,
        });
        let toolCalls: Array<{ id: string; name: string; arguments: string }> | undefined;
        for await (const chunk of stream) {
          if (chunk.type === 'text') yield { type: 'text.delta', text: chunk.text };
          else if (chunk.type === 'tool_calls') toolCalls = chunk.toolCalls;
        }
        // 每回合 LLM 用量落库（runId 关联 → 未来按 Run 聚合四类成本）
        await this.usage.recordChatUsage({
          userId: input.userId, conversationId: input.conversationId ?? '', messageId: input.messageId,
          providerId: resolved.providerId, modelId: resolved.modelId, runId: run.id,
          inputTokens: 0, outputTokens: 0, latencyMs: Date.now() - turnStarted, status: 'success',
        }).catch(() => undefined);
        if (!toolCalls?.length) break; // final 回答已流式输出

        // 循环检测：连续两次相同 Tool 同参数
        const signature = toolCalls.map((t) => `${t.name}:${t.arguments}`).sort().join('|');
        if (signature === lastToolSignature) {
          finalStatus = 'failed'; errorCode = ErrorCode.AGENT_LOOP_DETECTED;
          yield { type: 'status', stage: 'agent', message: '检测到重复操作，已停止' };
          break;
        }
        lastToolSignature = signature;

        const stepRow = await this.prisma.agentRunStep.create({
          data: { runId: run.id, stepIndex: step, type: 'tool_call', status: 'running' },
        });
        yield { type: 'run.progress', runId: run.id, currentStep: step + 1, maxSteps };

        for (const [toolIndex, call] of toolCalls.entries()) {
          yield { type: 'status', stage: 'tool', message: `正在调用 ${call.name}…` };
          yield { type: 'tool.start', toolName: call.name, runId: run.id };
          const result = await this.executeToolCall(input, run.id, stepRow.id, toolIndex, call, toolDefs, input.signal);
          // 生成类工具 → 转发 task.created（前端 TaskCard 依赖，与 Image/Video Agent 行为一致）
          const taskId = (result.output as { taskId?: string } | undefined)?.taskId;
          if (result.status === 'completed' && taskId && (call.name === 'image.generate' || call.name === 'video.generate')) {
            yield { type: 'task.created', taskId, kind: call.name === 'image.generate' ? 'image' : 'video' };
          }
          // 回喂模型（无论成败——失败让模型看到错误并修正）
          messages.push({ role: 'assistant', content: '', tool_calls: toolCalls });
          messages.push({ role: 'tool', content: JSON.stringify(result.output ?? result.error ?? {}), tool_call_id: call.id });
          yield { type: 'tool.end', toolName: call.name, runId: run.id, status: result.status, outputSummary: result.outputSummary };
        }
        await this.prisma.agentRunStep.update({
          where: { id: stepRow.id }, data: { status: 'completed', completedAt: new Date(), output: { toolCount: toolCalls.length } },
        });
        await this.prisma.agentRun.update({ where: { id: run.id }, data: { currentStep: step + 1 } });
      }
      if (finalStatus === 'completed' && input.signal.aborted) finalStatus = 'cancelled';

      await this.prisma.agentRunStep.create({
        data: { runId: run.id, stepIndex: 999, type: 'final', status: finalStatus === 'completed' ? 'completed' : 'failed', output: { finalStatus } },
      });
    } catch (err) {
      const appErr = err instanceof AppError ? err : mapProviderError(err as ProviderLikeError);
      finalStatus = appErr.code === ErrorCode.AGENT_RUN_TIMEOUT ? 'timeout' : 'failed';
      errorCode = appErr.code;
      yield { type: 'error', code: appErr.code, message: appErr.message };
    } finally {
      // 条件更新：终态不可复活（状态机锁定）
      await this.prisma.agentRun.updateMany({
        where: { id: run.id, status: 'running' },
        data: { status: finalStatus, errorCode, errorMessage: errorCode ? this.messageFor(errorCode) : null, completedAt: new Date() },
      });
      yield { type: 'agent.end', agentId: input.agent.id, runId: run.id, status: finalStatus };
      yield { type: 'run.completed', runId: run.id, status: finalStatus };
    }
  }

  /** 单个 Tool 执行：权限校验 → 幂等查重 → execute（超时包裹）→ ToolCall 落库 */
  private async executeToolCall(
    input: AgentLoopInput, runId: string, stepId: string, toolIndex: number,
    call: { id: string; name: string; arguments: string }, toolDefs: ToolDefinitionWire[], signal: AbortSignal,
  ): Promise<{ status: 'completed' | 'failed'; output?: unknown; error?: string; outputSummary?: string }> {
    const tool = this.registry.get(call.name);
    const idempotencyKey = createHash('sha256').update(`${runId}:${stepId}:${toolIndex}:${call.name}:${call.arguments}`).digest('hex');

    // 权限边界 1：Tool 必须在 Agent 允许清单内（LLM 输出不能扩大权限）
    if (!tool || !input.agent.tools.includes(call.name)) {
      await this.recordToolCall(stepId, call.name, idempotencyKey, call.arguments, undefined, 'failed', ErrorCode.TOOL_DENIED, '无权限调用该工具');
      return { status: 'failed', error: '无权限调用该工具', outputSummary: `${call.name}：无权限` };
    }
    // 权限边界 2：审批/高权限工具在 M4 一律拒绝（M6 接审批状态机）
    if (tool.requiresApproval || tool.permission === 'external_action') {
      await this.recordToolCall(stepId, call.name, idempotencyKey, call.arguments, undefined, 'failed', ErrorCode.TOOL_DENIED, '该工具需要审批（M6 上线）');
      return { status: 'failed', error: '该工具需要审批，当前不可用', outputSummary: `${call.name}：需要审批` };
    }

    // 幂等查重：同一 (runId, idempotencyKey) 已完成 → 复用输出，不重复执行
    const existing = await this.prisma.toolCall.findUnique({ where: { runStepId_idempotencyKey: { runStepId: stepId, idempotencyKey } } });
    if (existing?.status === 'completed' && existing.output) {
      return { status: 'completed', output: existing.output, outputSummary: '（复用已执行结果）' };
    }

    // 输入校验（strictObject 已拒绝身份字段；此处兜底非法 JSON）
    let parsedInput: unknown;
    try {
      parsedInput = tool.inputSchema.parse(JSON.parse(call.arguments || '{}'));
    } catch (err) {
      const msg = `参数校验失败: ${(err as Error).message}`;
      await this.recordToolCall(stepId, call.name, idempotencyKey, call.arguments, undefined, 'failed', ErrorCode.VALIDATION_ERROR, msg);
      return { status: 'failed', error: msg, outputSummary: `${call.name}：参数非法` };
    }

    const toolCtx: ToolContext = {
      userId: input.userId, projectId: input.projectId, conversationId: input.conversationId,
      messageId: input.messageId, agentRunId: runId, agentRunStepId: stepId,
      idempotencyKey, signal,
    };
    const startedAt = Date.now();
    try {
      const combinedSignal = AbortSignal.any([signal, AbortSignal.timeout(tool.timeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS)]);
      const output = await tool.execute(parsedInput, { ...toolCtx, signal: combinedSignal });
      await this.recordToolCall(stepId, call.name, idempotencyKey, call.arguments, output, 'completed', undefined, undefined, Date.now() - startedAt);
      return { status: 'completed', output, outputSummary: this.summarize(call.name, output) };
    } catch (err) {
      const appErr = err instanceof AppError ? err : new AppError(ErrorCode.PROVIDER_UNKNOWN, (err as Error).message);
      await this.recordToolCall(stepId, call.name, idempotencyKey, call.arguments, undefined, 'failed', appErr.code, appErr.message, Date.now() - startedAt);
      return { status: 'failed', error: appErr.message, outputSummary: `${call.name}：执行失败` };
    }
  }

  private async recordToolCall(
    stepId: string, toolName: string, idempotencyKey: string, inputJson: string,
    output: unknown, status: 'running' | 'completed' | 'failed', errorCode?: string, errorMessage?: string, durationMs?: number,
  ) {
    try {
      await this.prisma.toolCall.create({
        data: {
          runStepId: stepId, toolName, idempotencyKey,
          input: JSON.parse(inputJson || '{}') as never, output: output as never,
          status, errorCode, errorMessage, durationMs,
          completedAt: status === 'running' ? null : new Date(),
        },
      });
    } catch (err) {
      // UNIQUE(runStepId, idempotencyKey) 竞态：并发重复 → 已存在即幂等成功
      this.logger.warn(`ToolCall 落库冲突（幂等兜底）: ${(err as Error).message}`);
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
