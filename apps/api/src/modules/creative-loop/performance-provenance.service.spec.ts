import { describe, it, expect, vi } from 'vitest';
import { Prisma } from '@prisma/client';
import { PROVENANCE_SCAN_LIMIT, PerformanceProvenanceService } from './performance-provenance.service';
import { AGENT_PERFORMANCE_TOOL } from './insight-rules';

/**
 * M12-P1 来源判别单测（审计 R1）：判定的可靠性取决于这条查询——
 * **查谁**（哪个工具/哪个用户的 run 账本）、**取什么**（已落账本的 output）、**够不够**（枚举完整性）。
 *
 * 三条不变量：
 * ① 只认 agent 写工具 `performance.capture` 的账本，且按 **run 归属（userId）** server-side 收窄；
 * ② 只认**已落账本**（`output` 非 NULL）的行——running/waiting_approval 行没有副作用事实；
 * ③ 触到上限 → `complete=false`（**绝不把"没查完"读成"没有伪造行"**，调用方据此 fail-closed）。
 */
function makeHarness(rows: Array<{ output: unknown }>) {
  const prisma = { toolCall: { findMany: vi.fn(async () => rows) } };
  return { service: new PerformanceProvenanceService(prisma as never), prisma };
}

describe('PerformanceProvenanceService（agent 工具账本 → 绩效行来源）', () => {
  it('枚举：按工具名 + 已落账本 + run 归属查询；倒序有界（take = 上限 + 1 用于触顶探测）', async () => {
    const h = makeHarness([{ output: { performanceId: 'perf-1' } }, { output: { performanceId: 'perf-2' } }]);
    const result = await h.service.agentAuthoredIds('u1');
    expect(h.prisma.toolCall.findMany).toHaveBeenCalledWith({
      where: {
        toolName: AGENT_PERFORMANCE_TOOL,
        output: { not: Prisma.DbNull },
        runStep: { run: { userId: 'u1' } },
      },
      select: { output: true },
      orderBy: { startedAt: 'desc' },
      take: PROVENANCE_SCAN_LIMIT + 1,
    });
    expect([...result.ids].sort()).toEqual(['perf-1', 'perf-2']);
    expect(result).toMatchObject({ complete: true, scanned: 2, rule: 'agent-tool-ledger-exclusion' });
  });

  it('无账本（该用户从未让 agent 写绩效）→ 空集合且完整（外部事实不受影响）', async () => {
    const h = makeHarness([]);
    const result = await h.service.agentAuthoredIds('u1');
    expect(result.ids.size).toBe(0);
    expect(result).toMatchObject({ complete: true, scanned: 0 });
  });

  it('触顶（超过上限）→ complete=false 且只解析上限内的账本（fail-closed 的信号源）', async () => {
    const rows = Array.from({ length: PROVENANCE_SCAN_LIMIT + 1 }, (_, i) => ({ output: { performanceId: `perf-${i}` } }));
    const h = makeHarness(rows);
    const result = await h.service.agentAuthoredIds('u1');
    expect(result.complete).toBe(false);
    expect(result.scanned).toBe(PROVENANCE_SCAN_LIMIT);
    expect(result.ids.size).toBe(PROVENANCE_SCAN_LIMIT);
  });

  it('账本形状不符（别的工具/缺字段）→ 不误伤（绝不把无关账本读成绩效来源）', async () => {
    const h = makeHarness([
      { output: { externalActionId: 'ea-1' } },
      { output: null },
      { output: { performanceId: 'perf-真' } },
    ]);
    const result = await h.service.agentAuthoredIds('u1');
    expect([...result.ids]).toEqual(['perf-真']);
    expect(result.complete).toBe(true);
  });
});
