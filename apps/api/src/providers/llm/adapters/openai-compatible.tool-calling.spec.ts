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

  it('消息映射：role=tool 携带 tool_call_id；assistant 携带 tool_calls（点号名经可逆编码上线）', async () => {
    const adapter = new OpenAICompatibleAdapter(cfg, {
      chat: async (body) => {
        const msgs = (body as { messages: Array<Record<string, unknown>> }).messages;
        expect(msgs[0]).toMatchObject({ role: 'tool', tool_call_id: 'call_1' });
        const wire = (msgs[1].tool_calls as Array<{ id: string; type: string; function: { name: string; arguments: string } }>)[0];
        expect(wire).toMatchObject({ id: 'c1', type: 'function', function: { arguments: '{}' } });
        expect(wire.function.name).toMatch(/^fn_[A-Za-z0-9_-]+$/); // 编码上线（DeepSeek 严格模式）
        expect(Buffer.from(wire.function.name.slice(3), 'base64url').toString('utf8')).toBe('image.generate'); // 可逆
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

  // ===== M13+ 工具名可逆编码（DeepSeek 等强制 ^[a-zA-Z0-9_-]+$；用户实测实抓 400）=====

  it('发送：不合规工具名（点号）编码为 fn_<base64url> 恒合规；合规名原样透传', async () => {
    let sentBody: Record<string, unknown> = {};
    const adapter = new OpenAICompatibleAdapter(cfg, {
      chat: async (body) => { sentBody = body; return { choices: [{ message: { content: 'ok' } }] }; },
    });
    await adapter.chat({
      model: 'm', messages: [{ role: 'user', content: 'hi' }],
      tools: [
        { type: 'function', function: { name: 'agent.delegate', description: 'd', parameters: {} } },
        { type: 'function', function: { name: 'image_generate', description: 'd', parameters: {} } },
      ],
    });
    const names = (sentBody.tools as Array<{ function: { name: string } }>).map((t) => t.function.name);
    expect(names[0]).toMatch(/^fn_[A-Za-z0-9_-]+$/);
    expect(names[0]).not.toContain('.');
    expect(names[1]).toBe('image_generate'); // 合规名绝不编码
    expect(Buffer.from(names[0].slice(3), 'base64url').toString('utf8')).toBe('agent.delegate'); // 可逆
  });

  it('接收：fn_<base64url> 解码还原原名（引擎看到原名，协议不变）', async () => {
    const encoded = `fn_${Buffer.from('commerce.analysis.generate', 'utf8').toString('base64url')}`;
    const adapter = new OpenAICompatibleAdapter(cfg, {
      chat: async () => ({
        choices: [{ message: { tool_calls: [{ id: 'c1', function: { name: encoded, arguments: '{}' } }] } }],
      }),
    });
    const r = await adapter.chat({ model: 'm', messages: [{ role: 'user', content: 'hi' }] });
    expect(r.toolCalls).toEqual([{ id: 'c1', name: 'commerce.analysis.generate', arguments: '{}' }]);
  });

  it('接收：无法解码的前缀名原样返回（绝不丢信息）', async () => {
    const adapter = new OpenAICompatibleAdapter(cfg, {
      chat: async () => ({ choices: [{ message: { tool_calls: [{ id: 'c1', function: { name: 'fn_not-base64!', arguments: '{}' } }] } }] }),
    });
    const r = await adapter.chat({ model: 'm', messages: [{ role: 'user', content: 'hi' }] });
    expect(r.toolCalls).toEqual([{ id: 'c1', name: 'fn_not-base64!', arguments: '{}' }]);
  });
});
