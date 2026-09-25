import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ExternalActionsService, classifyRisk, ExecuteExternalActionInput } from './external-actions.service';
import { AppError, ErrorCode } from '../../common/errors/app-error';

const baseRow = {
  id: 'ea-1', status: 'pending_approval', externalRequestId: 'req-1', provider: 'mock',
  actionType: 'success', permission: 'external_action', riskLevel: 'high', input: { title: 'x' },
  result: null, errorCode: null, error: null, agentRunId: null, toolCallId: 'tc-1',
  approvalId: 'a1', connectionId: 'conn-1', startedAt: null, completedAt: null, createdAt: new Date(),
};
const doneRow = { ...baseRow, status: 'completed', result: { ok: true, externalId: 'ext-1' }, startedAt: new Date(), completedAt: new Date() };

function makeService(opts: {
  findUniqueSeq?: Array<Record<string, unknown> | null>;
  claimCount?: number;
} = {}) {
  const prisma = {
    approval: { findFirst: vi.fn().mockResolvedValue({ id: 'a1', status: 'approved', userId: 'u1', riskLevel: 'high' }) },
    connection: { findFirst: vi.fn().mockResolvedValue({ id: 'conn-1', status: 'active', provider: 'mock' }) },
    externalAction: {
      // 调用序：①幂等查重 ②建行后行读取 ③完成后行读取（或轮询）
      findUnique: opts.findUniqueSeq
        ? vi.fn().mockImplementationOnce(() => Promise.resolve(opts.findUniqueSeq![0])).mockImplementation(() => Promise.resolve(opts.findUniqueSeq![1] ?? null))
        : vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce(baseRow).mockResolvedValue(doneRow),
      create: vi.fn().mockResolvedValue({ ...baseRow }),
      update: vi.fn().mockResolvedValue({}),
      updateMany: vi.fn().mockResolvedValue({ count: opts.claimCount ?? 1 }),
      findFirst: vi.fn().mockResolvedValue(null),
      findMany: vi.fn().mockResolvedValue([]),
    },
  };
  const credentials = { getAccessToken: vi.fn().mockResolvedValue({ token: 'ACC', expiresAt: null }) };
  const mockProvider = { name: 'mock', execute: vi.fn().mockResolvedValue({ ok: true, externalId: 'ext-1' }) };
  const providers = { get: vi.fn((n: string) => (n === 'mock' ? mockProvider : undefined)) };
  const quota = {
    assertQuota: vi.fn().mockResolvedValue({ organizationId: 'org-1', consumed: 0, total: 1, reservationId: 'res-1' }),
    release: vi.fn().mockResolvedValue(undefined),
  };
  const svc = new ExternalActionsService(
    prisma as never, credentials as never, providers as never,
    { write: vi.fn().mockResolvedValue(undefined) } as never,
    { recordUsage: vi.fn().mockResolvedValue(undefined) } as never,
    quota as never,
  );
  return { svc, prisma, credentials, providers, mockProvider, quota };
}

function input(overrides: Partial<ExecuteExternalActionInput> = {}): ExecuteExternalActionInput {
  return {
    userId: 'u1', toolCallId: 'tc-1', provider: 'mock', actionType: 'success', payload: { title: 'x' },
    permission: 'external_action', idempotencyKey: 'key-1', signal: new AbortController().signal,
    ...overrides,
  };
}

describe('ExternalActionsService（M7-P3 审批复核 + Pre-M9 C2 claim-then-execute 幂等）', () => {
  beforeEach(() => vi.clearAllMocks());

  it('classifyRisk：financial/destructive → high；external_action → medium；其余 low', () => {
    expect(classifyRisk('financial')).toBe('high');
    expect(classifyRisk('destructive')).toBe('high');
    expect(classifyRisk('external_action')).toBe('medium');
    expect(classifyRisk('write')).toBe('low');
  });

  it('审批复核：无审批记录 → TOOL_DENIED；未批准 → TOOL_DENIED（绝不只信调用方）', async () => {
    const { svc, prisma } = makeService();
    prisma.approval.findFirst.mockResolvedValue(null);
    await expect(svc.execute(input())).rejects.toMatchObject({ code: 'TOOL_DENIED' });
    prisma.approval.findFirst.mockResolvedValue({ id: 'a1', status: 'rejected', userId: 'u1', riskLevel: 'high' });
    await expect(svc.execute(input())).rejects.toMatchObject({ code: 'TOOL_DENIED' });
  });

  it('成功执行：claim（(status, startedAt) CAS 推进 executing）→ provider（稳定 externalRequestId）→ 条件完成 + 结果回传', async () => {
    const { svc, prisma, mockProvider, quota } = makeService();
    const res = await svc.execute(input());
    expect(prisma.externalAction.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ id: 'ea-1', status: 'pending_approval', startedAt: null }),
      data: expect.objectContaining({ status: 'executing', approvalId: 'a1', connectionId: 'conn-1' }),
    }));
    expect(mockProvider.execute).toHaveBeenCalledWith(expect.objectContaining({
      externalRequestId: 'req-1', accessToken: 'ACC', actionType: 'success',
    }));
    expect(prisma.externalAction.updateMany).toHaveBeenLastCalledWith(expect.objectContaining({
      where: { id: 'ea-1', status: 'executing' },
      data: expect.objectContaining({ status: 'completed' }),
    }));
    expect(quota.release).toHaveBeenCalledWith('key-1', 'external_api_call');
    expect(res).toMatchObject({ externalActionId: 'ea-1', status: 'completed', result: { ok: true } });
  });

  it('幂等：completed 行已存在 → 直接复用结果，Provider 绝不重复调用', async () => {
    const { svc, prisma, mockProvider } = makeService({
      findUniqueSeq: [doneRow, doneRow],
    });
    const res = await svc.execute(input());
    expect(res).toMatchObject({ externalActionId: 'ea-1', status: 'completed' });
    expect(mockProvider.execute).not.toHaveBeenCalled();
  });

  it('崩溃残留：executing 超时行 → 重新 claim 同一 externalRequestId 继续（不建第二行）', async () => {
    const { svc, prisma, mockProvider } = makeService();
    const stale = {
      ...baseRow, status: 'executing', externalRequestId: 'req-stable',
      startedAt: new Date(Date.now() - 10 * 60_000), // 超接管窗口
    };
    prisma.externalAction.findUnique
      .mockReset()                    // 清掉默认 once 链
      .mockResolvedValueOnce(stale)   // ①幂等查重：残留行存在
      .mockResolvedValueOnce(stale)   // ②行读取
      .mockResolvedValue(doneRow);    // ③完成后
    await svc.execute(input());
    expect(prisma.externalAction.create).not.toHaveBeenCalled();
    expect(mockProvider.execute).toHaveBeenCalledWith(expect.objectContaining({ externalRequestId: 'req-stable' }));
  });

  it('Pre-M9 C2 并发：claim count=0（另一执行者赢）→ 轮询复用赢家结果，Provider 绝不重复执行', async () => {
    const { svc, prisma, mockProvider } = makeService({
      claimCount: 0,
      findUniqueSeq: [doneRow, doneRow],
    });
    prisma.externalAction.updateMany.mockResolvedValue({ count: 0 });
    const res = await svc.execute(input());
    expect(mockProvider.execute).not.toHaveBeenCalled();
    expect(res).toMatchObject({ externalActionId: 'ea-1', status: 'completed', result: { ok: true } });
  });

  it('连接校验失败（行创建之前）→ 无孤儿行；revoked/expired/缺失 分别映射', async () => {
    const { svc, prisma } = makeService();
    prisma.externalAction.findUnique.mockReset().mockResolvedValue(null); // 幂等查重恒无既有行
    prisma.connection.findFirst.mockResolvedValue({ id: 'c', status: 'revoked' });
    await expect(svc.execute(input())).rejects.toMatchObject({ code: 'CONNECTION_REVOKED' });
    prisma.connection.findFirst.mockResolvedValue({ id: 'c', status: 'expired' });
    await expect(svc.execute(input())).rejects.toMatchObject({ code: 'CONNECTION_NOT_ACTIVE' });
    prisma.connection.findFirst.mockResolvedValue(null);
    await expect(svc.execute(input())).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(prisma.externalAction.create).not.toHaveBeenCalled(); // 校验失败绝不落孤儿行
  });

  it('Provider 失败：行 failed（errorCode/error 落库）后原错误上抛（Engine 回喂 LLM）', async () => {
    const { svc, prisma, mockProvider, quota } = makeService();
    mockProvider.execute.mockRejectedValue(new AppError(ErrorCode.PROVIDER_UNKNOWN, '外部执行失败'));
    await expect(svc.execute(input())).rejects.toMatchObject({ code: 'PROVIDER_UNKNOWN' });
    expect(prisma.externalAction.updateMany).toHaveBeenLastCalledWith(expect.objectContaining({
      where: { id: 'ea-1', status: 'executing' },
      data: expect.objectContaining({ status: 'failed', errorCode: 'PROVIDER_UNKNOWN' }),
    }));
    expect(quota.release).toHaveBeenCalledWith('key-1', 'external_api_call');
  });

  it('取消：signal aborted → 行 cancelled(AGENT_CANCELLED) + AbortError 上抛', async () => {
    const { svc, prisma, mockProvider } = makeService();
    const ac = new AbortController();
    ac.abort();
    mockProvider.execute.mockImplementation(async () => {
      throw Object.assign(new Error('aborted'), { name: 'AbortError' });
    });
    await expect(svc.execute(input({ signal: ac.signal }))).rejects.toMatchObject({ name: 'AbortError' });
    expect(prisma.externalAction.updateMany).toHaveBeenLastCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: 'cancelled', errorCode: 'AGENT_CANCELLED' }),
    }));
  });

  it('不支持的 provider → PROVIDER_UNSUPPORTED（不触碰任何行）', async () => {
    const { svc, prisma } = makeService();
    await expect(svc.execute(input({ provider: 'shopify' }))).rejects.toMatchObject({ code: 'PROVIDER_UNSUPPORTED' });
    expect(prisma.externalAction.create).not.toHaveBeenCalled();
  });
});
