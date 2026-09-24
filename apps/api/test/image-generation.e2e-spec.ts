import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import cookieParser from 'cookie-parser';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { AppModule } from '../src/app.module';
import { GlobalExceptionFilter } from '../src/common/filters/global-exception.filter';
import { TransformInterceptor } from '../src/common/interceptors/transform.interceptor';
import { csrfProtection } from '../src/modules/auth/csrf.middleware';
import { MediaGenerationService } from '../src/modules/generations/media-generation.service';
import { PrismaService } from '../src/modules/prisma/prisma.service';

const XRW = { 'X-Requested-With': 'XMLHttpRequest' };

/**
 * 图片生成全链路 e2e（mock-router 分类 + mock-image 生图 + worker 消费）：
 * POST /chat "帮我做一张主图" → SSE task.created → 任务 completed → messages 带 generated_image 附件。
 */
describe('Image Generation (e2e, mock 全链路)', () => {
  let app: INestApplication;
  let cookie: string;
  let taskId: string;
  let convId = ''; // 从本套件 SSE 流捕获，避免并行 e2e 共享 DB 污染

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
    // 幂等：重置本套件用户当日 image 用量，避免反复运行触发每日限额
    const userId = login.body.data.user.id;
    const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);
    await moduleRef.get(PrismaService).usageRecord.deleteMany({ where: { userId, kind: 'image', createdAt: { gte: todayStart } } });
  });

  afterAll(async () => { await app.close(); });

  it('聊天生图：SSE task.created → 任务进入队列', async () => {
    const res = await request(app.getHttpServer()).post('/api/v1/chat').set(XRW).set('Cookie', cookie)
      .send({ message: '帮我做一张科技感主图' })
      .buffer(true).parse((r, cb) => { let s = ''; r.on('data', (c) => (s += c)); r.on('end', () => cb(null, s)); })
      .expect(200);
    const text = res.body as string;
    expect(text).toContain('event: task.created');
    expect(text).toContain('"kind":"image"');
    const match = text.match(/"taskId":"([0-9a-f-]+)"/);
    expect(match).toBeTruthy();
    taskId = match![1];
    const convMatch = text.match(/"conversationId":"([0-9a-f-]+)"/);
    expect(convMatch).toBeTruthy();
    convId = convMatch![1];
  });

  it('用户消息 intentType 落库为 image_generation', async () => {
    const msgs = await request(app.getHttpServer()).get(`/api/v1/conversations/${convId}/messages`).set('Cookie', cookie).expect(200);
    const userMsg = msgs.body.data.find((m: { role: string }) => m.role === 'user');
    expect(userMsg.intentType).toBe('image_generation');
  });

  it('任务完成：generated_image 附件挂到消息 + 用量落库', async () => {
    // 经 app 容器取服务执行任务（等价于 worker 消费队列；生产由独立 worker 进程执行）
    const appAny = app as unknown as { get: <T>(type: unknown) => T };
    await appAny.get<MediaGenerationService>(MediaGenerationService).executeTask(taskId);

    const polled = await request(app.getHttpServer()).get(`/api/v1/tasks/${taskId}`).set('Cookie', cookie).expect(200);
    expect(polled.body.data.status).toBe('completed');
    expect(polled.body.data.progress).toBe(100);

    const msgs = await request(app.getHttpServer()).get(`/api/v1/conversations/${convId}/messages`).set('Cookie', cookie).expect(200);
    const assistant = msgs.body.data.find((m: { role: string }) => m.role === 'assistant') as { id: string };
    const attachments = await appAny.get<PrismaService>(PrismaService).attachment.findMany({ where: { messageId: assistant.id } });
    expect(attachments.length).toBe(1);
    expect(attachments[0].kind).toBe('generated_image');
  });

  it('P3 linkage：非 Agent 路径（ImageAgent 直连）runId/toolCallId 为 null', async () => {
    const appAny = app as unknown as { get: <T>(type: unknown) => T };
    const task = await appAny.get<PrismaService>(PrismaService).generationTask.findUnique({ where: { id: taskId } });
    expect(task?.runId).toBeNull();
    expect(task?.toolCallId).toBeNull();
  });

  it('越权访问任务 → 404；取消已完成任务 → 409', async () => {
    await request(app.getHttpServer()).get(`/api/v1/tasks/${'0'.repeat(32)}`).set('Cookie', cookie).expect(404);
    const res = await request(app.getHttpServer()).post(`/api/v1/tasks/${taskId}/cancel`).set(XRW).set('Cookie', cookie).expect(409);
    expect(res.body.error.code).toBe('TASK_NOT_CANCELLABLE');
  });
});
