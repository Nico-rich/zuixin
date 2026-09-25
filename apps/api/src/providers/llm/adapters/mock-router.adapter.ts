import { ChatParams, ChatResponse, LLMChunk, LLMProvider } from '../llm.types';

/**
 * dev/e2e 替身：确定性意图分类。
 * ⚠️ 启发式规则仅存在于本替身 adapter——生产路由是 RouterService 的 LLM 分类（json_object + 阈值 + 兜底），
 * 后台把 routingPolicy.routerModelId 换成真实模型后，本替身自动失效、代码零改动。
 */
export class MockRouterAdapter implements LLMProvider {
  readonly kind = 'llm' as const;

  async chat(params: ChatParams): Promise<ChatResponse> {
    return { content: JSON.stringify(this.classify(params)), usage: { inputTokens: 1, outputTokens: 1 } };
  }

  async *stream(params: ChatParams): AsyncIterable<LLMChunk> {
    const text = JSON.stringify(this.classify(params));
    for (const ch of text) yield { type: 'text', text: ch };
    yield { type: 'usage', usage: { inputTokens: 4, outputTokens: Math.ceil(text.length / 4) } };
  }

  private classify(params: ChatParams): { type: string; confidence: number; parameters: { prompt: string } } {
    const last = params.messages.at(-1);
    const text = typeof last?.content === 'string' ? last.content : '';
    if (/图|图片|海报|主图|插画|logo|图标|banner/i.test(text)) {
      return { type: 'image_generation', confidence: 0.98, parameters: { prompt: text } };
    }
    if (/视频|短片|动画/i.test(text)) {
      return { type: 'video_generation', confidence: 0.9, parameters: { prompt: text } };
    }
    return { type: 'chat', confidence: 0.9, parameters: { prompt: text } };
  }
}
