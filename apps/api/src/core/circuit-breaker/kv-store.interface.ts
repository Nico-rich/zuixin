/** KV 抽象（Redis 生产 / 内存 fake 测试）：熔断计数 + 分布式锁 */
export interface KVStore {
  incr(key: string, ttlSec: number): Promise<number>;
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlSec?: number): Promise<void>;
  setNX(key: string, value: string, ttlSec: number): Promise<boolean>; // 不存在才写入（锁）
  del(key: string): Promise<void>;
}
