import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import cookieParser from 'cookie-parser';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { AppModule } from '../src/app.module';
import { GlobalExceptionFilter } from '../src/common/filters/global-exception.filter';
import { TransformInterceptor } from '../src/common/interceptors/transform.interceptor';
import { csrfProtection } from '../src/modules/auth/csrf.middleware';
import { ContextAssembler } from '../src/core/context/context-assembler';
import { PrismaService } from '../src/modules/prisma/prisma.service';

const XRW = { 'X-Requested-With': 'XMLHttpRequest' };

describe('ContextAssembler × Memory 集成 (e2e)', () => {
  let app: INestApplication;
  let cookie: string;
  let userId: string;
  let projectId: string;
  let assembler: ContextAssembler;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.use(cookieParser());
    app.use('/api/v1', csrfProtection);
    app.setGlobalPrefix('api/v1');
    app.useGlobalFilters(moduleRef.get(GlobalExceptionFilter));
    app.useGlobalInterceptors(new TransformInterceptor());
    await app.init();
    assembler = moduleRef.get(ContextAssembler);

    const login = await request(app.getHttpServer()).post('/api/v1/auth/login').set(XRW)
      .send({ email: process.env.SEED_ADMIN_EMAIL ?? 'admin@example.com', password: process.env.SEED_ADMIN_PASSWORD ?? 'admin123456' });
    cookie = (login.headers['set-cookie'] as unknown as string[]).map((c) => c.split(';')[0]).join('; ');
    userId = login.body.data.user.id;

    // 幂等：清理上次运行残留的记忆
    const prisma = moduleRef.get(PrismaService);
    await prisma.memory.deleteMany({ where: { userId } });

    const project = await request(app.getHttpServer()).post('/api/v1/projects').set(XRW).set('Cookie', cookie)
      .send({ name: '记忆集成测试项目' }).expect(201);
    projectId = project.body.data.id;
  });

  afterAll(async () => { await app.close(); });

  it('记忆 CRUD 全链路：user 记忆 + project 记忆 + candidate→active', async () => {
    // user memory（active 直建）
    await request(app.getHttpServer()).post('/api/v1/memories').set(XRW).set('Cookie', cookie)
      .send({ scope: 'user', content: '亚马逊主图 2000×2000', category: 'preference', importance: 80, status: 'active', source: 'manual' }).expect(201);

    // project memory（candidate → active 确认流）
    const candidate = await request(app.getHttpServer()).post('/api/v1/memories').set(XRW).set('Cookie', cookie)
      .send({ scope: 'project', projectId, content: '品牌：科技感插排，黑金配色', category: 'project_context', status: 'candidate', confidence: 0.9 }).expect(201);
    const id = candidate.body.data.id;
    expect(candidate.body.data.status).toBe('candidate');

    const activated = await request(app.getHttpServer()).patch(`/api/v1/memories/${id}`).set(XRW).set('Cookie', cookie)
      .send({ status: 'active' }).expect(200);
    expect(activated.body.data.status).toBe('active');

    // 搜索
    const found = await request(app.getHttpServer()).get('/api/v1/memories?q=2000').set('Cookie', cookie).expect(200);
    expect(found.body.data.some((m: { content: string }) => m.content.includes('2000×2000'))).toBe(true);
  });

  it('Assembler 组装：项目记忆(order10) → 用户记忆(order20) → 最近消息(order100)', async () => {
    const { messages, blocks } = await assembler.assemble({
      userId, conversationId: '00000000-0000-0000-0000-000000000000', projectId, excludeMessageId: '00000000-0000-0000-0000-000000000001',
    });
    const memoryBlocks = blocks.filter((b) => b.scope !== 'conversation');
    expect(memoryBlocks.map((b) => b.scope)).toEqual(['project', 'user']);
    expect(memoryBlocks[0].content).toContain('【项目记忆】');
    expect(memoryBlocks[1].content).toContain('【用户长期记忆】');
    // 顺序：project(10) < user(20)
    expect(memoryBlocks[0].order!).toBeLessThan(memoryBlocks[1].order!);
    expect(messages[0].role).toBe('user');
  });

  it('无项目时：仅用户记忆参与组装（M1 行为兼容）', async () => {
    const { blocks } = await assembler.assemble({
      userId, conversationId: '00000000-0000-0000-0000-000000000000',
    });
    const memoryBlocks = blocks.filter((b) => b.scope !== 'conversation');
    expect(memoryBlocks.map((b) => b.scope)).toEqual(['user']);
  });
});
