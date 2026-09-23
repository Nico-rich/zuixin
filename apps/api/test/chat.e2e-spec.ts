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

describe('Chat (e2e, Mock Provider 全链路)', () => {
  let app: INestApplication;
  let cookie: string;
  let convId = ''; // 从本套件自己的 SSE 流捕获，避免与其他并行 e2e 套件共享 DB 时取错会话
  const email = process.env.SEED_ADMIN_EMAIL ?? 'admin@example.com';
  const password = process.env.SEED_ADMIN_PASSWORD ?? 'admin123456';

  beforeAll(async () => {
    process.env.MOCK_DELAY_MS = '0'; // e2e 不等待分块延迟
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.use(cookieParser());
    app.use('/api/v1', csrfProtection);
    app.setGlobalPrefix('api/v1');
    app.useGlobalFilters(moduleRef.get(GlobalExceptionFilter));
    app.useGlobalInterceptors(new TransformInterceptor());
    await app.init();
    const login = await request(app.getHttpServer()).post('/api/v1/auth/login').set(XRW).send({ email, password });
    cookie = (login.headers['set-cookie'] as unknown as string[]).map((c) => c.split(';')[0]).join('; ');
  });

  afterAll(async () => { await app.close(); });

  it('未登录 POST /chat → 401', async () => {
    await request(app.getHttpServer()).post('/api/v1/chat').set(XRW).send({ message: 'hi' }).expect(401);
  });

  it('SSE 全链路：message_start → status → message_delta → message_end(completed)', async () => {
    const res = await request(app.getHttpServer()).post('/api/v1/chat').set(XRW).set('Cookie', cookie)
      .send({ message: '你好，介绍一下你自己' })
      .buffer(true).parse((r, cb) => { let s = ''; r.on('data', (c) => (s += c)); r.on('end', () => cb(null, s)); })
      .expect(200);
    const text = res.body as string;
    expect(res.headers['content-type']).toContain('text/event-stream');
    expect(text).toContain('event: message_start');
    expect(text).toContain('event: message_delta');
    expect(text).toContain('event: message_end');
    expect(text).toContain('"status":"completed"');
    const convMatch = text.match(/"conversationId":"([0-9a-f-]+)"/);
    expect(convMatch).toBeTruthy();
    convId = convMatch![1];
    // mock 逐字符流式，原始文本中不存在连续子串——解析 delta 帧拼接后校验内容
    const deltas: string[] = [];
    for (const frame of text.split('\n\n')) {
      const lines = frame.split('\n');
      const event = lines.find((l) => l.startsWith('event:'))?.slice(6).trim();
      const data = lines.find((l) => l.startsWith('data:'));
      if (event === 'message_delta' && data) {
        deltas.push((JSON.parse(data.slice(5).trim()) as { delta: string }).delta);
      }
    }
    expect(deltas.length).toBeGreaterThan(0);
    expect(deltas.join('')).toContain('[mock]');
  });

  it('消息完整持久化：conversations + messages 落库（含 intentType）', async () => {
    const msgs = await request(app.getHttpServer()).get(`/api/v1/conversations/${convId}/messages`).set('Cookie', cookie).expect(200);
    const roles = msgs.body.data.map((m: { role: string }) => m.role);
    expect(roles[0]).toBe('user');
    expect(roles[1]).toBe('assistant');
    const assistant = msgs.body.data[1];
    expect(assistant.status).toBe('completed');
    expect(assistant.content).toContain('mock');
  });

  it('指定 conversationId 追问：历史消息累计 4 条', async () => {
    await request(app.getHttpServer()).post('/api/v1/chat').set(XRW).set('Cookie', cookie)
      .send({ conversationId: convId, message: '继续' })
      .buffer(true).parse((r, cb) => { r.on('data', () => undefined); r.on('end', () => cb(null, '')); })
      .expect(200);
    const msgs = await request(app.getHttpServer()).get(`/api/v1/conversations/${convId}/messages`).set('Cookie', cookie).expect(200);
    expect(msgs.body.data.length).toBe(4);
  });

  it('非法参数：空消息 → 400 VALIDATION_ERROR', async () => {
    const res = await request(app.getHttpServer()).post('/api/v1/chat').set(XRW).set('Cookie', cookie).send({ message: '' }).expect(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('缺 CSRF 头 → 403', async () => {
    await request(app.getHttpServer()).post('/api/v1/chat').set('Cookie', cookie).send({ message: 'hi' }).expect(403);
  });
});
