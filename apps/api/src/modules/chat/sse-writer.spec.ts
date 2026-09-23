import { describe, it, expect } from 'vitest';
import { SSEWriter, SSESink } from './sse-writer';

class FakeSink implements SSESink {
  chunks: string[] = [];
  ended = false;
  writeHead(_code: number, headers: Record<string, string>) { this.chunks.push(`HEAD ${JSON.stringify(headers)}`); }
  write(s: string) { this.chunks.push(s); }
  flushHeaders() {}
  end() { this.ended = true; }
}

describe('SSEWriter', () => {
  it('init 写 SSE 响应头', () => {
    const sink = new FakeSink();
    const w = new SSEWriter(sink);
    w.init();
    expect(sink.chunks[0]).toContain('text/event-stream');
  });

  it('event 序列化为 event:/data: 双行 + 空行', () => {
    const sink = new FakeSink();
    const w = new SSEWriter(sink);
    w.event('message_delta', { delta: '你' });
    expect(sink.chunks.join('')).toBe('event: message_delta\ndata: {"delta":"你"}\n\n');
  });

  it('ping 为注释帧', () => {
    const sink = new FakeSink();
    const w = new SSEWriter(sink);
    w.ping();
    expect(sink.chunks.join('')).toBe(': ping\n\n');
  });

  it('end 关闭流', () => {
    const sink = new FakeSink();
    const w = new SSEWriter(sink);
    w.end();
    expect(sink.ended).toBe(true);
  });
});
