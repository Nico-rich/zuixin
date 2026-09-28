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
