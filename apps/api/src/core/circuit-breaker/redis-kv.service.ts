import { Injectable, OnModuleDestroy } from '@nestjs/common';
import Redis from 'ioredis';
import { KVStore } from './kv-store.interface';

@Injectable()
export class RedisKVService implements KVStore, OnModuleDestroy {
  private readonly client: Redis;
  constructor() {
    this.client = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379', { maxRetriesPerRequest: null });
  }
  async incr(key: string, ttlSec: number): Promise<number> {
    const n = await this.client.incr(key);
    if (n === 1) await this.client.expire(key, ttlSec);
    return n;
  }
  async get(key: string) { return this.client.get(key); }
  async set(key: string, value: string, ttlSec?: number) {
    if (ttlSec) await this.client.set(key, value, 'EX', ttlSec);
    else await this.client.set(key, value);
  }
  onModuleDestroy() { this.client.disconnect(); }
}
