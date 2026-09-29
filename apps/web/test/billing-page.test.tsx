import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import BillingPage from '@/app/billing/page';
import { parseReconciliation } from '@/app/billing/reconciliation-panel';
import { getBillingUsage, getReconciliation, getSubscription, listInvoices } from '@/lib/services/billing';
import { jsonResponse, renderWithQuery } from './helpers';

/**
 * /billing（M13-W5）：订阅 / 计划 / 用量 / 发票 / 对账。
 *
 * 覆盖点：
 *  - 金额与权益一律按服务端返回值渲染（前端不做金额计算/单位换算）；
 *  - facts（账本聚合）与 derived（服务端派生）**分层展示**，并显示 layering 出处字面量；
 *  - 对账 consistent 结论 + 缺失/重复/不符/孤儿/仅账本/未关联**逐段如实呈现**（含 ledgerOnly 的非差异语义）；
 *  - RBAC：读需 owner/admin/member（viewer 403 → 无权限徽标）；订阅（billing.write）仅 owner；
 *  - 防漂移：页面构造的组织级 URL 必须与 lib/services/billing.ts 完全一致。
 */

/** 账期口径与页面一致：当前 UTC 月（YYYY-MM） */
const PERIOD = (() => { const d = new Date(); return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`; })();

const ORGS = {
  data: [
    { id: 'org-1', name: '个人空间', slug: 'personal-u1', isPersonal: true, createdAt: '2026-09-01T00:00:00.000Z', members: [{ role: 'owner' }], _count: { members: 1, projects: 0 } },
    { id: 'org-2', name: '只读组织', slug: 'viewer-org', isPersonal: false, createdAt: '2026-09-01T00:00:00.000Z', members: [{ role: 'viewer' }], _count: { members: 2, projects: 1 } },
  ],
};

const PLANS = {
  data: [
    { id: 'plan-free', code: 'free', name: '免费版', monthlyPrice: 0, yearlyPrice: 0, entitlements: { agentRunsMonthly: 50 }, active: true, createdAt: 'T', updatedAt: 'T' },
    { id: 'plan-pro', code: 'pro', name: '专业版', monthlyPrice: 99, yearlyPrice: 990, entitlements: { agentRunsMonthly: 500, llmTokensMonthly: 2000000 }, active: true, createdAt: 'T', updatedAt: 'T' },
  ],
};

const SUBSCRIPTION = {
  data: { organizationId: 'org-1', plan: 'free', status: 'active', entitlements: { agentRunsMonthly: 50, seats: 3 }, currentPeriodEnd: '2026-10-29T00:00:00.000Z' },
};

const USAGE = {
  data: {
    organizationId: 'org-1', period: PERIOD,
    facts: { llm_tokens: 1500, llm_cost: 12.5, image_generation: 3 },
    derived: { totalUsageKinds: 3, llmCost: 12.5 },
    layering: { facts: 'ledger-aggregate', derived: 'service-computed' },
  },
};

const RECONCILED = {
  data: {
    organizationId: 'org-1', period: PERIOD, records: 12, mirrorRows: 15,
    missing: [], duplicates: [], wrongAmount: [], orphans: [],
    ledgerOnly: { rows: 3, kinds: { agent_run: { rows: 3, quantity: 3 } }, duplicateKeys: [], nonPositive: [] },
    unlinked: [], consistent: true,
  },
};

const RECONCILIATION_DIFF = {
  data: {
    organizationId: 'org-1', period: PERIOD, records: 12, mirrorRows: 15,
    missing: [{ usageRecordId: 'ur-1', kind: 'llm_cost', expected: 42, actual: 0 }],
    duplicates: [{ usageRecordId: 'ur-2', kind: 'llm_tokens', expected: 1, actual: 2 }],
    wrongAmount: [{ usageRecordId: 'ur-3', kind: 'llm_tokens', expected: 1500, actual: 1450 }],
    orphans: [{ ledgerId: 'led-9', usageRecordId: 'ur-gone', kind: 'llm_tokens' }],
    ledgerOnly: {
      rows: 4,
      kinds: { agent_run: { rows: 3, quantity: 3 }, storage: { rows: 1, quantity: 7 } },
      duplicateKeys: [{ idempotencyKey: 'run:r1', kind: 'agent_run', count: 2 }],
      nonPositive: [{ ledgerId: 'led-4', kind: 'image_generation', quantity: 0 }],
    },
    unlinked: [{ ledgerId: 'led-7', kind: 'video_seconds', idempotencyKey: 'ur:ur-3:video_seconds' }],
    consistent: false,
  },
};

const INVOICES = {
  data: [{
    id: 'inv-1', organizationId: 'org-1', subscriptionId: 'sub-1', number: 'INV-2026-0001', status: 'paid',
    amount: 99, currency: 'CNY', periodStart: '2026-09-01T00:00:00.000Z', periodEnd: '2026-10-01T00:00:00.000Z',
    paidAt: '2026-09-01T01:00:00.000Z', createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z',
  }],
};

/** 覆写值可以是响应体，也可以是 HTTP 状态码（数字 → 后端统一错误信封，如 403 FORBIDDEN） */
type Override = unknown | number;

interface Overrides {
  orgs?: unknown; subscription?: Override; usage?: Override;
  reconciliation?: Override; invoices?: Override;
}

function respond(body: Override, fallback: unknown): Response {
  if (typeof body === 'number') {
    const forbidden = body === 403;
    return jsonResponse({ error: { code: forbidden ? 'FORBIDDEN' : 'INTERNAL', message: forbidden ? '权限不足' : '服务不可用' } }, body);
  }
  return jsonResponse(body ?? fallback);
}

function mockApi(overrides: Overrides = {}) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    if (url === '/api/v1/organizations') return jsonResponse(overrides.orgs ?? ORGS);
    if (url === '/api/v1/billing/plans') return jsonResponse(PLANS);
    if (method === 'POST' && url === '/api/v1/billing/subscribe') {
      return jsonResponse({
        data: {
          subscriptionId: 'sub-2', plan: 'pro', status: 'active',
          invoice: { id: 'inv-2', number: 'INV-2026-0002', amount: 99, status: 'paid' },
          entitlements: { agentRunsMonthly: 500 },
        },
      }, 201);
    }
    if (url.startsWith('/api/v1/billing/subscription')) return respond(overrides.subscription, SUBSCRIPTION);
    if (url.startsWith('/api/v1/billing/usage')) return respond(overrides.usage, USAGE);
    if (url.startsWith('/api/v1/billing/reconciliation')) return respond(overrides.reconciliation, RECONCILED);
    if (url.startsWith('/api/v1/billing/invoices')) return respond(overrides.invoices, INVOICES);
    throw new Error(`未预期的请求：${method} ${url}`);
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

async function renderPage(overrides: Overrides = {}) {
  const fetchMock = mockApi(overrides);
  renderWithQuery(<BillingPage />);
  await screen.findByRole('heading', { name: '计划' });
  // 发票行是「组织级查询全部落地」的收口信号；被覆写成错误/空态的场景由用例自己等待
  if (overrides.invoices === undefined) await screen.findByText('INV-2026-0001');
  return fetchMock;
}

const orgSelect = () => screen.getByLabelText('组织') as HTMLSelectElement;

describe('/billing 订阅 / 计划 / 用量 / 发票', () => {
  it('订阅卡：计划 code、状态、周期结束与权益摘要按服务端返回呈现', async () => {
    await renderPage();
    const card = screen.getByRole('heading', { name: '当前订阅' }).closest('div')!.parentElement!;
    expect(within(card).getByText('free')).toBeInTheDocument();
    expect(within(card).getByText('active')).toBeInTheDocument();
    expect(within(card).getByText(/当前周期结束/).textContent)
      .toContain(new Date(SUBSCRIPTION.data.currentPeriodEnd).toLocaleString());
    expect(within(card).getByText('agentRunsMonthly')).toBeInTheDocument();
    expect(within(card).getByText('50')).toBeInTheDocument();
    expect(within(card).getByText('seats')).toBeInTheDocument();
  });

  it('计划列表：月/年价格按服务端数值格式化（不做换算），owner 可见订阅入口', async () => {
    await renderPage();
    expect(screen.getByText('¥99.00 / 月 · ¥990.00 / 年')).toBeInTheDocument();
    expect(screen.getByText('¥0.00 / 月 · ¥0.00 / 年')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '订阅 专业版' })).toBeEnabled();
  });

  it('用量：facts 与 derived 分层展示，并标注 layering 出处', async () => {
    await renderPage();
    const card = screen.getByRole('heading', { name: '用量' }).closest('div')!.parentElement!;
    expect(within(card).getByText('facts：ledger-aggregate')).toBeInTheDocument();
    expect(within(card).getByText('derived：service-computed')).toBeInTheDocument();
    // facts 表格：llm_cost 按金额格式化，计数型原样
    expect(within(card).getByText('¥12.50')).toBeInTheDocument();
    expect(within(card).getByText('1500')).toBeInTheDocument();
    // derived 分层独立呈现
    expect(within(card).getByText(/totalUsageKinds：3/)).toBeInTheDocument();
    expect(within(card).getByText(/llmCost：¥12\.50/)).toBeInTheDocument();
  });

  it('发票：状态徽标 + 金额如实呈现', async () => {
    await renderPage();
    const row = screen.getByText('INV-2026-0001').closest('tr')!;
    expect(within(row).getByText('paid')).toBeInTheDocument();
    expect(within(row).getByText('¥99.00')).toBeInTheDocument();
    expect(within(row).getByText(new Date(INVOICES.data[0].createdAt).toLocaleString())).toBeInTheDocument();
  });

  it('发票空态：明确提示而不是空表', async () => {
    await renderPage({ invoices: { data: [] } });
    expect(await screen.findByText('暂无发票')).toBeInTheDocument();
  });
});

describe('/billing 对账结论与明细', () => {
  it('一致：显示 consistent 结论 + 仅账本段（按设计非差异）', async () => {
    await renderPage();
    expect(screen.getByText('一致（consistent）')).toBeInTheDocument();
    expect(screen.getByText(/差异项 0 处/)).toBeInTheDocument();
    expect(screen.getByText(/按设计不产生用量记录的类型/)).toBeInTheDocument();
    const ledgerRow = screen.getByText('agent_run').closest('tr')!;
    expect(within(ledgerRow).getAllByText('3')).toHaveLength(2); // 行数 + 数量和
  });

  it('不一致：missing/duplicates/wrongAmount/orphans/ledgerOnly/unlinked 逐段列出原始字段', async () => {
    await renderPage({ reconciliation: RECONCILIATION_DIFF });
    expect(screen.getByText('存在差异（inconsistent）')).toBeInTheDocument();
    expect(screen.getByText(/差异项 7 处/)).toBeInTheDocument();

    expect(screen.getByText('缺失镜像')).toBeInTheDocument();
    const missing = screen.getByText('ur-1').closest('tr')!;
    expect(within(missing).getByText('llm_cost')).toBeInTheDocument();
    expect(within(missing).getByText('42')).toBeInTheDocument();
    expect(within(missing).getByText('0')).toBeInTheDocument();

    expect(screen.getByText('重复镜像')).toBeInTheDocument();
    expect(screen.getByText('ur-2')).toBeInTheDocument();
    expect(screen.getByText('金额/数量不符')).toBeInTheDocument();
    expect(screen.getByText('ur-3')).toBeInTheDocument();

    expect(screen.getByText('孤儿镜像')).toBeInTheDocument();
    expect(screen.getByText('led-9')).toBeInTheDocument();
    expect(screen.getByText('ur-gone')).toBeInTheDocument();

    expect(screen.getByText('仅账本行（ledgerOnly）')).toBeInTheDocument();
    expect(screen.getByText('storage')).toBeInTheDocument();
    expect(screen.getByText(/重复幂等键 1 个 · 非正数量 1 条/)).toBeInTheDocument();

    expect(screen.getByText('未关联（unlinked）')).toBeInTheDocument();
    expect(screen.getByText('led-7')).toBeInTheDocument();
    expect(screen.getByText('ur:ur-3:video_seconds')).toBeInTheDocument();
  });

  it('parseReconciliation：结构不认识 → null（页面据此明说不识别，而不是渲染半截数据）', () => {
    expect(parseReconciliation({ hello: 'world' })).toBeNull();
    expect(parseReconciliation(null)).toBeNull();
    expect(parseReconciliation({ consistent: true, ledgerOnly: { kinds: { agent_run: { rows: 2, quantity: 2 } } } }))
      .toMatchObject({ consistent: true, records: 0, mirrorRows: 0, ledgerOnly: { rows: 0, kinds: [{ kind: 'agent_run', rows: 2, quantity: 2 }] } });
  });
});

describe('/billing RBAC（服务端裁决，前端只按返回角色显隐）', () => {
  it('viewer：读被拒（403 FORBIDDEN）→ 无权限徽标 + 原始 message，且不提供订阅入口', async () => {
    await renderPage({ subscription: 403, usage: 403, reconciliation: 403, invoices: 403 });
    // 组织下拉必须先拿到组织列表（否则 fireEvent.change 的目标 option 还不存在）
    await screen.findByRole('option', { name: '只读组织' });
    fireEvent.change(orgSelect(), { target: { value: 'org-2' } });

    await waitFor(() => expect(orgSelect()).toHaveValue('org-2'));
    const alerts = await screen.findAllByRole('alert');
    expect(alerts[0]).toHaveTextContent('权限不足（FORBIDDEN）');
    expect(screen.getAllByText('无权限').length).toBeGreaterThan(0);
    expect(screen.queryByRole('button', { name: '订阅 专业版' })).toBeNull();
  });

  it('member 及以上：订阅按钮不出现（billing.write 仅 owner），但读路径正常', async () => {
    await renderPage({
      orgs: {
        data: [{ ...ORGS.data[0], members: [{ role: 'member' }] }],
      },
    });
    expect(screen.queryByRole('button', { name: '订阅 专业版' })).toBeNull();
    expect(screen.getAllByText('仅组织 owner 可订阅')).toHaveLength(2); // 每个计划一张卡
    expect(screen.getByText('INV-2026-0001')).toBeInTheDocument(); // 读仍可用
  });
});

describe('/billing 订阅动作', () => {
  it('owner 订阅：确认框 → POST subscribe（organizationId + planId）→ 成功提示 + 订阅/发票失效重取', async () => {
    const fetchMock = await renderPage();
    fireEvent.click(screen.getByRole('button', { name: '订阅 专业版' }));

    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByRole('heading', { name: '确认订阅' })).toBeInTheDocument();
    expect(within(dialog).getByText(/将组织 个人空间 的订阅切换为「专业版」（¥99\.00 \/ 月）/)).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole('button', { name: '确认订阅' }));

    await waitFor(() => {
      const call = fetchMock.mock.calls.find(([u, i]) => String(u) === '/api/v1/billing/subscribe' && i?.method === 'POST');
      expect(call).toBeDefined();
      expect(JSON.parse(String(call![1]?.body))).toEqual({ organizationId: 'org-1', planId: 'plan-pro' });
    });
    expect(await screen.findByRole('status')).toHaveTextContent('订阅成功：pro · 发票 INV-2026-0002 ¥99.00');
    await waitFor(() => {
      const paths = fetchMock.mock.calls.map(([u]) => String(u));
      expect(paths.filter((p) => p.startsWith('/api/v1/billing/subscription')).length).toBeGreaterThanOrEqual(2);
      expect(paths.filter((p) => p.startsWith('/api/v1/billing/invoices')).length).toBeGreaterThanOrEqual(2);
    });
  });

  it('订阅被服务端拒绝（403）：如实呈现 code 与 message', async () => {
    const fetchMock = await renderPage();
    fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (init?.method === 'POST' && url === '/api/v1/billing/subscribe') {
        return jsonResponse({ error: { code: 'FORBIDDEN', message: '权限不足' } }, 403);
      }
      if (url === '/api/v1/organizations') return jsonResponse(ORGS);
      if (url === '/api/v1/billing/plans') return jsonResponse(PLANS);
      if (url.startsWith('/api/v1/billing/subscription')) return jsonResponse(SUBSCRIPTION);
      if (url.startsWith('/api/v1/billing/usage')) return jsonResponse(USAGE);
      if (url.startsWith('/api/v1/billing/reconciliation')) return jsonResponse(RECONCILED);
      return jsonResponse(INVOICES);
    });

    fireEvent.click(screen.getByRole('button', { name: '订阅 专业版' }));
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: '确认订阅' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('订阅失败：权限不足（FORBIDDEN）');
  });
});

describe('/billing URL 防漂移', () => {
  it('页面构造的组织级路径与 lib/services/billing.ts 生成的完全一致', async () => {
    // ① 先让 service 层真实生成 URL
    const urls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => { urls.push(String(input)); return jsonResponse({ data: {} }); }));
    await getSubscription('org-1');
    await getBillingUsage({ organizationId: 'org-1', period: PERIOD });
    await getReconciliation({ organizationId: 'org-1', period: PERIOD });
    await listInvoices('org-1');
    const serviceUrls = [...urls];
    expect(serviceUrls).toEqual([
      '/api/v1/billing/subscription?organizationId=org-1',
      `/api/v1/billing/usage?organizationId=org-1&period=${PERIOD}`,
      `/api/v1/billing/reconciliation?organizationId=org-1&period=${PERIOD}`,
      '/api/v1/billing/invoices?organizationId=org-1',
    ]);

    // ② 再捕获页面实际发出的 URL（同一个组织 + 同一个账期）
    const fetchMock = mockApi();
    renderWithQuery(<BillingPage />);
    await screen.findByText('INV-2026-0001');
    await screen.findByText(/facts：ledger-aggregate/);

    const pageUrls = fetchMock.mock.calls.map(([u]) => String(u));
    for (const url of serviceUrls) expect(pageUrls, `页面未使用 service 层同款 URL：${url}`).toContain(url);
  });
});
