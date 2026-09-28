import { describe, it, expect } from 'vitest';
import { MockLLMAdapter } from './mock.adapter';

describe('MockLLMAdapter', () => {
  it('chat 返回固定回复', async () => {
    const a = new MockLLMAdapter({ timeoutMs: 30000 }, 0);
    const r = await a.chat({ model: 'm', messages: [{ role: 'user', content: 'hi' }] });
    expect(r.content).toContain('mock');
    expect(r.usage).toEqual({ inputTokens: 1, outputTokens: 1 });
  });

  it('stream 输出多个 text chunk 后以 usage 块结束（Pre-M9 R1：确定性用量供 engine 采集）', async () => {
    const a = new MockLLMAdapter({ timeoutMs: 30000 }, 0);
    const chunks = [];
    for await (const c of a.stream({ model: 'm', messages: [{ role: 'user', content: 'hi' }] })) chunks.push(c);
    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks.at(-1)).toMatchObject({ type: 'usage', usage: { inputTokens: 4, outputTokens: expect.any(Number) } });
    const texts = chunks.filter((c) => c.type === 'text');
    expect(texts.map((c) => (c.type === 'text' ? c.text : '')).join('')).toContain('mock');
  });

  it('signal 中止后抛出 AbortError', async () => {
    const a = new MockLLMAdapter({ timeoutMs: 30000 }, 5);
    const ac = new AbortController();
    const it = a.stream({ model: 'm', messages: [{ role: 'user', content: 'hi' }], signal: ac.signal })[Symbol.asyncIterator]();
    const first = await it.next();
    expect(first.done).toBe(false);
    ac.abort();
    await expect(it.next()).rejects.toMatchObject({ name: 'AbortError' });
  });
});
