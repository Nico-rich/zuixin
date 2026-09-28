import { render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { TaskCard, type TaskView } from '@/app/(chat)/chat/components/task-card';
import { jsonResponse } from './helpers';

function task(overrides: Partial<TaskView> = {}): TaskView {
  return { id: 't-1', type: 'image', status: 'pending', progress: null, statusMessage: null, errorMessage: null, ...overrides };
}

/** 第 n 次轮询返回对应状态；超出后保持最后一个 */
function mockTaskPolling(states: TaskView[]) {
  let i = 0;
  const fetchMock = vi.fn(async () => jsonResponse({ data: states[Math.min(i++, states.length - 1)] }));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

describe('TaskCard 任务态展示', () => {
  it('pending：显示“排队中…”并渲染进度条（0%）', async () => {
    mockTaskPolling([task({ status: 'pending' })]);
    render(<TaskCard taskId="t-1" kind="image" />);
    await waitFor(() => expect(document.querySelector('.animate-spin')).toBeTruthy());
    expect(screen.getByText('排队中…')).toBeInTheDocument();
    const bar = document.querySelector('.bg-zinc-400') as HTMLElement;
    expect(bar.style.width).toBe('0%');
  });

  it('processing：进度按后端值渲染（超 100 截断）且文案取 statusMessage', async () => {
    mockTaskPolling([task({ status: 'processing', progress: 140, statusMessage: '渲染中 140%' })]);
    render(<TaskCard taskId="t-1" kind="video" />);
    await screen.findByText('渲染中 140%');
    const bar = document.querySelector('.bg-zinc-400') as HTMLElement;
    expect(bar.style.width).toBe('100%');
    expect(screen.getByText('视频生成')).toBeInTheDocument();
  });

  it('completed：显示完成态、隐藏进度条，并回调 onDone 一次后停止轮询', async () => {
    const onDone = vi.fn();
    const fetchMock = mockTaskPolling([task({ status: 'completed', progress: 100 })]);
    render(<TaskCard taskId="t-1" kind="image" onDone={onDone} />);
    await screen.findByText('✅ 完成');
    await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1));
    expect(onDone.mock.calls[0][0]).toMatchObject({ status: 'completed' });
    expect(document.querySelector('.bg-zinc-400')).toBeNull();
    // 终态不再继续轮询
    await new Promise((r) => setTimeout(r, 60));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('failed：显示后端 errorMessage 与“重新发送”按钮', async () => {
    mockTaskPolling([task({ status: 'failed', errorMessage: '内容审核未通过' })]);
    render(<TaskCard taskId="t-1" kind="image" />);
    await screen.findByText('内容审核未通过');
    expect(screen.getByText('❌ 失败')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /重新发送/ })).toBeInTheDocument();
  });

  it('failed 且无错误信息：回退为“生成失败”', async () => {
    mockTaskPolling([task({ status: 'failed', errorMessage: null })]);
    render(<TaskCard taskId="t-1" kind="image" />);
    await screen.findByText('生成失败');
  });

  it('cancelled：显示“⏹ 已取消”，无进度条与重试按钮', async () => {
    mockTaskPolling([task({ status: 'cancelled' })]);
    render(<TaskCard taskId="t-1" kind="video" />);
    await screen.findByText('⏹ 已取消');
    expect(document.querySelector('.bg-zinc-400')).toBeNull();
    expect(screen.queryByRole('button', { name: /重新发送/ })).not.toBeInTheDocument();
  });

  it('轮询：未终态时每 2s 继续拉取，状态推进后展示最新值', async () => {
    const fetchMock = mockTaskPolling([
      task({ status: 'pending' }),
      task({ status: 'processing', progress: 60, statusMessage: '生成中 60%' }),
    ]);
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      render(<TaskCard taskId="t-1" kind="image" />);
      await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
      await vi.advanceTimersByTimeAsync(2000);
      await vi.waitFor(() => expect(screen.getByText('生成中 60%')).toBeInTheDocument());
      expect(fetchMock).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('单次请求失败不打断轮询：下一轮成功后正常展示', async () => {
    let call = 0;
    const fetchMock = vi.fn(async () => {
      call += 1;
      if (call === 1) throw new TypeError('network down');
      return jsonResponse({ data: task({ status: 'processing', statusMessage: '重试成功' }) });
    });
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      vi.stubGlobal('fetch', fetchMock);
      render(<TaskCard taskId="t-1" kind="image" />);
      await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
      await vi.advanceTimersByTimeAsync(2000);
      await vi.waitFor(() => expect(screen.getByText('重试成功')).toBeInTheDocument());
    } finally {
      vi.useRealTimers();
    }
  });
});

/**
 * M10-P13（审计 ARCH-07）：TaskCard 消费 task 通道 SSE 事件。
 * 契约：SSE 是**信号**（即时上屏 + 触发一次 DB 对账），DB 是**事实源**；
 * SSE 健康期不再按 2s 反复拉取，SSE 静默（断流/降级）时轮询兜底自动恢复。
 */
describe('TaskCard SSE 任务事件（ARCH-07）', () => {
  const progressEvent = (taskId: string, progress: number, message?: string) =>
    ({ type: 'task.progress' as const, taskId, progress, ...(message ? { message } : {}) });

  it('task.progress 事件：进度与文案立即上屏（两次渲染间的即时对账），SSE 健康期不再按 2s 拉取', async () => {
    const fetchMock = mockTaskPolling([task({ status: 'processing', progress: 10, statusMessage: '启动中' })]);
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const { rerender } = render(<TaskCard taskId="t-1" kind="image" />);
      await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1)); // 挂载即对账一次
      rerender(<TaskCard taskId="t-1" kind="image" event={progressEvent('t-1', 55, '生成中 55%')} />);
      await screen.findByText('生成中 55%'); // 无需等下一轮轮询（2s）
      await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2)); // 事件触发的即时 DB 对账
      expect((document.querySelector('.bg-zinc-400') as HTMLElement).style.width).toBe('55%');

      await vi.advanceTimersByTimeAsync(6000); // 3 个轮询周期内 SSE 一直新鲜
      expect(fetchMock).toHaveBeenCalledTimes(2); // 轮询降级为待命（无网络往返）
    } finally {
      vi.useRealTimers();
    }
  });

  it('task.completed 事件：立即对账 DB → 显示完成并回调 onDone 一次，之后停止轮询', async () => {
    const onDone = vi.fn();
    const fetchMock = mockTaskPolling([
      task({ status: 'processing', progress: 90 }),
      task({ status: 'completed', progress: 100 }),
    ]);
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const { rerender } = render(<TaskCard taskId="t-1" kind="image" onDone={onDone} />);
      await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
      rerender(<TaskCard taskId="t-1" kind="image" onDone={onDone} event={{ type: 'task.completed', taskId: 't-1', progress: 100 }} />);
      await screen.findByText('✅ 完成');
      await vi.waitFor(() => expect(onDone).toHaveBeenCalledTimes(1));
      await vi.advanceTimersByTimeAsync(5000);
      expect(onDone).toHaveBeenCalledTimes(1); // 终态不重复回调
      expect(fetchMock).toHaveBeenCalledTimes(2); // 终态后不再轮询
      expect(document.querySelector('.bg-zinc-400')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('失败经 task.progress（progress=100/message=失败）上报 → DB 对账后显示失败态（SSE 不臆断终态）', async () => {
    const fetchMock = mockTaskPolling([
      task({ status: 'processing', progress: 50 }),
      task({ status: 'failed', errorMessage: '内容审核未通过' }),
    ]);
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const { rerender } = render(<TaskCard taskId="t-1" kind="image" />);
      await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
      rerender(<TaskCard taskId="t-1" kind="image" event={progressEvent('t-1', 100, '失败')} />);
      await screen.findByText('内容审核未通过'); // 失败文案来自 DB 行（不以事件文案臆断）
      expect(screen.getByText('❌ 失败')).toBeInTheDocument();
      expect(fetchMock).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('SSE 静默（事件中断 >10s）→ 轮询兜底自动恢复（每 2s 拉取）', async () => {
    const fetchMock = mockTaskPolling([task({ status: 'processing', progress: 20, statusMessage: '生成中' })]);
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      render(<TaskCard taskId="t-1" kind="image" event={progressEvent('t-1', 20, '生成中')} />);
      await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1)); // 挂载 + 事件即时对账
      await vi.advanceTimersByTimeAsync(6000);
      const duringFresh = fetchMock.mock.calls.length;
      await vi.advanceTimersByTimeAsync(6000); // 越过新鲜度窗口（10s）
      expect(fetchMock.mock.calls.length).toBeGreaterThan(duringFresh);
    } finally {
      vi.useRealTimers();
    }
  });

  it('非本卡片 taskId 的事件被忽略（不改变展示，也不触发对账）', async () => {
    const fetchMock = mockTaskPolling([task({ status: 'pending' })]);
    render(<TaskCard taskId="t-1" kind="image" event={progressEvent('t-9', 88, '别人的任务')} />);
    await screen.findByText('排队中…');
    expect(screen.queryByText('别人的任务')).not.toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
