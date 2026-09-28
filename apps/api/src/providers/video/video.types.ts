export interface VideoGenerationParams {
  prompt: string;
  model: string;
  imageUrl?: string;             // 图生视频参考图（data URL / 自有存储 URL，adapter 决定支持与否）
  duration?: number;             // 秒
  aspectRatio?: string;          // '16:9' | '9:16' | '1:1'
  resolution?: string;           // '720p' | '1080p' …
  signal?: AbortSignal;
}

export interface VideoRemoteStatus {
  status: 'processing' | 'completed' | 'failed';
  progress?: number;
  resultUrl?: string;
  error?: string;
}

/**
 * 视频 Provider 统一接口——与 ImageProvider 完全独立（不继承、不共享实现）。
 * 异步任务型（万相等）：submit → 轮询 getStatus；cancel 可选。
 */
export interface VideoProvider {
  readonly kind: 'video';
  submit(params: VideoGenerationParams): Promise<{ remoteTaskId: string }>;
  /**
   * 查询远端任务状态。Pre-M9 G5：`opts.signal` 传整体 deadline 信号（适配器将其与单请求超时
   * 组合后交给 fetch，任一触发即中止）；不传则仅受适配器单请求超时约束。
   */
  getStatus(remoteTaskId: string, opts?: { signal?: AbortSignal }): Promise<VideoRemoteStatus>;
  cancel?(remoteTaskId: string): Promise<void>;
}
