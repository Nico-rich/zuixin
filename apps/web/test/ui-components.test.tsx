import { act, fireEvent, render, screen } from '@testing-library/react';
import { useEffect, useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Badge, badgeVariants } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog, DialogCloseButton, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Pagination } from '@/components/ui/pagination';
import { Select } from '@/components/ui/select';
import { Skeleton, SkeletonLines } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableEmpty, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { ToastProvider, useToast } from '@/components/ui/toast';

/**
 * 新组件库冒烟（M13-F1）——页面 agents 依赖的行为契约，逐条钉死：
 * 受控语义、无障碍角色/属性、边界（totalPages<=1 不渲染）、以及「不污染全局选择器」的刻意设计。
 * 不测视觉（Tailwind class 细节）；测的是页面能被写出来的最小行为集。
 */

afterEach(() => { vi.useRealTimers(); });

describe('Card', () => {
  it('标题是 h3（不抢页面 h1/h2 层级），description 为段落，footer 独立', () => {
    render(
      <Card>
        <CardHeader><CardTitle>运行详情</CardTitle><CardDescription>最近 24 小时</CardDescription></CardHeader>
        <CardContent>正文</CardContent>
        <CardFooter>页脚</CardFooter>
      </Card>,
    );
    expect(screen.getByRole('heading', { level: 3, name: '运行详情' })).toBeInTheDocument();
    expect(screen.getByText('最近 24 小时').tagName).toBe('P');
    expect(screen.getByText('正文')).toBeInTheDocument();
    expect(screen.getByText('页脚')).toBeInTheDocument();
  });
});

describe('Badge', () => {
  it('按 variant 产出不同样式类，且可承载状态字面量（不做业务判定）', () => {
    const { container } = render(<><Badge>已完成</Badge><Badge variant="success">成功</Badge><Badge variant="destructive">失败</Badge></>);
    const [plain, success, failed] = Array.from(container.querySelectorAll('span'));
    expect(plain.textContent).toBe('已完成');
    expect(success.className).toContain('emerald');
    expect(failed.className).toContain('red');
    expect(badgeVariants({ variant: 'info' })).toContain('sky');
  });
});

describe('Skeleton', () => {
  it('纯装饰：aria-hidden 且**不含任何文字**（避免与既有 e2e 的「加载中…」断言互相干扰）', () => {
    const { container } = render(<><Skeleton className="h-4 w-32" data-testid="s1" /><SkeletonLines lines={3} /></>);
    expect(screen.getByTestId('s1')).toHaveAttribute('aria-hidden', 'true');
    expect(container.textContent).toBe('');
    expect(container.querySelectorAll('.animate-pulse')).toHaveLength(4); // 1 + 3 行
  });
});

describe('Table', () => {
  it('是语义化 table（不是 ul/li 伪表格）——页面可继续用 ul>li 表达别的列表', () => {
    const { container } = render(
      <Table>
        <TableHeader><TableRow><TableHead>名称</TableHead><TableHead>状态</TableHead></TableRow></TableHeader>
        <TableBody>
          <TableRow><TableCell>run-1</TableCell><TableCell>运行中</TableCell></TableRow>
          <TableEmpty colSpan={2} />
        </TableBody>
      </Table>,
    );
    expect(screen.getByRole('table')).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: '名称' })).toBeInTheDocument();
    expect(screen.getByText('run-1')).toBeInTheDocument();
    expect(screen.getByText('暂无数据')).toBeInTheDocument();
    expect(container.querySelectorAll('ul li')).toHaveLength(0);
  });

  it('TableEmpty 可自定义文案并跨列', () => {
    render(<Table><TableBody><TableEmpty colSpan={4}>还没有连接</TableEmpty></TableBody></Table>);
    expect(screen.getByText('还没有连接')).toHaveAttribute('colspan', '4');
  });
});

describe('Select', () => {
  it('是原生 select：值/选项/onChange 可直接用，无需自造键盘交互', () => {
    const onChange = vi.fn();
    render(
      <Select aria-label="状态筛选" value="all" onChange={onChange}>
        <option value="all">全部</option><option value="success">成功</option>
      </Select>,
    );
    const select = screen.getByRole('combobox', { name: '状态筛选' });
    expect(select.tagName).toBe('SELECT');
    expect(screen.getAllByRole('option')).toHaveLength(2);
    expect(select).toHaveValue('all');
  });
});

describe('Pagination', () => {
  it('totalPages<=1 时不渲染（列表只有一页不该出现翻页条）', () => {
    const { container } = render(<Pagination page={1} totalPages={1} onPageChange={() => undefined} />);
    expect(container.textContent).toBe('');
  });

  it('受控：首页禁用上一页、末页禁用下一页，点击只回调不自增', () => {
    const onPageChange = vi.fn();
    const { rerender } = render(<Pagination page={1} totalPages={3} total={42} onPageChange={onPageChange} />);
    expect(screen.getByRole('button', { name: '上一页' })).toBeDisabled();
    expect(screen.getByText('1 / 3（共 42 条）')).toBeInTheDocument();
    screen.getByRole('button', { name: '下一页' }).click();
    expect(onPageChange).toHaveBeenCalledWith(2);

    rerender(<Pagination page={3} totalPages={3} onPageChange={onPageChange} />);
    expect(screen.getByRole('button', { name: '下一页' })).toBeDisabled();
  });
});

describe('Tabs', () => {
  function Basic() {
    const [kept, setKept] = useState('');
    return (
      <Tabs defaultValue="summary">
        <TabsList>
          <TabsTrigger value="summary">概览</TabsTrigger>
          <TabsTrigger value="timeline">时间线</TabsTrigger>
        </TabsList>
        <TabsContent value="summary"><input aria-label="备注" value={kept} onChange={(e) => setKept(e.target.value)} /></TabsContent>
        <TabsContent value="timeline">事件流</TabsContent>
      </Tabs>
    );
  }

  it('默认页签选中，点击切换；面板用 hidden 切换而非卸载（切回来不丢已填内容）', () => {
    render(<Basic />);
    const summary = screen.getByRole('tab', { name: '概览' });
    expect(summary).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tabpanel', { hidden: false })).toContainElement(screen.getByRole('textbox', { name: '备注' }));

    fireEvent.click(screen.getByRole('tab', { name: '时间线' }));
    expect(screen.getByRole('tab', { name: '时间线' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tabpanel', { hidden: false })).toHaveTextContent('事件流');
    // 概览面板仍在文档里（只是 hidden）：切页签不卸载子树
    expect(screen.getByRole('textbox', { name: '备注', hidden: true })).toBeInTheDocument();
  });

  it('键盘：→ 移动到下一个页签并选中，Home 回到首个（roving tabindex）', () => {
    render(<Basic />);
    const [summary, timeline] = screen.getAllByRole('tab');
    summary.focus();
    act(() => { timeline.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })); });
    expect(screen.getByRole('tab', { name: '时间线' })).toHaveAttribute('aria-selected', 'true');
    expect(document.activeElement).toBe(timeline);

    act(() => { timeline.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true })); });
    expect(screen.getByRole('tab', { name: '概览' })).toHaveAttribute('aria-selected', 'true');
  });

  it('受控用法：只回调 onValueChange，值由外部决定', () => {
    const onValueChange = vi.fn();
    const { rerender } = render(
      <Tabs value="a" onValueChange={onValueChange}>
        <TabsList><TabsTrigger value="a">A</TabsTrigger><TabsTrigger value="b">B</TabsTrigger></TabsList>
        <TabsContent value="a">A 面板</TabsContent><TabsContent value="b">B 面板</TabsContent>
      </Tabs>,
    );
    fireEvent.click(screen.getByRole('tab', { name: 'B' }));
    expect(onValueChange).toHaveBeenCalledWith('b');
    expect(screen.getByRole('tab', { name: 'A' })).toHaveAttribute('aria-selected', 'true'); // 未被外部改值前不动

    rerender(
      <Tabs value="b" onValueChange={onValueChange}>
        <TabsList><TabsTrigger value="a">A</TabsTrigger><TabsTrigger value="b">B</TabsTrigger></TabsList>
        <TabsContent value="a">A 面板</TabsContent><TabsContent value="b">B 面板</TabsContent>
      </Tabs>,
    );
    expect(screen.getByRole('tabpanel', { hidden: false })).toHaveTextContent('B 面板');
  });
});

describe('Dialog', () => {
  function Harness({ closeOnOverlayClick }: { closeOnOverlayClick?: boolean }) {
    const [open, setOpen] = useState(false);
    return (
      <>
        <button onClick={() => setOpen(true)}>打开</button>
        <Dialog open={open} onOpenChange={setOpen} closeOnOverlayClick={closeOnOverlayClick}>
          <DialogHeader><DialogTitle>删除确认</DialogTitle><DialogCloseButton onClose={() => setOpen(false)} /></DialogHeader>
          <DialogContent><DialogDescription>该操作不可撤销</DialogDescription>确定要删除吗？</DialogContent>
          <DialogFooter><button onClick={() => setOpen(false)}>取消</button></DialogFooter>
        </Dialog>
      </>
    );
  }

  it('关闭时不渲染；打开时 role=dialog + aria-modal + labelledby/describedby 已接线', () => {
    render(<Harness />);
    expect(screen.queryByRole('dialog')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: '打开' }));
    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    const titleId = dialog.getAttribute('aria-labelledby')!;
    const descId = dialog.getAttribute('aria-describedby')!;
    expect(document.getElementById(titleId)).toHaveTextContent('删除确认');
    expect(document.getElementById(descId)).toHaveTextContent('该操作不可撤销');
    expect(dialog).toHaveFocus(); // 打开后焦点进入内容区
  });

  it('Esc 关闭、点遮罩关闭；关闭后解锁 body 滚动', () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: '打开' }));
    expect(document.body.style.overflow).toBe('hidden');

    act(() => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.body.style.overflow).toBe('');

    fireEvent.click(screen.getByRole('button', { name: '打开' }));
    fireEvent.click(screen.getByTestId('dialog-overlay'));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('closeOnOverlayClick=false 时点遮罩不关（表单弹窗防误触）', () => {
    render(<Harness closeOnOverlayClick={false} />);
    fireEvent.click(screen.getByRole('button', { name: '打开' }));
    fireEvent.click(screen.getByTestId('dialog-overlay'));
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });
});

describe('Toast', () => {
  function Probe() {
    const { toast, dismiss } = useToast();
    return (
      <>
        <button onClick={() => toast({ title: '已保存', variant: 'success' })}>成功提示</button>
        <button onClick={() => { const id = toast({ title: '请求失败', variant: 'error', duration: 0 }); setTimeout(() => dismiss(id), 0); }}>错误提示</button>
        <button onClick={() => toast({ title: '稍后消失', duration: 1000 })}>定时提示</button>
      </>
    );
  }

  it('容器 aria-live=polite；success 用 role=status，error 用 role=alert（断言性提示）', () => {
    render(<ToastProvider><Probe /></ToastProvider>);
    expect(document.querySelector('[aria-live="polite"]')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '成功提示' }));
    expect(screen.getByRole('status')).toHaveTextContent('已保存');

    fireEvent.click(screen.getByRole('button', { name: '错误提示' }));
    expect(screen.getByRole('alert')).toHaveTextContent('请求失败');
  });

  it('duration 到点自动消失；关闭按钮可手动移除；提示条不使用 text-red-400（e2e 用它计数页面错误态）', () => {
    vi.useFakeTimers();
    render(<ToastProvider><Probe /></ToastProvider>);
    fireEvent.click(screen.getByRole('button', { name: '定时提示' }));
    expect(screen.getByTestId('toast')).toHaveTextContent('稍后消失');
    act(() => { vi.advanceTimersByTime(1000); });
    expect(screen.queryByTestId('toast')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: '成功提示' }));
    expect(screen.getByTestId('toast')).not.toHaveClass('text-red-400');
    fireEvent.click(screen.getByRole('button', { name: '关闭提示' }));
    expect(screen.queryByTestId('toast')).toBeNull();
  });

  it('未挂 Provider 时 useToast 返回 no-op（页面可独立单测，不抛错、不渲染）', () => {
    function Bare() {
      const { toast } = useToast();
      useEffect(() => { toast({ title: '无宿主' }); }, [toast]);
      return <p>无 Provider 的页面</p>;
    }
    const { container } = render(<Bare />);
    expect(screen.getByText('无 Provider 的页面')).toBeInTheDocument();
    expect(container.querySelectorAll('[data-testid="toast"]')).toHaveLength(0);
  });
});
