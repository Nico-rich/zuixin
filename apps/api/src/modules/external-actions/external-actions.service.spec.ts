import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ExternalActionsService, classifyRisk, ExecuteExternalActionInput } from './external-actions.service';
import { AppError, ErrorCode } from '../../common/errors/app-error';

function makeService() {
  const prisma = {
    approval: { findFirst: vi.fn().mockResolvedValue({ id: 'a1', status: 'approved', userId: 'u1', riskLevel: 'high' }) },
    connection: { findFirst: vi.fn().mockResolvedValue({ id: 'conn-1', status: 'active', provider: 'mock' }) },
    externalAction: {
      findUnique: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockResolvedValue({ id: 'ea-1', status: 'pending_approval' }),
      update: vi.fn().mockResolvedValue({}),
      findFirst: vi.fn().mockResolvedValue(null),
      findMany: vi.fn().mockResolvedValue([]),
    },
  };
  const credentials = { getAccessToken: vi.fn().mockResolvedValue({ token: 'ACC', expiresAt: null }) };
  const mockProvider = { name: 'mock', execute: vi.fn().mockResolvedValue({ ok: true, externalId: 'ext-1' }) };
  const providers = { get: vi.fn((n: string) => (n === 'mock' ? mockProvider : undefined)) };
  const svc = new ExternalActionsService(prisma as never, credentials as never, providers as never, { write: vi.fn().mockResolvedValue(undefined) } as never);
  return { svc, prisma, credentials, providers, mockProvider };
}

function input(overrides: Partial<ExecuteExternalActionInput> = {}): ExecuteExternalActionInput {
  return {
    userId: 'u1', toolCallId: 'tc-1', provider: 'mock', actionType: 'success', payload: { title: 'x' },
    permission: 'external_action', idempotencyKey: 'key-1', signal: new AbortController().signal,
    ...overrides,
  };
}

describe('ExternalActionsService（M7-P3 审批复核 + 幂等 + 连接 + Adapter）', () => {
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

  it('成功执行：pending_approval 行 → executing（approval/connection 绑定）→ completed + 结果回传', async () => {
    const { svc, prisma, mockProvider } = makeService();
    const done = { id: 'ea-1', status: 'completed', provider: 'mock', actionType: 'success', permission: 'external_action', riskLevel: 'high', input: { title: 'x' }, result: { ok: true, externalId: 'ext-1' }, errorCode: null, error: null, externalRequestId: 'req-1', agentRunId: null, toolCallId: 'tc-1', approvalId: 'a1', connectionId: 'conn-1', startedAt: new Date(), completedAt: new Date(), createdAt: new Date() };
    prisma.externalAction.update.mockResolvedValue(done);
    const res = await svc.execute(input());
    expect(prisma.externalAction.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'ea-1' },
      data: expect.objectContaining({ status: 'executing', externalRequestId: expect.any(String), approvalId: 'a1', connectionId: 'conn-1' }),
    }));
    expect(mockProvider.execute).toHaveBeenCalledWith(expect.objectContaining({
      externalRequestId: expect.any(String), accessToken: 'ACC', actionType: 'success',
    }));
    expect(res).toMatchObject({ externalActionId: 'ea-1', status: 'completed', result: { ok: true } });
  });

  it('幂等：completed 行已存在 → 直接复用结果，Provider 绝不重复调用', async () => {
    const { svc, prisma, mockProvider } = makeService();
    prisma.externalAction.findUnique.mockResolvedValue({
      id: 'ea-1', status: 'completed', result: { ok: true }, provider: 'mock', actionType: 'success',
      permission: 'external_action', riskLevel: 'high', input: {}, errorCode: null, error: null,
      externalRequestId: 'req-1', agentRunId: null, toolCallId: null, approvalId: 'a1', connectionId: 'conn-1',
      startedAt: new Date(), completedAt: new Date(), createdAt: new Date(),
    });
    const res = await svc.execute(input());
    expect(res).toMatchObject({ externalActionId: 'ea-1', status: 'completed' });
    expect(mockProvider.execute).not.toHaveBeenCalled();
  });

  it('崩溃残留：executing 行 → 复用同一行 + 同一 externalRequestId 继续执行（不建第二行）', async () => {
    const { svc, prisma, mockProvider } = makeService();
    prisma.externalAction.findUnique.mockResolvedValue({
      id: 'ea-9', status: 'executing', result: null, externalRequestId: 'req-stable', provider: 'mock',
      actionType: 'success', permission: 'external_action', riskLevel: 'high', input: {}, errorCode: null, error: null,
      agentRunId: null, toolCallId: null, approvalId: 'a1', connectionId: 'conn-1',
      startedAt: new Date(), completedAt: null, createdAt: new Date(),
    });
    await svc.execute(input());
    expect(prisma.externalAction.create).not.toHaveBeenCalled();
    expect(mockProvider.execute).toHaveBeenCalledWith(expect.objectContaining({ externalRequestId: 'req-stable' }));
  });

  it('连接校验失败（行创建之前）→ 无孤儿行；revoked/expired/缺失 分别映射', async () => {
    const { svc, prisma } = makeService();
    prisma.connection.findFirst.mockResolvedValue({ id: 'c', status: 'revoked' });
    await expect(svc.execute(input())).rejects.toMatchObject({ code: 'CONNECTION_REVOKED' });
    prisma.connection.findFirst.mockResolvedValue({ id: 'c', status: 'expired' });
    await expect(svc.execute(input())).rejects.toMatchObject({ code: 'CONNECTION_NOT_ACTIVE' });
    prisma.connection.findFirst.mockResolvedValue(null);
    await expect(svc.execute(input())).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(prisma.externalAction.create).not.toHaveBeenCalled(); // 校验失败绝不落孤儿行
  });

  it('Provider 失败：行 failed（errorCode/error 落库）后原错误上抛（Engine 回喂 LLM）', async () => {
    const { svc, prisma, mockProvider } = makeService();
    mockProvider.execute.mockRejectedValue(new AppError(ErrorCode.PROVIDER_UNKNOWN, '外部执行失败'));
    await expect(svc.execute(input())).rejects.toMatchObject({ code: 'PROVIDER_UNKNOWN' });
    expect(prisma.externalAction.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: 'failed', errorCode: 'PROVIDER_UNKNOWN' }),
    }));
  });

  it('取消：signal aborted → 行 cancelled(AGENT_CANCELLED) + AbortError 上抛', async () => {
    const { svc, prisma, mockProvider } = makeService();
    const ac = new AbortController();
    ac.abort();
    mockProvider.execute.mockImplementation(async () => {
      throw Object.assign(new Error('aborted'), { name: 'AbortError' });
    });
    await expect(svc.execute(input({ signal: ac.signal }))).rejects.toMatchObject({ name: 'AbortError' });
    expect(prisma.externalAction.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: 'cancelled', errorCode: 'AGENT_CANCELLED' }),
    }));
  });

  it('不支持的 provider → PROVIDER_UNSUPPORTED（不触碰任何行）', async () => {
    const { svc, prisma } = makeService();
    await expect(svc.execute(input({ provider: 'shopify' }))).rejects.toMatchObject({ code: 'PROVIDER_UNSUPPORTED' });
    expect(prisma.externalAction.create).not.toHaveBeenCalled();
  });
});
