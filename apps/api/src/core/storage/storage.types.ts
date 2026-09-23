import { Readable } from 'node:stream';

export interface StorageAdapter {
  put(key: string, stream: Readable, meta: { contentType: string; sizeBytes: number }): Promise<void>;
  createPresignedUrl(key: string, expiresInSec: number): Promise<string>;
  /** 读取文件流（附件回源 / 参考图 base64 转换） */
  getStream?(key: string): Promise<Readable>;
  delete(key: string): Promise<void>;
}
