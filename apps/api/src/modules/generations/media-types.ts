import { GenerationTask, TaskType } from '@prisma/client';

/** 执行器输出：待转存的文件 + 用量信息 + 最终使用的 Provider/Model（用量归因） */
export interface MediaExecResult {
  files: Array<{ url: string; mimeType?: string; metadata?: Record<string, unknown> }>;
  imageCount: number;
  videoSeconds: number;
  providerId: string;
  modelId: string;
}

export interface MediaExecContext {
  task: GenerationTask;
  /** 绝对截止时间戳（超时抛出 MEDIA_TASK_TIMEOUT） */
  deadline: number;
  publishProgress(progress: number, message: string): Promise<void>;
  /** 记录当前尝试的 Provider/Model（失败归因用） */
  setProviderAttempt(providerId: string, modelId: string): Promise<void>;
  setRemoteTaskId(remoteTaskId: string): Promise<void>;
}

/**
 * 媒体执行器策略接口：image / video 各自独立实现（不互相继承）。
 * MediaGenerationService 只负责统一任务生命周期（claim/超时/转存/用量/事件/清扫），
 * 具体的 Provider 调用逻辑全部在各自 executor。
 */
export interface MediaExecutor {
  readonly type: TaskType;
  execute(ctx: MediaExecContext): Promise<MediaExecResult>;
}
