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
import { MediaCleanupService } from '../src/modules/generations/media-cleanup.service';
import { PrismaService } from '../src/modules/prisma/prisma.service';

const XRW = { 'X-Requested-With': 'XMLHttpRequest' };

/**
 * 视频生成全链路 e2e（mock-router 分类 + mock-video 替身 + 统一 MediaGenerationService）：
 * POST /chat "帮我做一个视频" → SSE task.created(kind=video) → 任务完成 → generated_video 附件。
 * 另验证：孤儿清扫（人为造 processing 超时任务 → sweep → failed MEDIA_TASK_TIMEOUT）。
 */
describe('Video Generation (e2e, mock 全链路)', () => {
  let app: INestApplication;
  let cookie: string;
  let taskId: string;
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
  });

  afterAll(async () => { await app.close(); });

  it('聊天生视频：SSE task.created(kind=video) → 任务进入视频队列', async () => {
    const res = await request(app.getHttpServer()).post('/api/v1/chat').set(XRW).set('Cookie', cookie)
      .send({ message: '帮我做一个产品视频' })
      .buffer(true).parse((r, cb) => { let s = ''; r.on('data', (c) => (s += c)); r.on('end', () => cb(null, s)); })
      .expect(200);
    const text = res.body as string;
    expect(text).toContain('event: task.created');
    expect(text).toContain('"kind":"video"');
    const match = text.match(/"taskId":"([0-9a-f-]+)"/);
    expect(match).toBeTruthy();
    taskId = match![1];
    const convMatch = text.match(/"conversationId":"([0-9a-f-]+)"/);
    expect(convMatch).toBeTruthy();
    convId = convMatch![1];
  });

  it('任务完成：generated_video 附件（video/mp4）挂到消息 + video 用量落库', async () => {
    // 经 app 容器执行任务（等价于 Worker 消费；mock-video 约 10s 轮询完成）
    const appAny = app as unknown as { get: <T>(type: unknown) => T };
    await appAny.get<MediaGenerationService>(MediaGenerationService).executeTask(taskId);

    const polled = await request(app.getHttpServer()).get(`/api/v1/tasks/${taskId}`).set('Cookie', cookie).expect(200);
    expect(polled.body.data.status).toBe('completed');
    expect(polled.body.data.progress).toBe(100);

    const msgs = await request(app.getHttpServer()).get(`/api/v1/conversations/${convId}/messages`).set('Cookie', cookie).expect(200);
    const assistant = msgs.body.data.find((m: { role: string }) => m.role === 'assistant') as { id: string };
    const attachments = await appAny.get<PrismaService>(PrismaService).attachment.findMany({ where: { messageId: assistant.id } });
    expect(attachments.length).toBe(1);
    expect(attachments[0].kind).toBe('generated_video');
    expect(attachments[0].mimeType).toBe('video/mp4');
    const usage = await appAny.get<PrismaService>(PrismaService).usageRecord.findFirst({
      where: { taskId, kind: 'video' }, orderBy: { createdAt: 'desc' },
    });
    expect(usage?.status).toBe('success');
    expect(usage?.videoSeconds).toBeGreaterThanOrEqual(0);
  }, 30000);

  it('孤儿清扫：processing 超时任务 → failed(MEDIA_TASK_TIMEOUT)', async () => {
    const appAny = app as unknown as { get: <T>(type: unknown) => T };
    const prisma = appAny.get<PrismaService>(PrismaService);
    const orphan = await prisma.generationTask.create({
      data: {
        userId: (await prisma.user.findFirst())!.id,
        type: 'image', status: 'processing', input: { prompt: 'x' },
        startedAt: new Date(Date.now() - 10 * 60_000), // 10 分钟前开始（超过 5min 护栏）
      },
    });
    const swept = await appAny.get<MediaCleanupService>(MediaCleanupService).sweep();
    expect(swept).toBeGreaterThanOrEqual(1);
    const after = await prisma.generationTask.findUnique({ where: { id: orphan.id } });
    expect(after?.status).toBe('failed');
    expect(after?.errorCode).toBe('MEDIA_TASK_TIMEOUT');
    // 幂等：再次清扫不影响（已经 failed）
    await appAny.get<MediaCleanupService>(MediaCleanupService).sweep();
    const again = await prisma.generationTask.findUnique({ where: { id: orphan.id } });
    expect(again?.status).toBe('failed');
  });

  it('重复执行已完成任务 → 幂等跳过（单任务单结果）', async () => {
    const appAny = app as unknown as { get: <T>(type: unknown) => T };
    const prisma = appAny.get<PrismaService>(PrismaService);
    await appAny.get<MediaGenerationService>(MediaGenerationService).executeTask(taskId);
    const attachments = await prisma.attachment.findMany({ where: { taskId } });
    expect(attachments.length).toBe(1); // 不产生第二个视频附件
  });
});
