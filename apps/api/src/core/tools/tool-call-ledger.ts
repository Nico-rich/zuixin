import { Prisma } from '@prisma/client';
import { AppError, ErrorCode } from '../../common/errors/app-error';

/**
 * Pre-M9 G11：**写副作用工具的崩溃安全幂等协议（零 schema 变更）**。
 *
 * 背景：ToolCall 行本身已按 `(runStepId, idempotencyKey)` 唯一（同一次工具调用重放不会重复执行），
 * 但**工具内部**再写别的表（feedback / creativePerformance / commerceAnalysis / creativeBrief）
 * 没有二次幂等保护：执行中崩溃 → 行残留 `running`（或引擎终态写失败）→ resume 会**再执行一次工具**，
 * 于是同一个 ToolCall 产生第二行副作用事实。
 *
 * 协议（复用既有键，不新增列/表）：把 ToolCall 行自身的 `output` 当作**幂等账本**，
 * 与副作用写入放进**同一个数据库事务**——
 * - 首次执行：`副作用 insert` + `output = 副作用结果` **同时提交**；
 * - 崩溃/重放：事务要么整体未提交（无副作用、无账本 → 干净重试），要么整体已提交
 *   （账本命中 → 直接复用首次结果，**绝不二次写**）；
 * - 并发双执行：`output` 的 CAS（仅当仍为 NULL 才写入）保证只有一个赢家，
 *   输家抛错回滚 —— 它的那次 insert 一并回滚，绝不留下重复事实。
 *
 * 边界：`output` 只在引擎终态写（completed）时才会被引擎覆盖为同一份结果；
 * 因此"账本命中的行"与"引擎写入的行"语义一致，工具的输出形态（LLM 看到的内容）完全不变。
 * 非 ToolCall 路径（HTTP/工作流直调，无 toolCallId）行为**与改造前完全一致**（单写，不进账本）。
 */
export interface ToolCallLedgerDb {
  $transaction: <R>(fn: (tx: Prisma.TransactionClient) => Promise<R>) => Promise<R>;
}

/** 账本写入的载荷就是工具自身的返回值（与引擎落库内容逐字一致） */
export async function withToolCallLedger<T>(
  db: ToolCallLedgerDb,
  toolCallId: string | null | undefined,
  write: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  if (!toolCallId) return write(db as unknown as Prisma.TransactionClient);
  return db.$transaction(async (tx) => {
    const row = await tx.toolCall.findUnique({ where: { id: toolCallId }, select: { output: true } });
    if (row?.output !== null && row?.output !== undefined) return row.output as T; // 账本命中：首次执行已提交
    const value = await write(tx);
    const claimed = await tx.toolCall.updateMany({
      where: { id: toolCallId, output: { equals: Prisma.DbNull } }, // CAS：并发输家不得覆盖账本
      data: { output: value as Prisma.InputJsonValue },
    });
    if (claimed.count === 0) {
      throw new AppError(ErrorCode.VALIDATION_ERROR, '同一 ToolCall 的并发重复执行已拒绝（幂等账本已由另一次执行写入）');
    }
    return value;
  });
}
