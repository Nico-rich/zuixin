import { describe, it, expect } from 'vitest';
import { MockExternalActionProvider } from './mock-external-action.provider';
import { ExternalActionRequest } from './external-action-provider.interface';

/**
 * Pre-M9 G7：mock provider 的远端状态查询向量必须**确定性**且与 execute 语义对齐
 * （恢复路径的 e2e 依赖它：completed 分支的结果 externalId 由同一 externalRequestId 派生）。
 */
const req = (actionType: string, over: Partial<ExternalActionRequest> = {}): ExternalActionRequest => ({
  provider: 'mock', actionType, payload: { title: 'x' }, externalRequestId: 'req-1',
  connectionId: 'conn-1', accessToken: 'ACC', signal: new AbortController().signal, ...over,
});

describe('Pre-M9 G7：MockExternalActionProvider.remoteStatus', () => {
  it('success/duplicate → completed，且 externalId 与 execute 同源（同键绝不重复执行）', async () => {
    const p = new MockExternalActionProvider();
    const remote = await p.remoteStatus(req('success'));
    const executed = await p.execute(req('success')) as { externalId: string };
    expect(remote.status).toBe('completed');
    expect((remote.result as { externalId: string }).externalId).toBe(executed.externalId);
    expect((remote.result as { recovered?: boolean }).recovered).toBe(true);
  });

  it('failure → failed（错误码/文案与 execute 一致）', async () => {
    const p = new MockExternalActionProvider();
    await expect(p.remoteStatus(req('failure'))).resolves.toMatchObject({ status: 'failed', errorCode: 'PROVIDER_UNKNOWN' });
  });

  it('timeout/retry/未知动作 → processing（无权威结论：绝不把"查不到"当失败）', async () => {
    const p = new MockExternalActionProvider();
    await expect(p.remoteStatus(req('timeout'))).resolves.toEqual({ status: 'processing' });
    await expect(p.remoteStatus(req('retry'))).resolves.toEqual({ status: 'processing' });
    await expect(p.remoteStatus(req('whatever'))).resolves.toEqual({ status: 'processing' });
  });

  it('已取消信号 → AbortError（调用方按 unknown 处理，不落终态）', async () => {
    const p = new MockExternalActionProvider();
    const ac = new AbortController();
    ac.abort();
    await expect(p.remoteStatus(req('success', { signal: ac.signal }))).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('remoteStatus 绝不增加 execute 计数（查询无副作用）', async () => {
    const p = new MockExternalActionProvider();
    await p.remoteStatus(req('success'));
    expect(p.executeCount).toBe(0);
  });
});
