import { fireEvent, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '@/lib/api';
import AgentsPage from '@/app/agents/page';
import { renderWithQuery } from './helpers';

/**
 * Agents 管理列表页（M13-W2）：
 * - 真实调用 `listAgents`（本用例 mock service 函数，不 mock fetch —— 页面不拼 URL 是服务层契约）；
 * - **403 如实呈现**（后端全控制器 @Roles('admin')）：Badge「需要管理员权限」且不渲染写入口；
 * - 加载态 Skeleton（无文字）、错误态+重试、空态 TableEmpty；
 * - 添加 Agent：Dialog 表单 → createAgent 的完整入参（含 config.maxSteps 与工具多选）。
 */
const pushMock = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: pushMock, replace: vi.fn(), back: vi.fn(), forward: vi.fn(), refresh: vi.fn(), prefetch: vi.fn() }),
  useParams: () => ({ id: 'agent-1' }),
  usePathname: () => '/agents',
  useSearchParams: () => new URLSearchParams(),
}));

const service = vi.hoisted(() => ({
  listAgents: vi.fn(), getAgent: vi.fn(), getAgentVersions: vi.fn(), createAgent: vi.fn(),
  updateAgentDraft: vi.fn(), publishAgent: vi.fn(), rollbackAgent: vi.fn(), setAgentEnabled: vi.fn(),
}));

vi.mock('@/lib/services/agents', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/services/agents')>();
  return { ...actual, ...service };
});

type AgentRow = Awaited<ReturnType<typeof import('@/lib/services/agents').listAgents>>['data'][number];

/** 后端 list 是 `include: { activeVersion: true, versions: … }`：activeVersionId 有值时 activeVersion 必然同现 */
function agent(overrides: Partial<AgentRow> = {}): AgentRow {
  const published: NonNullable<AgentRow['versions']>[number] = {
    id: 'ver-1', agentId: 'agent-1', version: 1, status: 'published', systemPrompt: 'sp', modelId: null,
    tools: [], temperature: 0.7, maxTokens: null, config: null, createdAt: '2026-09-28T00:00:00.000Z', createdBy: null,
  };
  return {
    id: 'agent-1', slug: 'market-researcher', name: '市场研究员', description: '调研用',
    enabled: true, priority: 100, builtin: false, kind: 'custom', scope: 'system', organizationId: null,
    activeVersionId: 'ver-1', createdAt: '2026-09-28T00:00:00.000Z', updatedAt: '2026-09-28T01:00:00.000Z',
    versions: [published],
    activeVersion: published,
    ...overrides,
  };
}

beforeEach(() => {
  for (const fn of Object.values(service)) fn.mockReset();
  pushMock.mockReset();
});

describe('Agents 列表页', () => {
  it('渲染列表行：名称 / slug / 类型 / 启停状态 / 生效版本 / 版本数', async () => {
    service.listAgents.mockResolvedValue({ data: [agent({ enabled: false, kind: 'builtin', scope: 'organization' })] });
    renderWithQuery(<AgentsPage />);

    expect(await screen.findByText('市场研究员')).toBeInTheDocument();
    expect(screen.getByText('market-researcher')).toBeInTheDocument();
    expect(screen.getByText('内置 · 组织级')).toBeInTheDocument();
    expect(screen.getByText('已停用')).toBeInTheDocument();
    expect(screen.getByText('v1')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: '查看' })).toHaveAttribute('href', '/agents/agent-1');
  });

  it('403：Badge 提示需要管理员权限，不渲染列表与写入口（服务端裁决，前端不假装成功）', async () => {
    service.listAgents.mockRejectedValue(new ApiError('FORBIDDEN', 'Forbidden resource'));
    renderWithQuery(<AgentsPage />);

    expect(await screen.findByText('需要管理员权限')).toBeInTheDocument();
    expect(screen.getByText('无权读取 Agent 列表')).toBeInTheDocument();
    expect(screen.queryByRole('table')).toBeNull();
    expect(screen.queryByRole('button', { name: /添加/ })).toBeNull();
  });

  it('空列表：TableEmpty 空态', async () => {
    service.listAgents.mockResolvedValue({ data: [] });
    renderWithQuery(<AgentsPage />);
    expect(await screen.findByText('暂无 Agent')).toBeInTheDocument();
  });

  it('加载中：只渲染 Skeleton（无文字占位），不出现错误态', () => {
    service.listAgents.mockReturnValue(new Promise(() => undefined));
    const { container } = renderWithQuery(<AgentsPage />);
    expect(container.querySelectorAll('.animate-pulse').length).toBeGreaterThan(0);
    expect(container.textContent).not.toContain('加载失败');
  });

  it('非 403 错误：错误横幅 + 重试按钮会重新拉取', async () => {
    service.listAgents.mockRejectedValueOnce(new ApiError('INTERNAL', '服务异常'));
    renderWithQuery(<AgentsPage />);
    expect(await screen.findByText(/Agent 列表加载失败：服务异常/)).toBeInTheDocument();

    service.listAgents.mockResolvedValue({ data: [agent()] });
    fireEvent.click(screen.getByRole('button', { name: '重试' }));
    expect(await screen.findByText('市场研究员')).toBeInTheDocument();
  });

  it('添加 Agent：Dialog 表单提交 createAgent 的完整入参（kind=custom + config.maxSteps + 工具多选）', async () => {
    service.listAgents.mockResolvedValue({ data: [] });
    service.createAgent.mockResolvedValue({ data: { id: 'agent-9' } });
    renderWithQuery(<AgentsPage />);

    fireEvent.click(await screen.findByRole('button', { name: '添加 Agent' }));
    expect(screen.getByRole('dialog')).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('名称'), { target: { value: '选题助手' } });
    fireEvent.change(screen.getByLabelText('slug'), { target: { value: 'topic-helper' } });
    fireEvent.change(screen.getByLabelText('systemPrompt'), { target: { value: '你是选题助手' } });
    fireEvent.change(screen.getByLabelText(/temperature/), { target: { value: '1.2' } });
    fireEvent.change(screen.getByLabelText(/maxSteps/), { target: { value: '12' } });
    fireEvent.click(screen.getByRole('checkbox', { name: 'knowledge.search' }));

    fireEvent.click(screen.getByRole('button', { name: '添加' }));

    await waitFor(() => expect(service.createAgent).toHaveBeenCalledTimes(1));
    expect(service.createAgent).toHaveBeenCalledWith({
      slug: 'topic-helper',
      name: '选题助手',
      description: undefined,
      kind: 'custom',
      systemPrompt: '你是选题助手',
      tools: ['knowledge.search'],
      temperature: 1.2,
      config: { maxSteps: 12 },
    });
    await waitFor(() => expect(pushMock).toHaveBeenCalledWith('/agents/agent-9'));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('添加 Agent：本地校验拦截非法 slug/温度（不发请求）', async () => {
    service.listAgents.mockResolvedValue({ data: [] });
    renderWithQuery(<AgentsPage />);
    fireEvent.click(await screen.findByRole('button', { name: '添加 Agent' }));

    fireEvent.change(screen.getByLabelText('名称'), { target: { value: 'X' } });
    fireEvent.change(screen.getByLabelText('slug'), { target: { value: 'Bad Slug' } });
    fireEvent.change(screen.getByLabelText('systemPrompt'), { target: { value: 'sp' } });
    fireEvent.click(screen.getByRole('button', { name: '添加' }));

    expect(await screen.findByText(/slug 只能用小写字母/)).toBeInTheDocument();
    expect(service.createAgent).not.toHaveBeenCalled();
  });
});
