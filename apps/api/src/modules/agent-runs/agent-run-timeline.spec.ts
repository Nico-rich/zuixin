import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AgentRunTimelineService } from './agent-run-timeline.service';
import { aggregateRunUsage } from '../usage/usage.service';
import { RunUsageAggregate } from '../usage/usage.service';

vi.mock('../usage/usage.service', () => ({ aggregateRunUsage: vi.fn() }));

const t = (iso: string) => new Date(iso);

/** 完整 run 夹具：2 toolCall（1 成功 1 失败）+ final + 3 task（completed/failed/running）+ artifact */
function makeRunFixture(status: string) {
  return {
    id: 'run-1',
    status,
    startedAt: t('2026-09-24T00:00:00Z'),
    completedAt: status === 'completed' || status === 'failed' || status === 'cancelled' || status === 'timeout'
      ? t('2026-09-24T00:01:00Z') : null,
    agent: { id: 'agent-1', slug: 'chat', name: '通用助手' },
    agentVersion: { id: 'av-1', version: 3, status: 'published' },
    steps: [
      {
        id: 'step-1', stepIndex: 0, type: 'tool_call', status: 'completed',
        startedAt: t('2026-09-24T00:00:01Z'), completedAt: t('2026-09-24T00:00:20Z'),
        toolCalls: [
          {
            id: 'tc-1', toolName: 'artifact.create', status: 'completed',
            startedAt: t('2026-09-24T00:00:02Z'), completedAt: t('2026-09-24T00:00:10Z'),
            durationMs: 8000,
            input: { apiKey: 'sk-DO_NOT_LEAK' },
            output: { title: '营销方案', secret: 'DO_NOT_LEAK' },
          },
          {
            id: 'tc-2', toolName: 'knowledge.search', status: 'failed',
            startedAt: t('2026-09-24T00:00:11Z'), completedAt: t('2026-09-24T00:00:19Z'),
            durationMs: 8000,
            input: { query: '黑金配色' },
            output: { count: 3, raw: 'DO_NOT_LEAK' },
          },
        ],
      },
      {
        id: 'step-2', stepIndex: 1, type: 'final', status: 'completed',
        startedAt: t('2026-09-24T00:00:20Z'), completedAt: t('2026-09-24T00:00:30Z'),
        output: { finalStatus: 'completed' }, toolCalls: [],
      },
    ],
    tasks: [
      {
        id: 'task-1', type: 'image', status: 'completed', progress: 100, statusMessage: '生成成功',
        startedAt: t('2026-09-24T00:00:03Z'), completedAt: t('2026-09-24T00:00:12Z'),
        createdAt: t('2026-09-24T00:00:02Z'), model: { name: 'gpt-image-1' },
      },
      {
        id: 'task-2', type: 'video', status: 'failed', progress: 40, statusMessage: '生成失败',
        startedAt: t('2026-09-24T00:00:05Z'), completedAt: t('2026-09-24T00:00:15Z'),
        createdAt: t('2026-09-24T00:00:04Z'), model: null,
      },
      {
        id: 'task-3', type: 'image', status: 'running', progress: null, statusMessage: null,
        startedAt: null, completedAt: null,
        createdAt: t('2026-09-24T00:00:06Z'), model: null,
      },
    ],
    artifacts: [
      { id: 'art-1', type: 'creative_brief', title: '营销方案', summary: '方案摘要', createdAt: t('2026-09-24T00:00:13Z') },
    ],
    approvals: [],
  };
}

const usageFixture: RunUsageAggregate = {
  runId: 'run-1', durationMs: 60_000, totalTokens: 750, inputTokens: 600, outputTokens: 150,
  llmCost: 0.05, imageCost: 0.04, videoCost: 0.06, totalCost: 0.15,
  llmRounds: 3, imageCount: 2, videoSeconds: 10, failedCalls: 1,
  byKind: [{ kind: 'llm_chat', count: 3, cost: 0.05, tokens: 750 }],
};

describe('AgentRunTimelineService（只读投影）', () => {
  let prisma: { agentRun: { findFirst: ReturnType<typeof vi.fn> } };
  let service: AgentRunTimelineService;

  beforeEach(() => {
    vi.clearAllMocks();
    prisma = { agentRun: { findFirst: vi.fn().mockResolvedValue(makeRunFixture('completed')) } };
    service = new AgentRunTimelineService(prisma as never);
    vi.mocked(aggregateRunUsage).mockResolvedValue(usageFixture);
  });

  it('completed run：run 边界 + step/tool + task + artifact + usage 全源合并，排序确定', async () => {
    const tl = await service.build('u1', 'run-1');

    expect(tl.runId).toBe('run-1');
    expect(tl.agentName).toBe('通用助手');
    expect(tl.agentVersion).toBe(3);
    expect(tl.status).toBe('completed');

    const types = tl.items.map((i) => i.type);
    expect(types).toContain('run.started');
    expect(types).toContain('step.tool_call');
    expect(types).toContain('tool.started');
    expect(types).toContain('tool.completed');
    expect(types).toContain('tool.failed');
    expect(types).toContain('step.final');
    expect(types).toContain('task.completed');
    expect(types).toContain('task.failed');
    expect(types).toContain('task.created');
    expect(types).toContain('artifact.created');
    expect(types).toContain('run.completed');
    expect(types).toContain('usage.summary');

    // 排序：run.started 第一，usage.summary 最后；run.completed 在 usage 之前
    expect(types[0]).toBe('run.started');
    expect(types[types.length - 1]).toBe('usage.summary');
    expect(types.indexOf('run.completed')).toBeLessThan(types.indexOf('usage.summary'));

    // 失败工具映射为 tool.failed/failed
    const failedTool = tl.items.find((i) => i.id === 'tool-end-tc-2')!;
    expect(failedTool.type).toBe('tool.failed');
    expect(failedTool.status).toBe('failed');
    expect(failedTool.summary).toBe('找到 3 条相关片段'); // 安全摘要，非 raw output

    // 运行中 task → task.created/running，取 createdAt 时间戳
    const runningTask = tl.items.find((i) => i.id === 'task-task-3')!;
    expect(runningTask.type).toBe('task.created');
    expect(runningTask.status).toBe('running');

    // final step 映射
    const finalItem = tl.items.find((i) => i.id === 'step-step-2')!;
    expect(finalItem.type).toBe('step.final');
    expect(finalItem.status).toBe('success');
    expect(finalItem.summary).toBe('已完成');

    // 用量并入
    expect(tl.usage).toEqual(usageFixture);
    const usageItem = tl.items.find((i) => i.type === 'usage.summary')!;
    expect(usageItem.metadata?.totalTokens).toBe(750);
  });

  it('敏感数据零外泄：raw input/output/prompt 不进任何 item（含 metadata）', async () => {
    const tl = await service.build('u1', 'run-1');
    const serialized = JSON.stringify(tl.items);
    expect(serialized).not.toContain('DO_NOT_LEAK');
    expect(serialized).not.toContain('sk-DO_NOT_LEAK');
    expect(serialized).not.toContain('apiKey');
    // 无 raw 字段直出
    for (const item of tl.items) {
      expect(item).not.toHaveProperty('input');
      expect(item).not.toHaveProperty('output');
    }
  });

  it('终态映射：failed/cancelled/timeout 绝不伪装 completed', async () => {
    for (const status of ['failed', 'cancelled', 'timeout'] as const) {
      prisma.agentRun.findFirst.mockResolvedValue(makeRunFixture(status));
      const tl = await service.build('u1', 'run-1');
      const types = tl.items.map((i) => i.type);
      expect(types).toContain(`run.${status}`);
      expect(types).not.toContain('run.completed');
    }
  });

  it('running run：无终态项，不产出 run.completed/run.failed', async () => {
    prisma.agentRun.findFirst.mockResolvedValue(makeRunFixture('running'));
    const tl = await service.build('u1', 'run-1');
    const types = tl.items.map((i) => i.type);
    expect(types.some((x) => x.startsWith('run.completed') || x === 'run.failed')).toBe(false);
    expect(tl.completedAt).toBeNull();
  });

  it('用量聚合失败 → usage:null 且无 usage.summary 项（降级不拖垮 Timeline）', async () => {
    vi.mocked(aggregateRunUsage).mockRejectedValue(new Error('db down'));
    const tl = await service.build('u1', 'run-1');
    expect(tl.usage).toBeNull();
    expect(tl.items.some((i) => i.type === 'usage.summary')).toBe(false);
  });

  it('run 不存在/越权 → NOT_FOUND', async () => {
    prisma.agentRun.findFirst.mockResolvedValue(null);
    await expect(service.build('u1', 'run-other')).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('同 timestamp 项按类型权重排序（tool 在 task 前），确定性输出', async () => {
    const fixture = makeRunFixture('completed');
    // tool-end 与 task 完成时间对齐到同一时刻
    fixture.steps[0].toolCalls[0].completedAt = t('2026-09-24T00:00:12Z');
    fixture.tasks[0].completedAt = t('2026-09-24T00:00:12Z');
    prisma.agentRun.findFirst.mockResolvedValue(fixture);
    const tl = await service.build('u1', 'run-1');
    const idxTool = tl.items.findIndex((i) => i.id === 'tool-end-tc-1');
    const idxTask = tl.items.findIndex((i) => i.id === 'task-task-1');
    expect(idxTool).toBeGreaterThan(-1);
    expect(idxTask).toBeGreaterThan(-1);
    expect(idxTool).toBeLessThan(idxTask);
  });
});
