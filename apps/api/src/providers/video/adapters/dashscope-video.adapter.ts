import { VideoGenerationParams, VideoProvider, VideoRemoteStatus } from '../video.types';
import {
  DEFAULT_PROVIDER_REQUEST_TIMEOUT_MS, composeAbortSignal, normalizeRequestFailure,
} from '../../../core/http/request-guard';

export interface DashScopeVideoConfig {
  baseUrl: string;
  apiKey: string;
  /** 单请求超时（连接 + 响应头 + 读体）；缺省 60s（与 provider.timeoutMs 默认一致） */
  timeoutMs?: number;
}

type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;

/** getStatus 可选上下文（G5：整体 deadline 信号；调用方不传则仅用单请求超时） */
export interface DashScopeCallOptions { signal?: AbortSignal }

/**
 * 阿里通义万相视频（异步任务型）：submit 创建任务 → getStatus 轮询。
 * 端点：POST {base}/services/aigc/video-generation/video-synthesis（X-DashScope-Async: enable）
 *
 * Pre-M9 G5：每个请求都带**真实超时 + 可中止**（连接/响应/读体），整体 deadline 信号直达 fetch；
 * 视频任务耗时长（轮询窗口可达数分钟），因此**单请求超时与整体 deadline 必须分离**：
 * 单请求超时保证"一次 HTTP 不会挂死"，整体 deadline 由执行器轮询循环 + 信号共同保证。
 */
export class DashScopeVideoAdapter implements VideoProvider {
  readonly kind = 'video' as const;
  private readonly fetchFn: FetchFn;
  private readonly requestTimeoutMs: number;

  constructor(private readonly cfg: DashScopeVideoConfig, injected?: { fetch?: FetchFn }) {
    // Pre-M9 F3-B：redirect: 'manual' —— 3xx 不自动跟随
    this.fetchFn = injected?.fetch ?? ((url, init) => fetch(url, { ...(init as object), redirect: 'manual' } as never));
    this.requestTimeoutMs = cfg.timeoutMs && cfg.timeoutMs > 0 ? cfg.timeoutMs : DEFAULT_PROVIDER_REQUEST_TIMEOUT_MS;
  }

  private async request(url: string, init: RequestInit, external: AbortSignal | undefined, what: string): Promise<Response> {
    const signal = composeAbortSignal(external, this.requestTimeoutMs);
    try {
      return await this.fetchFn(url, signal ? { ...init, signal } : init);
    } catch (err) {
      throw normalizeRequestFailure(err, { what, requestTimeoutMs: this.requestTimeoutMs, external });
    }
  }

  async submit(params: VideoGenerationParams): Promise<{ remoteTaskId: string }> {
    const input: Record<string, unknown> = params.imageUrl ? { img_url: params.imageUrl } : { prompt: params.prompt };
    const res = await this.request(`${this.cfg.baseUrl}/services/aigc/video-generation/video-synthesis`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.cfg.apiKey}`,
        'Content-Type': 'application/json',
        'X-DashScope-Async': 'enable',
      },
      body: JSON.stringify({
        model: params.model,
        input,
        parameters: {
          ...(params.duration ? { duration: params.duration } : {}),
          ...(params.aspectRatio ? { ratio: params.aspectRatio } : {}),
          ...(params.resolution ? { resolution: params.resolution } : {}),
        },
      }),
    }, params.signal, '万相视频提交');
    if (!res.ok) throw Object.assign(new Error(`万相视频提交失败: ${res.status}`), { status: res.status });
    const body = (await res.json()) as { output?: { task_id?: string } };
    const taskId = body.output?.task_id;
    if (!taskId) throw new Error('万相视频响应缺少 task_id');
    return { remoteTaskId: taskId };
  }

  async getStatus(remoteTaskId: string, opts?: DashScopeCallOptions): Promise<VideoRemoteStatus> {
    const res = await this.request(`${this.cfg.baseUrl}/tasks/${remoteTaskId}`, {
      headers: { Authorization: `Bearer ${this.cfg.apiKey}` },
    }, opts?.signal, '万相视频查询');
    if (!res.ok) throw Object.assign(new Error(`万相视频查询失败: ${res.status}`), { status: res.status });
    const body = (await res.json()) as {
      output?: { task_status?: string; video_url?: string; message?: string };
    };
    const status = body.output?.task_status;
    if (status === 'SUCCEEDED') {
      if (!body.output?.video_url) return { status: 'failed', error: '视频完成但无结果' };
      return { status: 'completed', progress: 100, resultUrl: body.output.video_url };
    }
    if (status === 'FAILED' || status === 'CANCELED') {
      return { status: 'failed', error: body.output?.message ?? '万相视频任务失败' };
    }
    return { status: 'processing' };
  }
}
