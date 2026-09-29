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

afterEach(() => { vi.restoreAllMocks(); });
