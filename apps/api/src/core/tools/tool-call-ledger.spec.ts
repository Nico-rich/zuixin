import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Prisma } from '@prisma/client';
import { withToolCallLedger } from './tool-call-ledger';

/**
 * Pre-M9 G11：ToolCall 幂等账本协议单测。
 * 用内存态替身精确复现两个关键语义：①「账本值 = 首次执行的返回值」；②「CAS 只有 NULL 才能写入」
 * （否则"并发输家回滚、重放复用"这两条核心不变式在单测里根本不成立）。
 */
function makeDb(initialOutput: unknown = null) {
  const state = { output: initialOutput as unknown };
  const tx = {
    toolCall: {
      findUnique: vi.fn(async () => ({ output: state.output })),
      updateMany: vi.fn(async ({ where, data }: { where: { output?: { equals?: unknown } }; data: { output: unknown } }) => {
        // CAS：仅当 output 仍为 SQL NULL（Prisma.DbNull）才允许写入
        if (where.output?.equals === Prisma.DbNull && state.output !== null) return { count: 0 };
        state.output = data.output;
        return { count: 1 };
      }),
    },
    feedback: { create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({ id: 'fb-1', ...data })) },
  };
  const db = { $transaction: vi.fn(async (fn: (t: unknown) => Promise<unknown>) => fn(tx)) };
  return { db, tx, state };
}

describe('withToolCallLedger（G11 写副作用工具崩溃安全幂等）', () => {
  beforeEach(() => vi.clearAllMocks());

  it('无 toolCallId（HTTP/工作流直调）→ 不进事务、不写账本，行为与改造前一致', async () => {
    const { db } = makeDb();
    const write = vi.fn(async () => ({ id: 'fb-1' }));
    const res = await withToolCallLedger(db as never, null, write as never);
    expect(res).toEqual({ id: 'fb-1' });
    expect(db.$transaction).not.toHaveBeenCalled();
  });

  it('首次执行：副作用写入与账本（output=返回值）同一事务提交', async () => {
    const { db, tx, state } = makeDb();
    const res = await withToolCallLedger(db as never, 'tc-1', async (t) =>
      (t as unknown as typeof tx).feedback.create({ data: { rating: 5 } }) as Promise<{ id: string }>);
    expect(res).toEqual({ id: 'fb-1', rating: 5 });
    expect(tx.feedback.create).toHaveBeenCalledTimes(1);
    expect(tx.toolCall.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'tc-1', output: { equals: Prisma.DbNull } }, data: { output: { id: 'fb-1', rating: 5 } },
    }));
    expect(state.output).toEqual({ id: 'fb-1', rating: 5 });
  });

  it('崩溃重放（账本已有值）：直接复用首次结果，绝不二次写副作用', async () => {
    const { db, tx } = makeDb({ id: 'fb-1', rating: 5 });
    const write = vi.fn(async () => ({ id: 'fb-2' }));
    const res = await withToolCallLedger(db as never, 'tc-1', write as never);
    expect(res).toEqual({ id: 'fb-1', rating: 5 });
    expect(write).not.toHaveBeenCalled();
    expect(tx.toolCall.updateMany).not.toHaveBeenCalled();
  });

  it('并发双执行：CAS 输家抛错（其写入随事务回滚），账本保持赢家值', async () => {
    const { db, state } = makeDb();
    // 模拟"另一次执行在本次 write 之后、CAS 之前抢先写入账本"
    const write = vi.fn(async () => {
      state.output = { id: 'winner' };
      return { id: 'loser' };
    });
    await expect(withToolCallLedger(db as never, 'tc-1', write as never))
      .rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    expect(state.output).toEqual({ id: 'winner' }); // 赢家值不被覆盖
  });
});
