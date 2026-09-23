import { ChatParams, ChatResponse, LLMChunk, LLMProvider } from '../llm.types';

/** 开发/测试用 echo 适配器（无真实 API Key 时跑通全链路） */
export class MockLLMAdapter implements LLMProvider {
  readonly kind = 'llm' as const;

  async chat(params: ChatParams): Promise<ChatResponse> {
    return { content: this.reply(params), usage: { inputTokens: 1, outputTokens: 1 } };
  }

  async *stream(params: ChatParams): AsyncIterable<LLMChunk> {
    const text = this.reply(params);
    for (const ch of text) yield { type: 'text', text: ch };
  }

  private reply(params: ChatParams): string {
    const last = params.messages.at(-1);
    const q = typeof last?.content === 'string' ? last.content : '(多模态)';
    return `[mock] 收到你的消息："${q}"。这是本地 mock 模型回复，配置真实 Provider 后即可获得真实回答。`;
  }
}
