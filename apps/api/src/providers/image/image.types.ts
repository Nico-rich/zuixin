export interface ImageGenerationParams {
  prompt: string;
  model: string;
  size?: string;                 // '1024x1024' 等，由 adapter 映射
  aspectRatio?: string;          // '1:1' | '16:9' | '9:16' | …
  quality?: 'standard' | 'high';
  referenceImages?: string[];    // 参考图（data URL）；adapter 决定是否支持/降级
  count?: number;                // 1~4
  signal?: AbortSignal;
}

export interface ImageGenerationResult {
  images: Array<{ url: string; width?: number; height?: number }>;  // 第三方临时 URL 或 data URL，Worker 负责转存
  usage: { imageCount: number; providerModel: string };
}

export interface ImageRemoteStatus {
  status: 'processing' | 'completed' | 'failed';
  progress?: number;
  resultUrls?: string[];
  error?: string;
}

/**
 * 生图 Provider 统一接口。
 * 同步型（OpenAI/CogView/mock）实现 generate；
 * 异步任务型（通义万相等）实现 submit + getStatus，由 Worker 轮询。
 */
export interface ImageProvider {
  readonly kind: 'image';
  generate?(params: ImageGenerationParams): Promise<ImageGenerationResult>;
  submit?(params: ImageGenerationParams): Promise<{ remoteTaskId: string }>;
  /**
   * 查询远端任务状态。Pre-M9 G5：`opts.signal` 传整体 deadline 信号（适配器将其与单请求超时
   * 组合后交给 fetch，任一触发即中止）；不传则仅受适配器单请求超时约束。
   */
  getStatus?(remoteTaskId: string, opts?: { signal?: AbortSignal }): Promise<ImageRemoteStatus>;
}
