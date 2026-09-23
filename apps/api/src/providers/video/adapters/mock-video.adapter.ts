import { VideoGenerationParams, VideoProvider, VideoRemoteStatus } from '../video.types';

/** 最小合法 MP4 容器占位（ftyp+mdat；无 track，作为 dev/e2e 替身文件，真实 Provider 接入后为可播放视频） */
const MOCK_MP4_BASE64 =
  'AAAAIGZ0eXBpc29tAAAAAGlzb20AAAAMbW9vdk1kYXQAAAAAAAAA';

/**
 * dev/e2e 视频替身：submit 立即返回，getStatus 模拟异步进度（3 次轮询后完成），
 * 返回占位 MP4 data URL——无 Key 全链路可跑（与 mock LLM / mock-image 同哲学）。
 */
export class MockVideoAdapter implements VideoProvider {
  readonly kind = 'video' as const;
  private readonly tasks = new Map<string, { startedAt: number }>();

  async submit(params: VideoGenerationParams): Promise<{ remoteTaskId: string }> {
    const id = `mock-video-${Date.now()}-${Math.floor(Math.random() * 10000)}`;
    this.tasks.set(id, { startedAt: Date.now() });
    return { remoteTaskId: id };
  }

  async getStatus(remoteTaskId: string): Promise<VideoRemoteStatus> {
    const task = this.tasks.get(remoteTaskId);
    if (!task) return { status: 'failed', error: '任务不存在' };
    const elapsed = Date.now() - task.startedAt;
    if (elapsed < 3000) return { status: 'processing', progress: Math.round(elapsed / 30) };
    return { status: 'completed', progress: 100, resultUrl: `data:video/mp4;base64,${MOCK_MP4_BASE64}` };
  }
}
