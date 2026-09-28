import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Prisma } from '@prisma/client';
import { FeedbackService } from './feedback.service';

/** ToolCall 账本替身：output 即"首次执行已提交"的标记（与真实协议一致） */
function makeService(ledgerOutput: unknown = null) {
  const state = { output: ledgerOutput as unknown };
  const tx = {
    toolCall: {
      findUnique: vi.fn(async () => ({ output: state.output })),
      updateMany: vi.fn(async ({ where, data }: { where: { output?: { equals?: unknown } }; data: { output: unknown } }) => {
        if (where.output?.equals === Prisma.DbNull && state.output !== null) return { count: 0 };
        state.output = data.output;
        return { count: 1 };
      }),
    },
    feedback: { create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({ id: 'fb-1', createdAt: new Date(), ...data })) },
    creativePerformance: { create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({ id: 'cp-1', capturedAt: new Date(), ...data })) },
    performanceSnapshot: { create: vi.fn(async () => ({ id: 'snap-1' })) },
  };
  const prisma = {
    feedback: { create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({ id: 'fb-http', createdAt: new Date(), ...data })), findMany: vi.fn().mockResolvedValue([]) },
    creativePerformance: { create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({ id: 'cp-http', ...data })), findMany: vi.fn().mockResolvedValue([]) },
    performanceSnapshot: { create: vi.fn(async () => ({ id: 'snap-http' })) },
    artifact: { findFirst: vi.fn().mockResolvedValue({ id: 'art-1' }) },
    // M10-P15（BUG-15）：projectId 服务端归属裁决（非本人项目 → 404）
    project: { findFirst: vi.fn().mockResolvedValue({ id: 'proj-1' }) },
    memory: { findFirst: vi.fn().mockResolvedValue(null), findMany: vi.fn().mockResolvedValue([]) },
    $transaction: vi.fn(async (fn: (t: unknown) => Promise<unknown>) => fn(tx)),
  };
  const memories = { create: vi.fn().mockResolvedValue({ id: 'mem-1' }) };
  const svc = new FeedbackService(prisma as never, memories as never);
  return { svc, prisma, tx, memories, state };
}

describe('FeedbackService（M7-P8 学习闭环 + Pre-M9 G11 幂等）', () => {
  beforeEach(() => vi.clearAllMocks());

  it('submit（HTTP 直调，无 toolCallId）：单写事实，不进账本事务', async () => {
    const { svc, prisma, tx } = makeService();
    const row = await svc.submit('u1', { subjectType: 'artifact', subjectId: 'a1', rating: 5, comment: '好' });
    expect(row).toMatchObject({ id: 'fb-http', rating: 5 });
    expect(prisma.feedback.create).toHaveBeenCalledTimes(1);
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(tx.feedback.create).not.toHaveBeenCalled();
  });

  it('G11 submit（ToolCall）：事实写入 + 账本同事务；高分沉淀绩效记忆候选', async () => {
    const { svc, prisma, tx } = makeService();
    const row = await svc.submit('u1', { subjectType: 'artifact', subjectId: 'a1', rating: 5 }, { toolCallId: 'tc-1' });
    expect(row).toMatchObject({ id: 'fb-1' });
    expect(prisma.feedback.create).not.toHaveBeenCalled(); // 事实经 tx 写入（同事务）
    expect(tx.feedback.create).toHaveBeenCalledTimes(1);
    expect(tx.toolCall.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'tc-1', output: { equals: Prisma.DbNull } },
      data: { output: expect.objectContaining({ id: 'fb-1', rating: 5 }) },
    }));
    expect(memories_call(prisma)).toBe(true); // 记忆沉淀仍发生（metadata 幂等）
  });

  it('G11 submit 崩溃重放：账本命中 → 复用首次结果，绝不产生第二条 Feedback', async () => {
    const { svc, prisma, tx } = makeService({ id: 'fb-first', subjectType: 'artifact', subjectId: 'a1', rating: 5 });
    const row = await svc.submit('u1', { subjectType: 'artifact', subjectId: 'a1', rating: 5 }, { toolCallId: 'tc-1' });
    expect(row).toMatchObject({ id: 'fb-first' }); // 与首次执行逐字一致（LLM 看到的内容不变）
    expect(tx.feedback.create).not.toHaveBeenCalled();
    expect(prisma.feedback.create).not.toHaveBeenCalled();
  });

  it('G11 capturePerformance：绩效事实 + 快照 + 账本同事务，返回分层结果', async () => {
    const { svc, tx } = makeService();
    const res = await svc.capturePerformance('u1', {
      artifactId: 'art-1',
      metrics: { impressions: 10000, clicks: 500, spend: 1000, conversions: 40, revenue: 3000, orders: 35 },
    }, { toolCallId: 'tc-2' });
    expect(res).toMatchObject({ performanceId: 'cp-1', derived: { ctr: 0.05, roas: 3 }, layering: { derived: 'service-computed' } });
    expect(tx.creativePerformance.create).toHaveBeenCalledTimes(1);
    expect(tx.performanceSnapshot.create).toHaveBeenCalledTimes(1); // 快照与事实同生同死
    expect(tx.toolCall.updateMany).toHaveBeenCalledTimes(1);
  });

  it('G11 capturePerformance 崩溃重放：账本命中 → 不重复写事实/快照，结果逐字一致', async () => {
    const recorded = { performanceId: 'cp-first', facts: { impressions: 10000 }, derived: { ctr: 0.05 }, layering: { facts: 'reported' } };
    const { svc, tx } = makeService(recorded);
    const res = await svc.capturePerformance('u1', {
      artifactId: 'art-1',
      metrics: { impressions: 10000, clicks: 500, spend: 1000, conversions: 40, revenue: 3000, orders: 35 },
    }, { toolCallId: 'tc-2' });
    expect(res).toEqual(recorded);
    expect(tx.creativePerformance.create).not.toHaveBeenCalled();
    expect(tx.performanceSnapshot.create).not.toHaveBeenCalled();
  });

  it('capturePerformance：制品不存在 → 404（校验在任何写入之前）', async () => {
    const { svc, prisma } = makeService();
    prisma.artifact.findFirst.mockResolvedValue(null);
    await expect(svc.capturePerformance('u1', {
      artifactId: 'missing',
      metrics: { impressions: 1, clicks: 0, spend: 0, conversions: 0, revenue: 0, orders: 0 },
    }, { toolCallId: 'tc-3' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('M10-P15（BUG-15）：projectId 服务端归属裁决 —— 非本人项目 → 404 且零写入（两条事实路径）', async () => {
    // submit：跨租户 projectId 绝不落库（此前原样写入 ⇒ 跨租户引用注入 / 归属链断裂）
    const submit = makeService();
    submit.prisma.project.findFirst.mockResolvedValue(null);
    await expect(submit.svc.submit('u1', { subjectType: 'artifact', subjectId: 'a1', rating: 5, projectId: 'foreign-proj' }))
      .rejects.toMatchObject({ code: 'NOT_FOUND', message: '项目不存在' });
    expect(submit.prisma.feedback.create).not.toHaveBeenCalled();
    expect(submit.prisma.$transaction).not.toHaveBeenCalled();
    expect(submit.svc).toBeDefined();

    // capturePerformance：同上（写入前的判定，快照/事实均不落库）
    const perf = makeService();
    perf.prisma.project.findFirst.mockResolvedValue(null);
    await expect(perf.svc.capturePerformance('u1', {
      projectId: 'foreign-proj',
      metrics: { impressions: 1, clicks: 0, spend: 0, conversions: 0, revenue: 0, orders: 0 },
    })).rejects.toMatchObject({ code: 'NOT_FOUND', message: '项目不存在' });
    expect(perf.prisma.$transaction).not.toHaveBeenCalled();

    // 谓词锚：归属判定含 userId + deletedAt（谓词放宽即等于跨租户可写）
    const anchor = makeService();
    await anchor.svc.submit('u1', { subjectType: 'artifact', subjectId: 'a1', rating: 5, projectId: 'proj-1' });
    expect(anchor.prisma.project.findFirst).toHaveBeenCalledWith({
      where: { id: 'proj-1', userId: 'u1', deletedAt: null }, select: { id: true },
    });

    // 省略 projectId（个人面）不受影响：不查项目、照常落库
    const personal = makeService();
    await personal.svc.submit('u1', { subjectType: 'artifact', subjectId: 'a1', rating: 5 });
    expect(personal.prisma.project.findFirst).not.toHaveBeenCalled();
    expect(personal.prisma.feedback.create).toHaveBeenCalledTimes(1);
  });
});

/** 记忆沉淀断言辅助（高分/低分才写；本例 rating=5） */
function memories_call(prisma: { memory: { findFirst: ReturnType<typeof vi.fn> } }): boolean {
  return prisma.memory.findFirst.mock.calls.length > 0;
}
