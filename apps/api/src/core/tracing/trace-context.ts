import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';

/**
 * M8-P3 追踪上下文（AsyncLocalStorage）：
 * 一次 HTTP 请求 / 一次 Worker job / 一次工具调用建立一个上下文，下游（审计/指标/日志）
 * 用 current() 读取，绝不靠参数层层透传；缺失字段自动继承父上下文（嵌套子作用域只补充差异）。
 * 观测面绝不决定业务走向——上下文缺失时所有读取方都必须能降级（返回 undefined）。
 */
export interface TraceContextData {
  /** 请求 ID（HTTP 复用 pino genReqId 的 req.id；Worker 侧新生成） */
  requestId?: string;
  /** 分布式追踪 ID（HTTP 从 X-Trace-Id 头继承，否则新生成） */
  traceId: string;
  organizationId?: string;
  userId?: string;
  projectId?: string;
  runId?: string;
  toolCallId?: string;
  taskId?: string;
  workflowRunId?: string;
  provider?: string;
}

/** 新追踪 ID（uuid v4） */
export function newTraceId(): string {
  return randomUUID();
}

export class TraceContext {
  private static readonly als = new AsyncLocalStorage<TraceContextData>();

  /** 新追踪 ID（便捷转发：TraceContext.newTraceId()） */
  static newTraceId(): string {
    return newTraceId();
  }

  /**
   * 在给定上下文中执行 fn（未提供的字段继承父上下文；traceId 缺省继承父或新生成）。
   * 返回值/异常原样透传（同步与异步均可）。
   */
  static runWithContext<T>(ctx: Partial<TraceContextData>, fn: () => T): T {
    const parent = TraceContext.als.getStore();
    const store: TraceContextData = { ...(parent ?? { traceId: newTraceId() }) };
    store.traceId = ctx.traceId ?? parent?.traceId ?? newTraceId();
    for (const [key, value] of Object.entries(ctx)) {
      if (value !== undefined && key !== 'traceId') (store as unknown as Record<string, unknown>)[key] = value;
    }
    return TraceContext.als.run(store, fn);
  }

  /** 当前上下文（无活动上下文 → undefined；读取方必须降级处理） */
  static current(): TraceContextData | undefined {
    return TraceContext.als.getStore();
  }

  /** 只读快照（避免调用方直接改写 store） */
  static snapshot(): TraceContextData | undefined {
    const store = TraceContext.als.getStore();
    return store ? { ...store } : undefined;
  }

  /**
   * 回填当前上下文（如守卫解析出 userId、服务层解析出 organizationId/runId）。
   * 只在已有上下文内生效；无活动上下文时静默忽略（进程级无请求场景不伪造上下文）。
   */
  static patch(partial: Partial<TraceContextData>): void {
    const store = TraceContext.als.getStore();
    if (!store) return;
    for (const [key, value] of Object.entries(partial)) {
      if (value !== undefined) (store as unknown as Record<string, unknown>)[key] = value;
    }
  }
}
