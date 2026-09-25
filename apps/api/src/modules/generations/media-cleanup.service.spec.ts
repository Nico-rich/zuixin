import { describe, it, expect, vi } from 'vitest';
import { MediaCleanupService } from './media-cleanup.service';

const NOW = Date.now();
const staleStartedAt = new Date(NOW - 10 * 60_000); // 10 分钟前
const freshStartedAt = new Date(NOW - 30_000);      // 30 秒前

function makeService(opts: { staleCount?: number; freshCount?: number; timeoutMs?: number; rows?: Array<{ id: string; startedAt: Date; agentId: string; userId: string }> } = {}) {
  const prisma = {
    systemSetting: {
      findUnique: vi.fn().mockResolvedValue({ key: 'limits', value: { agentRunTimeoutMs: opts.timeoutMs ?? 120000 } }),
    },
    generationTask: { findMany: vi.fn().mockResolvedValue([]), updateMany: vi.fn() },
    agentRun: {
      findMany: vi.fn().mockResolvedValue(opts.rows ?? [
        { id: 'run-stale', startedAt: staleStartedAt, agentId: 'a1', userId: 'u1' },
        { id: 'run-fresh', startedAt: freshStartedAt, agentId: 'a1', userId: 'u1' },
      ]),
      updateMany: vi.fn().mockImplementation(async ({ where }: { where: { id: string } }) => ({
        count: where.id === 'run-stale' ? (opts.staleCount ?? 1) : (opts.freshCount ?? 0),
      })),
    },
  };
  const usage = { recordMediaUsage: vi.fn().mockResolvedValue(undefined) };
  const quota = { release: vi.fn().mockResolvedValue(undefined) };
  const resume = { onTaskTerminal: vi.fn().mockResolvedValue(undefined) };
  const svc = new MediaCleanupService(prisma as never, usage as never, quota as never, resume as never);
  return { svc, prisma, resume };
}

describe('MediaCleanupService.sweepAgentRuns（M4 Audit MUST-1）', () => {
  it('stale running run → timeout（条件更新 where status=running）', async () => {
    const { svc, prisma } = makeService();
    const swept = await svc.sweepAgentRuns();
    expect(swept).toBe(1); // 只有 stale 被清扫
    expect(prisma.agentRun.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'run-stale', status: 'running' },
      data: expect.objectContaining({ status: 'timeout', errorCode: 'AGENT_RUN_TIMEOUT' }),
    }));
  });

  it('正常执行中的 run（未超时）不被触碰', async () => {
    const { svc, prisma } = makeService();
    await svc.sweepAgentRuns();
    expect(prisma.agentRun.updateMany).not.toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ id: 'run-fresh' }) }));
  });

  it('已终态 run 不受影响（查询只取 running）', async () => {
    const { svc, prisma } = makeService();
    await svc.sweepAgentRuns();
    expect(prisma.agentRun.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ status: 'running' }) }));
  });

  it('M6-A2：只扫同步 run（workerId IS NULL）——异步 run 由 lease 恢复链路接管，不被 120s 误杀', async () => {
    const { svc, prisma } = makeService();
    await svc.sweepAgentRuns();
    expect(prisma.agentRun.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { status: 'running', workerId: null } }));
  });

  it('并发清扫：条件更新竞态（count=0）→ 不重复计入', async () => {
    const { svc } = makeService({ staleCount: 0 }); // 另一 worker 已抢先清扫
    const swept = await svc.sweepAgentRuns();
    expect(swept).toBe(0);
  });

  it('幂等：第一次清扫后第二次扫不到 running（结果一致）', async () => {
    const { svc, prisma } = makeService({ rows: [{ id: 'run-stale', startedAt: staleStartedAt, agentId: 'a1', userId: 'u1' }] });
    expect(await svc.sweepAgentRuns()).toBe(1);
    prisma.agentRun.findMany.mockResolvedValue([]); // 已终态 → 第二次无 running
    expect(await svc.sweepAgentRuns()).toBe(0);
  });

  it('阈值来自配置（非写死）：agentRunTimeoutMs=10s 时 30s 前的 run 会被清扫', async () => {
    const { svc } = makeService({
      timeoutMs: 10_000, // 阈值 10s → 30s 前的 fresh run 视为 stale
      rows: [{ id: 'run-fresh', startedAt: freshStartedAt, agentId: 'a1', userId: 'u1' }],
      freshCount: 1,
    });
    expect(await svc.sweepAgentRuns()).toBe(1);
  });
});
