import { describe, it, expect, vi } from 'vitest';
import { RouterService } from './router.service';
import { LLMProvider } from '../../providers/llm/llm.types';

function makeRouter(llm: LLMProvider, threshold = 0.7) {
  const llmManager = {
    resolve: vi.fn().mockResolvedValue({ adapter: llm, apiModelId: 'm', timeoutMs: 1000, providerId: 'p', providerName: 'p', modelId: 'rm' }),
  };
  const prisma = {
    systemSetting: {
      findUnique: vi.fn().mockResolvedValue({ key: 'routingPolicy', value: { confidenceThreshold: threshold, routerModelId: 'rm' } }),
    },
  };
  return { svc: new RouterService(llmManager as never, prisma as never) };
}

describe('RouterService', () => {
  const fakeLLM = (reply: string): LLMProvider => ({
    kind: 'llm',
    chat: async () => ({ content: reply }),
    stream: async function* () { yield { type: 'text', text: reply }; },
  });

  it('高置信度意图直接返回', async () => {
    const { svc } = makeRouter(fakeLLM(JSON.stringify({ type: 'image_generation', confidence: 0.98, parameters: { prompt: '科技感插排广告图', aspectRatio: '1:1' } })));
    const intent = await svc.classify({ userMessage: '生成一张科技感插排广告图', attachments: [], history: [] });
    expect(intent.type).toBe('image_generation');
  });

  it('低于阈值降级为 chat', async () => {
    const { svc } = makeRouter(fakeLLM(JSON.stringify({ type: 'video_generation', confidence: 0.3, parameters: { prompt: 'x' } })));
    const intent = await svc.classify({ userMessage: '随便聊聊', attachments: [], history: [] });
    expect(intent.type).toBe('chat');
  });

  it('LLM 返回非法 JSON → 重试后仍非法 → chat 兜底', async () => {
    let calls = 0;
    const badLLM: LLMProvider = {
      kind: 'llm',
      chat: async () => { calls++; return { content: '不是JSON' }; },
      stream: async function* () {},
    };
    const { svc } = makeRouter(badLLM);
    const intent = await svc.classify({ userMessage: 'hi', attachments: [], history: [] });
    expect(calls).toBe(2); // 1 次原始 + 1 次重试
    expect(intent.type).toBe('chat');
  });

  it('LLM 直接抛错 → chat 兜底（Router 永不阻塞聊天）', async () => {
    const broken: LLMProvider = {
      kind: 'llm',
      chat: async () => { throw new Error('provider down'); },
      stream: async function* () {},
    };
    const { svc } = makeRouter(broken);
    const intent = await svc.classify({ userMessage: 'hi', attachments: [], history: [] });
    expect(intent.type).toBe('chat');
  });

  it('无文字 + 单图片附件 → 快路径 image_analysis', async () => {
    let called = false;
    const spy: LLMProvider = { kind: 'llm', chat: async () => { called = true; return { content: '{}' }; }, stream: async function* () {} };
    const { svc } = makeRouter(spy);
    const intent = await svc.classify({ userMessage: '', attachments: [{ type: 'image' }], history: [] });
    expect(intent.type).toBe('image_analysis');
    expect(called).toBe(false);
  });

  it('未配置 routerModelId → chat 兜底（不调用 LLM）', async () => {
    const spy: LLMProvider = { kind: 'llm', chat: async () => { throw new Error('不应调用'); }, stream: async function* () {} };
    const llmManager = { resolve: vi.fn().mockResolvedValue({ adapter: spy, apiModelId: 'm' }) };
    const prisma = {
      systemSetting: { findUnique: vi.fn().mockResolvedValue({ key: 'routingPolicy', value: { confidenceThreshold: 0.7, routerModelId: null } }) },
    };
    const svc = new RouterService(llmManager as never, prisma as never);
    const intent = await svc.classify({ userMessage: 'hi', attachments: [], history: [] });
    expect(intent.type).toBe('chat');
  });
});
