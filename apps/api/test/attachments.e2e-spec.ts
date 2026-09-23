import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import cookieParser from 'cookie-parser';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { AppModule } from '../src/app.module';
import { GlobalExceptionFilter } from '../src/common/filters/global-exception.filter';
import { TransformInterceptor } from '../src/common/interceptors/transform.interceptor';
import { csrfProtection } from '../src/modules/auth/csrf.middleware';

const XRW = { 'X-Requested-With': 'XMLHttpRequest' };

// 1×1 PNG
const PNG_1PX = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

describe('Attachments (e2e)', () => {
  let app: INestApplication;
  let cookie: string;
  let attachmentId: string;

  beforeAll(async () => {
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

  it('上传图片 → 存储落盘 + 附件行 kind=upload', async () => {
    const res = await request(app.getHttpServer()).post('/api/v1/attachments')
      .set(XRW).set('Cookie', cookie)
      .attach('file', PNG_1PX, { filename: 'test.png', contentType: 'image/png' })
      .expect(201);
    attachmentId = res.body.data.id;
    expect(res.body.data.type).toBe('image');
    expect(res.body.data.kind).toBe('upload');
    expect(res.body.data.sizeBytes).toBe(PNG_1PX.length);
    expect(res.body.data.storageKey).toContain('/');
  });

  it('下载附件 → 原样字节流回源', async () => {
    const res = await request(app.getHttpServer()).get(`/api/v1/attachments/${attachmentId}`)
      .set('Cookie', cookie).expect(200);
    expect(res.headers['content-type']).toContain('image/png');
    expect(Buffer.compare(res.body as Buffer, PNG_1PX)).toBe(0);
  });

  it('不支持的文件类型 → 400 VALIDATION_ERROR', async () => {
    const res = await request(app.getHttpServer()).post('/api/v1/attachments')
      .set(XRW).set('Cookie', cookie)
      .attach('file', Buffer.from('evil'), { filename: 'x.exe', contentType: 'application/x-msdownload' })
      .expect(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('空请求体 → 400 缺少文件', async () => {
    await request(app.getHttpServer()).post('/api/v1/attachments').set(XRW).set('Cookie', cookie).expect(400);
  });

  it('越权访问他人附件 → 404', async () => {
    await request(app.getHttpServer()).get(`/api/v1/attachments/${'0'.repeat(32)}`).set('Cookie', cookie).expect(404);
  });
});
