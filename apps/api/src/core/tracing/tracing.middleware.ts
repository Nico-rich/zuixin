import { Inject, Injectable } from '@nestjs/common';
import { NextFunction, Request, Response } from 'express';
import { ObservabilityService } from './observability.service';
import { TraceContext, newTraceId } from './trace-context';

/**
 * M8-P3 HTTP 追踪中间件（传播 + 基础指标采样）：
 * - requestId 复用 pino genReqId 写入的 req.id（无则取 X-Request-Id 头，再退化为新 uuid）；
 * - traceId 从 X-Trace-Id 头继承（跨服务关联），否则新生成；两者都回写响应头；
 * - 请求处理链在下游执行于 TraceContext 内（服务层审计自动携带 requestId/traceId）；
 * - res.on('finish') 采样 request_count / request_latency_ms / error_count（status≥400）。
 * 注册方式：main.ts 单行 app.use(app.get(TracingMiddleware).handler)（express 需函数而非实例）。
 */
@Injectable()
export class TracingMiddleware {
  constructor(@Inject(ObservabilityService) private readonly metrics: ObservabilityService) {}

  /** express 兼容 handler（绑定实例，保留 DI 注入的 metrics） */
  handler = (req: Request, res: Response, next: NextFunction): void => {
    const incomingRequestId = req.headers['x-request-id'];
    const requestId = (req as Request & { id?: string }).id
      ?? (typeof incomingRequestId === 'string' && incomingRequestId ? incomingRequestId : newTraceId());
    const incomingTraceId = req.headers['x-trace-id'];
    const traceId = typeof incomingTraceId === 'string' && incomingTraceId ? incomingTraceId : newTraceId();

    res.setHeader('X-Request-Id', requestId);
    res.setHeader('X-Trace-Id', traceId);

    const startedAt = Date.now();
    res.on('finish', () => {
      // 守卫已在本请求上写入 req.user（finish 时点必定就绪）→ 样本归属到用户，实现 userId 首条件读取
      const userId = (req as Request & { user?: { userId?: string } }).user?.userId;
      const labels: Record<string, unknown> = {
        method: req.method,
        path: req.route?.path ?? req.path,
        status: res.statusCode,
        requestId,
      };
      if (userId) labels.userId = userId;
      const latencyMs = Date.now() - startedAt;
      void this.metrics.recordMetric('request_count', 1, 'count', labels);
      void this.metrics.recordMetric('request_latency_ms', latencyMs, 'ms', labels);
      if (res.statusCode >= 400) void this.metrics.recordMetric('error_count', 1, 'count', labels);
    });

    TraceContext.runWithContext({ requestId, traceId }, () => next());
  };
}
