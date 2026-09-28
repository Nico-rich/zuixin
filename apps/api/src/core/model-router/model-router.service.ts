import { Injectable, Logger } from '@nestjs/common';
import { AppError } from '../../common/errors/app-error';
import { mapProviderError, ProviderLikeError } from '../../common/errors/provider-error';
import { CircuitBreakerService } from '../circuit-breaker/circuit-breaker.service';

export interface ModelCandidate {
  modelId: string; providerId: string;
  priority: number; cost: number; latencyMs: number;
  /** Pre-M9 G1：半开 provider 候选（仅作探测使用，排在健康候选之后；探针失败会重新熔断） */
  probe?: boolean;
}

export interface ExecuteResult<T> { result: T; usedModel: ModelCandidate; fallbacks: ModelCandidate[]; }

/** 选模执行器：health → priority → cost → latency 排序；可重试错误逐个回退 */
@Injectable()
export class ModelRouterService {
  private readonly logger = new Logger('ModelRouter');
  constructor(
    private readonly cb: CircuitBreakerService,
    private readonly sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
  ) {}

  /**
   * 熔断过滤 + 排序：open provider 剔除；healthy 候选在前（priority → cost → latency）；
   * half-open provider 作为 **探测候选** 追加在末尾（G1：绝不再被永久排除——探通即复位，探败即重新熔断）。
   */
  async order(candidates: ModelCandidate[]): Promise<ModelCandidate[]> {
    const healthy: ModelCandidate[] = [];
    const probes: ModelCandidate[] = [];
    for (const c of candidates) {
      const s = await this.cb.state(c.providerId);
      if (s === 'open') continue;
      if (s === 'half_open') {
        if (!(await this.cb.canCall(c.providerId, {}, true))) continue; // 熔断器裁决：半开只放行探测
        probes.push({ ...c, probe: true });
        continue;
      }
      healthy.push(c);
    }
    const byRank = (a: ModelCandidate, b: ModelCandidate) =>
      a.priority - b.priority || a.cost - b.cost || a.latencyMs - b.latencyMs;
    return [...healthy.sort(byRank), ...probes.sort(byRank)];
  }

  async execute<T>(candidates: ModelCandidate[], fn: (c: ModelCandidate) => Promise<T>): Promise<ExecuteResult<T>> {
    const ordered = await this.order(candidates);
    const fallbacks: ModelCandidate[] = [];
    let lastErr: AppError | undefined;
    for (const c of ordered) {
      // 调用前最终裁决（order 与 execute 之间状态可能变化）：半开探测需抢占单飞探测槽
      if (!(await this.cb.canProbe(c.providerId))) {
        this.logger.warn(`provider ${c.providerId} 半开探测槽被占用/已重新熔断，跳过`);
        continue;
      }
      try {
        const result = await fn(c);
        await this.cb.recordSuccess(c.providerId);
        return { result, usedModel: c, fallbacks };
      } catch (err) {
        // 裸错误（含 status/name 信息）先归一化为 AppError，retryable 标记决定是否回退
        lastErr = err instanceof AppError ? err : mapProviderError(err as ProviderLikeError);
        await this.cb.recordFailure(c.providerId);
        if (!lastErr.retryable) break; // 参数/鉴权类错误回退无意义
        fallbacks.push(c);
        this.logger.warn(`provider ${c.providerId} 调用失败（${lastErr.code}），回退下一个候选`);
        await this.sleep(1000);
      }
    }
    throw new AppError(
      lastErr?.code ?? 'PROVIDER_UNKNOWN',
      `所有可用模型均失败（已尝试 ${ordered.length} 个）`,
      undefined, lastErr,
    );
  }
}
