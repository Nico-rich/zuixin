import { ImageGenerationParams, ImageProvider, ImageRemoteStatus } from '../image.types';
import {
  DEFAULT_PROVIDER_REQUEST_TIMEOUT_MS, composeAbortSignal, normalizeRequestFailure,
} from '../../../core/http/request-guard';

export interface DashScopeImageConfig {
  baseUrl: string;
  apiKey: string;
  /** 单请求超时（连接 + 响应头 + 读体）；缺省 60s（与 provider.timeoutMs 默认一致） */
  timeoutMs?: number;
}

type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;

/** getStatus 可选上下文（G5：整体 deadline 信号；调用方不传则仅用单请求超时） */
export interface DashScopeCallOptions { signal?: AbortSignal }

/**
 * 阿里通义万相（异步任务型）：submit 创建任务 → getStatus 轮询。
 * 端点：POST {baseUrl}/services/aigc/text2image/image-synthesis（X-DashScope-Async: enable）
 *
 * Pre-M9 G5：每个请求都带**真实超时 + 可中止**——
 * `AbortSignal.any([整体 deadline 信号, 单请求超时])` 直达 fetch（原实现完全丢弃 params.signal，
 * 且 buildAdapter 丢弃 provider.timeoutMs：卡死的连接会一直挂到任务被清扫）。
 */
export class DashScopeImageAdapter implements ImageProvider {
  readonly kind = 'image' as const;
  private readonly fetchFn: FetchFn;
  private readonly requestTimeoutMs: number;

  constructor(private readonly cfg: DashScopeImageConfig, injected?: { fetch?: FetchFn }) {
    // Pre-M9 F3-B：redirect: 'manual' —— 3xx 不自动跟随（否则可被 302 到内网/元数据地址）
    this.fetchFn = injected?.fetch ?? ((url, init) => fetch(url, { ...(init as object), redirect: 'manual' } as never));
    this.requestTimeoutMs = cfg.timeoutMs && cfg.timeoutMs > 0 ? cfg.timeoutMs : DEFAULT_PROVIDER_REQUEST_TIMEOUT_MS;
  }

  /** 统一出口：组合信号 + 超时归一化（所有请求都必须走这里） */
  private async request(url: string, init: RequestInit, external: AbortSignal | undefined, what: string): Promise<Response> {
    const signal = composeAbortSignal(external, this.requestTimeoutMs);
    try {
      return await this.fetchFn(url, signal ? { ...init, signal } : init);
    } catch (err) {
      throw normalizeRequestFailure(err, { what, requestTimeoutMs: this.requestTimeoutMs, external });
    }
  }

  async submit(params: ImageGenerationParams): Promise<{ remoteTaskId: string }> {
    const res = await this.request(`${this.cfg.baseUrl}/services/aigc/text2image/image-synthesis`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.cfg.apiKey}`,
        'Content-Type': 'application/json',
        'X-DashScope-Async': 'enable',
      },
      body: JSON.stringify({
        model: params.model,
        input: { prompt: params.prompt },
        parameters: {
          n: params.count ?? 1,
          size: params.size ?? '1024*1024',
          ...(params.aspectRatio ? { aspect_ratio: params.aspectRatio } : {}),
        },
      }),
    }, params.signal, '万相生图提交');
    if (!res.ok) throw Object.assign(new Error(`万相提交失败: ${res.status}`), { status: res.status });
    const body = (await res.json()) as { output?: { task_id?: string } };
    const taskId = body.output?.task_id;
    if (!taskId) throw new Error('万相响应缺少 task_id');
    return { remoteTaskId: taskId };
  }

  async getStatus(remoteTaskId: string, opts?: DashScopeCallOptions): Promise<ImageRemoteStatus> {
    const res = await this.request(`${this.cfg.baseUrl}/tasks/${remoteTaskId}`, {
      headers: { Authorization: `Bearer ${this.cfg.apiKey}` },
    }, opts?.signal, '万相生图查询');
    if (!res.ok) throw Object.assign(new Error(`万相查询失败: ${res.status}`), { status: res.status });
    const body = (await res.json()) as {
      output?: { task_status?: string; results?: Array<{ url?: string }>; message?: string };
    };
    const status = body.output?.task_status;
    if (status === 'SUCCEEDED') {
      return {
        status: 'completed',
        resultUrls: (body.output?.results ?? []).map((r) => r.url).filter((u): u is string => !!u),
      };
    }
    if (status === 'FAILED' || status === 'CANCELED') {
      return { status: 'failed', error: body.output?.message ?? '万相任务失败' };
    }
    return { status: 'processing' };
  }
}
