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
    // 只在用户消息上启发式触发工具（tool 结果是 JSON 且可能回显触发词——如 payload.title 含"发布到"，
    // 内容匹配会无限再触发同一工具 → run 永久 waiting。真实模型不做此启发式，替身必须隔离）
    if (last?.role !== 'user') return null;
    const text = typeof last?.content === 'string' ? last.content : '';
    const has = (name: string) => params.tools!.some((t) => t.function.name === name);
    if (/图|图片|海报|主图|插画|logo|图标|banner/i.test(text) && has('image.generate')) {
      return { id: 'call_mock_image', name: 'image.generate', arguments: JSON.stringify({ prompt: text }) };
    }
    if (/视频|短片|动画/i.test(text) && has('video.generate')) {
      return { id: 'call_mock_video', name: 'video.generate', arguments: JSON.stringify({ prompt: text, duration: 5 }) };
    }
    if (/主图方案|创意方案|创意简报|三套|3套|brief/i.test(text) && has('creativeBrief.create')) {
      return { id: 'call_mock_brief', name: 'creativeBrief.create', arguments: JSON.stringify({ problem: '转化率下降', objective: '提升点击率', creativeAngle: '黑金质感', visualDirection: '黑金配色+大字报排版', platform: '店铺主图' }) };
    }
    if (/转化率下降|转化下降|异常|诊断/i.test(text) && has('commerce.analysis.generate')) {
      return { id: 'call_mock_analysis', name: 'commerce.analysis.generate', arguments: JSON.stringify({ analysisType: 'composite', timeRange: { days: 30 }, possibleCauses: ['流量质量下降（推测）'], recommendations: ['优化主图点击率'] }) };
    }
    if (/方案|简报|brief/i.test(text) && has('artifact.create')) {
      return { id: 'call_mock_artifact', name: 'artifact.create', arguments: JSON.stringify({ type: 'creative_brief', title: text.slice(0, 40), summary: text }) };
    }
    if (/发布到|上架|publish to/i.test(text) && has('external_action.execute')) {
      return { id: 'call_mock_extact', name: 'external_action.execute', arguments: JSON.stringify({ actionType: 'success', payload: { title: text.slice(0, 40) } }) };
    }
    if (/广告|投放|ROAS/i.test(text) && has('commerce.ads.performance')) {
      return { id: 'call_mock_ads', name: 'commerce.ads.performance', arguments: JSON.stringify({ timeRange: { days: 30 } }) };
    }
    if (/流量|访客/i.test(text) && has('commerce.traffic.summary')) {
      return { id: 'call_mock_traffic', name: 'commerce.traffic.summary', arguments: JSON.stringify({ timeRange: { days: 30 } }) };
    }
    if (/对比|环比|同比/i.test(text) && has('commerce.analytics.compare')) {
      return { id: 'call_mock_compare', name: 'commerce.analytics.compare', arguments: JSON.stringify({ base: { days: 30 }, compare: { days: 30 } }) };
    }
    if (/商品|产品|选品/i.test(text) && has('commerce.products.list')) {
      return { id: 'call_mock_products', name: 'commerce.products.list', arguments: JSON.stringify({ page: 1, pageSize: 10 }) };
    }
    if (/订单|成交|购买/i.test(text) && has('commerce.orders.summary')) {
      return { id: 'call_mock_orders', name: 'commerce.orders.summary', arguments: JSON.stringify({ timeRange: { days: 30 } }) };
    }
    if (/销售|营收|店铺|分析/i.test(text) && has('commerce.analytics.summary')) {
      return { id: 'call_mock_analytics', name: 'commerce.analytics.summary', arguments: JSON.stringify({ timeRange: { days: 30 } }) };
    }
    if (/发布|外部操作|publish/i.test(text) && has('external_action.demo')) {
      return { id: 'call_mock_external', name: 'external_action.demo', arguments: JSON.stringify({ title: text.slice(0, 40), content: text }) };
    }
    if (/委派|交给.*处理|delegate/i.test(text) && has('agent.delegate')) {
      return { id: 'call_mock_delegate', name: 'agent.delegate', arguments: JSON.stringify({ task: '请确认创意方向：黑金质感' }) };
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
