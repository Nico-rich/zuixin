import { createWriteStream, existsSync, lstatSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { StorageAdapter, StorageListOptions, StorageListPage, StorageObjectInfo } from '../storage.types';

/** 单页上限的驱动侧硬上界（防止调用方传 Infinity 把整棵树读进内存） */
const MAX_LIST_LIMIT = 10_000;
const DEFAULT_LIST_LIMIT = 1_000;

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

  /**
   * M12-P5：枚举本驱动落地目录下的对象（孤儿对象清扫的数据来源）。
   *
   * 语义与边界：
   * - key 一律是**相对根目录的 POSIX 形式**（`\` 归一为 `/`），与 put/delete 的 key 口径一致；
   * - 只返回**文件**（空目录不产生对象）；`lastModified` 取文件 mtime（本地驱动拿得到，绝不给 null）；
   * - 前缀是字面前缀过滤（`u1/2026` 同时命中 `u1/2026/x` 与 `u1/20260/y`——不做目录语义推断，
   *   与 S3 `Prefix` 参数同一语义，避免两个驱动对同一个前缀给出不同结果）；
   * - 游标 = 上一页最后一个 key（**严格大于**继续）——keys 先排序再分页，因此翻页稳定、不漏不重
   *   （本地驱动是开发/单机形态，代价是每页一次全树 walk；对象量大时应改用对象存储驱动）。
   * - 根目录不存在 ⇒ 空页（空桶，不是错误）。
   */
  async list(options: StorageListOptions = {}): Promise<StorageListPage> {
    const limit = Math.min(Math.max(Math.trunc(options.limit ?? DEFAULT_LIST_LIMIT) || DEFAULT_LIST_LIMIT, 1), MAX_LIST_LIMIT);
    const prefix = options.prefix ?? '';
    const cursor = options.cursor ?? null;
    const entries = (existsSync(this.rootDir) ? this.walk(this.rootDir) : [])
      .map((absolute) => ({ key: relative(this.rootDir, absolute).split('\\').join('/'), absolute }))
      .filter((entry) => entry.key.startsWith(prefix))
      .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
    const start = cursor === null ? 0 : entries.findIndex((e) => e.key > cursor);
    const windowSlice = start < 0 ? [] : entries.slice(start, start + limit);
    const objects: StorageObjectInfo[] = [];
    for (const entry of windowSlice) {
      const stat = statSync(entry.absolute, { throwIfNoEntry: false });
      if (!stat?.isFile()) continue; // 与 walk 之间的竞态（对象刚被删）：跳过而不是抛错
      objects.push({ key: entry.key, sizeBytes: stat.size, lastModified: stat.mtime });
    }
    const last = windowSlice[windowSlice.length - 1];
    const hasMore = start >= 0 && start + limit < entries.length;
    return { objects, nextCursor: hasMore && last ? last.key : null };
  }

  /**
   * 递归收集根目录下的全部文件绝对路径（目录不存在/遍历中被删 ⇒ 空，绝不因竞态抛错）。
   *
   * 用 `readdirSync`（名字）+ `lstatSync` 而不是 `withFileTypes`：后者在 @types/node 下返回
   * `Dirent<NonSharedBuffer>`，与 `Dirent<string>` 不是同一类型（本仓库 strict 下无法安全标注）。
   * `lstat`（**不跟随符号链接**）同时确保 `isDirectory()`/`isFile()` 与 `withFileTypes` 的判据一致，
   * 也避免符号链接环导致无限递归。
   */
  private walk(dir: string): string[] {
    const out: string[] = [];
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return out;
    }
    for (const name of names) {
      const full = join(dir, name);
      const st = lstatSync(full, { throwIfNoEntry: false });
      if (!st) continue; // 遍历途中被删（竞态）：跳过
      if (st.isDirectory()) out.push(...this.walk(full));
      else if (st.isFile()) out.push(full);
    }
    return out;
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
