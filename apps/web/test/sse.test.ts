import { describe, expect, it } from 'vitest';
import { consumeSSE, type SSEHandler } from '@/lib/sse';

/** 把若干字符串片段拼成 fetch body 形态的 ReadableStream（每片段 = 一次网络到达） */
function streamOf(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
}

async function collect(chunks: string[]): Promise<Array<[string, string]>> {
  const seen: Array<[string, string]> = [];
  const handler: SSEHandler = (event, data) => { seen.push([event, data]); };
  await consumeSSE(streamOf(chunks), handler);
  return seen;
}

/** 线上帧格式由 apps/api 的 SSEWriter 决定：`event: <name>\ndata: <json>\n\n`（LF，非 CRLF） */
const frame = (name: string, data: unknown) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;

describe('consumeSSE 分帧解析', () => {
  it('单帧解析出 event 名与 data', async () => {
    const events = await collect([frame('message_delta', { type: 'message_delta', delta: '你好' })]);
    expect(events).toEqual([['message_delta', '{"type":"message_delta","delta":"你好"}']]);
  });

  it('帧被 TCP 分片切断（半帧到达）时不提前派发，拼接后恰好派发一次', async () => {
    const raw = frame('message_start', { messageId: 'm1', conversationId: 'c1', createdAt: 'T' });
    const cut = Math.floor(raw.length / 2);
    const events = await collect([raw.slice(0, cut), raw.slice(cut)]);
    expect(events).toHaveLength(1);
    expect(events[0][0]).toBe('message_start');
    expect(JSON.parse(events[0][1])).toEqual({ messageId: 'm1', conversationId: 'c1', createdAt: 'T' });
  });

  it('中文等多字节字符跨 chunk 边界被拆开时解码不乱码', async () => {
    const raw = frame('message_delta', { type: 'message_delta', delta: '生成中✨' });
    const bytes = new TextEncoder().encode(raw);
    // 故意按字节切在中文/emoji 中间
    const chunks: Uint8Array[] = [bytes.slice(0, 40), bytes.slice(40, 41), bytes.slice(41)];
    const seen: Array<[string, string]> = [];
    await consumeSSE(new ReadableStream<Uint8Array>({
      start(c) { for (const ch of chunks) c.enqueue(ch); c.close(); },
    }), (e, d) => { seen.push([e, d]); });
    expect(JSON.parse(seen[0][1])).toEqual({ type: 'message_delta', delta: '生成中✨' });
  });

  it('同一 chunk 内多帧按顺序派发', async () => {
    const events = await collect([
      frame('message_delta', { delta: 'a' }) + frame('message_delta', { delta: 'b' }) + frame('message_end', { status: 'completed' }),
    ]);
    expect(events.map(([e]) => e)).toEqual(['message_delta', 'message_delta', 'message_end']);
  });

  it('无 event: 行的帧回退为默认事件名 message', async () => {
    const events = await collect(['data: {"hello":"world"}\n\n']);
    expect(events).toEqual([['message', '{"hello":"world"}']]);
  });

  it('多行 data: 按 SSE 规范以 \\n 拼接', async () => {
    const events = await collect(['event: x\ndata: line1\ndata: line2\n\n']);
    expect(events).toEqual([['x', 'line1\nline2']]);
  });

  it('data: 后的前导空格被去除（SSEWriter 写的是 "data: {json}"）', async () => {
    const events = await collect(['event: x\ndata:     {"a":1}\n\n']);
    expect(events).toEqual([['x', '{"a":1}']]);
  });

  it('心跳/注释帧（": ping"）无 data 行，不派发任何事件', async () => {
    const events = await collect([': ping\n\n', frame('status', { stage: 'thinking', message: '分析中' }), ': ping\n\n']);
    expect(events).toEqual([['status', '{"stage":"thinking","message":"分析中"}']]);
  });

  it('流结束时不完整帧（缺 \\n\\n 收尾）被丢弃——不到收流边界不呈现半条消息', async () => {
    const events = await collect([frame('message_delta', { delta: 'a' }), 'event: message_delta\ndata: {"delta":"b"}']);
    expect(events).toEqual([['message_delta', '{"delta":"a"}']]);
  });

  it('空流不派发事件且正常 resolve', async () => {
    await expect(collect([])).resolves.toEqual([]);
  });

  it('handler 抛错时向上传播（不吞异常）', async () => {
    const stream = streamOf([frame('message_delta', { delta: 'x' })]);
    await expect(consumeSSE(stream, () => { throw new Error('handler boom'); })).rejects.toThrow('handler boom');
  });
});

/**
 * M10-P13（审计 M9-20）：CRLF 分帧。
 * SSE 规范允许 `\r\n` 行结束符；代理/网关可能把 LF 重写为 CRLF，而原实现只按 `\n\n` 切帧
 * → CRLF 流一条事件都收不到（内容全部滞留到流结束被丢弃）。
 */
describe('consumeSSE CRLF 兼容（M9-20）', () => {
  /** 线上 CRLF 帧：`event: <name>\r\ndata: <json>\r\n\r\n` */
  const crlfFrame = (name: string, data: unknown) => `event: ${name}\r\ndata: ${JSON.stringify(data)}\r\n\r\n`;

  it('纯 CRLF 流：帧正常切分并派发（旧实现在此完全静默）', async () => {
    const events = await collect([
      crlfFrame('task.progress', { type: 'task.progress', taskId: 't1', progress: 30 }),
      crlfFrame('task.completed', { type: 'task.completed', taskId: 't1' }),
    ]);
    expect(events.map(([e]) => e)).toEqual(['task.progress', 'task.completed']);
    expect(JSON.parse(events[0][1])).toEqual({ type: 'task.progress', taskId: 't1', progress: 30 });
  });

  it('CRLF 与 LF 混用（逐帧不同）都能识别', async () => {
    const events = await collect([
      crlfFrame('message_start', { messageId: 'm1' }),
      frame('message_end', { status: 'completed' }),
    ]);
    expect(events).toEqual([['message_start', '{"messageId":"m1"}'], ['message_end', '{"status":"completed"}']]);
  });

  it('`\\r\\n` 恰被 TCP 分片切开（chunk 以 \\r 结尾，下一 chunk 以 \\n 开头）不漏帧、不早派发', async () => {
    const raw = crlfFrame('x', { a: 1 }) + crlfFrame('y', { b: 2 });
    const cut = raw.indexOf('\r\n\r\n'); // 第一帧的帧尾 CRLF
    const chunks = [raw.slice(0, cut + 1), raw.slice(cut + 1)]; // 切开 "\r" | "\n\r\n..."
    expect(chunks[0].endsWith('\r')).toBe(true);
    expect(chunks[1].startsWith('\n')).toBe(true);

    const seen: Array<[string, string]> = [];
    await consumeSSE(new ReadableStream<Uint8Array>({
      start(c) { for (const ch of chunks) c.enqueue(new TextEncoder().encode(ch)); c.close(); },
    }), (e, d) => { seen.push([e, d]); });
    expect(seen).toEqual([['x', '{"a":1}'], ['y', '{"b":2}']]);
  });

  it('CRLF 流中的多行 data: 仍按 \\n 拼接（归一化不改变 data 语义）', async () => {
    const events = await collect(['event: x\r\ndata: line1\r\ndata: line2\r\n\r\n']);
    expect(events).toEqual([['x', 'line1\nline2']]);
  });

  it('CRLF 心跳注释帧不派发事件', async () => {
    const events = await collect([': ping\r\n\r\n', crlfFrame('status', { stage: 'thinking', message: '分析中' })]);
    expect(events).toEqual([['status', '{"stage":"thinking","message":"分析中"}']]);
  });
});
