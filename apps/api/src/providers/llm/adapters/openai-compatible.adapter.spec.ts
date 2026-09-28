import { describe, it, expect } from 'vitest';
import { OpenAICompatibleAdapter } from './openai-compatible.adapter';
import { ChatParams } from '../llm.types';

const cfg = { baseUrl: 'https://x.test/v1', apiKey: 'sk-test', timeoutMs: 1000 };
const params: ChatParams = { model: 'm1', messages: [{ role: 'user', content: '你好' }] };

describe('OpenAICompatibleAdapter', () => {
  it('chat 返回内容与 usage', async () => {
    const adapter = new OpenAICompatibleAdapter(cfg, {
      chat: async (p) => {
        expect(p.model).toBe('m1');
        return { choices: [{ message: { content: '你好！' } }], usage: { prompt_tokens: 3, completion_tokens: 2 } };
      },
    });
    const r = await adapter.chat(params);
    expect(r.content).toBe('你好！');
    expect(r.usage).toEqual({ inputTokens: 3, outputTokens: 2 });
  });

  it('stream 逐块输出 text', async () => {
    const adapter = new OpenAICompatibleAdapter(cfg, {
      stream: async function* () {
        yield { choices: [{ delta: { content: '你' } }] };
        yield { choices: [{ delta: { content: '好' } }] };
      },
    });
    const chunks = [];
    for await (const c of adapter.stream(params)) chunks.push(c);
    expect(chunks).toEqual([{ type: 'text', text: '你' }, { type: 'text', text: '好' }]);
  });

  it('stream 异常经 mapProviderError 归一化', async () => {
    const adapter = new OpenAICompatibleAdapter(cfg, {
      stream: async function* () { throw Object.assign(new Error('limited'), { status: 429 }); },
    });
    const it = adapter.stream(params)[Symbol.asyncIterator]();
    await expect(it.next()).rejects.toMatchObject({ code: 'PROVIDER_RATE_LIMITED', retryable: true });
  });

  it('messages 透传多模态 content', async () => {
    const adapter = new OpenAICompatibleAdapter(cfg, {
      chat: async (p) => {
        const msgs = p.messages as Array<{ content: unknown }>;
        expect(msgs[0].content).toEqual([{ type: 'image_url', image_url: { url: 'http://x/a.png' } }, { type: 'text', text: '分析' }]);
        return { choices: [{ message: { content: 'ok' } }] };
      },
    });
    await adapter.chat({ model: 'm1', messages: [{ role: 'user', content: [{ type: 'image', imageUrl: 'http://x/a.png' }, { type: 'text', text: '分析' }] }] });
  });

  it('responseFormat json_schema 映射为 OpenAI 格式', async () => {
    let captured: Record<string, unknown> = {};
    const adapter = new OpenAICompatibleAdapter(cfg, {
      chat: async (p) => { captured = p; return { choices: [{ message: { content: '{}' } }] }; },
    });
    await adapter.chat({ ...params, responseFormat: { type: 'json_schema', schema: { type: 'object' } } });
    expect(captured.response_format).toEqual({ type: 'json_schema', json_schema: { name: 'intent', strict: true, schema: { type: 'object' } } });
  });

  it('Pre-M9 R1/G6：流式仍带 stream_options.include_usage（超时改造不改变计量契约）', async () => {
    let captured: Record<string, unknown> = {};
    const adapter = new OpenAICompatibleAdapter(cfg, {
      stream: async function* (p) { captured = p; yield { choices: [{ delta: { content: 'x' } }] }; },
    });
    const chunks = [];
    for await (const c of adapter.stream(params)) chunks.push(c);
    expect(captured.stream).toBe(true);
    expect(captured.stream_options).toEqual({ include_usage: true });
    expect(chunks).toEqual([{ type: 'text', text: 'x' }]);
  });

  it('Pre-M9 G6：流中途静默（空闲超时）→ AppError PROVIDER_TIMEOUT（可重试/可回退），且底层请求被中断', async () => {
    process.env.LLM_STREAM_IDLE_TIMEOUT_MS = '20';
    let handedSignal: AbortSignal | undefined;
    try {
      const adapter = new OpenAICompatibleAdapter(cfg, {
        stream: (body, options) => {
          handedSignal = options?.signal;
          return (async function* () {
            yield { choices: [{ delta: { content: '你' } }] };
            await new Promise(() => undefined); // provider 静默：永不再发块（原实现会永久挂住）
          })();
        },
      });
      const it = adapter.stream(params)[Symbol.asyncIterator]();
      await expect(it.next()).resolves.toEqual({ value: { type: 'text', text: '你' }, done: false });
      await expect(it.next()).rejects.toMatchObject({ code: 'PROVIDER_TIMEOUT', retryable: true, message: expect.stringContaining('空闲超时') });
      expect(handedSignal?.aborted).toBe(true); // 超时 = 真正 abort 传输层，而非只抛错
    } finally { delete process.env.LLM_STREAM_IDLE_TIMEOUT_MS; }
  });

  it('Pre-M9 G6：外部 deadline 中止（用户取消/回合超时）→ 归一为 PROVIDER_TIMEOUT 且信号直达 SDK（引擎按 signal.aborted 走取消路径）', async () => {
    const external = new AbortController();
    let handedSignal: AbortSignal | undefined;
    let attached!: () => void;
    const ready = new Promise<void>((r) => { attached = r; });
    const adapter = new OpenAICompatibleAdapter(cfg, {
      stream: (body, options) => {
        handedSignal = options?.signal;
        return (async function* () {
          await new Promise((_, reject) => {
            handedSignal!.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
            attached(); // 监听已挂上（确定性：不靠 sleep 竞态）
          });
        })();
      },
    });
    const it = adapter.stream({ ...params, signal: external.signal })[Symbol.asyncIterator]();
    const pending = it.next();
    await ready;
    external.abort();
    // 断言走的是"中止"路径（mapProviderError 的 AbortError 文案），而非本适配器的某一层超时
    await expect(pending).rejects.toMatchObject({ code: 'PROVIDER_TIMEOUT', message: '模型请求超时' });
    expect(handedSignal?.aborted).toBe(true);
  });

  it('Pre-M9 G6：首包超时 → PROVIDER_TIMEOUT（连接建立后供应商不吐数据也算超时）', async () => {
    process.env.LLM_STREAM_FIRST_BYTE_TIMEOUT_MS = '20';
    try {
      const adapter = new OpenAICompatibleAdapter(cfg, {
        stream: () => (async function* () { await new Promise(() => undefined); yield { choices: [] }; })(),
      });
      const it = adapter.stream(params)[Symbol.asyncIterator]();
      await expect(it.next()).rejects.toMatchObject({ code: 'PROVIDER_TIMEOUT', message: expect.stringContaining('首包超时') });
    } finally { delete process.env.LLM_STREAM_FIRST_BYTE_TIMEOUT_MS; }
  });
});
