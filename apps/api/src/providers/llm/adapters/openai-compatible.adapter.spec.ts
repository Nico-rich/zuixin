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
        expect(p.messages[0].content).toEqual([{ type: 'image_url', image_url: { url: 'http://x/a.png' } }, { type: 'text', text: '分析' }]);
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
});
