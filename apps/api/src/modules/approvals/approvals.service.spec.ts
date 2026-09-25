import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ApprovalsService } from './approvals.service';

function makeService(rows: Array<Record<string, unknown>> = []) {
  const prisma = {
    approval: {
      findFirst: vi.fn(),
      findMany: vi.fn().mockResolvedValue(rows),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
  };
  const resume = { wakeWaitingRunByApproval: vi.fn().mockResolvedValue({ woken: true }) };
  const events = { publish: vi.fn().mockResolvedValue(undefined) };
  return { svc: new ApprovalsService(prisma as never, resume as never, events as never, { write: vi.fn().mockResolvedValue(undefined) } as never), prisma, resume, events };
}

describe('ApprovalsService（M7-P1 状态机 + 竞态 + 归属）', () => {
  beforeEach(() => vi.clearAllMocks());

  it('approve：条件更新 requested→approved（含未过期 OR）+ approvedAt + 唤醒 run + 观察事件', async () => {
    const { svc, prisma, resume, events } = makeService();
    prisma.approval.findFirst.mockResolvedValue({ id: 'a1', userId: 'u1', status: 'requested', agentRunId: 'run-1', expiresAt: null });
    await svc.approve('u1', 'a1');
    expect(prisma.approval.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        id: 'a1', userId: 'u1', status: 'requested',
        OR: [{ expiresAt: null }, { expiresAt: expect.any(Object) }],
      }),
      data: expect.objectContaining({ status: 'approved', approvedAt: expect.any(Date) }),
    }));
    expect(resume.wakeWaitingRunByApproval).toHaveBeenCalledWith('run-1', 'a1');
    expect(events.publish).toHaveBeenCalledWith(expect.stringContaining('agent-run:run-1'), expect.objectContaining({ type: 'approval.decided', status: 'approved' }));
  });

  it('reject/cancel：对应时间戳字段 + 唤醒（cancelled 也唤醒——run 不得永久 waiting）', async () => {
    const { svc, prisma, resume } = makeService();
    prisma.approval.findFirst.mockResolvedValue({ id: 'a1', userId: 'u1', status: 'requested', agentRunId: 'run-1', expiresAt: null });
    await svc.reject('u1', 'a1');
    expect(prisma.approval.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: 'rejected', rejectedAt: expect.any(Date) }),
    }));
    await svc.cancel('u1', 'a1');
    expect(prisma.approval.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: 'cancelled', cancelledAt: expect.any(Date) }),
    }));
    expect(resume.wakeWaitingRunByApproval).toHaveBeenCalledTimes(2);
  });

  it('竞态：并发 decide 输家（count=0 且未过期）→ 409 APPROVAL_NOT_PENDING，不唤醒', async () => {
    const { svc, prisma, resume } = makeService();
    prisma.approval.findFirst.mockResolvedValue({ id: 'a1', userId: 'u1', status: 'requested', agentRunId: 'run-1', expiresAt: null });
    prisma.approval.updateMany.mockResolvedValue({ count: 0 });
    await expect(svc.approve('u1', 'a1')).rejects.toMatchObject({ code: 'APPROVAL_NOT_PENDING' });
    expect(resume.wakeWaitingRunByApproval).not.toHaveBeenCalled();
  });

  it('竞态：approve 撞过期（count=0 且 expiresAt 已过）→ 懒过期落库 + 409 APPROVAL_EXPIRED', async () => {
    const { svc, prisma } = makeService();
    prisma.approval.findFirst.mockResolvedValue({ id: 'a1', userId: 'u1', status: 'requested', agentRunId: 'run-1', expiresAt: new Date(Date.now() - 1000) });
    prisma.approval.updateMany.mockResolvedValue({ count: 0 });
    await expect(svc.approve('u1', 'a1')).rejects.toMatchObject({ code: 'APPROVAL_EXPIRED' });
    expect(prisma.approval.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'a1', userId: 'u1', status: 'requested' },
      data: { status: 'expired' },
    }));
  });

  it('重复 approve（已终态）→ 409 APPROVAL_NOT_PENDING（绝不产生第二个 Tool execution）', async () => {
    const { svc, prisma, resume } = makeService();
    prisma.approval.findFirst.mockResolvedValue({ id: 'a1', userId: 'u1', status: 'approved', agentRunId: 'run-1', expiresAt: null });
    await expect(svc.approve('u1', 'a1')).rejects.toMatchObject({ code: 'APPROVAL_NOT_PENDING' });
    expect(prisma.approval.updateMany).not.toHaveBeenCalled();
    expect(resume.wakeWaitingRunByApproval).not.toHaveBeenCalled();
  });

  it('越权：他人 approval → 404（防枚举）；匿名同路径', async () => {
    const { svc, prisma } = makeService();
    prisma.approval.findFirst.mockResolvedValue(null);
    await expect(svc.get('u2', 'a1')).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(svc.approve('u2', 'a1')).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('list 懒过期：requested 且 expiresAt 已过 → 先 expired 再查询', async () => {
    const { svc, prisma } = makeService();
    await svc.list('u1', {});
    expect(prisma.approval.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ userId: 'u1', status: 'requested', expiresAt: expect.any(Object) }),
      data: { status: 'expired' },
    }));
  });

  it('cancelPendingForRun：run 取消附带清理 requested → cancelled（best-effort，不唤醒）', async () => {
    const { svc, prisma } = makeService();
    await svc.cancelPendingForRun('run-1');
    expect(prisma.approval.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { agentRunId: 'run-1', status: 'requested' },
      data: expect.objectContaining({ status: 'cancelled' }),
    }));
  });
});
