import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import ModelsSettingsPage from '@/app/settings/models/page';
import { ToastProvider } from '@/components/ui/toast';
import { jsonResponse, renderWithQuery } from './helpers';

/**
 * /settings/models 模型配置页（M13+）。
 *  - 非 admin：权限提示卡且**不发** /api/v1/providers；
 *  - Provider 表：状态/Key 徽标来自服务端投影（hasKey 布尔，绝无 Key 回显）；
 *  - 编辑弹窗：apiKey 只写（password + 留空不改 → PATCH body 无 apiKey 键）；脏值比对只发改动字段；
 *  - 默认模型卡：只列同类型模型；保存 → PATCH /api/v1/system-settings/routingPolicy。
 */
const replaceMock = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: replaceMock, push: vi.fn(), back: vi.fn(), forward: vi.fn(), refresh: vi.fn(), prefetch: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => '/settings/models',
}));

const ME_ADMIN = { data: { user: { id: 'u1', email: 'admin@example.com', displayName: '管理员', role: 'admin' } } };
const ME_USER = { data: { user: { id: 'u2', email: 'user@example.com', displayName: '成员', role: 'user' } } };

const PROVIDERS = {
  data: {
    providers: [
      {
        id: 'seed-llm-mock', name: '本地Mock', type: 'llm', adapter: 'mock', baseUrl: '',
        enabled: true, priority: 100, timeoutMs: 60000, hasKey: false, keyVersion: null,
        healthStatus: 'healthy', loaded: true, degradedReason: null, managedByExtension: false,
        models: [{ id: 'seed-model-mock-echo', name: 'Mock Echo', apiModelId: 'mock-echo', type: 'llm', enabled: true, priority: 1, isDefault: true, contextWindow: null, inputPrice: 0, outputPrice: 0, unitPrice: 0, capabilities: {} }],
        createdAt: '2026-09-29T00:00:00.000Z', updatedAt: '2026-09-29T00:00:00.000Z',
      },
      {
        id: 'seed-llm-OpenAI', name: 'OpenAI', type: 'llm', adapter: 'openai-compatible', baseUrl: 'https://api.openai.com/v1',
        enabled: false, priority: 100, timeoutMs: 60000, hasKey: true, keyVersion: 1,
        healthStatus: 'untested', loaded: false, degradedReason: null, managedByExtension: false,
        models: [{ id: 'seed-llm-OpenAI-gpt-4o-mini', name: 'GPT-4o mini', apiModelId: 'gpt-4o-mini', type: 'llm', enabled: true, priority: 1, isDefault: false, contextWindow: 128000, inputPrice: 0.15, outputPrice: 0.6, unitPrice: 0, capabilities: {} }],
        createdAt: '2026-09-29T00:00:00.000Z', updatedAt: '2026-09-29T00:00:00.000Z',
      },
    ],
  },
};
const POLICY = { data: { key: 'routingPolicy', description: '路由策略', value: { defaults: { llm: 'seed-model-mock-echo' } }, readOnlySubKeys: [], updatedAt: null } };

function mockApi(me: unknown = ME_ADMIN) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? 'GET').toUpperCase();
    if (url.includes('/api/v1/auth/me')) return jsonResponse(me);
    if (url.includes('/api/v1/providers') && method === 'GET') return jsonResponse(PROVIDERS);
    if (url.includes('/api/v1/providers/') && method === 'PATCH') {
      const body = JSON.parse(String(init?.body));
      return jsonResponse({ data: { ...PROVIDERS.data.providers[0], ...body, hasKey: body.apiKey !== undefined } });
    }
    if (url.includes('/api/v1/system-settings/routingPolicy') && method === 'PATCH') return jsonResponse(POLICY);
    if (url.includes('/api/v1/system-settings/routingPolicy')) return jsonResponse(POLICY);
    throw new Error(`未预期的请求：${url} ${method}`);
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

const rendered = () => renderWithQuery(<ToastProvider><ModelsSettingsPage /></ToastProvider>);

describe('/settings/models 模型配置页（M13+）', () => {
  beforeEach(() => replaceMock.mockClear());

  it('非 admin：权限提示卡，且不发 /api/v1/providers 请求', async () => {
    const fetchMock = mockApi(ME_USER);
    rendered();
    expect(await screen.findByText('需要管理员权限')).toBeInTheDocument();
    const urls = fetchMock.mock.calls.map((c) => String(c[0]));
    expect(urls.some((u) => u.includes('/api/v1/providers'))).toBe(false);
  });

  it('admin：Provider 表渲染状态与 Key 徽标（只回布尔，无 Key 回显）', async () => {
    mockApi();
    rendered();
    const table = await screen.findByText('本地Mock');
    expect(table).toBeInTheDocument();
    expect(screen.getByText('OpenAI')).toBeInTheDocument();
    expect(screen.getByText('已启用')).toBeInTheDocument();
    expect(screen.getByText('已停用')).toBeInTheDocument();
    expect(screen.getByText('无 Key')).toBeInTheDocument();
    expect(screen.getByText('已配置')).toBeInTheDocument();
    expect(screen.getAllByText('生图').length).toBeGreaterThan(0); // 默认模型卡能力徽标/标签
  });

  it('编辑弹窗：apiKey 只写（password、初值空）；提交空 Key 时 PATCH body 无 apiKey 键', async () => {
    const fetchMock = mockApi();
    rendered();
    await screen.findByText('本地Mock'); // providers 查询解析后再操作
    fireEvent.click(screen.getAllByRole('button', { name: '编辑' })[0]); // 首行 = 本地Mock
    const dialog = await screen.findByRole('dialog');
    const keyInput = within(dialog).getByTestId('provider-apikey') as HTMLInputElement;
    expect(keyInput.type).toBe('password');
    expect(keyInput.value).toBe('');

    // 只改优先级 → body 只含 priority（apiKey 空串被过滤）
    const priority = within(dialog).getByLabelText('优先级（越小越优先）') as HTMLInputElement;
    fireEvent.change(priority, { target: { value: '55' } });
    fireEvent.click(within(dialog).getByRole('button', { name: '保存' }));

    await waitFor(() => {
      const patchCall = fetchMock.mock.calls.find((c) => String(c[0]).includes('/api/v1/providers/') && (c[1] as RequestInit)?.method === 'PATCH');
      expect(patchCall).toBeDefined();
      const body = JSON.parse(String((patchCall![1] as RequestInit).body));
      expect(body).toEqual({ priority: 55 });
      expect('apiKey' in body).toBe(false);
    });
  });

  it('编辑弹窗：停用开关 → body {enabled:false}；无改动提交 → 表单错误提示、不发请求', async () => {
    const fetchMock = mockApi();
    rendered();
    await screen.findByText('本地Mock');
    fireEvent.click(screen.getAllByRole('button', { name: '编辑' })[0]);
    const dialog = await screen.findByRole('dialog');

    // 无改动提交：不发 PATCH
    fireEvent.click(within(dialog).getByRole('button', { name: '保存' }));
    expect(await within(dialog).findByText(/没有需要保存的改动/)).toBeInTheDocument();
    expect(fetchMock.mock.calls.filter((c) => (c[1] as RequestInit)?.method === 'PATCH')).toHaveLength(0);

    // 停用 → 只发 enabled
    fireEvent.click(within(dialog).getByTestId('provider-enabled'));
    fireEvent.click(within(dialog).getByRole('button', { name: '保存' }));
    await waitFor(() => {
      const patchCall = fetchMock.mock.calls.find((c) => String(c[0]).includes('/api/v1/providers/seed-llm-mock') && (c[1] as RequestInit)?.method === 'PATCH');
      expect(JSON.parse(String((patchCall![1] as RequestInit).body))).toEqual({ enabled: false });
    });
  });

  it('编辑弹窗：模型启停开关 → PATCH body 只含状态变化的模型（seed 生图/生视频模型默认停用，必须可启用）', async () => {
    const fetchMock = mockApi();
    rendered();
    await screen.findByText('本地Mock');
    fireEvent.click(screen.getAllByRole('button', { name: '编辑' })[0]);
    const dialog = await screen.findByRole('dialog');

    // 停用 Mock Echo（初值 enabled=true）→ body 只含该模型
    fireEvent.click(within(dialog).getByTestId('model-enabled-seed-model-mock-echo'));
    fireEvent.click(within(dialog).getByRole('button', { name: '保存' }));
    await waitFor(() => {
      const patchCall = fetchMock.mock.calls.find((c) => String(c[0]).includes('/api/v1/providers/seed-llm-mock') && (c[1] as RequestInit)?.method === 'PATCH');
      expect(patchCall).toBeDefined();
      expect(JSON.parse(String((patchCall![1] as RequestInit).body))).toEqual({ models: [{ id: 'seed-model-mock-echo', enabled: false }] });
    });
  });

  it('默认模型卡：只列同类型模型；保存 → PATCH routingPolicy {defaults:{llm}}', async () => {
    const fetchMock = mockApi();
    rendered();
    await screen.findByText('本地Mock'); // providers 查询解析后选项才就绪
    const select = await screen.findByLabelText('LLM（对话/Agent） 默认模型') as HTMLSelectElement;
    await waitFor(() => {
      const options = Array.from(select.options).map((o) => o.value);
      expect(options).toContain('seed-model-mock-echo');
      expect(options).toContain('seed-llm-OpenAI-gpt-4o-mini');
    });

    fireEvent.change(select, { target: { value: 'seed-llm-OpenAI-gpt-4o-mini' } });
    fireEvent.click(screen.getAllByRole('button', { name: '保存' })[0]);

    await waitFor(() => {
      const call = fetchMock.mock.calls.find((c) => String(c[0]).includes('/api/v1/system-settings/routingPolicy') && (c[1] as RequestInit)?.method === 'PATCH');
      expect(call).toBeDefined();
      expect(JSON.parse(String((call![1] as RequestInit).body))).toEqual({ defaults: { llm: 'seed-llm-OpenAI-gpt-4o-mini' } });
    });
  });
});
