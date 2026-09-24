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
 * M7-P5 Commerce Analysis + Creative Decision Loop e2e（真实 DB/Redis/Worker + mock 连接 + 双期种子数据）：
 * 分析工具（facts/derived/anomalies 服务端 + LLM 推测分离存储）→ 创意简报（自动挂最新分析证据 + Artifact 镜像）
 * → 复用现有 Image Agent/GenerationTask 管线（不重造媒体层）。
 */
describe('M7-P5 Commerce Analysis + Creative Brief (e2e, 双期数据)', () => {
  let app: INestApplication;
  let worker: INestApplicationContext;
  let prisma: PrismaService;
  let cookie: string;
  let userId = '';
  let agentId = '';
  let connectionId = '';
  let createdRunIds: string[] = [];
  let imageQueue: { pause(): Promise<void>; resume(): Promise<void>; close(): Promise<void> };

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
      .query({ state: start.body.data.state, code: 'p5-conn' }).expect(200);
    connectionId = cb.body.data.id;

    // 双期种子：前一期（60~30 天前，基线较好）vs 当前期（30~0 天，各项下降 → 规则异常触发）
    const now = Date.now();
    const day = (offset: number) => new Date(now - offset * 86400_000);
    await prisma.commerceRevenueMetric.createMany({
      data: [
        { userId, provider: 'mock', connectionId, periodStart: day(59), periodEnd: day(30), revenue: 30000, orders: 230, refunds: 500, netRevenue: 29500 },
        { userId, provider: 'mock', connectionId, periodStart: day(29), periodEnd: day(0), revenue: 25800, orders: 200, refunds: 89, netRevenue: 25711 },
      ],
    });
    await prisma.commerceTrafficMetric.createMany({
      data: [
        { userId, provider: 'mock', connectionId, periodStart: day(59), periodEnd: day(30), dimension: 'all', dimensionValue: 'all', impressions: 150000, visits: 12000, uniqueVisitors: 6000 },
        { userId, provider: 'mock', connectionId, periodStart: day(29), periodEnd: day(0), dimension: 'all', dimensionValue: 'all', impressions: 120000, visits: 9000, uniqueVisitors: 4500 },
        { userId, provider: 'mock', connectionId, periodStart: day(29), periodEnd: day(0), dimension: 'source', dimensionValue: 'ads', impressions: 70000, visits: 5000, uniqueVisitors: 2500 },
      ],
    });
    await prisma.commerceConversionMetric.createMany({
      data: [
        { userId, provider: 'mock', connectionId, periodStart: day(59), periodEnd: day(30), dimension: 'all', dimensionValue: 'all', clicks: 8000, addToCart: 1200, checkouts: 400, orders: 230, revenue: 30000 },
        { userId, provider: 'mock', connectionId, periodStart: day(29), periodEnd: day(0), dimension: 'all', dimensionValue: 'all', clicks: 6000, addToCart: 900, checkouts: 300, orders: 200, revenue: 25800 },
      ],
    });
    const campaign = await prisma.commerceCampaign.create({
      data: { userId, provider: 'mock', connectionId, externalId: 'C-P5', name: '夏季主推', status: 'active' },
    });
    await prisma.commerceAdMetric.createMany({
      data: [
        { userId, provider: 'mock', connectionId, campaignId: campaign.id, adId: null, periodStart: day(59), periodEnd: day(30), impressions: 90000, clicks: 3600, spend: 5000, conversions: 180, revenue: 20000 },
        { userId, provider: 'mock', connectionId, campaignId: campaign.id, adId: null, periodStart: day(29), periodEnd: day(0), impressions: 80000, clicks: 2400, spend: 6000, conversions: 120, revenue: 15000 },
      ],
    });

    // 分析决策环 Agent（无 image.generate——主图生成走既有管线/专用 Agent）
    const agent = await prisma.agent.create({
      data: {
        slug: `analysis-${Date.now()}`, name: '电商分析决策 Agent', enabled: true, builtin: false, kind: 'custom', scope: 'system',
        versions: {
          create: {
            version: 1, status: 'published', systemPrompt: '你是电商分析助手。事实与推测必须分开。', temperature: 0.7,
            tools: ['commerce.analytics.summary', 'commerce.analysis.generate', 'creativeBrief.create'] as never,
            config: { maxSteps: 6 } as never,
          },
        },
      },
      include: { versions: true },
    });
    agentId = agent.id;
    await prisma.agent.update({ where: { id: agent.id }, data: { activeVersionId: agent.versions[0].id } });

    const { NestFactory } = await import('@nestjs/core');
    worker = await NestFactory.createApplicationContext(WorkerModule, { bufferLogs: false });
    const { Queue } = await import('bullmq');
    imageQueue = new Queue('image', { connection: { url: process.env.REDIS_URL ?? 'redis://localhost:6379', maxRetriesPerRequest: null } });
  });

  afterAll(async () => {
    await imageQueue?.resume().catch(() => undefined);
    await imageQueue?.close().catch(() => undefined);
    if (createdRunIds.length) {
      await prisma.generationTask.deleteMany({ where: { runId: { in: createdRunIds } } });
      await prisma.artifact.deleteMany({ where: { runId: { in: createdRunIds } } });
      await prisma.usageRecord.deleteMany({ where: { runId: { in: createdRunIds } } });
      await prisma.agentRunMessage.deleteMany({ where: { runId: { in: createdRunIds } } });
      await prisma.creativeBrief.deleteMany({ where: { agentRunId: { in: createdRunIds } } });
      await prisma.commerceAnalysis.deleteMany({ where: { agentRunId: { in: createdRunIds } } });
      await prisma.agentRun.deleteMany({ where: { id: { in: createdRunIds } } });
    }
    await prisma.commerceAdMetric.deleteMany({ where: { userId } });
    await prisma.commerceCampaign.deleteMany({ where: { userId } });
    await prisma.commerceRevenueMetric.deleteMany({ where: { userId } });
    await prisma.commerceTrafficMetric.deleteMany({ where: { userId } });
    await prisma.commerceConversionMetric.deleteMany({ where: { userId } });
    await prisma.credential.deleteMany({ where: { connectionId } });
    await prisma.connection.deleteMany({ where: { id: connectionId } });
    if (agentId) await prisma.agent.delete({ where: { id: agentId } }).catch(() => undefined);
    await worker?.close().catch(() => undefined);
    await app.close();
  });

  async function runTool(message: string): Promise<{ runId: string; toolContent: string }> {
    const res = await request(app.getHttpServer()).post('/api/v1/agent-runs').set(XRW).set('Cookie', cookie)
      .send({ agentId, message }).expect(201);
    const runId = res.body.data.runId as string;
    createdRunIds.push(runId);
    expect(await waitForStatus(prisma, runId, ['completed', 'failed'], 30_000)).toBe('completed');
    const toolRow = await prisma.agentRunMessage.findFirst({ where: { runId, role: 'tool' } });
    return { runId, toolContent: toolRow?.content ?? '' };
  }

  it('P5 分析：规则异常（营收-14%/访问-25%/ROAS-37.5% 下降）由服务端判定；LLM 推测独立标注', async () => {
    const { runId, toolContent } = await runTool('分析转化率下降的原因');
    const parsed = JSON.parse(toolContent) as {
      analysisId: string; facts: Record<string, unknown>;
      anomalies: Array<{ metric: string; changePct: number; rule: string }>;
      possibleCauses: { source: string; items: string[] };
      layering: Record<string, string>;
    };
    expect(parsed.facts.revenue).toBe(25800);
    const revenueAnomaly = parsed.anomalies.find((a) => a.metric === 'revenue');
    expect(revenueAnomaly).toBeTruthy();
    expect(revenueAnomaly!.changePct).toBeCloseTo(-14, 0);
    expect(parsed.anomalies.some((a) => a.metric === 'visits')).toBe(true);
    expect(parsed.anomalies.some((a) => a.metric === 'roas')).toBe(true);
    expect(parsed.anomalies.every((a) => a.rule === 'server-threshold')).toBe(true);
    expect(parsed.possibleCauses).toMatchObject({ source: 'llm-interpretation', items: ['流量质量下降（推测）'] });
    expect(parsed.layering).toMatchObject({ facts: 'service-computed', possibleCauses: 'llm-interpretation' });

    // DB 分层断言：推测绝不混入事实
    const row = await prisma.commerceAnalysis.findFirst({ where: { agentRunId: runId } });
    expect(row).toBeTruthy();
    expect(JSON.stringify(row!.facts)).not.toContain('流量质量下降');
    expect((row!.possibleCauses as { source: string }).source).toBe('llm-interpretation');
  });

  it('P5 创意简报：自动挂最新分析证据（facts/derived/anomalies 快照）+ Artifact 镜像', async () => {
    const latestAnalysis = await prisma.commerceAnalysis.findFirst({ where: { userId }, orderBy: { createdAt: 'desc' } });
    const { runId, toolContent } = await runTool('生成3套主图创意方案');
    const parsed = JSON.parse(toolContent) as {
      briefId: string; artifactId: string | null; analysisId: string | null;
      layering: Record<string, string>;
    };
    expect(parsed.analysisId).toBe(latestAnalysis!.id); // 自动关联
    expect(parsed.artifactId).toBeTruthy(); // Artifact 镜像
    expect(parsed.layering).toMatchObject({ creativeAngle: 'llm-suggestion', evidence: 'service-computed' });

    const brief = await prisma.creativeBrief.findFirst({ where: { agentRunId: runId } });
    expect(brief).toBeTruthy();
    expect(brief!.problem).toBe('转化率下降');
    expect(brief!.creativeAngle).toBe('黑金质感');
    expect(brief!.visualDirection).toContain('黑金配色');
    const evidence = brief!.evidence as { analysisId: string; facts: Record<string, unknown>; layering: Record<string, string> };
    expect(evidence.analysisId).toBe(latestAnalysis!.id);
    expect(evidence.facts.revenue).toBe(25800);
    expect(evidence.layering.facts).toBe('service-computed');
    expect(brief!.artifactId).toBe(parsed.artifactId); // 制品镜像落库
    const artifact = await prisma.artifact.findUnique({ where: { id: parsed.artifactId! } });
    expect(artifact?.type).toBe('creative_brief');
  });

  it('P5 创意决策环闭环：简报方向 → 复用既有 Image Agent/GenerationTask 管线（不重造媒体层）', async () => {
    await imageQueue.pause(); // 确定性 waiting
    // general-assistant（既有 Image Agent 管线）按简报视觉方向生成主图
    const res = await request(app.getHttpServer()).post('/api/v1/agent-runs').set(XRW).set('Cookie', cookie)
      .send({ message: '根据简报生成黑金配色主图' })
      .expect(201);
    const runId = res.body.data.runId as string;
    createdRunIds.push(runId);
    expect(await waitForStatus(prisma, runId, ['waiting'], 25_000)).toBe('waiting'); // M6 waiting 语义复用
    await imageQueue.resume();
    expect(await waitForStatus(prisma, runId, ['completed', 'failed'], 30_000)).toBe('completed');
    const task = await prisma.generationTask.findFirst({ where: { runId } });
    expect(task).toBeTruthy();
    expect((task!.input as { prompt: string }).prompt).toContain('黑金配色'); // 简报视觉方向进入生成管线
    expect(task!.toolCallId).toBeTruthy(); // 追溯链完整
  });
});
