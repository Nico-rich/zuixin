import { describe, it, expect } from 'vitest';
import { ChatAgent } from './chat.agent';
import { AgentContext } from '../agent.types';
import { AppError } from '../../common/errors/app-error';
import { LLMProvider } from '../../providers/llm/llm.types';

const ctx = (over: Partial<AgentContext> = {}): AgentContext => ({
  userId: 'u1', conversationId: 'c1', messageId: 'm1', userMessage: '你好',
  attachments: [], history: [],
  intent: { type: 'chat', confidence: 0.99, parameters: { prompt: '你好' } },
  mode: 'normal', ...over,
});

const fakeAdapter = {
  kind: 'llm' as const,
  chat: async () => ({ content: '' }),
  stream: async function* () { yield { type: 'text' as const, text: '你' }; yield { type: 'text' as const, text: '好' }; },
};

describe('ChatAgent', () => {
  it('输出 status → text.delta… → done 事件序列', async () => {
    const agent = new ChatAgent({ llmManager: {} as never }, { resolveLLM: async () => ({ adapter: fakeAdapter, apiModelId: 'm' }) });
    const events = [];
    for await (const e of agent.execute(ctx())) events.push(e);
    expect(events[0]).toMatchObject({ type: 'status', stage: 'llm' });
    expect(events.filter((e) => e.type === 'text.delta')).toHaveLength(2);
    expect(events.at(-1)).toMatchObject({ type: 'done' });
  });

  it('provider 出错 → error 事件且不再有 done', async () => {
    const failing = {
      kind: 'llm' as const,
      chat: async () => ({ content: '' }),
      stream: async function* () { throw new AppError('PROVIDER_TIMEOUT', '超时'); },
    };
    const agent = new ChatAgent({ llmManager: {} as never }, { resolveLLM: async () => ({ adapter: failing, apiModelId: 'm' }) });
    const events = [];
    for await (const e of agent.execute(ctx())) events.push(e);
    const err = events.find((e) => e.type === 'error');
    expect(err).toMatchObject({ code: 'PROVIDER_TIMEOUT' });
    expect(events.some((e) => e.type === 'done')).toBe(false);
  });

  it('history 注入 systemPrompt 并排在历史之前', async () => {
    let captured: { messages: Array<{ role: string; content: string }> } = { messages: [] };
    const spyAdapter: LLMProvider = {
      kind: 'llm',
      chat: async () => ({ content: '' }),
      stream: async function* (p) {
        captured = p as unknown as { messages: Array<{ role: string; content: string }> };
        yield { type: 'text' as const, text: 'x' };
      },
    };
    const agent = new ChatAgent({ llmManager: {} as never }, {
      systemPrompt: '你是电商助手',
      resolveLLM: async () => ({ adapter: spyAdapter, apiModelId: 'm' }),
    });
    for await (const _ of agent.execute(ctx({ history: [{ role: 'user', content: '上一条' }] }))) {}
    expect(captured.messages[0]).toEqual({ role: 'system', content: '你是电商助手' });
    expect(captured.messages[1]).toEqual({ role: 'user', content: '上一条' });
  });

  it('多模态：图片附件 + 文字组装为 content parts', async () => {
    let captured: { messages: Array<{ content: unknown }> } = { messages: [] };
    const spyAdapter: LLMProvider = {
      kind: 'llm',
      chat: async () => ({ content: '' }),
      stream: async function* (p) {
        captured = p as unknown as { messages: Array<{ content: unknown }> };
        yield { type: 'text' as const, text: 'ok' };
      },
    };
    const agent = new ChatAgent({ llmManager: {} as never }, { resolveLLM: async () => ({ adapter: spyAdapter, apiModelId: 'm' }) });
    for await (const _ of agent.execute(ctx({
      userMessage: '分析这张图',
      attachments: [{ id: 'a1', type: 'image', mimeType: 'image/png', url: 'http://x/a.png' }],
    }))) {}
    expect(captured.messages[0].content).toEqual([
      { type: 'image', imageUrl: 'http://x/a.png' },
      { type: 'text', text: '分析这张图' },
    ]);
  });
});
