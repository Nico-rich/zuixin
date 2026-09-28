import { VideoGenerationParams, VideoProvider, VideoRemoteStatus } from '../video.types';

/** 最小合法 MP4 容器占位（ftyp+mdat；无 track，作为 dev/e2e 替身文件，真实 Provider 接入后为可播放视频） */
const MOCK_MP4_BASE64 =
  'AAAAIGZ0eXBpc29tAAAAAGlzb20AAAAMbW9vdk1kYXQAAAAAAAAA';

/** 替身完成时长（3 次轮询后完成——与历史行为一致，既有 e2e 时序不变） */
const COMPLETE_AFTER_MS = 3000;

/** 任务登记表上限（dev 长跑进程不无界增长；超出按插入顺序淘汰最旧） */
const MAX_TASKS = 1000;

/**
 * M10-P2 D18：**provider 侧失败**的替身构造（提交时 prompt 带此标记 ⇒ 该远端任务终态失败）。
 * 为什么需要它：`failed` 是 provider 的**权威终态**，恢复路径（G7）必须能落"provider 报的失败原因"。
 * 但"不认识的 remoteTaskId"**不能**当成失败（那是未知，不是结论）——所以要覆盖"远端确实失败"这条路径，
 * 只能用显式的失败构造，而不能靠"查不到 = 失败"（旧行为，会把重启后仍在跑的任务判死并计费）。
 */
export const MOCK_VIDEO_FAIL_MARKER = '[mock-provider-fail]';

/** 替身 provider 侧失败文案（恢复路径会把该文案原样落到任务的 errorMessage） */
export const MOCK_VIDEO_FAIL_REASON = '模拟远端生成失败（provider 权威终态）';

/**
 * **provider 侧**任务登记表（模块级，跨 adapter 实例共享）。
 * M10-P2 D18：替身模拟的是"provider 侧"状态——平台进程崩溃/重启（adapter 重新构造）后，
 * provider 侧的任务**依然存在**，这正是 G7 崩溃恢复路径（按 remoteTaskId 问 provider）的前提。
 * 若登记表挂在实例上，重启后必然查不到 → 恢复路径拿到"未知"，永远无法被真实测试覆盖。
 */
const PROVIDER_TASKS = new Map<string, { startedAt: number; failure?: string }>();

/**
 * dev/e2e 视频替身：submit 立即返回，getStatus 模拟异步进度（3 次轮询后完成），
 * 返回占位 MP4 data URL——无 Key 全链路可跑（与 mock LLM / mock-image 同哲学）。
 *
 * M10-P2 D18（远端状态契约对齐）：
 * - 任务登记表为**模块级**（见上），支持"平台重启后按 remoteTaskId 反查"的崩溃恢复路径测试；
 * - **未知 remoteTaskId 绝不返回 `failed`**：`failed` 是 provider 的**权威终态**，恢复路径会据此把任务
 *   判死（"钱花了却被判失败"）。替身无法确认远端状态 → 返回 `processing`（非终态，交由超时兜底裁决）。
 *   真实异步 provider（如万相）在"任务 id 不认识"时同样不应伪造成终态失败。
 */
export class MockVideoAdapter implements VideoProvider {
  readonly kind = 'video' as const;

  /** 替身完成时长（env 可覆盖：MOCK_VIDEO_COMPLETE_AFTER_MS——与 MOCK_DELAY_MS 同模式的测试友好开关，生产/dev 默认不变） */
  constructor(private readonly completeAfterMs = Number(process.env.MOCK_VIDEO_COMPLETE_AFTER_MS ?? COMPLETE_AFTER_MS)) {}

  async submit(params: VideoGenerationParams): Promise<{ remoteTaskId: string }> {
    const id = `mock-video-${Date.now()}-${Math.floor(Math.random() * 10000)}`;
    // provider 侧失败构造：提交时带标记 ⇒ 该远端任务终态失败（见 MOCK_VIDEO_FAIL_MARKER 注释）
    PROVIDER_TASKS.set(id, { startedAt: Date.now(), failure: params.prompt.includes(MOCK_VIDEO_FAIL_MARKER) ? MOCK_VIDEO_FAIL_REASON : undefined });
    while (PROVIDER_TASKS.size > MAX_TASKS) {
      const oldest = PROVIDER_TASKS.keys().next().value; // Map 保序 → 第一个即最旧
      if (oldest === undefined) break;
      PROVIDER_TASKS.delete(oldest);
    }
    return { remoteTaskId: id };
  }

  async getStatus(remoteTaskId: string): Promise<VideoRemoteStatus> {
    const task = PROVIDER_TASKS.get(remoteTaskId);
    // 无法确认（进程重启/登记表淘汰/id 非法）→ 非终态，绝不伪造成 provider 权威失败
    if (!task) return { status: 'processing', progress: 0 };
    // provider 侧真实终态失败（提交时显式构造）——恢复路径据此落"provider 报的原因"
    if (task.failure) return { status: 'failed', error: task.failure };
    const elapsed = Date.now() - task.startedAt;
    if (elapsed < this.completeAfterMs) return { status: 'processing', progress: Math.round(elapsed / 30) };
    return { status: 'completed', progress: 100, resultUrl: `data:video/mp4;base64,${MOCK_MP4_BASE64}` };
  }
}
