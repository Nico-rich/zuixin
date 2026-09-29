import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '@/lib/api';
import AgentDetailPage from '@/app/agents/[id]/page';
import { renderWithQuery } from './helpers';

/**
 * Agent 详情 / 版本生命周期（M13-W2）：
 * - 版本列表 + 版本详情（systemPrompt / tools / config.maxSteps）投影直渲；
 * - 写操作各自打到对应 service 函数：setAgentEnabled / publishAgent / rollbackAgent / updateAgentDraft；
 * - 状态驱动禁用：草稿不能设为生效版本（后端 400）、已是生效版本不回滚、无草稿不能上线；
 * - 403（admin-only）如实呈现。
 */
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn(), forward: vi.fn(), refresh: vi.fn(), prefetch: vi.fn() }),
  useParams: () => ({ id: 'agent-1' }),
  usePathname: () => '/agents/agent-1',
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

type AgentDetail = Awaited<ReturnType<typeof import('@/lib/services/agents').getAgent>>['data'];

type AgentVersion = NonNullable<AgentDetail['versions']>[number];

function version(overrides: Partial<AgentVersion> = {}): AgentVersion {
  return {
    id: 'ver-2', agentId: 'agent-1', version: 2, status: 'published', systemPrompt: '线上提示词',
    modelId: null, tools: ['knowledge.search'], temperature: 0.5, maxTokens: 2048,
    config: { maxSteps: 12, requiresTools: true }, createdAt: '2026-09-28T00:00:00.000Z', createdBy: null,
    ...overrides,
  };
}

function detail(overrides: Partial<AgentDetail> = {}): AgentDetail {
  const published = version();
  const draft = version({ id: 'ver-3', version: 3, status: 'draft', systemPrompt: '草稿提示词', tools: ['knowledge.search', 'ext.custom.tool'], config: { maxSteps: 6 } });
  return {
    id: 'agent-1', slug: 'market-researcher', name: '市场研究员', description: '调研用',
    enabled: true, priority: 100, builtin: false, kind: 'custom', scope: 'system', organizationId: null,
    activeVersionId: published.id, createdAt: '2026-09-28T00:00:00.000Z', updatedAt: '2026-09-28T01:00:00.000Z',
    versions: [draft, published], activeVersion: published,
    ...overrides,
  };
}

async function renderDetail(data: AgentDetail = detail()) {
  service.getAgent.mockResolvedValue({ data });
  renderWithQuery(<AgentDetailPage />);
  await screen.findByRole('heading', { name: '市场研究员' });
}

beforeEach(() => {
  for (const fn of Object.values(service)) fn.mockReset();
  service.updateAgentDraft.mockResolvedValue({ data: {} });
  service.publishAgent.mockResolvedValue({ data: {} });
  service.rollbackAgent.mockResolvedValue({ data: {} });
  service.setAgentEnabled.mockResolvedValue({ data: {} });
});

describe('Agent 详情页：版本投影', () => {
  it('渲染 Agent 头部 + 版本列表 + 选中版本的详情（默认选中生效版本）', async () => {
    await renderDetail();

    expect(screen.getByText('market-researcher')).toBeInTheDocument();
    expect(screen.getByText('已启用')).toBeInTheDocument();
    expect(screen.getByText('自定义')).toBeInTheDocument();

    const table = screen.getByRole('table');
    expect(within(table).getByText('v2')).toBeInTheDocument();
    expect(within(table).getByText('v3')).toBeInTheDocument();
    expect(within(table).getByText('已上线')).toBeInTheDocument();
    expect(within(table).getByText('草稿')).toBeInTheDocument();

    // 默认选中生效版本 v2：面板显示线上提示词与 config.maxSteps
    expect(screen.getByText('线上提示词')).toBeInTheDocument();
    expect(screen.getByText('12')).toBeInTheDocument();
  });

  it('切换版本链接：展示该版本详情（草稿的未登记工具也原样呈现）', async () => {
    await renderDetail();
    fireEvent.click(within(screen.getByRole('table')).getByText('v3'));
    expect(await screen.findByText('草稿提示词')).toBeInTheDocument();
    expect(screen.getByText('ext.custom.tool')).toBeInTheDocument();
    expect(screen.getByText('6')).toBeInTheDocument(); // draft config.maxSteps
  });
});

describe('Agent 详情页：写操作', () => {
  it('停用：PATCH enabled=false（启停不改版本）', async () => {
    await renderDetail();
    fireEvent.click(screen.getByRole('button', { name: '停用' }));
    await waitFor(() => expect(service.setAgentEnabled).toHaveBeenCalledWith('agent-1', false));
  });

  it('启用：当前停用时按钮为「启用」并提交 true', async () => {
    await renderDetail(detail({ enabled: false }));
    fireEvent.click(screen.getByRole('button', { name: '启用' }));
    await waitFor(() => expect(service.setAgentEnabled).toHaveBeenCalledWith('agent-1', true));
  });

  it('上线草稿：有草稿时可点，调用 publishAgent', async () => {
    await renderDetail();
    fireEvent.click(screen.getByRole('button', { name: '上线草稿' }));
    await waitFor(() => expect(service.publishAgent).toHaveBeenCalledWith('agent-1'));
  });

  it('上线草稿：没有草稿时禁用（避免拿后端的「没有可发布的草稿」400）', async () => {
    await renderDetail(detail({
      versions: [version()],
      activeVersion: version(),
      activeVersionId: 'ver-2',
    }));
    expect(screen.getByRole('button', { name: '上线草稿' })).toBeDisabled();
    expect(service.publishAgent).not.toHaveBeenCalled();
  });

  it('回滚：对已归档版本可点（rollbackAgent(versionId)），对草稿与生效版本禁用', async () => {
    await renderDetail(detail({
      versions: [
        version({ id: 'ver-3', version: 3, status: 'draft' }),
        version({ id: 'ver-1', version: 1, status: 'archived' }),
        version(),
      ],
    }));
    const rows = within(screen.getByRole('table')).getAllByRole('row');
    // row[0] = 表头；row[1] = v3 草稿；row[2] = v1 归档；row[3] = v2 生效版本
    expect(within(rows[1]).getByRole('button', { name: '设为生效版本' })).toBeDisabled();
    expect(within(rows[3]).getByRole('button', { name: '设为生效版本' })).toBeDisabled();

    fireEvent.click(within(rows[2]).getByRole('button', { name: '设为生效版本' }));
    await waitFor(() => expect(service.rollbackAgent).toHaveBeenCalledWith('agent-1', 'ver-1'));
  });

  it('编辑草稿：预填草稿内容，提交 updateAgentDraft（保留既有 config 键，maxSteps 可改）', async () => {
    await renderDetail();
    fireEvent.click(screen.getByRole('button', { name: '编辑草稿' }));

    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.getByLabelText('systemPrompt')).toHaveValue('草稿提示词');
    expect(screen.getByLabelText(/maxSteps/)).toHaveValue(6);
    expect(screen.getByRole('checkbox', { name: 'ext.custom.tool' })).toBeChecked();

    fireEvent.change(screen.getByLabelText('systemPrompt'), { target: { value: '改过的提示词' } });
    fireEvent.change(screen.getByLabelText(/maxSteps/), { target: { value: '10' } });
    fireEvent.click(screen.getByRole('button', { name: '存为草稿' }));

    await waitFor(() => expect(service.updateAgentDraft).toHaveBeenCalledTimes(1));
    expect(service.updateAgentDraft).toHaveBeenCalledWith('agent-1', {
      systemPrompt: '改过的提示词',
      tools: ['knowledge.search', 'ext.custom.tool'],
      temperature: 0.5,
      maxTokens: 2048,
      config: { maxSteps: 10 },
    });
  });

  it('编辑草稿：无草稿时以生效版本为模板（标题写明新建草稿）', async () => {
    await renderDetail(detail({ versions: [version()], activeVersion: version() }));
    fireEvent.click(screen.getByRole('button', { name: '编辑草稿' }));
    expect(screen.getByText('基于 v2 新建草稿')).toBeInTheDocument();
  });
});

describe('Agent 详情页：错误态', () => {
  it('403：Badge 提示需要管理员权限', async () => {
    service.getAgent.mockRejectedValue(new ApiError('FORBIDDEN', 'Forbidden resource'));
    renderWithQuery(<AgentDetailPage />);
    expect(await screen.findByText('需要管理员权限')).toBeInTheDocument();
    expect(screen.getByText('无权查看该 Agent')).toBeInTheDocument();
  });

  it('404：Agent 不存在的明确提示', async () => {
    service.getAgent.mockRejectedValue(new ApiError('NOT_FOUND', 'Agent 不存在'));
    renderWithQuery(<AgentDetailPage />);
    expect(await screen.findByText(/Agent 不存在（可能已被移除）/)).toBeInTheDocument();
  });
});
