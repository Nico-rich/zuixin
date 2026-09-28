import { describe, it, expect } from 'vitest';
import { MockVideoAdapter, MOCK_VIDEO_FAIL_MARKER, MOCK_VIDEO_FAIL_REASON } from './mock-video.adapter';

describe('MockVideoAdapter', () => {
  it('submit 返回 remoteTaskId；getStatus 先 processing 后 completed（含 data URL 结果）', async () => {
    const adapter = new MockVideoAdapter();
    const { remoteTaskId } = await adapter.submit({ prompt: 'x', model: 'mock-video-1', duration: 5 });
    expect(remoteTaskId).toContain('mock-video-');
    const early = await adapter.getStatus(remoteTaskId);
    expect(early.status).toBe('processing');

    // 替身完成时长可用构造参数/env 覆盖（MOCK_VIDEO_COMPLETE_AFTER_MS）→ 新实例以 0 完成时长读同一 provider 侧登记表
    const fast = new MockVideoAdapter(0);
    const done = await fast.getStatus(remoteTaskId);
    expect(done.status).toBe('completed');
    expect(done.resultUrl).toContain('data:video/mp4;base64,');
  });

  // M10-P2 D18：`failed` 是 provider 的**权威终态**，恢复路径据此把任务判死。替身对"不认识的
  // remoteTaskId"（平台重启/登记表淘汰/id 非法）**不得伪造失败** → 返回非终态 processing，由超时兜底裁决。
  it('未知 remoteTaskId → processing（绝不伪造 provider 权威失败）', async () => {
    const adapter = new MockVideoAdapter();
    const status = await adapter.getStatus('nope');
    expect(status).toMatchObject({ status: 'processing' });
    expect(status.error).toBeUndefined();
  });

  // M10-P2 D18：provider 的**权威失败**必须是"provider 侧真失败"，用显式标记构造（提交时带
  // MOCK_VIDEO_FAIL_MARKER）。恢复路径（G7）据此落"provider 报的失败原因"——这条覆盖不能靠
  // "查不到 id = 失败"（那会把重启后仍在跑的任务判死）。
  it('provider 侧失败构造（提交 prompt 带标记）→ 该远端任务返回 failed + provider 原因', async () => {
    const adapter = new MockVideoAdapter();
    const { remoteTaskId } = await adapter.submit({ prompt: `x ${MOCK_VIDEO_FAIL_MARKER}`, model: 'mock-video-1', duration: 5 });
    expect(await adapter.getStatus(remoteTaskId)).toMatchObject({ status: 'failed', error: MOCK_VIDEO_FAIL_REASON });
    // 未带标记的任务不受影响（同一实例内两种终态并存）
    const ok = await adapter.submit({ prompt: 'x', model: 'mock-video-1', duration: 5 });
    expect((await new MockVideoAdapter(0).getStatus(ok.remoteTaskId)).status).toBe('completed');
  });

  // M10-P2 D18：登记表在**模块级**（代表 provider 侧状态）——平台进程重启（新 adapter 实例）后
  // provider 侧任务依然存在，这正是 G7 崩溃恢复路径（按 remoteTaskId 问 provider）可被真实测试的前提。
  it('平台重启（新 adapter 实例）→ 仍能按 remoteTaskId 反查 provider 侧真实状态', async () => {
    const beforeRestart = new MockVideoAdapter();
    const { remoteTaskId } = await beforeRestart.submit({ prompt: 'crash-recovery', model: 'mock-video-1', duration: 5 });
    expect((await beforeRestart.getStatus(remoteTaskId)).status).toBe('processing');

    const afterRestart = new MockVideoAdapter(0); // 重启后的新实例（完成时长 0 便于观测终态）
    expect(await afterRestart.getStatus(remoteTaskId)).toMatchObject({ status: 'completed' });
  });
});
