import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { RunTimeline } from '@/app/(chat)/chat/components/run-timeline';
import type { RunTimeline as RunTimelineData, TimelineItem } from '@/app/(chat)/chat/components/types';
import { jsonResponse } from './helpers';

function item(overrides: Partial<TimelineItem> = {}): TimelineItem {
  return { id: 'i-1', type: 'run.started', status: 'success', timestamp: '2026-09-28T00:00:00.000Z', title: '开始执行', ...overrides };
}

function timeline(overrides: Partial<RunTimelineData> = {}): RunTimelineData {
  return {
    runId: 'run-1', agentId: 'agent-1', agentName: '图片助手', agentVersion: 1,
    status: 'completed', startedAt: '2026-09-28T00:00:00.000Z', completedAt: '2026-09-28T00:00:05.000Z',
    items: [item()], usage: null, ...overrides,
  };
}

function mockTimeline(payload: RunTimelineData | null, status = 200) {
  const fetchMock = vi.fn(async () => (payload ? jsonResponse({ data: payload }) : jsonResponse({ error: { code: 'NOT_FOUND', message: '不存在' } }, status)));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

const expand = () => fireEvent.click(screen.getByRole('button', { name: /执行详情/ }));

describe('RunTimeline 执行详情面板', () => {
  it('默认折叠：不请求接口、不渲染步骤', () => {
    const fetchMock = mockTimeline(timeline());
    render(<RunTimeline runId="run-1" />);
    expect(screen.getByRole('button', { name: /执行详情/ })).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.queryByText('开始执行')).not.toBeInTheDocument();
  });

  it('展开按 runId 拉取时间线并渲染步骤（含耗时格式化与摘要）', async () => {
    const fetchMock = mockTimeline(timeline({
      items: [
        item({ id: 'i-1', type: 'run.started', title: '开始执行' }),
        item({ id: 'i-2', type: 'tool.completed', title: 'image.generate', summary: '已生成 1 张', durationMs: 1234 }),
        item({ id: 'i-3', type: 'task.completed', title: '图片任务完成', durationMs: 250 }),
      ],
    }));
    render(<RunTimeline runId="run-42" />);
    expand();
    expect(await screen.findByText('image.generate')).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith('/api/v1/agent-runs/run-42/timeline', expect.objectContaining({ credentials: 'include' }));
    expect(screen.getByText('已生成 1 张')).toBeInTheDocument();
    expect(screen.getByText('1.2s')).toBeInTheDocument();  // 1234ms → 秒
    expect(screen.getByText('250ms')).toBeInTheDocument(); // <1s 保留毫秒
    expect(screen.getByText('开始执行')).toBeInTheDocument();
  });

  it('加载完成后标题栏显示步骤数与 run 状态，再次点击可折叠', async () => {
    mockTimeline(timeline({ status: 'failed', items: [item({ id: 'i-1' }), item({ id: 'i-2' })] }));
    render(<RunTimeline runId="run-1" />);
    expand();
    expect(await screen.findByText('2 项 · failed')).toBeInTheDocument();
    expand(); // 收起
    await waitFor(() => expect(screen.queryByText('开始执行')).not.toBeInTheDocument());
  });

  it('失败步骤标题使用红色样式（状态 → 视觉映射）', async () => {
    mockTimeline(timeline({ items: [item({ id: 'i-1', type: 'run.failed', status: 'failed', title: '执行失败' })] }));
    render(<RunTimeline runId="run-1" />);
    expand();
    expect(await screen.findByText('执行失败')).toHaveClass('text-red-400');
  });

  // M10-P13（审计 M9-18）：api 的 TimelineItemType 含 run.waiting 与 approval.*（timeline.types.ts），
  // web 的 ICONS 表原未覆盖 → 一律回退 '•'（"等待"与"等审批"看不出区别）。本用例锁定补齐后的映射。
  it('run.waiting / approval.* 有专属图标（M9-18 已补齐）', async () => {
    mockTimeline(timeline({
      items: [
        item({ id: 'i-1', type: 'approval.requested', status: 'running', title: '等待审批：send_email' }),
        item({ id: 'i-2', type: 'approval.approved', title: '审批通过' }),
        item({ id: 'i-3', type: 'approval.rejected', title: '审批驳回' }),
        item({ id: 'i-4', type: 'run.waiting', title: '等待生成任务' }),
        item({ id: 'i-5', type: 'run.started', title: '开始执行' }),
      ],
    }));
    render(<RunTimeline runId="run-1" />);
    expand();
    await screen.findByText('审批驳回');
    expect(screen.getByText('🙋')).toBeInTheDocument(); // requested
    expect(screen.getByText('👍')).toBeInTheDocument(); // approved
    expect(screen.getByText('👎')).toBeInTheDocument(); // rejected
    expect(screen.getByText('⏸')).toBeInTheDocument();  // run.waiting
    expect(screen.getByText('▶')).toBeInTheDocument();  // run.started
    expect(screen.queryByText('•')).not.toBeInTheDocument(); // 覆盖到时序项后不再有兜底图标
  });

  it('approval.expired / approval.cancelled 同样有图标，未登记类型才回退 "•"', async () => {
    mockTimeline(timeline({
      items: [
        item({ id: 'i-1', type: 'approval.expired', title: '审批超时' }),
        item({ id: 'i-2', type: 'approval.cancelled', title: '审批取消' }),
        item({ id: 'i-3', type: 'future.unknown', title: '未来事件' }),
      ],
    }));
    render(<RunTimeline runId="run-1" />);
    expand();
    await screen.findByText('审批超时');
    expect(screen.getByText('⌛')).toBeInTheDocument();
    expect(screen.getByText('🚫')).toBeInTheDocument();
    expect(screen.getAllByText('•')).toHaveLength(1);
  });

  it('请求失败：展示“时间线加载失败”，不留空白面板，也不缓存错误结果', async () => {
    const fetchMock = mockTimeline(null, 500);
    render(<RunTimeline runId="run-1" />);
    expand();
    expect(await screen.findByText('时间线加载失败')).toBeInTheDocument();
    // data 为空 → 标题栏不显示统计；收起后重新展开会重试拉取（失败不缓存）
    expect(screen.queryByText(/项 · /)).not.toBeInTheDocument();
    expand(); // 收起
    expand(); // 重新展开
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
  });
});

/* ------------------------------------------------------------------ *
 * M13-W10：usage 渲染
 * 后端 RunUsageAggregate（usage.service.ts）此前被 web 整体丢弃（types.ts 声明了 RunTimelineUsage
 * 却无人消费）→ 用户看不到 token/成本/媒体用量。这里锁定「如实呈现」的三条口径：
 *  - 用量为 0 的维度照样显示（0 与「没有该维度」是两件事，不用空白冒充）；
 *  - 小额成本按量级保留有效数字（0.000048 不得被抹成 $0.00）；
 *  - failedCalls > 0 显式告警（失败调用已计入用量事实表）。
 * ------------------------------------------------------------------ */

const USAGE = {
  runId: 'run-1', durationMs: 12_345, totalTokens: 1_801, inputTokens: 1_234, outputTokens: 567,
  llmCost: 0.123456, imageCost: 0.05, videoCost: 0, totalCost: 0.173456,
  llmRounds: 3, imageCount: 2, videoSeconds: 4, failedCalls: 1,
  byKind: [{ kind: 'llm', count: 3, cost: 0.123456, tokens: 1_801 }],
};

describe('RunTimeline：usage（token/成本/媒体用量）如实呈现', () => {
  const usagePanel = () => screen.getByTestId('run-usage');

  it('usage 存在时渲染耗时/tokens/成本/媒体计数与逐 kind 明细', async () => {
    mockTimeline(timeline({ usage: USAGE }));
    render(<RunTimeline runId="run-1" />);
    expand();
    await screen.findByText('开始执行');
    const panel = usagePanel();
    expect(within(panel).getByText('12.3s')).toBeInTheDocument();
    expect(within(panel).getByText('1,234 入 + 567 出 = 1,801')).toBeInTheDocument();
    expect(within(panel).getByText('$0.1235 LLM + $0.0500 图片 + $0 视频 = $0.1735')).toBeInTheDocument();
    expect(within(panel).getByText('2 张')).toBeInTheDocument();
    expect(within(panel).getByText('4 秒')).toBeInTheDocument();
    expect(within(panel).getByText('llm')).toBeInTheDocument();
    expect(within(panel).getByText(/3 次 · 1,801 tokens · \$0\.1235/)).toBeInTheDocument();
    // failedCalls > 0 → 告警配色（不静默）
    expect(within(panel).getByText('失败调用').nextElementSibling).toHaveTextContent('1');
    expect(within(panel).getByText('失败调用').nextElementSibling).toHaveClass('text-amber-300');
  });

  it('usage=null（旧 run 无用量事实）时不渲染用量面板', async () => {
    mockTimeline(timeline({ usage: null }));
    render(<RunTimeline runId="run-1" />);
    expand();
    await screen.findByText('开始执行');
    expect(screen.queryByTestId('run-usage')).not.toBeInTheDocument();
  });

  it('零用量维度照样显示 0；小额成本保留有效数字、不做预算判定', async () => {
    mockTimeline(timeline({
      usage: {
        ...USAGE, durationMs: 0, totalTokens: 0, inputTokens: 0, outputTokens: 0,
        llmCost: 0, imageCost: 0, videoCost: 0.000048, totalCost: 0.000048,
        llmRounds: 0, imageCount: 0, videoSeconds: 0, failedCalls: 0, byKind: [],
      },
    }));
    render(<RunTimeline runId="run-1" />);
    expand();
    await screen.findByText('开始执行');
    const panel = usagePanel();
    expect(within(panel).getByText('0 入 + 0 出 = 0')).toBeInTheDocument();
    expect(within(panel).getByText('0 张')).toBeInTheDocument();
    expect(within(panel).getByText('0 秒')).toBeInTheDocument();
    // 0.000048 若被抹成 $0.00 就等于伪造了「没有成本」
    expect(within(panel).getByText('$0 LLM + $0 图片 + $0.000048 视频 = $0.000048')).toBeInTheDocument();
    expect(within(panel).getByText('失败调用').nextElementSibling).toHaveClass('text-zinc-300');
  });
});
