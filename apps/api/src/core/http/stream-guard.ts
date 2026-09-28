/**
 * Pre-M9 G6：LLM 流式响应的**四层超时**守卫（连接 / 首包 / 空闲 / 总时长）。
 *
 * 缺陷背景：openai-compatible 适配器只把 `provider.timeoutMs` 交给 SDK，SDK 的超时在
 * **收到响应头后即失效**——流式响应若中途静默（TCP 半开、供应商卡住），`for await` 会
 * 永久等待（回合挂住、lease 靠过期兜底、用户看到"生成中"不动）。
 *
 * 四层口径：
 * - **connect**：从发起到拿到流对象（连接 + 响应头）；
 * - **firstByte**：从流对象到**首个数据块**（TTFT 上界）；
 * - **idle**：相邻数据块的**最大间隔**；超时 → 主动 abort 底层请求（中断，绝不挂着）；
 * - **total**：整条流的绝对上限（与 AgentRun/回合 deadline 信号共同构成上界）。
 * 任一超时都 → `StreamTimeoutError`，适配器归一为 `PROVIDER_TIMEOUT`（可重试/可回退）。
 */
export type StreamTimeoutLayer = 'connect' | 'firstByte' | 'idle' | 'total';

export interface StreamTimeouts {
  connectMs: number;
  firstByteMs: number;
  idleMs: number;
  totalMs: number;
}

/** 默认取 provider.timeoutMs（provider 配置的请求超时）；各层可用 env 单独收紧/放宽 */
export function streamTimeoutsFrom(cfg: { timeoutMs: number }): StreamTimeouts {
  const pick = (name: string) => {
    const n = Number(process.env[name]);
    return Number.isFinite(n) && n > 0 ? Math.trunc(n) : cfg.timeoutMs;
  };
  return {
    connectMs: pick('LLM_STREAM_CONNECT_TIMEOUT_MS'),
    firstByteMs: pick('LLM_STREAM_FIRST_BYTE_TIMEOUT_MS'),
    idleMs: pick('LLM_STREAM_IDLE_TIMEOUT_MS'),
    totalMs: pick('LLM_STREAM_TOTAL_TIMEOUT_MS'),
  };
}

export class StreamTimeoutError extends Error {
  readonly code = 'PROVIDER_TIMEOUT';
  constructor(readonly layer: StreamTimeoutLayer, readonly timeoutMs: number) {
    super(StreamTimeoutError.messageOf(layer, timeoutMs));
    this.name = 'StreamTimeoutError';
  }

  private static messageOf(layer: StreamTimeoutLayer, ms: number): string {
    switch (layer) {
      case 'connect': return `模型连接超时（>${ms}ms 未建立/未返回响应头）`;
      case 'firstByte': return `模型首包超时（>${ms}ms 未收到首个数据块）`;
      case 'idle': return `模型流式响应空闲超时（>${ms}ms 无新数据，已中断请求）`;
      case 'total': return `模型流式响应总时长超时（>${ms}ms）`;
    }
  }
}

/**
 * 流式守卫：持有**内部 AbortController**（超时/放弃时 abort 真实请求），
 * 并把「外部 deadline 信号 + 内部控制器 + 总时长」组合成一个信号交给底层 SDK/fetch。
 */
export class StreamGuard {
  private readonly controller = new AbortController();
  /** 交给底层请求的信号：外部 deadline ∪ 内部中止 ∪ 总时长上限 */
  readonly signal: AbortSignal;
  private readonly startedAt = Date.now();
  private firstChunkSeen = false;

  constructor(private readonly t: StreamTimeouts, external?: AbortSignal) {
    const parts: AbortSignal[] = [this.controller.signal, AbortSignal.timeout(Math.max(this.t.totalMs, 1))];
    if (external) parts.unshift(external);
    this.signal = AbortSignal.any(parts);
  }

  /** 连接层：等到流对象（连接 + 响应头） */
  async connect<T>(factory: () => Promise<T> | T): Promise<T> {
    return this.withLayer(async () => factory(), this.t.connectMs, 'connect');
  }

  /** 逐块推进：首包用 firstByte 上界，其后用 idle 上界，且都不超过剩余总时长 */
  async next<T>(it: AsyncIterator<T>): Promise<IteratorResult<T>> {
    const elapsed = Date.now() - this.startedAt;
    if (elapsed >= this.t.totalMs) {
      this.abort();
      throw new StreamTimeoutError('total', this.t.totalMs);
    }
    const layer: StreamTimeoutLayer = this.firstChunkSeen ? 'idle' : 'firstByte';
    const layerMs = this.firstChunkSeen ? this.t.idleMs : this.t.firstByteMs;
    const result = await this.withLayer(() => it.next(), Math.min(layerMs, this.t.totalMs - elapsed), layer);
    if (!result.done) this.firstChunkSeen = true;
    return result;
  }

  /** 中断在途请求（超时、异常、消费者提前退出都应收尾，绝不把请求挂在服务端） */
  abort(): void {
    if (!this.controller.signal.aborted) this.controller.abort();
  }

  private async withLayer<T>(fn: () => Promise<T>, ms: number, layer: StreamTimeoutLayer): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    const guard = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        this.abort(); // 超时 = 主动中断底层请求（否则服务端连接会一直挂着）
        reject(new StreamTimeoutError(layer, ms));
      }, Math.max(ms, 1));
      timer.unref?.();
    });
    const settled = (async () => fn())().finally(() => { if (timer) clearTimeout(timer); });
    return Promise.race([settled, guard]);
  }
}
