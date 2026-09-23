import { AgentEvent } from '@ai-agent/shared';
import { LLMManagerService } from '../../providers/llm/llm-manager.service';
import { ChatMessage, LLMProvider } from '../../providers/llm/llm.types';
import { Agent, AgentContext } from '../agent.types';

export interface ChatAgentOptions {
  systemPrompt?: string;
  resolveLLM?: (ctx: AgentContext) => Promise<{ adapter: LLMProvider; apiModelId: string }>;
}

/** 通用聊天 Agent：LLM 流式输出（支持多模态附件 → vision 模型） */
export class ChatAgent implements Agent {
  readonly id = 'chat';
  constructor(
    private readonly deps: { llmManager: LLMManagerService },
    private readonly options: ChatAgentOptions = {},
  ) {}

  async *execute(ctx: AgentContext): AsyncIterable<AgentEvent> {
    yield { type: 'status', stage: 'llm', message: '正在生成回答…' };
    try {
      const { adapter, apiModelId } = this.options.resolveLLM
        ? await this.options.resolveLLM(ctx)
        : await this.resolveDefault(ctx);
      const messages = this.buildMessages(ctx);
      const stream = adapter.stream({ model: apiModelId, messages, temperature: 0.7 });
      for await (const chunk of stream) {
        if (chunk.type === 'text') yield { type: 'text.delta', text: chunk.text };
      }
      yield { type: 'done', messageId: ctx.messageId };
    } catch (err) {
      const e = err as { code?: string; message?: string };
      yield { type: 'error', code: e.code ?? 'PROVIDER_UNKNOWN', message: e.message ?? '生成失败' };
    }
  }

  private async resolveDefault(ctx: AgentContext): Promise<{ adapter: LLMProvider; apiModelId: string }> {
    // 默认模型解析在 M4 接线（读 routingPolicy.defaults.llm）；M4 之前必须通过 options.resolveLLM 注入
    throw new Error(`ChatAgent 未配置 resolveLLM（conversationId=${ctx.conversationId}），M4 接线后启用默认模型解析`);
  }

  private buildMessages(ctx: AgentContext): ChatMessage[] {
    const parts: ChatMessage[] = [];
    if (this.options.systemPrompt) parts.push({ role: 'system', content: this.options.systemPrompt });
    parts.push(...ctx.history);
    if (ctx.attachments.length > 0 && ctx.userMessage) {
      const content = [
        ...ctx.attachments.filter((a) => a.type === 'image').map((a) => ({ type: 'image' as const, imageUrl: a.url })),
        { type: 'text' as const, text: ctx.userMessage },
      ];
      parts.push({ role: 'user', content });
    } else {
      parts.push({ role: 'user', content: ctx.userMessage });
    }
    return parts;
  }
}
