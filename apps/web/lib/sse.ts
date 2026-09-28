export type SSEHandler = (event: string, data: string) => void;

/**
 * fetch ReadableStream → SSE 事件流（POST+SSE 用 fetch 而非 EventSource）。
 *
 * M10-P13（审计 M9-20）**CRLF 分帧**：SSE 线上规范允许 `\r\n` 作为行结束符（部分代理/网关会把
 * `\n` 重写为 `\r\n`）。原实现只按 `\n\n` 切帧 → CRLF 流的帧边界永远匹配不上，全部内容滞留到流结束
 * 被丢弃（前端表现为"连接正常但一条事件都收不到"）。修复：先**归一化**行结束符再切帧。
 *
 * 归一化作用在**累积缓冲**（而非单个 chunk）上：`\r` 恰好落在 chunk 末尾时保持原样，
 * 等下一 chunk 的 `\n` 到达后一起替换——跨 TCP 分片的 `\r\n` 不会被误判或漏判。
 */
export async function consumeSSE(body: ReadableStream<Uint8Array>, onEvent: SSEHandler): Promise<void> {
  const decoder = new TextDecoder();
  let buf = '';
  for await (const chunk of readChunks(body)) {
    buf = (buf + decoder.decode(chunk, { stream: true })).replace(/\r\n/g, '\n');
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
