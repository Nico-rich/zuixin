import { Injectable, Logger } from '@nestjs/common';
import { AppError } from '../../common/errors/app-error';
import { mapProviderError, ProviderLikeError } from '../../common/errors/provider-error';
import { CircuitBreakerService } from '../circuit-breaker/circuit-breaker.service';

export interface ModelCandidate {
  modelId: string; providerId: string;
  priority: number; cost: number; latencyMs: number;
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

  /** 过滤熔断中 provider 并按 priority → cost → latency 排序 */
  async order(candidates: ModelCandidate[]): Promise<ModelCandidate[]> {
    const filtered: ModelCandidate[] = [];
    for (const c of candidates) {
      if (await this.cb.canCall(c.providerId)) filtered.push(c);
    }
    return filtered.sort((a, b) => a.priority - b.priority || a.cost - b.cost || a.latencyMs - b.latencyMs);
  }

  async execute<T>(candidates: ModelCandidate[], fn: (c: ModelCandidate) => Promise<T>): Promise<ExecuteResult<T>> {
    const ordered = await this.order(candidates);
    const fallbacks: ModelCandidate[] = [];
    let lastErr: AppError | undefined;
    for (const c of ordered) {
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
