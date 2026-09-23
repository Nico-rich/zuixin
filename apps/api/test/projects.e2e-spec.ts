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

describe('Projects (e2e)', () => {
  let app: INestApplication;
  let cookie: string;
  let projectId: string;

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

  it('未登录 → 401', async () => {
    await request(app.getHttpServer()).get('/api/v1/projects').expect(401);
  });

  it('创建 → 列表 → 详情 → 修改 全链路', async () => {
    const created = await request(app.getHttpServer()).post('/api/v1/projects').set(XRW).set('Cookie', cookie)
      .send({ name: '亚马逊店铺', description: '智能插排项目', metadata: { brand: '科技感' } }).expect(201);
    projectId = created.body.data.id;
    expect(created.body.data.name).toBe('亚马逊店铺');

    const list = await request(app.getHttpServer()).get('/api/v1/projects').set('Cookie', cookie).expect(200);
    expect(list.body.data.some((p: { id: string }) => p.id === projectId)).toBe(true);

    const detail = await request(app.getHttpServer()).get(`/api/v1/projects/${projectId}`).set('Cookie', cookie).expect(200);
    expect(detail.body.data.description).toBe('智能插排项目');

    const updated = await request(app.getHttpServer()).patch(`/api/v1/projects/${projectId}`).set(XRW).set('Cookie', cookie)
      .send({ name: '亚马逊店铺 V2' }).expect(200);
    expect(updated.body.data.name).toBe('亚马逊店铺 V2');
  });

  it('越权访问他人项目 → 404（防枚举）', async () => {
    await request(app.getHttpServer()).get(`/api/v1/projects/${'0'.repeat(32)}`).set('Cookie', cookie).expect(404);
  });

  it('非法参数：空 name → 400 VALIDATION_ERROR', async () => {
    const res = await request(app.getHttpServer()).post('/api/v1/projects').set(XRW).set('Cookie', cookie).send({ name: '' }).expect(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('软删除后列表不可见', async () => {
    await request(app.getHttpServer()).delete(`/api/v1/projects/${projectId}`).set(XRW).set('Cookie', cookie).expect(200);
    const list = await request(app.getHttpServer()).get('/api/v1/projects').set('Cookie', cookie).expect(200);
    expect(list.body.data.some((p: { id: string }) => p.id === projectId)).toBe(false);
  });
});
