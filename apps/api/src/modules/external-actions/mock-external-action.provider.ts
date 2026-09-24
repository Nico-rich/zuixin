import { Injectable } from '@nestjs/common';
import { ExternalActionProvider, ExternalActionRequest } from './external-action-provider.interface';
import { AppError, ErrorCode } from '../../common/errors/app-error';

/**
 * M7-P3 Mock External Action Provider（测试向量由 actionType 驱动，确定性）：
 * - success/duplicate → 成功（externalId 含 requestId，可断言幂等键复用）；
 * - failure → PROVIDER_UNKNOWN；timeout → PROVIDER_TIMEOUT；
 * - retry → 同 requestId 首次瞬时超时、之后成功（演示「重复请求不重复执行 + 重试收敛」）；
 * - forbidden → FORBIDDEN。
 * 绝不伪造真实平台（shopify/amazon/meta/google/tiktok）调用成功。
 */
@Injectable()
export class MockExternalActionProvider implements ExternalActionProvider {
  readonly name = 'mock';
  executeCount = 0;
  /** requestId 级去重记忆（retry 向量） */
  private readonly seen = new Set<string>();

  async execute(req: ExternalActionRequest): Promise<unknown> {
    this.executeCount++;
    if (req.signal.aborted) {
      throw Object.assign(new Error('aborted'), { name: 'AbortError' });
    }
    switch (req.actionType) {
      case 'success':
      case 'duplicate':
        return { ok: true, externalId: `${req.externalRequestId}-done`, payload: req.payload };
      case 'failure':
        throw new AppError(ErrorCode.PROVIDER_UNKNOWN, 'mock: 外部执行失败');
      case 'timeout':
        throw new AppError(ErrorCode.PROVIDER_TIMEOUT, 'mock: 外部执行超时');
      case 'retry':
        if (this.seen.has(req.externalRequestId)) {
          return { ok: true, retried: true, externalId: `${req.externalRequestId}-done` };
        }
        this.seen.add(req.externalRequestId);
        throw new AppError(ErrorCode.PROVIDER_TIMEOUT, 'mock: 瞬时超时（重试后成功）');
      case 'forbidden':
        throw new AppError(ErrorCode.FORBIDDEN, 'mock: 远端拒绝');
      default:
        return { ok: true, externalId: `${req.externalRequestId}-default`, payload: req.payload };
    }
  }
}
