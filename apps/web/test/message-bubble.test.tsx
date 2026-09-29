import { fireEvent, render, screen, act } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MessageBubble } from '@/app/(chat)/chat/components/message-bubble';
import type { ChatMessage } from '@/app/(chat)/chat/components/types';

function assistant(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return { id: 'm-1', role: 'assistant', content: '', status: 'streaming', ...overrides };
}

const noop = () => undefined;

describe('MessageBubble', () => {
  it('用户消息原样展示文本（不进 Markdown 渲染，也无重试入口）', () => {
    render(<MessageBubble message={{ id: 'u1', role: 'user', content: '# 不是标题', status: 'completed' }} streaming={false} onRetry={noop} />);
    expect(screen.getByText('# 不是标题')).toBeInTheDocument();
    expect(screen.queryByRole('heading')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /重试/ })).not.toBeInTheDocument();
  });

  it('assistant 空内容 + streaming：显示“正在生成…”与流式光标', () => {
    render(<MessageBubble message={assistant()} streaming onRetry={noop} />);
    expect(screen.getByText('正在生成…')).toBeInTheDocument();
    expect(screen.getByText('▍')).toBeInTheDocument();
  });

  it('assistant 有内容时渲染 Markdown（标题/列表/代码块）且无占位文案', () => {
    render(<MessageBubble message={assistant({ content: '## 结论\n\n- 第一点\n- 第二点', status: 'completed' })} streaming={false} onRetry={noop} />);
    expect(screen.getByRole('heading', { level: 2, name: '结论' })).toBeInTheDocument();
    expect(screen.getAllByRole('listitem')).toHaveLength(2);
    expect(screen.queryByText('正在生成…')).not.toBeInTheDocument();
  });

  it('M11-P13：代码块渲染源码文本（高亮后的子节点不得退化成 [object Object]），复制内容为源码', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });
    render(<MessageBubble message={assistant({ content: '```js\nconst secret = 1;\n```', status: 'completed' })} streaming={false} onRetry={noop} />);
    const code = document.querySelector('pre code')!;
    expect(code.textContent).toContain('const secret = 1;');
    expect(code.textContent).not.toContain('[object Object]');
    expect(screen.getByText('js')).toBeInTheDocument(); // 语言标签
    // 气泡自带复制入口（标题“复制”，无文案）与代码块复制按钮同名，按文案取代码块那个
    const codeCopy = screen.getAllByRole('button', { name: /复制/ }).find((b) => b.textContent?.includes('复制'))!;
    await act(async () => {
      fireEvent.click(codeCopy);
      await Promise.resolve();
    });
    expect(writeText).toHaveBeenCalledWith('const secret = 1;');
  });

  it('failed：展示失败文案与错误码，点击“重试”回调一次', () => {
    const onRetry = vi.fn();
    render(<MessageBubble message={assistant({ content: '半截', status: 'failed', errorCode: 'PROVIDER_TIMEOUT' })} streaming={false} onRetry={onRetry} />);
    expect(screen.getByText('生成失败（PROVIDER_TIMEOUT）')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /重试/ }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('failed 且无错误码：仅显示“生成失败”', () => {
    render(<MessageBubble message={assistant({ content: 'x', status: 'failed', errorCode: null })} streaming={false} onRetry={noop} />);
    expect(screen.getByText('生成失败')).toBeInTheDocument();
  });

  it('cancelled：显示“已停止”，不显示失败块', () => {
    render(<MessageBubble message={assistant({ content: '写了一半', status: 'cancelled' })} streaming={false} onRetry={noop} />);
    expect(screen.getByText('已停止')).toBeInTheDocument();
    expect(screen.queryByText(/生成失败/)).not.toBeInTheDocument();
  });

  it('图片/文件附件按类型渲染：图片走 img，文件给下载链接', () => {
    render(<MessageBubble message={assistant({
      content: '产物如下', status: 'completed',
      attachments: [
        { id: 'a-1', kind: 'generated_image', type: 'image', mimeType: 'image/png', originalName: 'demo.png' },
        { id: 'a-2', kind: 'generated_file', type: 'file', mimeType: 'application/pdf', originalName: 'report.pdf' },
      ],
    })} streaming={false} onRetry={noop} />);
    const img = screen.getByRole('img', { name: 'demo.png' });
    expect(img).toHaveAttribute('src', '/api/v1/attachments/a-1');
    expect(screen.getByRole('link', { name: /report\.pdf/ })).toHaveAttribute('href', '/api/v1/attachments/a-2');
  });

  it('复制按钮把内容写入剪贴板并切换为已复制态', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });
    render(<MessageBubble message={assistant({ content: '复制我', status: 'completed' })} streaming={false} onRetry={noop} />);
    await act(async () => {
      fireEvent.click(screen.getByTitle('复制'));
      await Promise.resolve();
    });
    expect(writeText).toHaveBeenCalledWith('复制我');
    expect(screen.getByTitle('复制').querySelector('svg')).toHaveClass('lucide-check');
  });
});

/**
 * M13-W10：本人 user 消息的编辑/删除入口。
 * 授权口径与 api 同源（chat.controller PATCH/DELETE messages/:id 仅本人的 user 消息）——
 * 组件层只负责「有入口」与「样式状态」，越权由服务端裁决（403/404 由调用方如实呈现）。
 */
describe('MessageBubble：user 消息操作入口（M13-W10）', () => {
  const userMsg = (overrides: Partial<ChatMessage> = {}): ChatMessage =>
    ({ id: 'u-1', role: 'user', content: '原始问题', status: 'completed', ...overrides });

  it('未传回调 = 只读：不渲染编辑/删除按钮', () => {
    render(<MessageBubble message={userMsg()} streaming={false} onRetry={noop} />);
    expect(screen.queryByTitle('编辑消息')).not.toBeInTheDocument();
    expect(screen.queryByTitle('删除消息')).not.toBeInTheDocument();
  });

  it('传回调时渲染编辑/删除（默认悬浮显形：opacity-0 + 命名 group 的 hover 态）', () => {
    render(<MessageBubble message={userMsg()} streaming={false} onRetry={noop} onEdit={noop} onDelete={noop} />);
    const row = screen.getByTitle('编辑消息').parentElement!;
    expect(row.className).toContain('opacity-0');
    expect(row.className).toContain('group-hover/user:opacity-100');
    // 命名 group：裸 group 会被 chat e2e 的 div.group 助手气泡选择器命中
    expect(document.querySelector('div.group')).not.toBeInTheDocument();
    expect(document.querySelector('div.group\\/user')).toBeInTheDocument();
  });

  it('actionsPinned（右键唤出）时操作行常显', () => {
    render(<MessageBubble message={userMsg()} streaming={false} onRetry={noop} onEdit={noop} actionsPinned />);
    const row = screen.getByTitle('编辑消息').parentElement!;
    expect(row.className).toContain('opacity-100');
    expect(row.className).not.toContain('opacity-0');
  });

  it('点击编辑/删除各回调一次', () => {
    const onEdit = vi.fn();
    const onDelete = vi.fn();
    render(<MessageBubble message={userMsg()} streaming={false} onRetry={noop} onEdit={onEdit} onDelete={onDelete} />);
    fireEvent.click(screen.getByTitle('编辑消息'));
    fireEvent.click(screen.getByTitle('删除消息'));
    expect(onEdit).toHaveBeenCalledTimes(1);
    expect(onDelete).toHaveBeenCalledTimes(1);
  });

  it('editedAt 存在时渲染「已编辑」标记（缺失/null = 未编辑过）', () => {
    const { rerender } = render(<MessageBubble message={userMsg()} streaming={false} onRetry={noop} onEdit={noop} />);
    expect(screen.queryByText('已编辑')).not.toBeInTheDocument();
    rerender(<MessageBubble message={userMsg({ editedAt: '2026-09-29T00:00:00.000Z', content: '改过的问题' })} streaming={false} onRetry={noop} onEdit={noop} />);
    expect(screen.getByText('已编辑')).toBeInTheDocument();
    expect(screen.getByText('改过的问题')).toBeInTheDocument();
  });

  it('assistant 消息永不出现编辑/删除入口（即便传了回调）', () => {
    render(<MessageBubble message={assistant({ content: '回答', status: 'completed' })} streaming={false} onRetry={noop} onEdit={noop} onDelete={noop} />);
    expect(screen.queryByTitle('编辑消息')).not.toBeInTheDocument();
    expect(screen.queryByTitle('删除消息')).not.toBeInTheDocument();
  });
});

afterEach(() => { vi.restoreAllMocks(); });
