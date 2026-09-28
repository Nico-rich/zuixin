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
 * Pre-M9 G7：远端任务**真实状态**（provider 权威）。恢复路径只认这三种结论：
 * - `completed`：远端已完成 → 取回结果并按正常完成一致的方式落库（转存/用量/事件/配额/resume）；
 * - `failed`：远端已失败 → 落失败终态（错误来自 provider）；
 * - `processing`：远端仍在执行 → **保持非终态**（由超时兜底裁决，绝不提前判死）。
 */
export type MediaRemoteStatus =
  | { status: 'processing' }
  | { status: 'completed'; result: MediaExecResult }
  | { status: 'failed'; error: string };

/** Pre-M9 G7：恢复查询入参（执行器按 type 各自解析适配器；`input` 为任务原始入参，用于用量归因） */
export interface MediaRemoteQuery {
  taskId: string;
  remoteTaskId: string;
  /** 平台 Model.id（execute 时由 setProviderAttempt 写入；缺失 → 无法解析适配器） */
  modelId: string | null;
  providerId: string | null;
  /** 任务原始入参（Json） */
  input: unknown;
  /** 查询截止时间戳（毫秒）：调用方给上限，适配器据此构造 signal，绝不无限期挂着 */
  deadline: number;
}

/**
 * 媒体执行器策略接口：image / video 各自独立实现（不互相继承）。
 * MediaGenerationService 只负责统一任务生命周期（claim/超时/转存/用量/事件/清扫），
 * 具体的 Provider 调用逻辑全部在各自 executor。
 */
export interface MediaExecutor {
  readonly type: TaskType;
  execute(ctx: MediaExecContext): Promise<MediaExecResult>;
  /**
   * Pre-M9 G7：**远端状态查询**（仅恢复路径使用）——进程崩溃/重启后本地执行者已死，
   * 但 provider 侧任务可能已完成；按 `remoteTaskId` 问 provider 才是权威。
   * 未实现（同步型 provider 无远端任务概念）或无法解析适配器 → 返回 `null`，
   * 调用方按"无法恢复"兜底（绝不把 null 当成失败）。
   *
   * M10-P2 D18（兜底语义**契约化**，与 MediaGenerationService.recoverRemoteGenerationTask 一字对应）：
   * - `queryRemoteStatus` 为**可选**：同步型 provider（OpenAI/CogView 生图等，无远端任务概念）不实现；
   *   异步型执行器在"无 `modelId` 归因 / 适配器无 `getStatus` / 模型已停用（resolve 抛错）"时同样返回 `null`。
   * - **`null` 的语义 = "无法断定"（≠失败）**：调用方必须映射为 `unknown`，保持任务非终态，交由
   *   清扫超时/护栏兜底裁决；**绝不**把 `null` 落成 failed（否则"钱花了却被判失败"）。
   * - 适配器侧的**未知 remoteTaskId 也不得伪造成 `failed`**（provider 权威终态）：无法确认时返回
   *   `processing`（非终态）。反面教材见替身修复：mock-video「任务不存在 → failed」会把重启后的任务判死。
   * - 查询抛错（provider 不可达/超时）同样按 `unknown` 处理，不写任何终态。
   */
  queryRemoteStatus?(query: MediaRemoteQuery): Promise<MediaRemoteStatus | null>;
}
