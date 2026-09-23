import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { StorageLocalAdapter } from './storage-local.adapter';

describe('StorageLocalAdapter', () => {
  let dir: string; let adapter: StorageLocalAdapter;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'storage-test-')); adapter = new StorageLocalAdapter(dir); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('put 写入文件，delete 删除', async () => {
    await adapter.put('u1/2026/09/a.txt', Readable.from(['hello']), { contentType: 'text/plain', sizeBytes: 5 });
    const path = join(dir, 'u1', '2026', '09', 'a.txt');
    expect(readFileSync(path, 'utf8')).toBe('hello');
    await adapter.delete('u1/2026/09/a.txt');
    expect(existsSync(path)).toBe(false);
  });

  it('createPresignedUrl 返回 local:// URI（由 API 附件端点流式回源）', async () => {
    const url = await adapter.createPresignedUrl('u1/x.png', 900);
    expect(url).toBe('local://u1/x.png');
  });

  it('路径穿越被拒绝', async () => {
    await expect(adapter.put('../evil.txt', Readable.from(['x']), { contentType: 'text/plain', sizeBytes: 1 }))
      .rejects.toThrow();
  });
});
