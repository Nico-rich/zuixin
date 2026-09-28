import { Injectable } from '@nestjs/common';
import { KVStore } from './kv-store.interface';

export type BreakerState = 'healthy' | 'open' | 'half_open';
export interface BreakerConfig { failureThreshold?: number; cooldownSec?: number; }

const WINDOW_SEC = 60;
const DEFAULT_FAILURE_THRESHOLD = 5;
const DEFAULT_COOLDOWN_SEC = 60;
/**
 * Pre-M9 G1：openedAt 标记的存活时间 = 冷却期 + 观察窗。
 * 冷却期到期 → half_open（仅探测放行）；观察窗内无探测 → 标记自然过期 → 自愈回 healthy。
 * 关键点：**绝不留下永久排除的键**（旧实现 openedAt 无 TTL，跳闸即永久出局）。
 */
const HALF_OPEN_OBSERVE_SEC = 600;
/** 半开探测槽 TTL（同一 provider 冷却窗内只允许单个并发探测，防止冷却到期瞬间探测风暴） */
const PROBE_SLOT_SEC = 30;

/**
 * Pre-M9 G1 熔断器（三态 + TTL 自愈）：
 * - healthy：正常调用；连续失败达阈值 → open（记录 openedAt）
 * - open：拒绝一切调用；openedAt + cooldown 到期 → half_open（无需外部干预，自动半开）
 * - half_open：只放行探测请求（canCall(..., isProbe=true)）；探测成功 → healthy（复位），探测失败 → 重新 open（冷却重计时）
 * 状态由 KV 中的 openedAt 时间戳派生（多实例一致，无进程内状态）。
 */
@Injectable()
export class CircuitBreakerService {
  constructor(private readonly kv: KVStore, private readonly now: () => number = Date.now) {}

  private key(p: string, s: string) { return `cb:${p}:${s}`; }

  private cooldownMs(cfg: BreakerConfig): number {
    return (cfg.cooldownSec ?? DEFAULT_COOLDOWN_SEC) * 1000;
  }

  /** 冷却期 + 观察窗 → openedAt 键 TTL（秒）；保证冷却判定期间标记一定可读 */
  private openTtlSec(cfg: BreakerConfig): number {
    return Math.max(1, Math.ceil(this.cooldownMs(cfg) / 1000)) + HALF_OPEN_OBSERVE_SEC;
  }

  async state(providerId: string, cfg: BreakerConfig = {}): Promise<BreakerState> {
    const openedAt = await this.kv.get(this.key(providerId, 'openedAt'));
    if (openedAt) {
      return this.now() - Number(openedAt) >= this.cooldownMs(cfg) ? 'half_open' : 'open';
    }
    return 'healthy';
  }

  /**
   * M9-P3 只读窗口统计（路由评分输入）：当前 KV 窗口内的连续失败数与成功数。
   * **纯读取，绝不写入/复位计数**（熔断计数的唯一写入者是 recordSuccess/recordFailure）；
   * KV 不可用 → 返回零值（评分退化为「无窗口事实」，绝不因观测面故障改变路由准入）。
   */
  async windowStats(providerId: string): Promise<{ failures: number; successes: number }> {
    try {
      const [failures, successes] = await Promise.all([
        this.kv.get(this.key(providerId, 'consecutiveFailures')),
        this.kv.get(this.key(providerId, 'success')),
      ]);
      return {
        failures: Math.max(0, Number(failures ?? 0) || 0),
        successes: Math.max(0, Number(successes ?? 0) || 0),
      };
    } catch {
      return { failures: 0, successes: 0 };
    }
  }

  /** 判定该 provider 当前是否允许调用（open 拒绝；half_open 只放行探测请求） */
  async canCall(providerId: string, cfg: BreakerConfig = {}, isProbe = false): Promise<boolean> {
    const s = await this.state(providerId, cfg);
    if (s === 'healthy') return true;
    if (s === 'half_open') return isProbe;
    return false;
  }

  /**
   * 半开探测放行（单飞）：state=half_open 时用 NX 抢占探测槽，保证同一冷却窗只有一个在途探测；
   * 槽被占用 → 视为「暂不可调用」（调用方跳过该 provider，稍后重试）。
   */
  async canProbe(providerId: string, cfg: BreakerConfig = {}): Promise<boolean> {
    const s = await this.state(providerId, cfg);
    if (s === 'healthy') return true; // 健康 provider 无需抢槽
    if (s === 'open') return false;
    return this.kv.setNX(this.key(providerId, 'probe'), String(this.now()), PROBE_SLOT_SEC);
  }

  /** 调用成功：复位熔断标记（healthy）+ 清零连续失败计数 + 释放探测槽 */
  async recordSuccess(providerId: string): Promise<void> {
    await this.kv.set(this.key(providerId, 'consecutiveFailures'), '0', WINDOW_SEC);
    await this.kv.del(this.key(providerId, 'openedAt'));
    await this.kv.del(this.key(providerId, 'probe'));
    await this.kv.incr(this.key(providerId, 'success'), WINDOW_SEC);
  }

  /** 调用失败：半开探测失败 → 立即重新 open；健康态累计达阈值 → open。返回本次是否（重新）触发熔断 */
  async recordFailure(providerId: string, cfg: BreakerConfig = {}): Promise<boolean> {
    const fails = await this.kv.incr(this.key(providerId, 'consecutiveFailures'), WINDOW_SEC);
    const s = await this.state(providerId, cfg);
    if (s === 'half_open') {
      // 探测失败 → 重新打开（openedAt 重计时，探测槽释放）
      await this.kv.set(this.key(providerId, 'openedAt'), String(this.now()), this.openTtlSec(cfg));
      await this.kv.del(this.key(providerId, 'probe'));
      return true;
    }
    if (s === 'healthy' && fails >= (cfg.failureThreshold ?? DEFAULT_FAILURE_THRESHOLD)) {
      await this.kv.set(this.key(providerId, 'openedAt'), String(this.now()), this.openTtlSec(cfg));
      return true; // 本次触发熔断
    }
    return false;
  }
}
