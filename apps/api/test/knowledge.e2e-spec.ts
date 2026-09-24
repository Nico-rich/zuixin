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
import { ContextAssembler } from '../src/core/context/context-assembler';
import { AgentRegistryService } from '../src/agents/agent-registry.service';

const XRW = { 'X-Requested-With': 'XMLHttpRequest' };

/**
 * M5-P5 Knowledge 全链路 e2e（mock-embedding 替身）：
 * 文档生命周期 → pgvector 检索 → knowledge.search Tool（Agent Loop）→ KnowledgeSource 注入 → 级联删除。
 */
describe('Knowledge (e2e, mock-embedding 全链路)', () => {
  let app: INestApplication;
  let cookie: string;
  let userId: string;
  let docId = '';
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
    userId = login.body.data.user.id;
    // 幂等：清理本套件历史文档
    await moduleRef.get(PrismaService).document.deleteMany({ where: { userId } });
  });

  afterAll(async () => { await app.close(); });

  it('文档生命周期：text 创建 → 同步索引 → ready + chunkCount ≥1', async () => {
    const content = '产品规格说明书。本产品是智能插排，尺寸 2000×2000 像素主图规范，品牌色为黑金配色。'.repeat(20);
    const res = await request(app.getHttpServer()).post('/api/v1/knowledge/documents').set(XRW).set('Cookie', cookie)
      .send({ name: '产品规格', sourceType: 'text', content }).expect(201);
    docId = res.body.data.id;
    expect(res.body.data.status).toBe('ready');
    expect(res.body.data.chunkCount).toBeGreaterThanOrEqual(1);
  });

  it('越权：他人文档 → 404（防枚举）', async () => {
    await request(app.getHttpServer()).get(`/api/v1/knowledge/documents/${'0'.repeat(32)}`).set('Cookie', cookie).expect(404);
  });

  it('file 源缺 attachmentId → 400；不支持类型校验', async () => {
    const res = await request(app.getHttpServer()).post('/api/v1/knowledge/documents').set(XRW).set('Cookie', cookie)
      .send({ name: 'x', sourceType: 'file' }).expect(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('knowledge.search Tool 全链路：Agent Loop 经 Tool 检索（run/toolCall 落库）', async () => {
    // 开启 general-assistant 的 knowledge（模拟后台配置）
    const appAny = app as unknown as { get: <T>(type: unknown) => T };
    const prisma = appAny.get<PrismaService>(PrismaService);
    const agent = await prisma.agent.findUnique({ where: { slug: 'general-assistant' }, include: { activeVersion: true } });
    await prisma.agentVersion.update({
      where: { id: agent!.activeVersionId! },
      data: { config: { maxSteps: 8, knowledge: { enabled: true } } },
    });
    await appAny.get<AgentRegistryService>(AgentRegistryService).refresh();

    const res = await request(app.getHttpServer()).post('/api/v1/chat').set(XRW).set('Cookie', cookie)
      .send({ message: '帮我查一下产品规格资料' })
      .buffer(true).parse((r, cb) => { let s = ''; r.on('data', (c) => (s += c)); r.on('end', () => cb(null, s)); })
      .expect(200);
    const text = res.body as string;
    expect(text).toContain('event: tool.start');
    expect(text).toContain('"toolName":"knowledge.search"');
    expect(text).toContain('event: tool.end');
    const convMatch = text.match(/"conversationId":"([0-9a-f-]+)"/);
    convId = convMatch![1];

    const runs = await prisma.agentRun.findMany({ where: { conversationId: convId } });
    expect(runs.length).toBe(1);
    const steps = await prisma.agentRunStep.findMany({ where: { runId: runs[0].id } });
    const calls = await prisma.toolCall.findMany({ where: { runStepId: { in: steps.map((s) => s.id) } } });
    expect(calls.some((c) => c.toolName === 'knowledge.search')).toBe(true);
    const kCall = calls.find((c) => c.toolName === 'knowledge.search')!;
    expect(kCall.status).toBe('completed');
    expect(kCall.output).toBeTruthy();

    // 恢复默认关闭（不影响其他 e2e 套件）
    await prisma.agentVersion.update({ where: { id: agent!.activeVersionId! }, data: { config: { maxSteps: 8, knowledge: { enabled: false } } } });
    await appAny.get<AgentRegistryService>(AgentRegistryService).refresh();
  });

  it('KnowledgeSource（Path A）：enabled 时注入 [Knowledge] 块；disabled 不检索', async () => {
    const appAny = app as unknown as { get: <T>(type: unknown) => T };
    const assembler = appAny.get<ContextAssembler>(ContextAssembler);
    const enabled = await assembler.assemble({
      userId, conversationId: '00000000-0000-0000-0000-000000000000',
      userMessage: '智能插排的主图规范是什么', knowledge: { enabled: true },
    });
    expect(enabled.blocks.some((b) => b.scope === 'knowledge' && b.content.includes('[Knowledge]'))).toBe(true);
    const disabled = await assembler.assemble({
      userId, conversationId: '00000000-0000-0000-0000-000000000000',
      userMessage: '智能插排的主图规范是什么', knowledge: { enabled: false },
    });
    expect(disabled.blocks.some((b) => b.scope === 'knowledge')).toBe(false);
  });

  it('删除级联：delete 文档 → chunks 清零（无孤儿数据）', async () => {
    const appAny = app as unknown as { get: <T>(type: unknown) => T };
    const prisma = appAny.get<PrismaService>(PrismaService);
    await request(app.getHttpServer()).delete(`/api/v1/knowledge/documents/${docId}`).set(XRW).set('Cookie', cookie).expect(200);
    expect(await prisma.documentChunk.count({ where: { documentId: docId } })).toBe(0);
    await request(app.getHttpServer()).get(`/api/v1/knowledge/documents/${docId}`).set('Cookie', cookie).expect(404);
  });
});
