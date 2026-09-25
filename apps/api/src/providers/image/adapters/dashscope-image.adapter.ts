import { ImageGenerationParams, ImageProvider, ImageRemoteStatus } from '../image.types';

export interface DashScopeImageConfig { baseUrl: string; apiKey: string; }

type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;

/**
 * 阿里通义万相（异步任务型）：submit 创建任务 → getStatus 轮询。
 * 端点：POST {baseUrl}/services/aigc/text2image/image-synthesis（X-DashScope-Async: enable）
 */
export class DashScopeImageAdapter implements ImageProvider {
  readonly kind = 'image' as const;
  private readonly fetchFn: FetchFn;

  constructor(private readonly cfg: DashScopeImageConfig, injected?: { fetch?: FetchFn }) {
    // Pre-M9 F3-B：redirect: 'manual' —— 3xx 不自动跟随（否则可被 302 到内网/元数据地址）
    this.fetchFn = injected?.fetch ?? ((url, init) => fetch(url, { ...(init as object), redirect: 'manual' } as never));
  }

  async submit(params: ImageGenerationParams): Promise<{ remoteTaskId: string }> {
    const res = await this.fetchFn(`${this.cfg.baseUrl}/services/aigc/text2image/image-synthesis`, {
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
    });
    if (!res.ok) throw Object.assign(new Error(`万相提交失败: ${res.status}`), { status: res.status });
    const body = (await res.json()) as { output?: { task_id?: string } };
    const taskId = body.output?.task_id;
    if (!taskId) throw new Error('万相响应缺少 task_id');
    return { remoteTaskId: taskId };
  }

  async getStatus(remoteTaskId: string): Promise<ImageRemoteStatus> {
    const res = await this.fetchFn(`${this.cfg.baseUrl}/tasks/${remoteTaskId}`, {
      headers: { Authorization: `Bearer ${this.cfg.apiKey}` },
    });
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
