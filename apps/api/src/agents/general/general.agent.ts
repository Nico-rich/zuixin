import { AgentEvent } from '@ai-agent/shared';
import { Agent, AgentContext } from '../agent.types';
import { AgentRuntimeEngine, AgentLoopAgentConfig } from '../../core/agent-loop/agent-runtime-engine';
import { ContextAssembler } from '../../core/context/context-assembler';

export interface GeneralAgentDeps {
  engine: AgentRuntimeEngine;
  context: ContextAssembler;
  config: AgentLoopAgentConfig;
}

/**
 * 通用助手 Agent = M6-P2 Sync Driver：
 * 职责只保留——上下文组装（ContextAssembler，唯一入口）+ RuntimeContext 构建（身份来自服务端 ctx，
 * 用户输入不可指定 userId/runId/agentVersionId）+ Engine 事件流透传。
 * SSE 输出、消息落库、锁释放等 HTTP 侧职责全部留在 ChatService。
 */
export class GeneralAssistantAgent implements Agent {
  readonly id: string;

  constructor(private readonly deps: GeneralAgentDeps) {
    this.id = deps.config.id;
  }

  async *execute(ctx: AgentContext): AsyncIterable<AgentEvent> {
    const { messages } = await this.deps.context.assemble({
      userId: ctx.userId,
      conversationId: ctx.conversationId,
      projectId: ctx.projectId,
      userMessage: ctx.userMessage,
      excludeMessageId: ctx.messageId,
      // Knowledge 自动检索开关（Agent 版本配置 knowledge.enabled；默认关闭，普通聊天不触发 embedding）
      knowledge: { enabled: this.deps.config.knowledgeEnabled ?? false },
      // 上下文预算（AgentVersion 配置；默认 limits.contextBudgetTokens=8000）
      budgetTokens: this.deps.config.contextBudgetTokens,
    });
    const run = this.deps.engine.run({
      userId: ctx.userId,
      projectId: ctx.projectId,
      conversationId: ctx.conversationId,
      messageId: ctx.messageId,
      userMessage: ctx.userMessage,
      history: messages,
      agent: this.deps.config,
      signal: ctx.signal ?? new AbortController().signal,
    });
    for await (const event of run) {
      yield event;
    }
    // outcome 由引擎在 generator return 中产出（P3 Async Driver 直接消费；Sync 路径契约 = 事件流，冻结不变）
    await run.next();
  }
}
