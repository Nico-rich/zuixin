import { Injectable } from '@nestjs/common';
import { KVStore } from './kv-store.interface';

export type BreakerState = 'healthy' | 'open' | 'half_open';
export interface BreakerConfig { failureThreshold?: number; cooldownSec?: number; }

const WINDOW_SEC = 60;

@Injectable()
export class CircuitBreakerService {
  constructor(private readonly kv: KVStore, private readonly now: () => number = Date.now) {}

  private key(p: string, s: string) { return `cb:${p}:${s}`; }

  async state(providerId: string, cfg: BreakerConfig = {}): Promise<BreakerState> {
    const openedAt = await this.kv.get(this.key(providerId, 'openedAt'));
    if (openedAt) {
      const cooldown = (cfg.cooldownSec ?? 60) * 1000;
      return this.now() - Number(openedAt) >= cooldown ? 'half_open' : 'open';
    }
    return 'healthy';
  }

  /** 判定该 provider 当前是否允许调用（open 拒绝；half_open 只放行探测请求） */
  async canCall(providerId: string, cfg: BreakerConfig = {}, isProbe = false): Promise<boolean> {
    const s = await this.state(providerId, cfg);
    if (s === 'healthy') return true;
    if (s === 'half_open') return isProbe;
    return false;
  }

  async recordSuccess(providerId: string): Promise<void> {
    await this.kv.set(this.key(providerId, 'consecutiveFailures'), '0', WINDOW_SEC);
    await this.kv.set(this.key(providerId, 'openedAt'), ''); // 清除熔断标记（空串视为无标记）
    await this.kv.incr(this.key(providerId, 'success'), WINDOW_SEC);
  }

  async recordFailure(providerId: string, cfg: BreakerConfig = {}): Promise<boolean> {
    const fails = await this.kv.incr(this.key(providerId, 'consecutiveFailures'), WINDOW_SEC);
    const openedAt = await this.kv.get(this.key(providerId, 'openedAt'));
    if (!openedAt && fails >= (cfg.failureThreshold ?? 5)) {
      await this.kv.set(this.key(providerId, 'openedAt'), String(this.now()));
      return true; // 本次触发熔断
    }
    return false;
  }
}
