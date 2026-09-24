import { ChatParams, ChatResponse, LLMChunk, LLMProvider } from '../llm.types';

/** 开发/测试用 echo 适配器（无真实 API Key 时跑通全链路）；分块延迟模拟真实流式 */
export class MockLLMAdapter implements LLMProvider {
  readonly kind = 'llm' as const;
  constructor(private readonly chunkDelayMs = 20) {}

  async chat(params: ChatParams): Promise<ChatResponse> {
    return { content: this.reply(params), usage: { inputTokens: 1, outputTokens: 1 } };
  }

  async *stream(params: ChatParams): AsyncIterable<LLMChunk> {
    // dev/e2e 替身：确定性 function calling（启发式仅存在于本替身；生产由真实模型驱动）
    const toolCall = this.maybeToolCall(params);
    if (toolCall) {
      yield { type: 'tool_calls', toolCalls: [toolCall] };
      return;
    }
    const text = this.reply(params);
    for (const ch of text) {
      if (params.signal?.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
      yield { type: 'text', text: ch };
      if (this.chunkDelayMs > 0) await new Promise((r) => setTimeout(r, this.chunkDelayMs));
    }
  }

  private maybeToolCall(params: ChatParams) {
    if (!params.tools?.length) return null;
    const last = params.messages.at(-1);
    const text = typeof last?.content === 'string' ? last.content : '';
    const has = (name: string) => params.tools!.some((t) => t.function.name === name);
    if (/图|图片|海报|主图|插画|logo|图标|banner/i.test(text) && has('image.generate')) {
      return { id: 'call_mock_image', name: 'image.generate', arguments: JSON.stringify({ prompt: text }) };
    }
    if (/视频|短片|动画/i.test(text) && has('video.generate')) {
      return { id: 'call_mock_video', name: 'video.generate', arguments: JSON.stringify({ prompt: text, duration: 5 }) };
    }
    if (/方案|简报|brief/i.test(text) && has('artifact.create')) {
      return { id: 'call_mock_artifact', name: 'artifact.create', arguments: JSON.stringify({ type: 'creative_brief', title: text.slice(0, 40), summary: text }) };
    }
    if (/记住|记下/i.test(text) && has('memory.create_candidate')) {
      return { id: 'call_mock_memory', name: 'memory.create_candidate', arguments: JSON.stringify({ content: text, category: 'preference', importance: 70, confidence: 0.9 }) };
    }
    if (/查一下|检索|知识库|资料/i.test(text) && has('knowledge.search')) {
      return { id: 'call_mock_knowledge', name: 'knowledge.search', arguments: JSON.stringify({ query: text }) };
    }
    return null;
  }

  private reply(params: ChatParams): string {
    const last = params.messages.at(-1);
    const q = typeof last?.content === 'string' ? last.content : '(多模态)';
    return `[mock] 收到你的消息："${q}"。这是本地 mock 模型回复，配置真实 Provider 后即可获得真实回答。`;
  }
}
