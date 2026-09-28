import OpenAI from 'openai';
import { AppError, ErrorCode } from '@ai-agent/shared';
import { ChatMessage, ChatParams, ChatResponse, LLMChunk, LLMProvider } from '../llm.types';
import { mapSdkError } from '../errors';
import { manualRedirectFetch } from '../../../modules/security/provider-base-url.guard';
import { StreamGuard, StreamTimeoutError, streamTimeoutsFrom } from '../../../core/http/stream-guard';

export interface OpenAICompatibleConfig { baseUrl: string; apiKey: string; timeoutMs: number; }

type RequestOptions = { signal?: AbortSignal };
type ChatFn = (body: Record<string, unknown>, options?: RequestOptions) => Promise<Record<string, unknown>>;
type StreamFn = (body: Record<string, unknown>, options?: RequestOptions) => AsyncIterable<Record<string, unknown>> | Promise<AsyncIterable<Record<string, unknown>>>;

/** OpenAI / DeepSeek / Kimi / 阿里百炼 / 火山方舟 / 智谱 六家共用一个 adapter（baseUrl + key 配置化） */
export class OpenAICompatibleAdapter implements LLMProvider {
  readonly kind = 'llm' as const;
  private readonly chatFn: ChatFn;
  private readonly streamFn: StreamFn;
  /** Pre-M9 G6：四层流式超时（构造期解析一次：provider.timeoutMs + env 覆盖） */
  private readonly cfg: OpenAICompatibleConfig;

  constructor(cfg: OpenAICompatibleConfig, injected?: { chat?: ChatFn; stream?: StreamFn }) {
    this.cfg = cfg;
    // Pre-M9 F3-B：禁止自动跟随重定向（3xx 会绕过 baseUrl 校验）；出网策略与 baseUrl 校验同源
    const client = new OpenAI({ baseURL: cfg.baseUrl, apiKey: cfg.apiKey, timeout: cfg.timeoutMs, maxRetries: 0, fetch: manualRedirectFetch });
    this.chatFn = injected?.chat ?? (async (body, options) => (await client.chat.completions.create(body as never, options)) as unknown as Record<string, unknown>);
    this.streamFn = injected?.stream ?? (async (body, options) => (await client.chat.completions.create({ ...body, stream: true } as never, options)) as unknown as AsyncIterable<Record<string, unknown>>);
  }

  async chat(params: ChatParams): Promise<ChatResponse> {
    try {
      const r = await this.chatFn(this.buildBody(params, false), { signal: params.signal });
      const choice = (r.choices as Array<{ message?: { content?: string | null; tool_calls?: unknown[] } }>)?.[0];
      const usage = r.usage as { prompt_tokens?: number; completion_tokens?: number } | undefined;
      return {
        content: choice?.message?.content ?? '',
        toolCalls: this.mapToolCalls(choice?.message?.tool_calls),
        usage: usage ? { inputTokens: usage.prompt_tokens ?? 0, outputTokens: usage.completion_tokens ?? 0 } : undefined,
      };
      // M10-P2：（真实 HTTP 下）SDK 自身 timeout → APIConnectionTimeoutError（无 status/code），
      // 必须归一为 PROVIDER_TIMEOUT（可重试/可回退），绝不放任其降级为不可重试的 PROVIDER_UNKNOWN
    } catch (err) { throw mapSdkError(err); }
  }

  async *stream(params: ChatParams): AsyncIterable<LLMChunk> {
    // Pre-M9 G6：四层超时（连接/首包/空闲/总时长）+ 主动中断。
    // 外部 deadline 信号（AgentRun/回合）与内部控制器、总时长上限共同组合交给 SDK → fetch abort。
    const guard = new StreamGuard(streamTimeoutsFrom(this.cfg), params.signal);
    try {
      // M6-A8：signal 经 SDK options 传入（body.signal 会被 JSON 序列化丢弃且不接入 fetch abort）
      const s = await guard.connect(() => this.streamFn(this.buildBody(params, true), { signal: guard.signal }));
      // OpenAI 流式 tool_calls 以 delta 分片到达，按 index 聚合，流结束时一次产出内部协议块
      const acc = new Map<number, { id?: string; name?: string; args: string }>();
      let usage: { prompt_tokens?: number; completion_tokens?: number } | undefined;
      const iterator = s[Symbol.asyncIterator]();
      for (;;) {
        const step = await guard.next(iterator);
        if (step.done) break;
        const chunk = step.value;
        const delta = (chunk.choices as Array<{ delta?: { content?: string | null; tool_calls?: Array<{ index: number; id?: string; function?: { name?: string; arguments?: string } }> } }>)?.[0]?.delta;
        if (delta?.content) yield { type: 'text', text: delta.content };
        for (const tc of delta?.tool_calls ?? []) {
          const cur = acc.get(tc.index) ?? { args: '' };
          if (tc.id) cur.id = tc.id;
          if (tc.function?.name) cur.name = tc.function.name;
          if (tc.function?.arguments) cur.args += tc.function.arguments;
          acc.set(tc.index, cur);
        }
        // Pre-M9 R1：usage 在流末 chunk 报告（stream_options.include_usage）——provider 权威数字
        const u = chunk.usage as { prompt_tokens?: number; completion_tokens?: number } | undefined;
        if (u) usage = u;
      }
      // M10-P2（契约 e2e + SDK 源码取证）：openai@4 的 Stream 在**请求被 abort 时静默结束迭代**
      // （streaming.js: `catch (e) { if (e.name === 'AbortError') return; }`，`[DONE]` 只是 `continue`）。
      // 于是总时长层/外部 deadline（AbortSignal）中断后，`iterator.next()` 会 resolve `{done:true}`，
      // 循环正常收尾——被**截断**的流会被上层当成"生成完成"（脏内容落库、丢 usage）。守卫信号已中止
      // ⇒ 本次流没跑完，必须归一 PROVIDER_TIMEOUT（可重试/可回退，与既有取消语义一致）。
      // 注：正常结束（服务端发完 [DONE] 并关闭响应体）时信号未中止，不受影响。
      if (guard.signal.aborted) throw new AppError(ErrorCode.PROVIDER_TIMEOUT, '模型流式响应被中断（超时/取消）');
      if (acc.size > 0) {
        yield { type: 'tool_calls', toolCalls: [...acc.values()].map((t) => ({ id: t.id ?? `call_${Math.random()}`, name: t.name ?? '', arguments: t.args })) };
      }
      if (usage) {
        yield { type: 'usage', usage: { inputTokens: usage.prompt_tokens ?? 0, outputTokens: usage.completion_tokens ?? 0 } };
      }
    } catch (err) {
      // 超时层 → PROVIDER_TIMEOUT（可重试/可回退）；AppError 原样透传（绝不被 mapProviderError 降级）
      if (err instanceof StreamTimeoutError) throw new AppError(ErrorCode.PROVIDER_TIMEOUT, err.message);
      // M10-P2：guard.abort() 会让真实 SDK 立刻抛出 APIUserAbortError（"Request was aborted."）。
      // 它与 StreamTimeoutError 在同一 tick 竞争 Promise.race 的胜者（SDK 拒绝先入队 → 可能胜出），
      // 因此这里必须兜底：SDK 中止/超时形状一律归一为 PROVIDER_TIMEOUT，绝不变成不可重试的 unknown。
      // （层特定的中文文案仅在 StreamTimeoutError 胜出时保留；错误码/可重试性是契约保证。）
      throw mapSdkError(err);
    } finally {
      // 收尾（正常结束/异常/消费者提前 return）都中断在途请求：绝不把连接挂在服务端
      guard.abort();
    }
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
      ...(isStream ? { stream_options: { include_usage: true } } : {}), // R1：流末 usage 报告
    };
    if (p.temperature != null) body.temperature = p.temperature;
    if (p.maxTokens != null) body.max_tokens = p.maxTokens;
    if (p.responseFormat) {
      body.response_format = p.responseFormat.type === 'json_schema' && p.responseFormat.schema
        ? { type: 'json_schema', json_schema: { name: 'intent', strict: true, schema: p.responseFormat.schema } }
        : { type: 'json_object' };
    }
    if (p.tools?.length) body.tools = p.tools; // 内部协议与 OpenAI 格式同构，直接透传
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
