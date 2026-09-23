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
  getStatus(remoteTaskId: string): Promise<VideoRemoteStatus>;
  cancel?(remoteTaskId: string): Promise<void>;
}
