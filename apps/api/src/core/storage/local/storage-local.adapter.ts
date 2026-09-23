import { createWriteStream, mkdirSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { StorageAdapter } from '../storage.types';

/** 开发环境本地磁盘驱动；createPresignedUrl 返回 local:// URI 由 API 附件端点流式回源（M2 实现） */
export class StorageLocalAdapter implements StorageAdapter {
  constructor(private readonly rootDir: string) {}

  async put(key: string, stream: Readable, _meta: { contentType: string; sizeBytes: number }): Promise<void> {
    const path = this.safePath(key);
    mkdirSync(dirname(path), { recursive: true });
    await pipeline(stream, createWriteStream(path));
  }

  async createPresignedUrl(key: string, _expiresInSec: number): Promise<string> { return `local://${key}`; }

  async getStream(key: string): Promise<Readable> {
    const { createReadStream } = await import('node:fs');
    return createReadStream(this.safePath(key));
  }

  async delete(key: string): Promise<void> {
    await rm(this.safePath(key), { force: true });
  }

  /** 路径穿越防护：含 `..`、空段或反斜杠的 key 直接拒绝（fail loud，而非静默改写；Windows 下 `\` 同样是分隔符） */
  private safePath(key: string): string {
    const segments = key.split('/');
    if (segments.some((s) => s === '..' || s === '' || s.includes('\\'))) {
      throw new Error('非法 storage key');
    }
    const path = resolve(this.rootDir, ...segments);
    if (!path.startsWith(resolve(this.rootDir))) throw new Error('非法 storage key');
    return path;
  }
}
