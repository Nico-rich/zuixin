import { Inject, Injectable, Logger, OnModuleInit, Optional } from '@nestjs/common';
import { LifecycleRegistry } from '../../lifecycle/lifecycle-registry';

/** SSE 输出端最小接口（Express Response / 测试 fake）——与 modules/chat/sse-writer 的 SSESink 兼容 */
export interface SseConnectionSink {
  end(): void;
  destroy?: () => void;
  writableEnded?: boolean;
  /** 写 SSE 帧（task 通道转发用；Express Response 天然具备） */
  write?(chunk: string): void;
}

/**
 * 连接归属元数据（M10-P13：`task` 通道事件按 owner 路由到"相关连接"）。
 * 未显式传入时由 add() 从 Express Response 的 `res.req` 推导（JwtAuthGuard 写入的 `req.user` 与已解析的 body）——
 * 这样既有调用方（chat/agent-runs 控制器）无需改动即获得归属信息。
 */
export interface SseConnectionOwner {
  userId?: string;
  /** 会话归属（未知为 null/undefined；路由时只在**双侧都已知**时才要求相等） */
  conversationId?: string | null;
}

export interface SseConnectionInfo extends SseConnectionOwner {
  id: string;
  kind: string;
  /** 建立时刻（ms） */
  openedAt: number;
  closed: boolean;
}

/** 从 Express Response 上取回请求上下文（无 req 的 fake sink → 空归属，路由时按 fail-closed 处理） */
function deriveOwner(sink: unknown): SseConnectionOwner {
  const req = (sink as { req?: { user?: { userId?: string }; body?: { conversationId?: string | null } } } | undefined)?.req;
  if (!req) return {};
  return { userId: req.user?.userId, conversationId: req.body?.conversationId ?? null };
}

/** 关闭 SSESink 的宽限期：先 end（干净 EOF，客户端可正常收尾），仍不结束则 destroy 兜底 */
const CLOSE_GRACE_MS = 300;

/**
 * Pre-M9 G3：SSE 连接纳管（连接集合 + 关闭/超时）。
 *
 * 背景：SSE 是长连接，若不在停机序列中显式关闭，`app.close()` 只能强杀 socket（客户端看到连接被重置），
 * 或让 HTTP server 迟迟无法关闭（挂到进程强退 exit(1)）。本注册表提供：
 * - 连接集合：`add()` 返回注销函数，连接结束/客户端断开时调用；
 * - 排空：`beginDrain()` 后**拒绝新订阅**（控制器返回 503），已有流继续；
 * - 关闭：`closeAll()` 逐个 end + 宽限超时 destroy，保证停机序列不挂住；
 * - 可观测：`size()` / `snapshot()`（测试与运维断言用）。
 */
@Injectable()
export class SseRegistryService implements OnModuleInit {
  private readonly logger = new Logger('SseRegistry');
  private readonly conns = new Map<string, { info: SseConnectionInfo; sink: SseConnectionSink }>();
  private draining = false;
  private seq = 0;

  /** @Optional：单测可直接 new（无停机注册表时仍可独立使用）；生产由 LifecycleModule（@Global）注入 */
  constructor(@Optional() @Inject(LifecycleRegistry) private readonly lifecycle?: LifecycleRegistry) {}

  onModuleInit(): void {
    this.lifecycle?.register('stopSseSubscriptions', 'sse:beginDrain', () => this.beginDrain());
    this.lifecycle?.register('drainSse', 'sse:closeAll', async () => { await this.closeAll('server-shutdown'); });
  }

  /** 是否已进入排空（true 时控制器必须拒绝新订阅） */
  isDraining(): boolean { return this.draining; }

  size(): number { return this.conns.size; }

  snapshot(): SseConnectionInfo[] { return [...this.conns.values()].map((c) => ({ ...c.info })); }

  /**
   * 登记一条 SSE 连接；返回注销函数（幂等）。
   * `owner` 缺省时从 sink（Express Response）推导——既有控制器不改一行即带上归属，供 task 通道按 owner 路由。
   */
  add(kind: string, sink: SseConnectionSink, owner?: SseConnectionOwner): () => void {
    const id = `sse-${++this.seq}`;
    const info: SseConnectionInfo = { id, kind, openedAt: Date.now(), closed: false, ...(owner ?? deriveOwner(sink)) };
    this.conns.set(id, { info, sink });
    return () => {
      const cur = this.conns.get(id);
      if (cur) { cur.info.closed = true; this.conns.delete(id); }
    };
  }

  /**
   * M10-P13：按谓词向匹配连接投递一帧（task 通道转发用）。
   * - 跳过已结束的连接（`writableEnded`）与写失败/不支持写的连接——写失败的连接视为已断开并注销（幂等）；
   * - 单个连接异常绝不影响其他连接（异常隔离），返回成功投递条数（可观测/测试断言用）。
   */
  deliver(match: (info: SseConnectionInfo) => boolean, write: (sink: SseConnectionSink, info: SseConnectionInfo) => void): number {
    let delivered = 0;
    for (const { info, sink } of [...this.conns.values()]) {
      if (info.closed || sink.writableEnded) continue;
      if (!match(info)) continue;
      try {
        write(sink, info);
        delivered++;
      } catch (err) {
        this.logger.warn(`SSE 转发失败，注销连接（${info.id}/${info.kind}）: ${(err as Error).message}`);
        info.closed = true;
        this.conns.delete(info.id);
      }
    }
    return delivered;
  }

  /** 停止接受新订阅（幂等） */
  beginDrain(): void {
    if (this.draining) return;
    this.draining = true;
    this.logger.log(`SSE 进入排空：拒绝新订阅（当前连接 ${this.conns.size} 条）`);
  }

  /** 关闭全部 SSE 连接：end（干净 EOF）→ 宽限 CLOSE_GRACE_MS → destroy 残留；返回关闭条数 */
  async closeAll(reason: string, graceMs = CLOSE_GRACE_MS): Promise<number> {
    const list = [...this.conns.values()];
    if (list.length === 0) return 0;
    this.logger.log(`关闭全部 SSE 连接（${list.length} 条，reason=${reason}）`);
    for (const { info, sink } of list) {
      try {
        if (!sink.writableEnded) sink.end();
      } catch (err) {
        this.logger.warn(`SSE end 失败（${info.id}）: ${(err as Error).message}`);
      }
    }
    if (graceMs > 0) await new Promise((r) => setTimeout(r, graceMs).unref?.());
    let destroyed = 0;
    for (const { info, sink } of list) {
      if (!this.conns.has(info.id)) continue; // 已自然结束并注销
      try { sink.destroy?.(); destroyed++; } catch { /* 连接已断 */ }
      this.conns.delete(info.id);
    }
    if (destroyed) this.logger.warn(`SSE 宽限期后强制 destroy ${destroyed} 条残留连接`);
    return list.length;
  }

  /** 测试/运维：复位（仅单测使用） */
  reset(): void { this.conns.clear(); this.draining = false; }
}
