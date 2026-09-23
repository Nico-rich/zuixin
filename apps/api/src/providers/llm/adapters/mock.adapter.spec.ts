import { describe, it, expect } from 'vitest';
import { MockLLMAdapter } from './mock.adapter';

describe('MockLLMAdapter', () => {
  it('chat 返回固定回复', async () => {
    const a = new MockLLMAdapter();
    const r = await a.chat({ model: 'm', messages: [{ role: 'user', content: 'hi' }] });
    expect(r.content).toContain('mock');
    expect(r.usage).toEqual({ inputTokens: 1, outputTokens: 1 });
  });

  it('stream 输出多个 text chunk 后结束', async () => {
    const a = new MockLLMAdapter();
    const chunks = [];
    for await (const c of a.stream({ model: 'm', messages: [{ role: 'user', content: 'hi' }] })) chunks.push(c);
    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks.every((c) => c.type === 'text')).toBe(true);
    expect(chunks.map((c) => (c.type === 'text' ? c.text : '')).join('')).toContain('mock');
  });
});
