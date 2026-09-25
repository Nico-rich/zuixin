import { VideoGenerationParams, VideoProvider, VideoRemoteStatus } from '../video.types';

export interface DashScopeVideoConfig { baseUrl: string; apiKey: string; }

type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;

/**
 * 阿里通义万相视频（异步任务型）：submit 创建任务 → getStatus 轮询。
 * 端点：POST {base}/services/aigc/video-generation/video-synthesis（X-DashScope-Async: enable）
 */
export class DashScopeVideoAdapter implements VideoProvider {
  readonly kind = 'video' as const;
  private readonly fetchFn: FetchFn;

  constructor(private readonly cfg: DashScopeVideoConfig, injected?: { fetch?: FetchFn }) {
    // Pre-M9 F3-B：redirect: 'manual' —— 3xx 不自动跟随
    this.fetchFn = injected?.fetch ?? ((url, init) => fetch(url, { ...(init as object), redirect: 'manual' } as never));
  }

  async submit(params: VideoGenerationParams): Promise<{ remoteTaskId: string }> {
    const input: Record<string, unknown> = params.imageUrl ? { img_url: params.imageUrl } : { prompt: params.prompt };
    const res = await this.fetchFn(`${this.cfg.baseUrl}/services/aigc/video-generation/video-synthesis`, {
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
    });
    if (!res.ok) throw Object.assign(new Error(`万相视频提交失败: ${res.status}`), { status: res.status });
    const body = (await res.json()) as { output?: { task_id?: string } };
    const taskId = body.output?.task_id;
    if (!taskId) throw new Error('万相视频响应缺少 task_id');
    return { remoteTaskId: taskId };
  }

  async getStatus(remoteTaskId: string): Promise<VideoRemoteStatus> {
    const res = await this.fetchFn(`${this.cfg.baseUrl}/tasks/${remoteTaskId}`, {
      headers: { Authorization: `Bearer ${this.cfg.apiKey}` },
    });
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
