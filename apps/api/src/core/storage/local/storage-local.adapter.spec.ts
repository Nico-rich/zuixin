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

  it('getStream：文件存在 → 可读流；不存在 → 确定性 NOT_FOUND（绝不返回裸 error 流打崩进程）', async () => {
    await adapter.put('u1/ok.txt', Readable.from(['ok']), { contentType: 'text/plain', sizeBytes: 2 });
    const stream = await adapter.getStream('u1/ok.txt');
    const chunks: Buffer[] = [];
    for await (const c of stream) chunks.push(c as Buffer);
    expect(Buffer.concat(chunks).toString()).toBe('ok');

    await expect(adapter.getStream('u1/missing.png')).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('getStream：key 指向目录 → NOT_FOUND（EISDIR 不得以 error 流形式漏出）', async () => {
    await adapter.put('u1/sub/a.txt', Readable.from(['x']), { contentType: 'text/plain', sizeBytes: 1 });
    await expect(adapter.getStream('u1/sub')).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});

/**
 * M12-P5：`list`（孤儿对象清扫的数据来源）。
 * 与 S3 驱动同一语义：字面前缀、游标 = 上一页最后一个 key、lastModified 拿得到就给（本地驱动恒能拿到）。
 */
describe('StorageLocalAdapter list（M12-P5 对象枚举）', () => {
  let dir: string; let adapter: StorageLocalAdapter;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'storage-list-')); adapter = new StorageLocalAdapter(dir); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  const put = (key: string, body = 'x') => adapter.put(key, Readable.from([body]), { contentType: 'text/plain', sizeBytes: body.length });

  it('枚举全部文件：key 为相对根目录的 POSIX 形式，sizeBytes/lastModified 来自文件本身', async () => {
    await put('u1/2026/09/a.txt', 'hello');
    await put('u2/b.bin', 'xy');

    const page = await adapter.list();

    expect(page.objects.map((o) => o.key)).toEqual(['u1/2026/09/a.txt', 'u2/b.bin']);
    expect(page.objects.map((o) => o.sizeBytes)).toEqual([5, 2]);
    for (const o of page.objects) expect(o.lastModified).toBeInstanceOf(Date); // 本地驱动拿得到，绝不给 null
    expect(page.nextCursor).toBeNull();
  });

  it('前缀是字面前缀：`u1/2026` 同时命中 `u1/2026/...` 与 `u1/20260/...`（不做目录语义推断，与 S3 一致）', async () => {
    await put('u1/2026/a.txt');
    await put('u1/20260/b.txt');
    await put('u1/2027/c.txt');

    const page = await adapter.list({ prefix: 'u1/2026' });

    expect(page.objects.map((o) => o.key)).toEqual(['u1/2026/a.txt', 'u1/20260/b.txt']);
  });

  it('分页：nextCursor = 上一页最后一个 key，续页严格大于游标；翻完不漏不重', async () => {
    for (const k of ['a/1', 'a/2', 'a/3', 'a/4', 'a/5']) await put(k);

    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const page: Awaited<ReturnType<StorageLocalAdapter['list']>> = await adapter.list({ prefix: 'a/', limit: 2, cursor });
      seen.push(...page.objects.map((o) => o.key));
      cursor = page.nextCursor;
      pages += 1;
    } while (cursor !== null);

    expect(seen).toEqual(['a/1', 'a/2', 'a/3', 'a/4', 'a/5']);
    expect(pages).toBe(3);
  });

  it('边界：根目录不存在 ⇒ 空页（空桶不是错误）；空目录不产生对象；limit 收敛到 [1, 硬上界]', async () => {
    rmSync(dir, { recursive: true, force: true });
    await expect(adapter.list()).resolves.toEqual({ objects: [], nextCursor: null });

    await put('a/1');
    await adapter.list({ prefix: 'nope/' }).then((p) => expect(p.objects).toEqual([]));
    // 非法 limit（0 / Infinity）不得打穿：0 → 回退默认，Infinity → 收敛到硬上界
    await expect(adapter.list({ limit: 0 })).resolves.toMatchObject({ nextCursor: null });
    await expect(adapter.list({ limit: Number.POSITIVE_INFINITY })).resolves.toMatchObject({ nextCursor: null });
  });

  it('与 put/delete 同一 key 口径：`\\` 归一为 `/`（Windows 路径分隔符不会漏进 key）', async () => {
    await put('u1/2026/09/a.txt');
    const page = await adapter.list();
    expect(page.objects[0].key).not.toContain('\\');
  });
});
