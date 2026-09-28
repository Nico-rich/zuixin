import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ExternalActionsService, classifyRisk, ExecuteExternalActionInput } from './external-actions.service';
import { AppError, ErrorCode } from '../../common/errors/app-error';
import { bindPayload } from '../approvals/approval-binding';

/** 引擎审批门的绑定口径：(工具名, 工具入参) —— 审批行由引擎在同一 helper 下写入（Pre-M9 Approval Binding） */
const TOOL_NAME = 'external_action.execute';
const toolInput = { actionType: 'success', payload: { title: 'x' } };
const approvedPayload = bindPayload({ toolName: TOOL_NAME, input: toolInput }, TOOL_NAME, toolInput);

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
  /** Pre-M9 G7：provider 的远端状态查询（缺省 = 平台不支持状态查询） */
  remoteStatus?: (req: <T>() => T) => Promise<unknown>;
  connectionStatus?: string;
  token?: { token: string } | null;
} = {}) {
  const prisma = {
    approval: { findFirst: vi.fn().mockResolvedValue({ id: 'a1', status: 'approved', userId: 'u1', riskLevel: 'high', payload: approvedPayload }) },
    // Pre-M9：引擎路径的绑定校验以 ToolCall 行为事实源（toolName + 工具入参）
    toolCall: { findUnique: vi.fn().mockResolvedValue({ toolName: TOOL_NAME, input: toolInput }) },
    connection: { findFirst: vi.fn().mockResolvedValue({ id: 'conn-1', status: opts.connectionStatus ?? 'active', provider: 'mock' }) },
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
  const credentials = { getAccessToken: vi.fn().mockResolvedValue(opts.token === undefined ? { token: 'ACC', expiresAt: null } : opts.token) };
  const mockProvider = {
    name: 'mock',
    execute: vi.fn().mockResolvedValue({ ok: true, externalId: 'ext-1' }),
    ...(opts.remoteStatus ? { remoteStatus: vi.fn(opts.remoteStatus as never) } : {}),
  };
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

  it('Pre-M9 Binding（引擎口径）：审批未绑定/绑定到别的工具入参 → APPROVAL_BINDING_MISMATCH，绝不执行', async () => {
    // ① 升级前的旧审批（payload 无 __binding）→ fail-closed
    const legacy = makeService();
    legacy.prisma.approval.findFirst.mockResolvedValue({
      id: 'a1', status: 'approved', userId: 'u1', riskLevel: 'high', payload: { toolName: TOOL_NAME, input: toolInput },
    });
    await expect(legacy.svc.execute(input())).rejects.toMatchObject({ code: ErrorCode.APPROVAL_BINDING_MISMATCH });
    expect(legacy.mockProvider.execute).not.toHaveBeenCalled();

    // ② 审批绑定的是另一个工具入参（批准 A、执行 B）→ 拒绝
    const other = makeService();
    const otherInput = { actionType: 'success', payload: { title: '另一个标题' } };
    other.prisma.approval.findFirst.mockResolvedValue({
      id: 'a1', status: 'approved', userId: 'u1', riskLevel: 'high',
      payload: bindPayload({ toolName: TOOL_NAME, input: otherInput }, TOOL_NAME, otherInput),
    });
    await expect(other.svc.execute(input())).rejects.toMatchObject({ code: ErrorCode.APPROVAL_BINDING_MISMATCH });
    expect(other.mockProvider.execute).not.toHaveBeenCalled();
    expect(other.prisma.externalAction.create).not.toHaveBeenCalled();
  });

  it('Pre-M9 Binding（引擎口径）：工具入参被换成另一个动作（子动作不一致）→ APPROVAL_BINDING_MISMATCH', async () => {
    const { svc, prisma, mockProvider } = makeService();
    // 绑定与工具行一致（自洽），但本次执行的动作 actionType/payload 与工具入参里描述的动作不同
    await expect(svc.execute(input({ actionType: 'success', payload: { title: '被替换的载荷' } })))
      .rejects.toMatchObject({ code: ErrorCode.APPROVAL_BINDING_MISMATCH });
    expect(mockProvider.execute).not.toHaveBeenCalled();
    expect(prisma.externalAction.create).not.toHaveBeenCalled();
  });

  it('Pre-M9 Binding（工作流口径 approvalId）：绑定与渲染载荷一致 → 放行；执行时换载荷 → 拒绝', async () => {
    const { svc, prisma, mockProvider } = makeService();
    const rendered = { title: '渲染后的载荷' };
    prisma.approval.findFirst.mockResolvedValue({
      id: 'a1', status: 'approved', userId: 'u1', riskLevel: 'high',
      payload: bindPayload({ stepId: 's1', boundActionType: 'shop.publish' }, 'shop.publish', rendered),
    });
    await svc.execute(input({ toolCallId: undefined, approvalId: 'a1', actionType: 'shop.publish', payload: rendered }));
    expect(mockProvider.execute).toHaveBeenCalledTimes(1);

    // 执行时把载荷换成别的（金额/收件人/目标资源被替换）→ 拒绝（绝不放行到 provider）
    mockProvider.execute.mockClear();
    await expect(svc.execute(input({ toolCallId: undefined, approvalId: 'a1', actionType: 'shop.publish', payload: { title: '被替换' } })))
      .rejects.toMatchObject({ code: ErrorCode.APPROVAL_BINDING_MISMATCH });
    expect(mockProvider.execute).not.toHaveBeenCalled();
  });
});

describe('Pre-M9 G7：ExternalAction executing 残留行按远端真实状态恢复', () => {
  const executingRow = {
    ...baseRow, userId: 'u1', projectId: 'proj-1', idempotencyKey: 'key-1',
    status: 'executing', externalRequestId: 'req-stable', startedAt: new Date(Date.now() - 20 * 60_000),
  };
  const staleOnly = (opts: Parameters<typeof makeService>[0] = {}) => {
    const h = makeService(opts);
    h.prisma.externalAction.findUnique.mockReset().mockResolvedValue(executingRow);
    return h;
  };

  it('远端已完成 → 落 completed + 审计 + 计量（同一把 ea:{id} 幂等键）+ 配额释放，绝不重复执行副作用', async () => {
    const { svc, prisma, mockProvider, quota } = staleOnly({
      remoteStatus: async () => ({ status: 'completed', result: { ok: true, externalId: 'req-stable-done' } }),
    });
    await expect(svc.recoverExecutingAction('ea-1')).resolves.toBe('completed');

    expect(mockProvider.execute).not.toHaveBeenCalled(); // 远端是既成事实：绝不重放
    expect(prisma.externalAction.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'ea-1', status: 'executing' },
      data: expect.objectContaining({ status: 'completed', result: { ok: true, externalId: 'req-stable-done' } }),
    }));
    expect(quota.release).toHaveBeenCalledWith('key-1', 'external_api_call');
  });

  it('远端已失败 → 落 failed（错误码/文案来自 provider）+ 配额释放，不计量', async () => {
    const { svc, prisma, quota } = staleOnly({
      remoteStatus: async () => ({ status: 'failed', errorCode: 'FORBIDDEN', error: '远端拒绝' }),
    });
    await expect(svc.recoverExecutingAction('ea-1')).resolves.toBe('failed');
    expect(prisma.externalAction.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'ea-1', status: 'executing' },
      data: expect.objectContaining({ status: 'failed', errorCode: 'FORBIDDEN', error: '远端拒绝' }),
    }));
    expect(quota.release).toHaveBeenCalledWith('key-1', 'external_api_call');
  });

  it('远端仍在执行/无结论 → 保持 executing（绝不伪造终态）', async () => {
    const { svc, prisma } = staleOnly({ remoteStatus: async () => ({ status: 'processing' }) });
    await expect(svc.recoverExecutingAction('ea-1')).resolves.toBe('processing');
    expect(prisma.externalAction.updateMany).not.toHaveBeenCalled();
  });

  it('provider 未实现 remoteStatus（平台不支持状态查询）→ unknown，不介入', async () => {
    const { svc, prisma } = staleOnly();
    await expect(svc.recoverExecutingAction('ea-1')).resolves.toBe('unknown');
    expect(prisma.externalAction.updateMany).not.toHaveBeenCalled();
  });

  it('状态查询抛错（provider 不可达）→ unknown：保持 executing，绝不把"查不到"当失败', async () => {
    const { svc, prisma } = staleOnly({ remoteStatus: async () => { throw new AppError(ErrorCode.PROVIDER_TIMEOUT, '超时'); } });
    await expect(svc.recoverExecutingAction('ea-1')).resolves.toBe('unknown');
    expect(prisma.externalAction.updateMany).not.toHaveBeenCalled();
  });

  it('连接不可用 / 凭证取不到 → unknown（不带着空凭证去查远端）', async () => {
    const revoked = staleOnly({ connectionStatus: 'revoked', remoteStatus: async () => ({ status: 'completed' }) });
    await expect(revoked.svc.recoverExecutingAction('ea-1')).resolves.toBe('unknown');
    expect(revoked.prisma.externalAction.updateMany).not.toHaveBeenCalled();

    const noToken = staleOnly({ token: null, remoteStatus: async () => ({ status: 'completed' }) });
    await expect(noToken.svc.recoverExecutingAction('ea-1')).resolves.toBe('unknown');
    expect(noToken.prisma.externalAction.updateMany).not.toHaveBeenCalled();
  });

  it('非 executing 行（已终态/审批中）→ unknown，绝不复活', async () => {
    const { svc, prisma } = makeService({ remoteStatus: async () => ({ status: 'completed' }) });
    prisma.externalAction.findUnique.mockReset().mockResolvedValue({ ...baseRow, status: 'cancelled', userId: 'u1' });
    await expect(svc.recoverExecutingAction('ea-1')).resolves.toBe('unknown');
    expect(prisma.externalAction.updateMany).not.toHaveBeenCalled();
  });

  it('竞态：远端完成写入时已被正常路径终态（count=0）→ unknown，不重复计量', async () => {
    const { svc, prisma } = staleOnly({ remoteStatus: async () => ({ status: 'completed', result: { ok: true } }) });
    prisma.externalAction.updateMany.mockResolvedValue({ count: 0 });
    await expect(svc.recoverExecutingAction('ea-1')).resolves.toBe('unknown');
  });

  it('recoverStaleExecutingActions：只扫静默超阈值的 executing 行，按结果计数，单行失败不中断', async () => {
    const { svc, prisma } = makeService({ remoteStatus: async () => ({ status: 'completed', result: { ok: true } }) });
    prisma.externalAction.findMany.mockResolvedValue([{ id: 'ea-1' }, { id: 'ea-2' }]);
    prisma.externalAction.findUnique.mockReset()
      .mockResolvedValueOnce(executingRow)
      .mockRejectedValueOnce(new Error('查询异常'));

    const r = await svc.recoverStaleExecutingActions(60_000);
    expect(r).toEqual({ scanned: 2, recovered: 1 }); // 一行恢复、一行异常不影响整批
    expect(prisma.externalAction.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { status: 'executing', startedAt: { lt: expect.any(Date) } },
    }));
  });
});
