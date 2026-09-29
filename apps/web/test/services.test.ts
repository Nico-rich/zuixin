import { describe, expect, it, vi } from 'vitest';
import { apiFetchWithMeta } from '@/lib/api';
import * as projects from '@/lib/services/projects';
import * as conversations from '@/lib/services/conversations';
import * as agents from '@/lib/services/agents';
import * as agentRuns from '@/lib/services/agent-runs';
import * as knowledge from '@/lib/services/knowledge';
import * as memories from '@/lib/services/memories';
import * as creative from '@/lib/services/creative';
import * as connections from '@/lib/services/connections';
import * as billing from '@/lib/services/billing';
import * as organizations from '@/lib/services/organizations';
import * as analytics from '@/lib/services/analytics';
import * as feedback from '@/lib/services/feedback';
import * as extensions from '@/lib/services/extensions';
import * as usage from '@/lib/services/usage';
import * as settings from '@/lib/services/settings';

/**
 * service 层契约（M13-F1）——**这是后续页面 agents 的接口事实源**。
 *
 * 断言的是「HTTP 语义」而非实现细节：方法、路径（含查询串编码）、请求体、以及两条跨切面红线：
 *   ① 一律经 apiFetch/apiFetchWithMeta → 必然带 `X-Requested-With`（后端 CSRF 中间件要求）与
 *      `credentials: 'include'`（cookie 域），且**绝不带 Authorization**（API 不认 Bearer）；
 *   ② 一律同源相对路径（不带 API_BASE / 不带协议主机），否则 cookie 不随行、CSRF 预检口径也会变。
 *
 * 若后端路径变更，这里必须同步改——页面 agents 不应各自拼接 URL。
 */
type FetchCall = [RequestInfo | URL, RequestInit | undefined];
type Case = { name: string; call: () => Promise<unknown>; method: string; url: string; body?: unknown };

/** 一次「真实调用 + HTTP 语义断言」；返回该次调用的 [url, init] 供补充断言 */
async function expectRequest(c: Case): Promise<FetchCall> {
  const mock = vi.fn(async () => new Response(JSON.stringify({ data: [] }), {
    status: 200,
    headers: { 'content-type': 'application/json', 'X-Page-Limit': '20', 'X-Page-Has-More': 'true', 'X-Page-Order': 'desc', 'X-Page-Next-Cursor': 'cursor-2' },
  }));
  vi.stubGlobal('fetch', mock);
  await c.call();
  const [call] = mock.mock.calls as unknown as FetchCall[];
  const [url, init] = call;

  expect(String(url), `${c.name}：路径`).toBe(c.url);
  expect(init?.method ?? 'GET', `${c.name}：方法`).toBe(c.method);
  // 跨切面红线（与 apps/api 的 cookie/CSRF 语义绑定）
  expect(String(url), `${c.name}：必须同源相对路径`).toMatch(/^\/api\/v1\//);
  expect(init?.credentials, `${c.name}：cookie 凭据`).toBe('include');
  const headers = init?.headers as Record<string, string>;
  expect(headers['X-Requested-With'], `${c.name}：CSRF 头`).toBe('XMLHttpRequest');
  expect(Object.keys(headers).map((k) => k.toLowerCase()), `${c.name}：不得用 Bearer`).not.toContain('authorization');
  if (c.body === undefined) {
    expect(init?.body, `${c.name}：不应有请求体`).toBeUndefined();
  } else {
    expect(JSON.parse(String(init?.body)), `${c.name}：请求体`).toEqual(c.body);
    expect(headers['Content-Type'], `${c.name}：JSON 内容类型`).toBe('application/json');
  }
  return call;
}

describe('service 契约：projects / conversations', () => {
  it('projects', async () => {
    const cases: Case[] = [
      { name: 'listProjects', call: () => projects.listProjects(), method: 'GET', url: '/api/v1/projects' },
      { name: 'createProject', call: () => projects.createProject({ name: '新项目' }), method: 'POST', url: '/api/v1/projects', body: { name: '新项目' } },
      { name: 'getProject', call: () => projects.getProject('p1'), method: 'GET', url: '/api/v1/projects/p1' },
      { name: 'updateProject', call: () => projects.updateProject('p1', { description: null }), method: 'PATCH', url: '/api/v1/projects/p1', body: { description: null } },
      { name: 'deleteProject', call: () => projects.deleteProject('p1'), method: 'DELETE', url: '/api/v1/projects/p1' },
    ];
    for (const c of cases) await expectRequest(c);
  });

  it('conversations（含游标分页与消息子资源）', async () => {
    const cases: Case[] = [
      { name: 'listConversations', call: () => conversations.listConversations(), method: 'GET', url: '/api/v1/conversations' },
      { name: 'listConversations+过滤', call: () => conversations.listConversations({ projectId: 'p1', limit: 20 }), method: 'GET', url: '/api/v1/conversations?projectId=p1&limit=20' },
      { name: 'createConversation', call: () => conversations.createConversation(), method: 'POST', url: '/api/v1/conversations', body: {} },
      { name: 'getConversation', call: () => conversations.getConversation('c1'), method: 'GET', url: '/api/v1/conversations/c1' },
      { name: 'updateConversation', call: () => conversations.updateConversation('c1', { title: '改名' }), method: 'PATCH', url: '/api/v1/conversations/c1', body: { title: '改名' } },
      { name: 'deleteConversation', call: () => conversations.deleteConversation('c1'), method: 'DELETE', url: '/api/v1/conversations/c1' },
      { name: 'listConversationMessages', call: () => conversations.listConversationMessages('c1', { limit: 5 }), method: 'GET', url: '/api/v1/conversations/c1/messages?limit=5' },
    ];
    for (const c of cases) await expectRequest(c);
  });

  it('分页元信息来自 X-Page-* 响应头（不在 body 里），listConversations 返回**已拆信封**的 { data, meta }', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ data: [{ id: 'c1' }] }), {
      status: 200,
      headers: {
        'content-type': 'application/json',
        'X-Page-Limit': '20', 'X-Page-Has-More': 'true', 'X-Page-Order': 'desc',
        'X-Page-Next-Cursor': 'cursor-2', 'X-Page-Prev-Cursor': 'cursor-0',
      },
    })));
    const res = await conversations.listConversations({ limit: 20 });
    expect(res.data).toEqual([{ id: 'c1' }]); // 数组本身，不是 { data: [...] }（页面不用写 res.data.data）
    expect(res.meta).toEqual({ limit: 20, hasMore: true, order: 'desc', nextCursor: 'cursor-2', prevCursor: 'cursor-0' });
  });

  it('apiFetchWithMeta：拆信封 + 保留原始响应体（逃生口），非信封响应体也能原样返回', async () => {
    const headers = { 'content-type': 'application/json', 'X-Page-Has-More': 'true' };
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ data: { items: [1], total: 9 } }), { status: 200, headers })));
    const wrapped = await apiFetchWithMeta<{ items: number[] }>('/api/v1/x');
    expect(wrapped.data).toEqual({ items: [1], total: 9 });
    expect(wrapped.body).toEqual({ data: { items: [1], total: 9 } }); // 信封之外的字段不丢

    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify([1, 2]), { status: 200, headers })));
    const bare = await apiFetchWithMeta<number[]>('/api/v1/y');
    expect(bare.data).toEqual([1, 2]); // 没有 data 键 → 原样返回
  });

  it('listConversationMessages 有查询串与无查询串两种形态', async () => {
    await expectRequest({ name: 'listConversationMessages(默认)', call: () => conversations.listConversationMessages('c1'), method: 'GET', url: '/api/v1/conversations/c1/messages' });
  });
});

describe('service 契约：agents / agent-runs', () => {
  it('agents（全控制器 admin-only：403 必须如实呈现）', async () => {
    const cases: Case[] = [
      { name: 'listAgents', call: () => agents.listAgents(), method: 'GET', url: '/api/v1/agents' },
      { name: 'getAgent', call: () => agents.getAgent('a1'), method: 'GET', url: '/api/v1/agents/a1' },
      { name: 'getAgentVersions', call: () => agents.getAgentVersions('a1'), method: 'GET', url: '/api/v1/agents/a1/versions' },
      { name: 'createAgent', call: () => agents.createAgent({ slug: 's', name: 'n', kind: 'custom', systemPrompt: 'sp' }), method: 'POST', url: '/api/v1/agents', body: { slug: 's', name: 'n', kind: 'custom', systemPrompt: 'sp' } },
      { name: 'updateAgentDraft', call: () => agents.updateAgentDraft('a1', { temperature: 0.2 }), method: 'PATCH', url: '/api/v1/agents/a1/draft', body: { temperature: 0.2 } },
      { name: 'publishAgent', call: () => agents.publishAgent('a1'), method: 'POST', url: '/api/v1/agents/a1/publish' },
      { name: 'rollbackAgent', call: () => agents.rollbackAgent('a1', 'v1'), method: 'POST', url: '/api/v1/agents/a1/rollback', body: { versionId: 'v1' } },
      { name: 'setAgentEnabled', call: () => agents.setAgentEnabled('a1', false), method: 'PATCH', url: '/api/v1/agents/a1/enabled', body: { enabled: false } },
    ];
    for (const c of cases) await expectRequest(c);
  });

  it('agent-runs（conversationId 必填、事件流另走 SSE）', async () => {
    const cases: Case[] = [
      { name: 'listAgentRuns', call: () => agentRuns.listAgentRuns('c1'), method: 'GET', url: '/api/v1/agent-runs?conversationId=c1' },
      { name: 'getAgentRun', call: () => agentRuns.getAgentRun('r1'), method: 'GET', url: '/api/v1/agent-runs/r1' },
      { name: 'startAgentRun', call: () => agentRuns.startAgentRun({ message: '你好', conversationId: 'c1' }), method: 'POST', url: '/api/v1/agent-runs', body: { message: '你好', conversationId: 'c1' } },
      { name: 'cancelAgentRun', call: () => agentRuns.cancelAgentRun('r1'), method: 'POST', url: '/api/v1/agent-runs/r1/cancel' },
      { name: 'retryAgentRun', call: () => agentRuns.retryAgentRun('r1'), method: 'POST', url: '/api/v1/agent-runs/r1/retry' },
      { name: 'getRunTimeline', call: () => agentRuns.getRunTimeline('r1'), method: 'GET', url: '/api/v1/agent-runs/r1/timeline' },
    ];
    for (const c of cases) await expectRequest(c);
  });

  it('conversationId 会被 URL 编码（不得拼出坏路径：空格/斜杠都不能原样进 query）', async () => {
    await expectRequest({ name: 'listAgentRuns(编码)', call: () => agentRuns.listAgentRuns('c 1/2'), method: 'GET', url: '/api/v1/agent-runs?conversationId=c%201%2F2' });
  });

  it('RUN_EVENTS_PATH 是给 lib/sse.ts 用的（非 JSON 信封，不走 apiFetch）', () => {
    expect(agentRuns.RUN_EVENTS_PATH('r1')).toBe('/api/v1/agent-runs/r1/events');
  });
});

describe('service 契约：knowledge / memories', () => {
  it('knowledge', async () => {
    const cases: Case[] = [
      { name: 'listDocuments', call: () => knowledge.listDocuments(), method: 'GET', url: '/api/v1/knowledge/documents' },
      { name: 'listDocuments+project', call: () => knowledge.listDocuments('p1'), method: 'GET', url: '/api/v1/knowledge/documents?projectId=p1' },
      { name: 'createDocument', call: () => knowledge.createDocument({ name: 'd', sourceType: 'text', content: 'x' }), method: 'POST', url: '/api/v1/knowledge/documents', body: { name: 'd', sourceType: 'text', content: 'x' } },
      { name: 'getDocument', call: () => knowledge.getDocument('d1'), method: 'GET', url: '/api/v1/knowledge/documents/d1' },
      { name: 'reindexDocument', call: () => knowledge.reindexDocument('d1'), method: 'POST', url: '/api/v1/knowledge/documents/d1/reindex' },
      { name: 'deleteDocument', call: () => knowledge.deleteDocument('d1'), method: 'DELETE', url: '/api/v1/knowledge/documents/d1' },
    ];
    for (const c of cases) await expectRequest(c);
  });

  it('memories（无 GET /:id：详情靠列表）', async () => {
    const cases: Case[] = [
      { name: 'listMemories', call: () => memories.listMemories(), method: 'GET', url: '/api/v1/memories' },
      { name: 'listMemories+过滤', call: () => memories.listMemories({ scope: 'project', status: 'candidate', projectId: 'p1', q: '偏好' }), method: 'GET', url: '/api/v1/memories?scope=project&projectId=p1&status=candidate&q=%E5%81%8F%E5%A5%BD' },
      { name: 'createMemory', call: () => memories.createMemory({ scope: 'user', content: 'c', category: 'preference' }), method: 'POST', url: '/api/v1/memories', body: { scope: 'user', content: 'c', category: 'preference' } },
      { name: 'updateMemory', call: () => memories.updateMemory('m1', { status: 'active' }), method: 'PATCH', url: '/api/v1/memories/m1', body: { status: 'active' } },
      { name: 'deleteMemory', call: () => memories.deleteMemory('m1'), method: 'DELETE', url: '/api/v1/memories/m1' },
    ];
    for (const c of cases) await expectRequest(c);
  });
});

describe('service 契约：creative-loop（路径基是 creative-loop，不是 creative）', () => {
  it('insights / hypotheses 全量端点', async () => {
    const cases: Case[] = [
      { name: 'buildInsight', call: () => creative.buildInsight({ days: 7 }), method: 'POST', url: '/api/v1/creative-loop/insights', body: { days: 7 } },
      { name: 'listInsights', call: () => creative.listInsights({ organizationId: 'o1', limit: 10 }), method: 'GET', url: '/api/v1/creative-loop/insights?organizationId=o1&limit=10' },
      { name: 'getInsight', call: () => creative.getInsight('i1'), method: 'GET', url: '/api/v1/creative-loop/insights/i1' },
      { name: 'interpretInsight', call: () => creative.interpretInsight('i1', { items: ['要点'] }), method: 'POST', url: '/api/v1/creative-loop/insights/i1/interpretation', body: { items: ['要点'] } },
      { name: 'createHypothesis', call: () => creative.createHypothesis({ statement: 's' }), method: 'POST', url: '/api/v1/creative-loop/hypotheses', body: { statement: 's' } },
      { name: 'listHypotheses', call: () => creative.listHypotheses({ status: 'ready' }), method: 'GET', url: '/api/v1/creative-loop/hypotheses?status=ready' },
      { name: 'getHypothesis', call: () => creative.getHypothesis('h1'), method: 'GET', url: '/api/v1/creative-loop/hypotheses/h1' },
      { name: 'updateHypothesis', call: () => creative.updateHypothesis('h1', { statement: 's2' }), method: 'PATCH', url: '/api/v1/creative-loop/hypotheses/h1', body: { statement: 's2' } },
      { name: 'setHypothesisStatus', call: () => creative.setHypothesisStatus('h1', { status: 'ready' }), method: 'POST', url: '/api/v1/creative-loop/hypotheses/h1/status', body: { status: 'ready' } },
      { name: 'deleteHypothesis', call: () => creative.deleteHypothesis('h1'), method: 'DELETE', url: '/api/v1/creative-loop/hypotheses/h1' },
      { name: 'startHypothesis', call: () => creative.startHypothesis('h1', { platform: 'meta', riskLevel: 'low' }), method: 'POST', url: '/api/v1/creative-loop/hypotheses/h1/start', body: { platform: 'meta', riskLevel: 'low' } },
      { name: 'getHypothesisStatus', call: () => creative.getHypothesisStatus('h1'), method: 'GET', url: '/api/v1/creative-loop/hypotheses/h1/status' },
      { name: 'getHypothesisRun', call: () => creative.getHypothesisRun('h1'), method: 'GET', url: '/api/v1/creative-loop/hypotheses/h1/run' },
      { name: 'concludeHypothesis(默认空体)', call: () => creative.concludeHypothesis('h1'), method: 'POST', url: '/api/v1/creative-loop/hypotheses/h1/conclude', body: {} },
      { name: 'concludeHypothesis', call: () => creative.concludeHypothesis('h1', { decision: 'rejected', reason: 'r' }), method: 'POST', url: '/api/v1/creative-loop/hypotheses/h1/conclude', body: { decision: 'rejected', reason: 'r' } },
      { name: 'attachHypothesisEvaluation', call: () => creative.attachHypothesisEvaluation('h1', 'e1'), method: 'POST', url: '/api/v1/creative-loop/hypotheses/h1/evaluation', body: { evaluationRunId: 'e1' } },
      { name: 'attachHypothesisExperiment', call: () => creative.attachHypothesisExperiment('h1', 'x1'), method: 'POST', url: '/api/v1/creative-loop/hypotheses/h1/experiment', body: { experimentId: 'x1' } },
    ];
    for (const c of cases) await expectRequest(c);
  });
});

describe('service 契约：connections / billing', () => {
  it('connections（视图永不含凭证；OAuth 只跳 authorizeUrl）', async () => {
    const cases: Case[] = [
      { name: 'listConnections', call: () => connections.listConnections(), method: 'GET', url: '/api/v1/connections' },
      { name: 'listConnections+provider', call: () => connections.listConnections('github'), method: 'GET', url: '/api/v1/connections?provider=github' },
      { name: 'getConnection', call: () => connections.getConnection('k1'), method: 'GET', url: '/api/v1/connections/k1' },
      { name: 'startConnection', call: () => connections.startConnection('github'), method: 'POST', url: '/api/v1/connections/github/start', body: {} },
      { name: 'completeConnection', call: () => connections.completeConnection('github', { state: 's', code: 'c' }), method: 'GET', url: '/api/v1/connections/github/callback?state=s&code=c' },
      { name: 'refreshConnection', call: () => connections.refreshConnection('k1'), method: 'POST', url: '/api/v1/connections/k1/refresh' },
      { name: 'revokeConnection', call: () => connections.revokeConnection('k1'), method: 'POST', url: '/api/v1/connections/k1/revoke' },
      { name: 'deleteConnection', call: () => connections.deleteConnection('k1'), method: 'DELETE', url: '/api/v1/connections/k1' },
    ];
    for (const c of cases) await expectRequest(c);
  });

  it('billing（organizationId 省略 = 个人组织，服务端裁定）', async () => {
    const cases: Case[] = [
      { name: 'listPlans', call: () => billing.listPlans(), method: 'GET', url: '/api/v1/billing/plans' },
      { name: 'getSubscription', call: () => billing.getSubscription(), method: 'GET', url: '/api/v1/billing/subscription' },
      { name: 'getSubscription+org', call: () => billing.getSubscription('o1'), method: 'GET', url: '/api/v1/billing/subscription?organizationId=o1' },
      { name: 'getBillingUsage', call: () => billing.getBillingUsage({ organizationId: 'o1', period: '2026-09' }), method: 'GET', url: '/api/v1/billing/usage?organizationId=o1&period=2026-09' },
      { name: 'getReconciliation', call: () => billing.getReconciliation({ period: '2026-09' }), method: 'GET', url: '/api/v1/billing/reconciliation?period=2026-09' },
      { name: 'listInvoices', call: () => billing.listInvoices('o1'), method: 'GET', url: '/api/v1/billing/invoices?organizationId=o1' },
      { name: 'subscribe', call: () => billing.subscribe({ organizationId: 'o1', planId: 'pl1' }), method: 'POST', url: '/api/v1/billing/subscribe', body: { organizationId: 'o1', planId: 'pl1' } },
    ];
    for (const c of cases) await expectRequest(c);
  });
});

describe('service 契约：organizations / invitations', () => {
  it('organizations', async () => {
    const cases: Case[] = [
      { name: 'listOrganizations', call: () => organizations.listOrganizations(), method: 'GET', url: '/api/v1/organizations' },
      { name: 'createOrganization', call: () => organizations.createOrganization({ name: '团队' }), method: 'POST', url: '/api/v1/organizations', body: { name: '团队' } },
      { name: 'getOrganization', call: () => organizations.getOrganization('o1'), method: 'GET', url: '/api/v1/organizations/o1' },
      { name: 'updateOrganization', call: () => organizations.updateOrganization('o1', { name: '新名' }), method: 'PATCH', url: '/api/v1/organizations/o1', body: { name: '新名' } },
      { name: 'deleteOrganization', call: () => organizations.deleteOrganization('o1'), method: 'DELETE', url: '/api/v1/organizations/o1' },
      { name: 'disableOrganization', call: () => organizations.disableOrganization('o1'), method: 'POST', url: '/api/v1/organizations/o1/disable' },
      { name: 'enableOrganization', call: () => organizations.enableOrganization('o1'), method: 'POST', url: '/api/v1/organizations/o1/enable' },
      { name: 'listMembers', call: () => organizations.listMembers('o1'), method: 'GET', url: '/api/v1/organizations/o1/members' },
      { name: 'removeMember', call: () => organizations.removeMember('o1', 'u2'), method: 'DELETE', url: '/api/v1/organizations/o1/members/u2' },
      { name: 'inviteMember', call: () => organizations.inviteMember('o1', { email: 'a@b.c', role: 'member' }), method: 'POST', url: '/api/v1/organizations/o1/invitations', body: { email: 'a@b.c', role: 'member' } },
      { name: 'listInvitations', call: () => organizations.listInvitations('o1'), method: 'GET', url: '/api/v1/organizations/o1/invitations' },
      { name: 'acceptInvitation', call: () => organizations.acceptInvitation('tok en'), method: 'POST', url: '/api/v1/invitations/tok%20en/accept' },
      { name: 'revokeInvitation', call: () => organizations.revokeInvitation('tok'), method: 'POST', url: '/api/v1/invitations/tok/revoke' },
    ];
    for (const c of cases) await expectRequest(c);
  });
});

describe('service 契约：analytics / feedback', () => {
  it('analytics（facts / derived / meta 分层由服务端给）', async () => {
    const cases: Case[] = [
      { name: 'getAnalyticsOverview', call: () => analytics.getAnalyticsOverview(), method: 'GET', url: '/api/v1/analytics/overview' },
      { name: 'getAnalyticsOverview+参数', call: () => analytics.getAnalyticsOverview({ organizationId: 'o1', range: 'week' }), method: 'GET', url: '/api/v1/analytics/overview?organizationId=o1&range=week' },
      { name: 'getAnalyticsBreakdown', call: () => analytics.getAnalyticsBreakdown({ kind: 'usage', days: 30 }), method: 'GET', url: '/api/v1/analytics/breakdown?kind=usage&days=30' },
      { name: 'refreshAnalytics', call: () => analytics.refreshAnalytics({ organizationId: 'o1' }), method: 'POST', url: '/api/v1/analytics/refresh', body: { organizationId: 'o1' } },
      { name: 'getAnalyticsSources', call: () => analytics.getAnalyticsSources({ period: '2026-09' }), method: 'GET', url: '/api/v1/analytics/sources?period=2026-09' },
    ];
    for (const c of cases) await expectRequest(c);
  });

  it('feedback（绩效入口是外部事实：正文不可信，派生值由服务端算）', async () => {
    const cases: Case[] = [
      { name: 'createFeedback', call: () => feedback.createFeedback({ subjectType: 'artifact', subjectId: 'a1', rating: 5 }), method: 'POST', url: '/api/v1/feedback', body: { subjectType: 'artifact', subjectId: 'a1', rating: 5 } },
      { name: 'listFeedback+过滤', call: () => feedback.listFeedback({ subjectType: 'agentRun', subjectId: 'r1' }), method: 'GET', url: '/api/v1/feedback?subjectType=agentRun&subjectId=r1' },
      { name: 'capturePerformance', call: () => feedback.capturePerformance({ metrics: { impressions: 1, clicks: 1, spend: 1, conversions: 1, revenue: 1, orders: 1 } }), method: 'POST', url: '/api/v1/feedback/performance', body: { metrics: { impressions: 1, clicks: 1, spend: 1, conversions: 1, revenue: 1, orders: 1 } } },
      { name: 'listPerformance', call: () => feedback.listPerformance({ artifactId: 'a1' }), method: 'GET', url: '/api/v1/feedback/performance?artifactId=a1' },
      { name: 'getPerformanceInsights', call: () => feedback.getPerformanceInsights(5), method: 'GET', url: '/api/v1/feedback/performance/insights?limit=5' },
    ];
    for (const c of cases) await expectRequest(c);
  });
});

describe('service 契约：extensions（organizationId 必填）', () => {
  it('catalog / 安装 / 生命周期 / 白名单', async () => {
    const cases: Case[] = [
      { name: 'createExtension', call: () => extensions.createExtension({ name: 'n', slug: 's', kind: 'tool', manifest: {} }), method: 'POST', url: '/api/v1/extensions', body: { name: 'n', slug: 's', kind: 'tool', manifest: {} } },
      { name: 'listExtensions', call: () => extensions.listExtensions('o1'), method: 'GET', url: '/api/v1/extensions?organizationId=o1' },
      { name: 'listCatalog', call: () => extensions.listCatalog('o1'), method: 'GET', url: '/api/v1/extensions/catalog?organizationId=o1' },
      { name: 'listInstallations', call: () => extensions.listInstallations('o1'), method: 'GET', url: '/api/v1/extensions/installations?organizationId=o1' },
      { name: 'listExtensionSteps', call: () => extensions.listExtensionSteps('o1'), method: 'GET', url: '/api/v1/extensions/steps?organizationId=o1' },
      { name: 'getExtension', call: () => extensions.getExtension('e1', 'o1'), method: 'GET', url: '/api/v1/extensions/e1?organizationId=o1' },
      { name: 'updateExtension', call: () => extensions.updateExtension('e1', { name: 'n2' }), method: 'PATCH', url: '/api/v1/extensions/e1', body: { name: 'n2' } },
      { name: 'publishExtension', call: () => extensions.publishExtension('e1'), method: 'POST', url: '/api/v1/extensions/e1/publish', body: {} },
      { name: 'deprecateExtension', call: () => extensions.deprecateExtension('e1'), method: 'POST', url: '/api/v1/extensions/e1/deprecate' },
      { name: 'archiveExtension', call: () => extensions.archiveExtension('e1'), method: 'POST', url: '/api/v1/extensions/e1/archive' },
      { name: 'installExtension', call: () => extensions.installExtension('e1', { organizationId: 'o1' }), method: 'POST', url: '/api/v1/extensions/e1/install', body: { organizationId: 'o1' } },
      { name: 'uninstallExtension', call: () => extensions.uninstallExtension('e1', 'o1'), method: 'POST', url: '/api/v1/extensions/e1/uninstall', body: { organizationId: 'o1' } },
      { name: 'enableExtension', call: () => extensions.enableExtension('e1', 'o1'), method: 'POST', url: '/api/v1/extensions/e1/enable', body: { organizationId: 'o1' } },
      { name: 'disableExtension', call: () => extensions.disableExtension('e1', 'o1'), method: 'POST', url: '/api/v1/extensions/e1/disable', body: { organizationId: 'o1' } },
      { name: 'getAllowlist', call: () => extensions.getAllowlist('e1'), method: 'GET', url: '/api/v1/extensions/e1/allowlist' },
      { name: 'addToAllowlist', call: () => extensions.addToAllowlist('e1', 'o2'), method: 'POST', url: '/api/v1/extensions/e1/allowlist', body: { organizationId: 'o2' } },
      { name: 'removeFromAllowlist', call: () => extensions.removeFromAllowlist('e1', 'o2'), method: 'DELETE', url: '/api/v1/extensions/e1/allowlist/o2' },
    ];
    for (const c of cases) await expectRequest(c);
  });
});

describe('service 契约：usage / settings', () => {
  it('usage 只有一个端点（run 级聚合）', async () => {
    await expectRequest({ name: 'getRunUsage', call: () => usage.getRunUsage('r1'), method: 'GET', url: '/api/v1/usage/agent-runs/r1' });
  });

  it('settings 目前只有会话/设备面（后端无 settings 控制器，前端不伪造）', async () => {
    const cases: Case[] = [
      { name: 'listSessions', call: () => settings.listSessions(), method: 'GET', url: '/api/v1/auth/sessions' },
      { name: 'revokeSession', call: () => settings.revokeSession('s1'), method: 'DELETE', url: '/api/v1/auth/sessions/s1' },
      { name: 'revokeDeviceSessions', call: () => settings.revokeDeviceSessions('d 1'), method: 'DELETE', url: '/api/v1/auth/sessions/device/d%201' },
      { name: 'logoutAll', call: () => settings.logoutAll(), method: 'POST', url: '/api/v1/auth/logout-all' },
      { name: 'rotateSession', call: () => settings.rotateSession(), method: 'POST', url: '/api/v1/auth/rotate' },
    ];
    for (const c of cases) await expectRequest(c);
  });
});

describe('service 契约：queryKey 工厂（页面失效缓存必须复用同一键）', () => {
  it('每个模块导出稳定、可序列化的键工厂', () => {
    expect(projects.projectKeys.all).toEqual(['projects']);
    expect(projects.projectKeys.detail('p1')).toEqual(['projects', 'p1']);
    expect(conversations.conversationKeys.messages('c1')).toEqual(['messages', 'c1']); // 与既有 chat-workspace 一致
    expect(conversations.conversationKeys.list(null)).toEqual(['conversations', null]);
    expect(agents.agentKeys.versions('a1')).toEqual(['agents', 'a1', 'versions']);
    expect(agentRuns.agentRunKeys.list('c1')).toEqual(['agent-runs', 'c1']);
    expect(knowledge.knowledgeKeys.list()).toEqual(['knowledge-documents', null]);
    expect(memories.memoryKeys.list({ status: 'active' })).toEqual(['memories', { status: 'active' }]);
    expect(creative.creativeKeys.status('h1')).toEqual(['creative-hypothesis-status', 'h1']);
    expect(connections.connectionKeys.list('github')).toEqual(['connections', 'github']);
    expect(billing.billingKeys.usage('o1', '2026-09')).toEqual(['billing-usage', 'o1', '2026-09']);
    expect(organizations.organizationKeys.members('o1')).toEqual(['organization-members', 'o1']);
    expect(analytics.analyticsKeys.overview('o1', 'week')).toEqual(['analytics-overview', 'o1', 'week']);
    expect(feedback.feedbackKeys.performanceInsights(5)).toEqual(['feedback-performance-insights', 5]);
    expect(extensions.extensionKeys.catalog('o1')).toEqual(['extensions-catalog', 'o1']);
    expect(usage.usageKeys.run('r1')).toEqual(['usage-run', 'r1']);
    expect(settings.settingsKeys.sessions).toEqual(['auth-sessions']);
  });
});
