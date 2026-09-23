/** SSE 输出端最小接口（Express Response / 测试 fake） */
export interface SSESink {
  writeHead(code: number, headers: Record<string, string>): void;
  flushHeaders(): void;
  write(chunk: string): void;
  end(): void;
}

export class SSEWriter {
  constructor(private readonly sink: SSESink) {}

  init(): void {
    this.sink.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    this.sink.flushHeaders();
  }

  event(name: string, data: unknown): void {
    this.sink.write(`event: ${name}\n`);
    this.sink.write(`data: ${JSON.stringify(data)}\n\n`);
  }

  ping(): void { this.sink.write(': ping\n\n'); }

  end(): void { this.sink.end(); }
}
