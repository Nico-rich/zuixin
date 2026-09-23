import OpenAI from 'openai';
import { ChatMessage, ChatParams, ChatResponse, LLMChunk, LLMProvider } from '../llm.types';
import { mapProviderError, ProviderLikeError } from '../../../common/errors/provider-error';

export interface OpenAICompatibleConfig { baseUrl: string; apiKey: string; timeoutMs: number; }

type ChatFn = (body: Record<string, unknown>) => Promise<Record<string, unknown>>;
type StreamFn = (body: Record<string, unknown>) => AsyncIterable<Record<string, unknown>> | Promise<AsyncIterable<Record<string, unknown>>>;

/** OpenAI / DeepSeek / Kimi / 阿里百炼 / 火山方舟 / 智谱 六家共用一个 adapter（baseUrl + key 配置化） */
export class OpenAICompatibleAdapter implements LLMProvider {
  readonly kind = 'llm' as const;
  private readonly chatFn: ChatFn;
  private readonly streamFn: StreamFn;

  constructor(cfg: OpenAICompatibleConfig, injected?: { chat?: ChatFn; stream?: StreamFn }) {
    const client = new OpenAI({ baseURL: cfg.baseUrl, apiKey: cfg.apiKey, timeout: cfg.timeoutMs, maxRetries: 0 });
    this.chatFn = injected?.chat ?? (async (body) => (await client.chat.completions.create(body as never)) as unknown as Record<string, unknown>);
    this.streamFn = injected?.stream ?? (async (body) => (await client.chat.completions.create({ ...body, stream: true } as never)) as unknown as AsyncIterable<Record<string, unknown>>);
  }

  async chat(params: ChatParams): Promise<ChatResponse> {
    try {
      const r = await this.chatFn(this.buildBody(params, false));
      const choice = (r.choices as Array<{ message?: { content?: string | null; tool_calls?: unknown[] } }>)?.[0];
      const usage = r.usage as { prompt_tokens?: number; completion_tokens?: number } | undefined;
      return {
        content: choice?.message?.content ?? '',
        toolCalls: this.mapToolCalls(choice?.message?.tool_calls),
        usage: usage ? { inputTokens: usage.prompt_tokens ?? 0, outputTokens: usage.completion_tokens ?? 0 } : undefined,
      };
    } catch (err) { throw mapProviderError(err as ProviderLikeError); }
  }

  async *stream(params: ChatParams): AsyncIterable<LLMChunk> {
    try {
      const s = await this.streamFn(this.buildBody(params, true));
      // OpenAI 流式 tool_calls 以 delta 分片到达，按 index 聚合，流结束时一次产出内部协议块
      const acc = new Map<number, { id?: string; name?: string; args: string }>();
      for await (const chunk of s) {
        const delta = (chunk.choices as Array<{ delta?: { content?: string | null; tool_calls?: Array<{ index: number; id?: string; function?: { name?: string; arguments?: string } }> } }>)?.[0]?.delta;
        if (delta?.content) yield { type: 'text', text: delta.content };
        for (const tc of delta?.tool_calls ?? []) {
          const cur = acc.get(tc.index) ?? { args: '' };
          if (tc.id) cur.id = tc.id;
          if (tc.function?.name) cur.name = tc.function.name;
          if (tc.function?.arguments) cur.args += tc.function.arguments;
          acc.set(tc.index, cur);
        }
      }
      if (acc.size > 0) {
        yield { type: 'tool_calls', toolCalls: [...acc.values()].map((t) => ({ id: t.id ?? `call_${Math.random()}`, name: t.name ?? '', arguments: t.args })) };
      }
    } catch (err) { throw mapProviderError(err as ProviderLikeError); }
  }

  /** Provider tool_calls → 内部 ToolCallRequest[] */
  private mapToolCalls(raw: unknown[] | undefined) {
    if (!raw?.length) return undefined;
    return raw.map((tc) => {
      const t = tc as { id?: string; function?: { name?: string; arguments?: string } };
      return { id: t.id ?? `call_${Math.random()}`, name: t.function?.name ?? '', arguments: t.function?.arguments ?? '{}' };
    });
  }

  private buildBody(p: ChatParams, isStream: boolean): Record<string, unknown> {
    const body: Record<string, unknown> = {
      model: p.model,
      messages: p.messages.map((m) => this.mapMessage(m)),
      stream: isStream,
    };
    if (p.temperature != null) body.temperature = p.temperature;
    if (p.maxTokens != null) body.max_tokens = p.maxTokens;
    if (p.responseFormat) {
      body.response_format = p.responseFormat.type === 'json_schema' && p.responseFormat.schema
        ? { type: 'json_schema', json_schema: { name: 'intent', strict: true, schema: p.responseFormat.schema } }
        : { type: 'json_object' };
    }
    if (p.tools?.length) body.tools = p.tools; // 内部协议与 OpenAI 格式同构，直接透传
    if (p.signal) body.signal = p.signal;
    return body;
  }

  /** 消息映射（含 tool 角色 / tool_calls） */
  private mapMessage(m: ChatMessage): Record<string, unknown> {
    const mapped: Record<string, unknown> = { role: m.role, content: this.mapContent(m) };
    if (m.role === 'tool' && m.tool_call_id) mapped.tool_call_id = m.tool_call_id;
    if (m.role === 'assistant' && m.tool_calls?.length) {
      mapped.tool_calls = m.tool_calls.map((t) => ({ id: t.id, type: 'function', function: { name: t.name, arguments: t.arguments } }));
    }
    return mapped;
  }

  private mapContent(m: ChatMessage): unknown {
    if (typeof m.content === 'string') return m.content;
    return m.content.map((part) =>
      part.type === 'text' ? { type: 'text', text: part.text } : { type: 'image_url', image_url: { url: part.imageUrl } },
    );
  }
}
