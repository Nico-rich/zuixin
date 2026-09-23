/** 熔断计数用 KV 抽象（Redis 生产 / 内存 fake 测试） */
export interface KVStore {
  incr(key: string, ttlSec: number): Promise<number>;
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlSec?: number): Promise<void>;
}
