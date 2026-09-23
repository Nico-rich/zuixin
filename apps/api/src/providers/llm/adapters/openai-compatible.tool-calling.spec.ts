import { describe, it, expect } from 'vitest';
import { OpenAICompatibleAdapter } from './openai-compatible.adapter';

const cfg = { baseUrl: 'https://x.test/v1', apiKey: 'sk-test', timeoutMs: 1000 };

describe('OpenAICompatibleAdapter Tool Calling（内部统一协议）', () => {
  it('chat：provider tool_calls → 内部 ToolCallRequest[]', async () => {
    const adapter = new OpenAICompatibleAdapter(cfg, {
      chat: async () => ({
        choices: [{
          message: {
            content: null,
            tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'image.generate', arguments: '{"prompt":"主图"}' } }],
          },
        }],
      }),
    });
    const r = await adapter.chat({ model: 'm', messages: [{ role: 'user', content: '帮我做一张主图' }], tools: [{ type: 'function', function: { name: 'image.generate', description: 'x', parameters: {} } }] });
    expect(r.toolCalls).toEqual([{ id: 'call_1', name: 'image.generate', arguments: '{"prompt":"主图"}' }]);
    expect(r.content).toBe('');
  });

  it('stream：delta 分片聚合后一次产出 tool_calls 块（内部协议，无 provider 细节）', async () => {
    const adapter = new OpenAICompatibleAdapter(cfg, {
      stream: async function* () {
        yield { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_9', function: { name: 'video.generate', arguments: '{"duration"' } }] } }] };
        yield { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: ':5}' } }] } }] };
      },
    });
    const chunks = [];
    for await (const c of adapter.stream({ model: 'm', messages: [{ role: 'user', content: '视频' }], tools: [] })) chunks.push(c);
    expect(chunks).toEqual([{ type: 'tool_calls', toolCalls: [{ id: 'call_9', name: 'video.generate', arguments: '{"duration":5}' }] }]);
  });

  it('stream：文本 + 工具调用并存 → 先 text 块后 tool_calls 块', async () => {
    const adapter = new OpenAICompatibleAdapter(cfg, {
      stream: async function* () {
        yield { choices: [{ delta: { content: '好的，我来' } }] };
        yield { choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'image.generate', arguments: '{}' } }] } }] };
      },
    });
    const chunks = [];
    for await (const c of adapter.stream({ model: 'm', messages: [{ role: 'user', content: 'x' }], tools: [] })) chunks.push(c);
    expect(chunks[0]).toEqual({ type: 'text', text: '好的，我来' });
    expect(chunks[1].type).toBe('tool_calls');
  });

  it('消息映射：role=tool 携带 tool_call_id；assistant 携带 tool_calls', async () => {
    const adapter = new OpenAICompatibleAdapter(cfg, {
      chat: async (body) => {
        const msgs = (body as { messages: Array<Record<string, unknown>> }).messages;
        expect(msgs[0]).toMatchObject({ role: 'tool', tool_call_id: 'call_1' });
        expect(msgs[1].tool_calls).toEqual([{ id: 'c1', type: 'function', function: { name: 'image.generate', arguments: '{}' } }]);
        return { choices: [{ message: { content: 'ok' } }] };
      },
    });
    await adapter.chat({
      model: 'm',
      messages: [
        { role: 'tool', content: '结果', tool_call_id: 'call_1' },
        { role: 'assistant', content: '', tool_calls: [{ id: 'c1', name: 'image.generate', arguments: '{}' }] },
      ],
    });
  });
});
