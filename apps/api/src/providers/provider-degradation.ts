import { Logger } from '@nestjs/common';

/**
 * M10-P2 D12：provider **启动配置校验**失败 → degraded 标记 + 聚合告警 + 计数。
 *
 * 缺陷背景：四个 manager 的 `refresh()` 里 `buildAdapter` 抛错只写一条 `logger.error` 就**静默跳过**
 * 该 provider——启动期看不到"哪些 provider 没加载"，调用期又只报裸 `Error`（→ 500 INTERNAL）或干脆
 * 找不到适配器。运维只能等到用户报障。
 *
 * **有意取舍：不阻断启动。** 单个 provider 配错（adapter 名拼错/新增 adapter 未接线/构造期参数非法）
 * 只应让**该 provider**不可用：四个 manager 的 provider 互为候选（RoutingService 按能力/健康/熔断
 * 排序 + 回退链），启动期 fail-fast 会把"一个 provider 的配置错误"放大成"整站不可用"（含健康检查、
 * 其他能力全部能力）。代价必须显式补偿：
 *  1. 启动期**聚合告警**（每个失败 provider 单条 error + 一条汇总，明确指出 degraded 数量与原因）；
 *  2. `ObservabilityService` 记 `provider_degraded` 计数（best-effort，观测写入绝不阻断主流程）；
 *  3. 调用期遇到未加载 provider → `PROVIDER_CONFIG_INVALID`（明确错误码，绝不裸 500/静默跳过）。
 *
 * 本类只做"记录与聚合"，**不做降级路由决策**（那是 RoutingService 的职责），也不参与熔断计数。
 */
export interface ProviderDegradedEntry {
  providerId: string;
  providerName: string;
  adapter: string;
  reason: string;
  at: number;
}

/** 计数记录器（ObservabilityService 的最小接口——避免 providers 层依赖 tracing 实现） */
export interface ProviderDegradedRecorder {
  recordProviderDegraded(input: {
    type: string;
    providerId: string;
    providerName: string;
    adapter: string;
    reason: string;
  }): Promise<void>;
}

export class ProviderDegradationTracker {
  private readonly degraded = new Map<string, ProviderDegradedEntry>();

  constructor(
    /** provider 类型（llm/image/video/embedding）——进日志与指标标签 */
    private readonly type: string,
    private readonly logger: Logger,
    private readonly metrics?: ProviderDegradedRecorder,
  ) {}

  /** 每次 refresh 前复位（provider 修好后必须能自动摘掉 degraded 标记） */
  reset(): void {
    this.degraded.clear();
  }

  /** buildAdapter 失败：单条 error 日志（保留既有行为，绝不静默吞掉） */
  markFailed(row: { id: string; name: string; adapter: string }, err: unknown): void {
    const reason = (err as Error)?.message ?? String(err);
    this.degraded.set(row.id, { providerId: row.id, providerName: row.name, adapter: row.adapter, reason, at: Date.now() });
    this.logger.error(`${this.type} provider ${row.name}（${row.adapter}）配置校验失败（degraded）: ${reason}`);
  }

  /** 启动/刷新期汇总：聚合告警 + provider_degraded 计数（观测失败只 warn，绝不影响加载结果） */
  async report(): Promise<void> {
    if (this.degraded.size === 0) return;
    const entries = [...this.degraded.values()];
    this.logger.error(
      `${this.type} providers 加载完成：${entries.length} 个 **degraded（配置校验失败，未加载）**，` +
      `服务不中断（多 provider 互为候选）；调用这些 provider 将返回 PROVIDER_CONFIG_INVALID → ` +
      entries.map((e) => `${e.providerName}(${e.adapter}): ${e.reason}`).join('; '),
    );
    for (const e of entries) {
      try {
        await this.metrics?.recordProviderDegraded({
          type: this.type, providerId: e.providerId, providerName: e.providerName, adapter: e.adapter, reason: e.reason,
        });
      } catch (err) {
        this.logger.warn(`provider_degraded 计数写入失败（观测 best-effort）: ${(err as Error).message}`);
      }
    }
  }

  /** 调用期归因：该 provider 是否因配置校验失败而不可用（用于错误消息，绝不泄漏内部细节以外的东西） */
  reasonOf(providerId: string): string | undefined {
    return this.degraded.get(providerId)?.reason;
  }

  get size(): number {
    return this.degraded.size;
  }
}
