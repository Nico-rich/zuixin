import { AgentEvent } from '@ai-agent/shared';
import { Agent, AgentContext } from '../agent.types';
import { AgentLoopService, AgentLoopAgentConfig } from '../../core/agent-loop/agent-loop.service';
import { ContextAssembler } from '../../core/context/context-assembler';

export interface GeneralAgentDeps {
  loop: AgentLoopService;
  context: ContextAssembler;
  config: AgentLoopAgentConfig;
}

/**
 * 通用助手 Agent（Agent Loop 驱动）：
 * ContextAssembler 取上下文（最近消息 + 项目/用户记忆）→ AgentLoop 决策（回答或调用工具）。
 * 上下文组装唯一走 ContextAssembler，Agent 不直查 Memory。
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
      excludeMessageId: ctx.messageId,
    });
    yield* this.deps.loop.execute({
      userId: ctx.userId,
      projectId: ctx.projectId,
      conversationId: ctx.conversationId,
      messageId: ctx.messageId,
      userMessage: ctx.userMessage,
      history: messages,
      agent: this.deps.config,
      signal: ctx.signal ?? new AbortController().signal,
    });
  }
}
