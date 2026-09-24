import { Injectable } from '@nestjs/common';

export interface ChunkingOptions {
  chunkSize?: number;   // 字符数，默认 800
  overlap?: number;     // 重叠字符数，默认 120
}

/**
 * 基础文本分块（确定性、无空块、同输入同输出）。
 * P5 不做语义切分/NLP——按长度 + overlap 稳定切分。
 */
@Injectable()
export class ChunkingService {
  chunk(text: string, options: ChunkingOptions = {}): string[] {
    const chunkSize = options.chunkSize ?? 800;
    const overlap = options.overlap ?? 120;
    if (chunkSize <= 0) throw new Error('chunkSize 必须为正数');
    if (overlap >= chunkSize) throw new Error('overlap 必须小于 chunkSize');

    const normalized = text.replace(/\r\n/g, '\n').trim();
    if (!normalized) return [];
    if (normalized.length <= chunkSize) return [normalized];

    const chunks: string[] = [];
    const step = chunkSize - overlap;
    let start = 0;
    while (start < normalized.length) {
      const end = Math.min(start + chunkSize, normalized.length);
      const piece = normalized.slice(start, end).trim();
      if (piece) chunks.push(piece);
      if (end >= normalized.length) break;
      start += step;
    }
    return chunks;
  }
}
