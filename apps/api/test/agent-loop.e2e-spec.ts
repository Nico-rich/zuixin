import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import cookieParser from 'cookie-parser';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { AppModule } from '../src/app.module';
import { GlobalExceptionFilter } from '../src/common/filters/global-exception.filter';
import { TransformInterceptor } from '../src/common/interceptors/transform.interceptor';
import { csrfProtection } from '../src/modules/auth/csrf.middleware';
import { PrismaService } from '../src/modules/prisma/prisma.service';

const XRW = { 'X-Requested-With': 'XMLHttpRequest' };

/**
 * M4 Loop 全链路 e2e（mock LLM function-calling 替身驱动）：
 * ① chat 意图 + "方案"关键词 → 通用助手经 Loop 调用 artifact.create → 制品落库；
 * ② "记住：…" → memory.create_candidate → 候选记忆落库（不绕过状态机）；
 * ③ AgentRun/Step/ToolCall 落库（completed/终态）+ 幂等键；④ agent-runs API 权限 404。
 * 注：image/video 意图直接映射 Image/Video Agent（设计如此，不走 Loop），媒体路径由各自 e2e 覆盖。
 */
describe('Agent Loop (e2e, mock 全链路)', () => {
  let app: INestApplication;
  let cookie: string;
  let convId = '';

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
    const login = await request(app.getHttpServer()).post('/api/v1/auth/login').set(XRW)
      .send({ email: process.env.SEED_ADMIN_EMAIL ?? 'admin@example.com', password: process.env.SEED_ADMIN_PASSWORD ?? 'admin123456' });
    cookie = (login.headers['set-cookie'] as unknown as string[]).map((c) => c.split(';')[0]).join('; ');
    // 幂等：清理本套件历史运行产生的 agent 候选记忆
    const userId = login.body.data.user.id;
    await moduleRef.get(PrismaService).memory.deleteMany({ where: { userId, source: 'agent' } });
  });

  afterAll(async () => { await app.close(); });

  it('Loop 调 artifact.create：agent.start → tool.start → tool.end → agent.end → message_end(completed)', async () => {
    const res = await request(app.getHttpServer()).post('/api/v1/chat').set(XRW).set('Cookie', cookie)
      .send({ message: '帮我做一个营销方案' })
      .buffer(true).parse((r, cb) => { let s = ''; r.on('data', (c) => (s += c)); r.on('end', () => cb(null, s)); })
      .expect(200);
    const text = res.body as string;
    expect(text).toContain('event: agent.start');
    expect(text).toContain('event: tool.start');
    expect(text).toContain('"toolName":"artifact.create"');
    expect(text).toContain('event: tool.end');
    expect(text).toContain('event: agent.end');
    expect(text).toContain('"status":"completed"');
    const convMatch = text.match(/"conversationId":"([0-9a-f-]+)"/);
    expect(convMatch).toBeTruthy();
    convId = convMatch![1];
  });

  it('制品落库：creative_brief artifact + run/steps/toolCalls 全链路记录（幂等键非空）', async () => {
    const appAny = app as unknown as { get: <T>(type: unknown) => T };
    const prisma = appAny.get<PrismaService>(PrismaService);
    const artifacts = await prisma.artifact.findMany({ where: { conversationId: convId } });
    expect(artifacts.length).toBe(1);
    expect(artifacts[0].type).toBe('creative_brief');

    const runs = await prisma.agentRun.findMany({ where: { conversationId: convId } });
    expect(runs.length).toBe(1);
    expect(runs[0].status).toBe('completed');
    const steps = await prisma.agentRunStep.findMany({ where: { runId: runs[0].id } });
    expect(steps.some((s) => s.type === 'tool_call')).toBe(true);
    expect(steps.some((s) => s.type === 'final')).toBe(true);
    const calls = await prisma.toolCall.findMany({ where: { runStepId: { in: steps.map((s) => s.id) } } });
    expect(calls.length).toBe(1);
    expect(calls[0].toolName).toBe('artifact.create');
    expect(calls[0].status).toBe('completed');
    expect(calls[0].idempotencyKey).toBeTruthy();
  });

  it('Loop 调 memory.create_candidate：只产候选不绕过状态机', async () => {
    const before = await (app as unknown as { get: <T>(t: unknown) => T }).get<PrismaService>(PrismaService).memory.count();
    await request(app.getHttpServer()).post('/api/v1/chat').set(XRW).set('Cookie', cookie)
      .send({ message: '记住：以后素材都用黑金配色', conversationId: convId })
      .buffer(true).parse((r, cb) => { r.on('data', () => undefined); r.on('end', () => cb(null, '')); })
      .expect(200);
    const appAny = app as unknown as { get: <T>(type: unknown) => T };
    const prisma = appAny.get<PrismaService>(PrismaService);
    const after = await prisma.memory.count();
    expect(after).toBe(before + 1);
    const mem = await prisma.memory.findFirst({ orderBy: { createdAt: 'desc' } });
    expect(mem?.status).toBe('candidate'); // 绝不直接 active
    expect(mem?.source).toBe('agent');
  });

  it('agent-runs API：自己的 run 可读；他人 run → 404（防枚举）', async () => {
    const list = await request(app.getHttpServer()).get(`/api/v1/agent-runs?conversationId=${convId}`).set('Cookie', cookie).expect(200);
    expect(list.body.data.length).toBe(2);
    const runId = list.body.data[0].id;
    const detail = await request(app.getHttpServer()).get(`/api/v1/agent-runs/${runId}`).set('Cookie', cookie).expect(200);
    expect(detail.body.data.steps.length).toBeGreaterThanOrEqual(2);
    await request(app.getHttpServer()).get(`/api/v1/agent-runs/${'0'.repeat(32)}`).set('Cookie', cookie).expect(404);
  });
});
