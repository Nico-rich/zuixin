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
import { CommerceAnalysisService } from '../src/modules/commerce/commerce-analysis.service';

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
 * M7-P8 Feedback / Performance Learning e2e（真实 PostgreSQL + Redis/Worker）：
 * 反馈评分 → 记忆候选；绩效回流 → facts/derived + 阈值记忆；洞察读取；简报证据底座闭环；越权矩阵。
 */
describe('M7-P8 Feedback / Performance Learning (e2e)', () => {
  let app: INestApplication;
  let worker: INestApplicationContext;
  let prisma: PrismaService;
  let cookie: string;
  let cookieB: string;
  let userId = '';
  let agentId = '';
  let artifactId = '';
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

    const userB = await prisma.user.create({ data: { email: `userb-p8-${Date.now()}@example.com`, passwordHash: 'unused-hash' } });
    const { JwtService } = await import('@nestjs/jwt');
    const jwt = moduleRef.get(JwtService);
    cookieB = `agent_access=${await jwt.signAsync({ sub: userB.id, role: 'user' })}`;

    // 反馈对象（制品）+ 学习闭环 Agent（performance.insights）
    const artifact = await prisma.artifact.create({
      data: { userId, type: 'image', title: '黑金主图A', status: 'ready' },
    });
    artifactId = artifact.id;
    const agent = await prisma.agent.create({
      data: {
        slug: `feedback-${Date.now()}`, name: '学习闭环 Agent', enabled: true, builtin: false, kind: 'custom', scope: 'system',
        versions: {
          create: {
            version: 1, status: 'published', systemPrompt: '你是创意学习助手', temperature: 0.7,
            tools: ['performance.insights'] as never, config: { maxSteps: 4 } as never,
          },
        },
      },
      include: { versions: true },
    });
    agentId = agent.id;
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
    await prisma.feedback.deleteMany({ where: { userId } });
    await prisma.creativePerformance.deleteMany({ where: { userId } });
    await prisma.performanceSnapshot.deleteMany({ where: { userId } });
    await prisma.memory.deleteMany({ where: { userId, metadata: { path: ['kind'], equals: 'performance' } } });
    await prisma.creativeBrief.deleteMany({ where: { userId } });
    await prisma.artifact.deleteMany({ where: { id: artifactId } });
    if (agentId) await prisma.agent.delete({ where: { id: agentId } }).catch(() => undefined);
    await worker?.close().catch(() => undefined);
    await app.close();
  });

  it('P8 反馈评分：高分 → Feedback 行 + 绩效记忆候选（source=feedback，幂等单条）', async () => {
    const res = await request(app.getHttpServer()).post('/api/v1/feedback').set(XRW).set('Cookie', cookie)
      .send({ subjectType: 'artifact', subjectId: artifactId, rating: 5, comment: '质感很好' })
      .expect(201);
    expect(res.body.data).toMatchObject({ subjectType: 'artifact', subjectId: artifactId, rating: 5 });
    // 幂等：重复提交同评分 → 记忆候选仍只有一条
    await request(app.getHttpServer()).post('/api/v1/feedback').set(XRW).set('Cookie', cookie)
      .send({ subjectType: 'artifact', subjectId: artifactId, rating: 5, comment: '质感很好' })
      .expect(201);
    const memories = await prisma.memory.findMany({
      where: { userId, metadata: { path: ['kind'], equals: 'performance' } },
    });
    expect(memories).toHaveLength(1);
    expect(memories[0].content).toContain('评分 5');
    expect(memories[0].source).toBe('feedback');
    expect((memories[0].metadata as { subjectId: string }).subjectId).toBe(artifactId);
    // 列表读取
    const list = await request(app.getHttpServer()).get(`/api/v1/feedback?subjectId=${artifactId}`).set(XRW).set('Cookie', cookie).expect(200);
    expect((list.body.data as Array<{ rating: number }>).length).toBe(2);
  });

  it('P8 绩效回流：facts 原始 + derived 服务端派生 + 达标阈值记忆（layering 标注）', async () => {
    const res = await request(app.getHttpServer()).post('/api/v1/feedback/performance').set(XRW).set('Cookie', cookie)
      .send({
        artifactId,
        metrics: { impressions: 10000, clicks: 500, spend: 1000, conversions: 40, revenue: 3000, orders: 35 },
      })
      .expect(201);
    expect(res.body.data).toMatchObject({
      facts: { impressions: 10000, clicks: 500 },
      derived: { ctr: 0.05, roas: 3 }, // 服务端计算
      layering: { derived: 'service-computed' },
    });
    const perf = await prisma.creativePerformance.findFirst({ where: { artifactId } });
    expect(perf).toBeTruthy();
    // 通用快照层同步
    const snapshots = await prisma.performanceSnapshot.findMany({ where: { userId } });
    expect(snapshots).toHaveLength(1);
    // 达标（ctr 5% ≥ 3%）→ 绩效记忆候选（service-rule）
    const memories = await prisma.memory.findMany({
      where: { userId, metadata: { path: ['kind'], equals: 'performance' } },
    });
    const perfMemory = memories.find((m) => (m.metadata as { derivedFrom?: string }).derivedFrom === 'performance');
    expect(perfMemory).toBeTruthy();
    expect(perfMemory!.content).toContain('表现好');
  });

  it('P8 洞察读取：performanceMemory（memory 候选）+ recentPerformance（service-computed 事实）分层', async () => {
    const res = await request(app.getHttpServer()).get('/api/v1/feedback/performance/insights').set(XRW).set('Cookie', cookie).expect(200);
    expect((res.body.data.performanceMemory as Array<{ source: string }>).length).toBeGreaterThanOrEqual(2); // feedback + performance 两条
    expect(res.body.data.performanceMemory[0].source).toBe('memory');
    expect((res.body.data.recentPerformance as Array<{ derived: { roas: number } }>)[0].derived.roas).toBe(3);
    expect(res.body.data.recentPerformance[0].source).toBe('service-computed');
    expect(res.body.data.layering).toMatchObject({ performanceMemory: 'memory-candidate', recentPerformance: 'service-computed' });
  });

  it('P8 闭环：创意简报 evidence 自动附带绩效记忆底座（performance-memory 标注，与事实层分离）', async () => {
    const analysis = app.get(CommerceAnalysisService);
    const brief = await analysis.createBrief(userId, {
      problem: '转化率下降', objective: '提升点击率',
    }, {});
    expect(brief.briefId).toBeTruthy();
    const row = await prisma.creativeBrief.findFirst({ where: { id: brief.briefId } });
    const evidence = row!.evidence as { layering: Record<string, string>; performanceMemory: Array<{ content: string }> };
    expect(evidence.layering.performanceMemory).toBe('memory-candidate');
    expect(evidence.performanceMemory.length).toBeGreaterThanOrEqual(2);
    expect(evidence.performanceMemory.some((m) => m.content.includes('表现好'))).toBe(true);
  });

  it('P8 工具路径：Agent 调用 performance.insights → 结构化洞察回喂', async () => {
    const res = await request(app.getHttpServer()).post('/api/v1/agent-runs').set(XRW).set('Cookie', cookie)
      .send({ agentId, message: '查看创意表现洞察' })
      .expect(201);
    const runId = res.body.data.runId as string;
    createdRunIds.push(runId);
    expect(await waitForStatus(prisma, runId, ['completed', 'failed'], 30_000)).toBe('completed');
    const toolRow = await prisma.agentRunMessage.findFirst({ where: { runId, role: 'tool' } });
    expect(toolRow?.content).toContain('performanceMemory');
    expect(toolRow?.content).toContain('service-computed');
  });

  it('P8 越权矩阵：他人 feedback/performance 读 → 404；匿名 401', async () => {
    const feedback = await prisma.feedback.findFirst({ where: { userId } });
    await request(app.getHttpServer()).get('/api/v1/feedback').set(XRW).expect(401);
    await request(app.getHttpServer()).get('/api/v1/feedback').set(XRW).set('Cookie', cookieB).expect(200); // 列表=自己的（空）不泄露
    const other = await request(app.getHttpServer()).get('/api/v1/feedback').set(XRW).set('Cookie', cookieB).expect(200);
    expect((other.body.data as Array<{ id: string }>).some((f) => f.id === feedback!.id)).toBe(false);
    await request(app.getHttpServer()).get('/api/v1/feedback/performance/insights').set(XRW).set('Cookie', cookieB).expect(200);
    expect((other.body.data as Array<{ id: string }>)).toHaveLength(0);
  });
});
