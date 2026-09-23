export type SSEHandler = (event: string, data: string) => void;

/** fetch ReadableStream → SSE 事件流（POST+SSE 用 fetch 而非 EventSource） */
export async function consumeSSE(body: ReadableStream<Uint8Array>, onEvent: SSEHandler): Promise<void> {
  const decoder = new TextDecoder();
  let buf = '';
  for await (const chunk of readChunks(body)) {
    buf += decoder.decode(chunk, { stream: true });
    let idx: number;
    while ((idx = buf.indexOf('\n\n')) >= 0) {
      const frame = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      let event = 'message';
      const dataLines: string[] = [];
      for (const line of frame.split('\n')) {
        if (line.startsWith('event:')) event = line.slice(6).trim();
        else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
      }
      if (dataLines.length) onEvent(event, dataLines.join('\n'));
    }
  }
}

async function* readChunks(stream: ReadableStream<Uint8Array>): AsyncGenerator<Uint8Array> {
  const reader = stream.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      yield value;
    }
  } finally { reader.releaseLock(); }
}
