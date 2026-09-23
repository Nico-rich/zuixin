import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import cookieParser from 'cookie-parser';
import Redis from 'ioredis';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { AppModule } from '../src/app.module';
import { GlobalExceptionFilter } from '../src/common/filters/global-exception.filter';
import { TransformInterceptor } from '../src/common/interceptors/transform.interceptor';
import { csrfProtection } from '../src/modules/auth/csrf.middleware';

const XRW = { 'X-Requested-With': 'XMLHttpRequest' };

describe('Auth (e2e)', () => {
  let app: INestApplication;
  let redis: Redis;
  const email = process.env.SEED_ADMIN_EMAIL ?? 'admin@example.com';
  const password = process.env.SEED_ADMIN_PASSWORD ?? 'admin123456';

  beforeAll(async () => {
    // 清理历史登录失败计数，避免多次运行测试套件累计触发限流
    redis = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379');
    const keys: string[] = [];
    let cursor = '0';
    do {
      const [next, batch] = await redis.scan(cursor, 'MATCH', 'auth:loginfail:*', 'COUNT', 100);
      cursor = next;
      keys.push(...batch);
    } while (cursor !== '0');
    if (keys.length) await redis.del(...keys);

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.use(cookieParser());
    app.use('/api/v1', csrfProtection);
    app.setGlobalPrefix('api/v1');
    app.useGlobalFilters(moduleRef.get(GlobalExceptionFilter));
    app.useGlobalInterceptors(new TransformInterceptor());
    await app.init();
  });

  afterAll(async () => { await app.close(); redis.disconnect(); });

  it('登录成功 → Set-Cookie 含 HttpOnly 双 cookie + user 数据', async () => {
    const res = await request(app.getHttpServer()).post('/api/v1/auth/login').set(XRW).send({ email, password }).expect(201);
    const cookies = (res.headers['set-cookie'] as unknown as string[]) ?? [];
    expect(cookies.some((c: string) => c.includes('agent_access') && c.includes('HttpOnly'))).toBe(true);
    expect(cookies.some((c: string) => c.includes('agent_refresh') && c.includes('HttpOnly'))).toBe(true);
    expect(res.body.data.user.email).toBe(email);
  });

  it('密码错误 → 401 统一错误结构', async () => {
    const res = await request(app.getHttpServer()).post('/api/v1/auth/login').set(XRW).send({ email, password: 'wrong-pass' }).expect(401);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
  });

  it('me：带 cookie 200，无 cookie 401', async () => {
    const login = await request(app.getHttpServer()).post('/api/v1/auth/login').set(XRW).send({ email, password }).expect(201);
    const cookie = (login.headers['set-cookie'] as unknown as string[]).map((c) => c.split(';')[0]).join('; ');
    const ok = await request(app.getHttpServer()).get('/api/v1/auth/me').set('Cookie', cookie).expect(200);
    expect(ok.body.data.user.email).toBe(email);
    await request(app.getHttpServer()).get('/api/v1/auth/me').expect(401);
  });

  it('缺 CSRF 头 → 403', async () => {
    await request(app.getHttpServer()).post('/api/v1/auth/login').send({ email, password }).expect(403);
  });

  it('logout 后 refresh 失效', async () => {
    const login = await request(app.getHttpServer()).post('/api/v1/auth/login').set(XRW).send({ email, password }).expect(201);
    const refresh = (login.headers['set-cookie'] as unknown as string[]).find((c) => c.startsWith('agent_refresh='))!.split(';')[0];
    await request(app.getHttpServer()).post('/api/v1/auth/logout').set(XRW).set('Cookie', refresh).expect(201);
    await request(app.getHttpServer()).post('/api/v1/auth/refresh').set(XRW).set('Cookie', refresh).expect(401);
  });
});
