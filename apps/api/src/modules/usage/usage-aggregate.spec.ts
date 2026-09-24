import { describe, it, expect, vi } from 'vitest';
import { aggregateRunUsage } from './usage.service';

function makePrisma(rows: Array<Record<string, unknown>>) {
  return {
    agentRun: {
      findFirst: vi.fn().mockResolvedValue({
        id: 'run-1', userId: 'u1',
        startedAt: new Date('2026-09-24T00:00:00Z'), completedAt: new Date('2026-09-24T00:01:30Z'),
      }),
    },
    usageRecord: { findMany: vi.fn().mockResolvedValue(rows) },
  };
}

describe('aggregateRunUsage（执行成本投影聚合）', () => {
  it('聚合 LLM 多回合 + image/video：tokens/成本/回合数全部计入', async () => {
    const prisma = makePrisma([
      { kind: 'llm_chat', inputTokens: 100, outputTokens: 50, estimatedCost: 0.01, status: 'success', imageCount: 0, videoSeconds: 0 },
      { kind: 'llm_chat', inputTokens: 200, outputTokens: 100, estimatedCost: 0.02, status: 'success', imageCount: 0, videoSeconds: 0 },
      { kind: 'llm_chat', inputTokens: 300, outputTokens: 0, estimatedCost: 0.03, status: 'failed', imageCount: 0, videoSeconds: 0 },
      { kind: 'image', inputTokens: 0, outputTokens: 0, estimatedCost: 0.04, status: 'success', imageCount: 2, videoSeconds: 0 },
      { kind: 'video', inputTokens: 0, outputTokens: 0, estimatedCost: 0.05, status: 'success', imageCount: 0, videoSeconds: 10 },
    ]);
    const agg = await aggregateRunUsage(prisma as never, 'u1', 'run-1');
    expect(agg.llmRounds).toBe(3);                    // 三轮 LLM 全部记录（含失败回合）
    expect(agg.totalTokens).toBe(750);
    expect(agg.inputTokens).toBe(600);
    expect(agg.outputTokens).toBe(150);
    expect(agg.imageCount).toBe(2);
    expect(agg.videoSeconds).toBe(10);
    expect(agg.totalCost).toBeCloseTo(0.15, 5);
    expect(agg.failedCalls).toBe(1);
    expect(agg.durationMs).toBe(90_000);
    expect(agg.byKind.length).toBe(3);
  });

  it('越权：非本人 run → NOT_FOUND', async () => {
    const prisma = makePrisma([]);
    prisma.agentRun.findFirst.mockResolvedValue(null);
    await expect(aggregateRunUsage(prisma as never, 'u1', 'run-other')).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('空用量 → 全零聚合（合法）', async () => {
    const prisma = makePrisma([]);
    const agg = await aggregateRunUsage(prisma as never, 'u1', 'run-1');
    expect(agg.totalCost).toBe(0);
    expect(agg.llmRounds).toBe(0);
    expect(agg.byKind).toEqual([]);
  });
});
