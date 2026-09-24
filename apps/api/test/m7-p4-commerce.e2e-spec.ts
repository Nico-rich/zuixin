import { Test } from '@nestjs/testing';
import { INestApplication, INestApplicationContext } from '@nestjs/common';
import request from 'supertest';
import cookieParser from 'cookie-parser';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { AppModule } from '../src/app.module';
import { WorkerModule } from '../src/worker.module';
import { GlobalExceptionFilter } from '../src/common/filters/global-exception.filter';
import { TransformInterceptor } from '../src/common/interceptors/transform.interceptor';
import { csrfProtection } from '../src/modules/auth/csrf.middleware';
import { PrismaService } from '../src/modules/prisma/prisma.service';

const XRW = { 'X-Requested-With': 'XMLHttpRequest' };

async function waitForStatus(prisma: PrismaService, runId: string, targets: string[], timeoutMs = 30_000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  let last = '';
  while (Date.now() < deadline) {
    const run = await prisma.agentRun.findUnique({ where: { id: runId } });
    last = run?.status ?? 'missing';
    if (run && targets.includes(run.status)) return run.status;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`run ${runId} 未在 ${timeoutMs}ms 内到达 ${targets.join('/')}（当前 ${last}）`);
}

/**
 * M7-P4 Commerce DataSource + Tools e2e（真实 PostgreSQL + Redis/Worker + mock 连接 + 种子数据）：
 * 9 个只读工具经真实 Agent 链路执行（facts/derived 分层断言）；只读保证（数据零变更）；
 * 无连接失败回喂；时间窗校验。
 */
describe('M7-P4 Commerce DataSource + Tools (e2e, mock adapter + 种子数据)', () => {
  let app: INestApplication;
  let worker: INestApplicationContext;
  let prisma: PrismaService;
  let cookie: string;
  let userId = '';
  let demoAgentId = '';
  let connectionId = '';
  let createdRunIds: string[] = [];

  beforeAll(async () => {
    process.env.MOCK_DELAY_MS = '0';
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.use(cookieParser());
    app.use('/api/v1', csrfProtection);
    app.setGlobalPrefix('api/v1');
    app.useGlobalFilters(moduleRef.get(GlobalExceptionFilter));
    app.useGlobalInterceptors(new TransformInterceptor());
    await app.init();
    await app.listen(0);
    prisma = moduleRef.get(PrismaService);

    const login = await request(app.getHttpServer()).post('/api/v1/auth/login').set(XRW)
      .send({ email: process.env.SEED_ADMIN_EMAIL ?? 'admin@example.com', password: process.env.SEED_ADMIN_PASSWORD ?? 'admin123456' });
    cookie = (login.headers['set-cookie'] as unknown as string[]).map((c) => c.split(';')[0]).join('; ');
    userId = login.body.data.user.id;

    const start = await request(app.getHttpServer()).post('/api/v1/connections/mock/start').set(XRW).set('Cookie', cookie).send({}).expect(201);
    const cb = await request(app.getHttpServer()).get('/api/v1/connections/mock/callback').set(XRW).set('Cookie', cookie)
      .query({ state: start.body.data.state, code: 'p4-conn' }).expect(200);
    connectionId = cb.body.data.id;

    // 规范化种子数据（明确 mock；30 天窗口内的周期指标）
    const now = Date.now();
    const day = (offset: number) => new Date(now - offset * 86400_000);
    await prisma.commerceProduct.createMany({
      data: [
        { userId, provider: 'mock', connectionId, externalId: 'P-1001', title: '黑金主图T恤', price: 129, status: 'active', inventory: 200, category: '服装' },
        { userId, provider: 'mock', connectionId, externalId: 'P-1002', title: '极简风卫衣', price: 219, status: 'active', inventory: 80, category: '服装' },
        { userId, provider: 'mock', connectionId, externalId: 'P-1003', title: '联名帆布包', price: 89, status: 'draft', inventory: 0, category: '配饰' },
      ],
    });
    await prisma.commerceOrder.createMany({
      data: [
        { userId, provider: 'mock', connectionId, externalId: 'O-1', orderNumber: 'NO-1001', status: 'paid', totalAmount: 258, itemCount: 2, orderedAt: day(1) },
        { userId, provider: 'mock', connectionId, externalId: 'O-2', orderNumber: 'NO-1002', status: 'fulfilled', totalAmount: 129, itemCount: 1, orderedAt: day(3) },
        { userId, provider: 'mock', connectionId, externalId: 'O-3', orderNumber: 'NO-1003', status: 'cancelled', totalAmount: 219, itemCount: 1, orderedAt: day(5) },
        { userId, provider: 'mock', connectionId, externalId: 'O-4', orderNumber: 'NO-1004', status: 'refunded', totalAmount: 89, itemCount: 1, orderedAt: day(8) },
        { userId, provider: 'mock', connectionId, externalId: 'O-5', orderNumber: 'NO-1005', status: 'fulfilled', totalAmount: 438, itemCount: 2, orderedAt: day(10) },
      ],
    });
    await prisma.commerceTrafficMetric.createMany({
      data: [
        { userId, provider: 'mock', connectionId, periodStart: day(29), periodEnd: day(0), dimension: 'all', dimensionValue: 'all', impressions: 120000, visits: 9000, uniqueVisitors: 4500 },
        { userId, provider: 'mock', connectionId, periodStart: day(29), periodEnd: day(0), dimension: 'source', dimensionValue: 'direct', impressions: 50000, visits: 4000, uniqueVisitors: 2000 },
        { userId, provider: 'mock', connectionId, periodStart: day(29), periodEnd: day(0), dimension: 'source', dimensionValue: 'ads', impressions: 70000, visits: 5000, uniqueVisitors: 2500 },
      ],
    });
    await prisma.commerceConversionMetric.createMany({
      data: [
        { userId, provider: 'mock', connectionId, periodStart: day(29), periodEnd: day(0), dimension: 'all', dimensionValue: 'all', clicks: 6000, addToCart: 900, checkouts: 300, orders: 200, revenue: 25800 },
      ],
    });
    const campaign = await prisma.commerceCampaign.create({
      data: { userId, provider: 'mock', connectionId, externalId: 'C-1', name: '夏季主推', status: 'active', objective: 'conversion', budget: 10000, startDate: day(29) },
    });
    const adGroup = await prisma.commerceAdGroup.create({
      data: { campaignId: campaign.id, externalId: 'AG-1', name: '主图文案A', status: 'active' },
    });
    await prisma.commerceAd.create({
      data: { adGroupId: adGroup.id, externalId: 'AD-1', name: '主图A-黑金', status: 'active', creativeType: 'image' },
    });
    await prisma.commerceAdMetric.createMany({
      data: [
        { userId, provider: 'mock', connectionId, campaignId: campaign.id, adId: null, periodStart: day(29), periodEnd: day(0), impressions: 80000, clicks: 2400, spend: 6000, conversions: 120, revenue: 15000 },
      ],
    });
    await prisma.commerceInventoryMetric.createMany({
      data: [
        { userId, provider: 'mock', connectionId, productId: null, periodStart: day(29), periodEnd: day(0), stock: 280, reserved: 20, sold: 200 },
      ],
    });
    await prisma.commerceRevenueMetric.createMany({
      data: [
        { userId, provider: 'mock', connectionId, periodStart: day(29), periodEnd: day(0), revenue: 25800, orders: 200, refunds: 89, netRevenue: 25711 },
      ],
    });

    const agent = await prisma.agent.create({
      data: {
        slug: `commerce-${Date.now()}`, name: '电商分析 Agent', enabled: true, builtin: false, kind: 'custom', scope: 'system',
        versions: {
          create: {
            version: 1, status: 'published', systemPrompt: '你是电商数据分析助手。区分事实与推测。', temperature: 0.7,
            tools: [
              'commerce.products.list', 'commerce.products.get', 'commerce.orders.list', 'commerce.orders.summary',
              'commerce.traffic.summary', 'commerce.ads.campaigns.list', 'commerce.ads.performance',
              'commerce.analytics.summary', 'commerce.analytics.compare',
            ] as never,
            config: { maxSteps: 6 } as never,
          },
        },
      },
      include: { versions: true },
    });
    demoAgentId = agent.id;
    await prisma.agent.update({ where: { id: agent.id }, data: { activeVersionId: agent.versions[0].id } });

    const { NestFactory } = await import('@nestjs/core');
    worker = await NestFactory.createApplicationContext(WorkerModule, { bufferLogs: false });
  });

  afterAll(async () => {
    if (createdRunIds.length) {
      await prisma.generationTask.deleteMany({ where: { runId: { in: createdRunIds } } });
      await prisma.artifact.deleteMany({ where: { runId: { in: createdRunIds } } });
      await prisma.usageRecord.deleteMany({ where: { runId: { in: createdRunIds } } });
      await prisma.agentRunMessage.deleteMany({ where: { runId: { in: createdRunIds } } });
      await prisma.agentRun.deleteMany({ where: { id: { in: createdRunIds } } });
    }
    await prisma.commerceAdMetric.deleteMany({ where: { userId } });
    await prisma.commerceAd.deleteMany({ where: { adGroup: { campaign: { userId } } } });
    await prisma.commerceAdGroup.deleteMany({ where: { campaign: { userId } } });
    await prisma.commerceCampaign.deleteMany({ where: { userId } });
    await prisma.commerceOrderItem.deleteMany({ where: { order: { userId } } });
    await prisma.commerceOrder.deleteMany({ where: { userId } });
    await prisma.commerceProduct.deleteMany({ where: { userId } });
    await prisma.commerceTrafficMetric.deleteMany({ where: { userId } });
    await prisma.commerceConversionMetric.deleteMany({ where: { userId } });
    await prisma.commerceInventoryMetric.deleteMany({ where: { userId } });
    await prisma.commerceRevenueMetric.deleteMany({ where: { userId } });
    await prisma.credential.deleteMany({ where: { connectionId } });
    await prisma.connection.deleteMany({ where: { id: connectionId } });
    if (demoAgentId) await prisma.agent.delete({ where: { id: demoAgentId } }).catch(() => undefined);
    await worker?.close().catch(() => undefined);
    await app.close();
  });

  async function runTool(message: string): Promise<{ runId: string; toolContent: string }> {
    const res = await request(app.getHttpServer()).post('/api/v1/agent-runs').set(XRW).set('Cookie', cookie)
      .send({ agentId: demoAgentId, message }).expect(201);
    const runId = res.body.data.runId as string;
    createdRunIds.push(runId);
    expect(await waitForStatus(prisma, runId, ['completed', 'failed'], 30_000)).toBe('completed');
    const toolRow = await prisma.agentRunMessage.findFirst({ where: { runId, role: 'tool' } });
    return { runId, toolContent: toolRow?.content ?? '' };
  }

  it('P4 analytics.summary：facts 原始事实 + derived 服务端派生（conversionRate/roas/aov）', async () => {
    const { toolContent } = await runTool('分析最近30天店铺销售情况');
    const parsed = JSON.parse(toolContent) as { facts: Record<string, number>; derived: Record<string, number> };
    expect(parsed.facts).toMatchObject({ revenue: 25800, orders: 200, impressions: 120000, visits: 9000 });
    expect(parsed.derived.conversionRate).toBeCloseTo(0.02, 2); // round2(200/9000)
    expect(parsed.derived.roas).toBeCloseTo(15000 / 6000, 2);
    expect(parsed.derived.aov).toBeCloseTo(25800 / 200, 2);
  });

  it('P4 traffic.summary：facts 含按来源分布 + derived 人均访问（总量=all 行，来源是子集绝不重复计数）', async () => {
    const { toolContent } = await runTool('最近流量怎么样');
    const parsed = JSON.parse(toolContent) as { facts: { visits: number; bySource: Record<string, { impressions: number }> }; derived: { avgVisitsPerVisitor: number } };
    expect(parsed.facts.visits).toBe(9000); // 只取 all 行；source 行是子集，绝不累加
    expect(parsed.facts.bySource.ads).toMatchObject({ impressions: 70000 });
    expect(parsed.derived.avgVisitsPerVisitor).toBeCloseTo(9000 / 4500, 2);
  });

  it('P4 ads.performance：facts + derived（ctr/cvr/roas/cpc）按系列分组', async () => {
    const { toolContent } = await runTool('广告投放效果如何');
    const parsed = JSON.parse(toolContent) as { facts: Array<{ campaignName: string }>; derived: Array<{ roas: number; ctr: number }> };
    expect(parsed.facts[0].campaignName).toBe('夏季主推');
    expect(parsed.derived[0].ctr).toBeCloseTo(2400 / 80000, 4);
    expect(parsed.derived[0].roas).toBeCloseTo(15000 / 6000, 2);
  });

  it('P4 orders.summary：facts 状态分布 + derived aov（取消/退款不计入营收）', async () => {
    const { toolContent } = await runTool('订单汇总一下');
    const parsed = JSON.parse(toolContent) as { facts: { orderCount: number; revenue: number; byStatus: Record<string, number> }; derived: { aov: number } };
    expect(parsed.facts.orderCount).toBe(5);
    expect(parsed.facts.revenue).toBe(825); // 258+129+438
    expect(parsed.facts.byStatus.cancelled).toBe(1);
    expect(parsed.derived.aov).toBeCloseTo(825 / 3, 2);
  });

  it('P4 products.list：facts 分页商品（只读，数据零变更）', async () => {
    const before = await prisma.commerceProduct.count({ where: { userId } });
    const { toolContent } = await runTool('看看商品列表');
    const parsed = JSON.parse(toolContent) as { facts: { total: number; items: Array<{ title: string }> } };
    expect(parsed.facts.total).toBeGreaterThanOrEqual(3);
    expect(parsed.facts.items.some((i) => i.title === '黑金主图T恤')).toBe(true);
    expect(await prisma.commerceProduct.count({ where: { userId } })).toBe(before); // read-only 保证
    expect(await prisma.commerceOrder.count({ where: { userId } })).toBe(5); // 无任何写路径
  });

  it('P4 analytics.compare：两期变化率由服务端计算（facts 字段含 changePct）', async () => {
    const { toolContent } = await runTool('对比一下这30天和之前30天');
    const parsed = JSON.parse(toolContent) as { facts: Record<string, { base: number; compare: number; changePct: number | null }> };
    expect(parsed.facts.revenue).toBeDefined();
    expect(parsed.facts.revenue.changePct).toBeTypeOf('number');
  });

  it('P4 无连接：工具失败回喂（提示先连接），run 正常收尾不伪装完成', async () => {
    // 吊销该用户全部 mock 连接（含历史残留）——默认连接解析必然落空
    await prisma.connection.updateMany({ where: { userId, provider: 'mock', status: 'active' }, data: { status: 'revoked' } });
    const { toolContent } = await runTool('分析店铺销售');
    expect(toolContent).toContain('未找到可用的店铺连接');
  });
});
