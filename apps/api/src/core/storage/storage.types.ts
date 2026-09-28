import { Readable } from 'node:stream';

/**
 * 对象存储驱动契约。
 *
 * M11-P11（D1-12/NV-13）**有界性要求**：实现方必须保证 put/getStream/delete **不会永久挂起**
 * （网络/磁盘故障时须自行以超时或 abort 收口；S3 驱动由 `NodeHttpHandler` 的建连/请求超时兜底）。
 * 调用方（尤其请求路径）仍应再套 `core/storage/storage-timeouts.ts` 的 `withStorageDeadline`——
 * 存储驱动是外部依赖面，任何第三方实现都不可假定其遵守上界。
 */
export interface StorageAdapter {
  put(key: string, stream: Readable, meta: { contentType: string; sizeBytes: number }): Promise<void>;
  createPresignedUrl(key: string, expiresInSec: number): Promise<string>;
  /** 读取文件流（附件回源 / 参考图 base64 转换） */
  getStream?(key: string): Promise<Readable>;
  delete(key: string): Promise<void>;
}
