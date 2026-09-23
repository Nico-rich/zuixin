import OpenAI from 'openai';
import { ChatMessage, ChatParams, ChatResponse, LLMChunk, LLMProvider } from '../llm.types';
import { mapProviderError } from '../errors';

export interface OpenAICompatibleConfig { baseUrl: string; apiKey: string; timeoutMs: number; }

type ChatFn = (body: Record<string, unknown>) => Promise<Record<string, unknown>>;
type StreamFn = (body: Record<string, unknown>) => Promise<AsyncIterable<Record<string, unknown>>>;

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
      const choice = (r.choices as Array<{ message?: { content?: string } }>)?.[0];
      const usage = r.usage as { prompt_tokens?: number; completion_tokens?: number } | undefined;
      return {
        content: choice?.message?.content ?? '',
        usage: usage ? { inputTokens: usage.prompt_tokens ?? 0, outputTokens: usage.completion_tokens ?? 0 } : undefined,
      };
    } catch (err) { throw mapProviderError(err as Error); }
  }

  async *stream(params: ChatParams): AsyncIterable<LLMChunk> {
    try {
      const s = await this.streamFn(this.buildBody(params, true));
      for await (const chunk of s) {
        const delta = (chunk.choices as Array<{ delta?: { content?: string } }>)?.[0]?.delta?.content;
        if (delta) yield { type: 'text', text: delta };
      }
    } catch (err) { throw mapProviderError(err as Error); }
  }

  private buildBody(p: ChatParams, isStream: boolean): Record<string, unknown> {
    const body: Record<string, unknown> = {
      model: p.model,
      messages: p.messages.map((m) => ({ role: m.role, content: this.mapContent(m) })),
      stream: isStream,
    };
    if (p.temperature != null) body.temperature = p.temperature;
    if (p.maxTokens != null) body.max_tokens = p.maxTokens;
    if (p.responseFormat) {
      body.response_format = p.responseFormat.type === 'json_schema' && p.responseFormat.schema
        ? { type: 'json_schema', json_schema: { name: 'intent', strict: true, schema: p.responseFormat.schema } }
        : { type: 'json_object' };
    }
    if (p.signal) body.signal = p.signal;
    return body;
  }

  private mapContent(m: ChatMessage): unknown {
    if (typeof m.content === 'string') return m.content;
    return m.content.map((part) =>
      part.type === 'text' ? { type: 'text', text: part.text } : { type: 'image_url', image_url: { url: part.imageUrl } },
    );
  }
}
