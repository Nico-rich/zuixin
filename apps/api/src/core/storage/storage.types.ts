import { Readable } from 'node:stream';

/**
 * 对象存储驱动契约。
 *
 * M11-P11（D1-12/NV-13）**有界性要求**：实现方必须保证 put/getStream/delete **不会永久挂起**
 * （网络/磁盘故障时须自行以超时或 abort 收口；S3 驱动由 `NodeHttpHandler` 的建连/请求超时兜底）。
 * 调用方（尤其请求路径）仍应再套 `core/storage/storage-timeouts.ts` 的 `withStorageDeadline`——
 * 存储驱动是外部依赖面，任何第三方实现都不可假定其遵守上界。
 */
/**
 * M12-P5：对象枚举条目（`list` 能力的最小事实）。
 *
 * `lastModified` 允许为 null（驱动拿不到修改时间时如实给 null，**绝不猜测**）——调用方一律把它
 * 当作"年龄未知"保守处理（见 scheduler/storage-orphan-sweep.service.ts：年龄未知的对象永不被删）。
 */
export interface StorageObjectInfo {
  key: string;
  sizeBytes: number;
  /** 对象最后修改时间；null = 驱动无法提供（不是"1970 年"，别拿它当"很旧"） */
  lastModified: Date | null;
}

export interface StorageListOptions {
  /** 只列该前缀下的对象（缺省 = 全量）。前缀是**字面前缀**，不做目录语义推断 */
  prefix?: string;
  /** 单页上限（驱动必须遵守，可再收敛到自己的上限） */
  limit?: number;
  /** 续页游标：上一页返回的 `nextCursor`（null/undefined = 从头开始） */
  cursor?: string | null;
}

export interface StorageListPage {
  objects: StorageObjectInfo[];
  /** 下一页游标；null = 已到末尾 */
  nextCursor: string | null;
}

export interface StorageAdapter {
  put(key: string, stream: Readable, meta: { contentType: string; sizeBytes: number }): Promise<void>;
  // 预留，未接线（M12 Final Audit 登记：零生产调用点；上传仍为服务端 multipart）
  createPresignedUrl(key: string, expiresInSec: number): Promise<string>;
  /** 读取文件流（附件回源 / 参考图 base64 转换） */
  getStream?(key: string): Promise<Readable>;
  delete(key: string): Promise<void>;
  /**
   * 枚举对象（**可选能力**；M12-P5 孤儿对象清扫的数据来源）。
   *
   * 未实现的驱动 ⇒ undefined：调用方必须把「驱动不支持枚举」与「枚举到 0 个对象」当成两件不同的事
   * （前者是能力缺失、后者是空桶），绝不静默把前者当后者——否则"清扫器报告干净"会掩盖"根本没扫"。
   * 与 put/getStream/delete 同一有界性要求：list 也必须自行收口（S3 驱动走同一 abort 兜底）。
   */
  list?(options?: StorageListOptions): Promise<StorageListPage>;
}
