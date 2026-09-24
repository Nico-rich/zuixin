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
import { CryptoService } from '../src/core/crypto/crypto.service';
import { MockOAuthProvider } from '../src/modules/connections/oauth/mock-oauth.provider';

const XRW = { 'X-Requested-With': 'XMLHttpRequest' };

/**
 * M7-P2 Connection/OAuth/Credential e2e（真实 PostgreSQL；mock OAuth provider 全生命周期）：
 * start→callback（凭证 DB 密文断言）→refresh（token 轮换 + 竞态单次远端调用）→revoke→reconnect；
 * invalid/expired state、重复 callback、refresh 失败标记 expired、越权矩阵、DELETE 级联。
 */
describe('M7-P2 Connection / OAuth / Credential (e2e, mock provider)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let crypto: CryptoService;
  let cookie: string;
  let cookieB: string;
  let userId = '';
  let connectionIds: string[] = [];

  beforeAll(async () => {
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
    crypto = moduleRef.get(CryptoService);

    const login = await request(app.getHttpServer()).post('/api/v1/auth/login').set(XRW)
      .send({ email: process.env.SEED_ADMIN_EMAIL ?? 'admin@example.com', password: process.env.SEED_ADMIN_PASSWORD ?? 'admin123456' });
    cookie = (login.headers['set-cookie'] as unknown as string[]).map((c) => c.split(';')[0]).join('; ');
    userId = login.body.data.user.id;

    const userB = await prisma.user.create({ data: { email: `userb-p2-${Date.now()}@example.com`, passwordHash: 'unused-hash' } });
    const { JwtService } = await import('@nestjs/jwt');
    const jwt = moduleRef.get(JwtService);
    cookieB = `agent_access=${await jwt.signAsync({ sub: userB.id, role: 'user' })}`;
  });

  afterAll(async () => {
    if (connectionIds.length) {
      await prisma.credential.deleteMany({ where: { connectionId: { in: connectionIds } } });
      await prisma.connection.deleteMany({ where: { id: { in: connectionIds } } });
    }
    await app.close();
  });

  async function connect(code: string): Promise<{ connectionId: string; state: string }> {
    const start = await request(app.getHttpServer()).post('/api/v1/connections/mock/start').set(XRW).set('Cookie', cookie)
      .send({}).expect(201);
    const state = start.body.data.state as string;
    expect(start.body.data.authorizeUrl).toContain('state=');
    const cb = await request(app.getHttpServer()).get(`/api/v1/connections/mock/callback`).set(XRW).set('Cookie', cookie)
      .query({ state, code }).expect(200);
    const connectionId = cb.body.data.id as string;
    connectionIds.push(connectionId);
    return { connectionId, state };
  }

  it('P2 全生命周期：start → callback（凭证 DB 密文 ≠ 明文）→ refresh（token 轮换）→ revoke → 重复 revoke 409', async () => {
    const { connectionId } = await connect('code-lifecycle');

    // 连接投影不含任何凭证字段
    const conn = await request(app.getHttpServer()).get(`/api/v1/connections/${connectionId}`).set(XRW).set('Cookie', cookie).expect(200);
    expect(conn.body.data).toMatchObject({ id: connectionId, provider: 'mock', providerAccountId: 'mock-account-code-lifecycle', status: 'active' });
    expect(JSON.stringify(conn.body.data)).not.toContain('mock_access');

    // DB at rest 密文断言（六不原则：DB 加密）
    const creds = await prisma.credential.findMany({ where: { connectionId } });
    const access = creds.find((c) => c.type === 'access_token');
    expect(access).toBeTruthy();
    expect(access!.encryptedValue).not.toContain('mock_access_code-lifecycle');
    expect(crypto.decrypt(access!.encryptedValue)).toBe('mock_access_code-lifecycle'); // 可逆解密
    expect(JSON.stringify(access)).not.toContain('mock_access');

    // refresh：token 轮换（远端调用一次）
    const before = (app.get(MockOAuthProvider)).refreshCount;
    const refreshed = await request(app.getHttpServer()).post(`/api/v1/connections/${connectionId}/refresh`).set(XRW).set('Cookie', cookie).expect(201);
    expect(refreshed.body.data.status).toBe('active');
    expect((app.get(MockOAuthProvider)).refreshCount).toBe(before + 1);
    const newAccess = await prisma.credential.findFirst({ where: { connectionId, type: 'access_token' } });
    expect(crypto.decrypt(newAccess!.encryptedValue)).not.toBe('mock_access_code-lifecycle');

    // revoke → revoked；重复 revoke 409
    const revoked = await request(app.getHttpServer()).post(`/api/v1/connections/${connectionId}/revoke`).set(XRW).set('Cookie', cookie).expect(201);
    expect(revoked.body.data.status).toBe('revoked');
    await request(app.getHttpServer()).post(`/api/v1/connections/${connectionId}/revoke`).set(XRW).set('Cookie', cookie).expect(409);
    // revoked 后 refresh 409
    await request(app.getHttpServer()).post(`/api/v1/connections/${connectionId}/refresh`).set(XRW).set('Cookie', cookie).expect(409);
  });

  it('P2 reconnect：revoked 后重新 start+callback（同 providerAccountId）→ 同一连接复活 active + 凭证替换', async () => {
    const { connectionId } = await connect('code-reconnect');
    await request(app.getHttpServer()).post(`/api/v1/connections/${connectionId}/revoke`).set(XRW).set('Cookie', cookie).expect(201);

    const start = await request(app.getHttpServer()).post('/api/v1/connections/mock/start').set(XRW).set('Cookie', cookie).send({}).expect(201);
    const cb = await request(app.getHttpServer()).get('/api/v1/connections/mock/callback').set(XRW).set('Cookie', cookie)
      .query({ state: start.body.data.state, code: 'code-reconnect' }).expect(200);
    expect(cb.body.data.id).toBe(connectionId); // 不新建
    expect(cb.body.data.status).toBe('active');
    expect(cb.body.data.revokedAt).toBeNull();
    expect(await prisma.connection.count({ where: { id: connectionId, userId } })).toBe(1);
  });

  it('P2 state 安全：invalid state 400 / expired state 400 / 重复 callback 400（单次消费，不重复建连接）', async () => {
    await request(app.getHttpServer()).get('/api/v1/connections/mock/callback').set(XRW).set('Cookie', cookie)
      .query({ state: 'f'.repeat(48), code: 'x' }).expect(400);

    const start = await request(app.getHttpServer()).post('/api/v1/connections/mock/start').set(XRW).set('Cookie', cookie).send({}).expect(201);
    const state = start.body.data.state as string;
    // 制造过期
    await prisma.oAuthState.update({ where: { state }, data: { expiresAt: new Date(Date.now() - 1000) } });
    await request(app.getHttpServer()).get('/api/v1/connections/mock/callback').set(XRW).set('Cookie', cookie)
      .query({ state, code: 'x' }).expect(400);

    const start2 = await request(app.getHttpServer()).post('/api/v1/connections/mock/start').set(XRW).set('Cookie', cookie).send({}).expect(201);
    const state2 = start2.body.data.state as string;
    await request(app.getHttpServer()).get('/api/v1/connections/mock/callback').set(XRW).set('Cookie', cookie)
      .query({ state: state2, code: 'code-dup' }).expect(200);
    await request(app.getHttpServer()).get('/api/v1/connections/mock/callback').set(XRW).set('Cookie', cookie)
      .query({ state: state2, code: 'code-dup' }).expect(400); // 已消费
    expect(await prisma.connection.count({ where: { userId, providerAccountId: 'mock-account-code-dup' } })).toBe(1);
  });

  it('P2 refresh 竞态：并发 refresh ×3 → 远端只调用一次（in-flight 折叠）', async () => {
    const { connectionId } = await connect('code-race');
    const provider = app.get(MockOAuthProvider);
    const before = provider.refreshCount;
    await Promise.all([
      request(app.getHttpServer()).post(`/api/v1/connections/${connectionId}/refresh`).set(XRW).set('Cookie', cookie),
      request(app.getHttpServer()).post(`/api/v1/connections/${connectionId}/refresh`).set(XRW).set('Cookie', cookie),
      request(app.getHttpServer()).post(`/api/v1/connections/${connectionId}/refresh`).set(XRW).set('Cookie', cookie),
    ]);
    expect(provider.refreshCount).toBe(before + 1);
  });

  it('P2 refresh 失败（远端吊销 expired token）→ 502 PROVIDER_AUTH + connection 标记 expired → reconnect 复活', async () => {
    const { connectionId } = await connect('expired');
    await request(app.getHttpServer()).post(`/api/v1/connections/${connectionId}/refresh`).set(XRW).set('Cookie', cookie).expect(502);
    expect((await prisma.connection.findUnique({ where: { id: connectionId } }))?.status).toBe('expired');

    const start = await request(app.getHttpServer()).post('/api/v1/connections/mock/start').set(XRW).set('Cookie', cookie).send({}).expect(201);
    const cb = await request(app.getHttpServer()).get('/api/v1/connections/mock/callback').set(XRW).set('Cookie', cookie)
      .query({ state: start.body.data.state, code: 'expired' }).expect(200);
    expect(cb.body.data.status).toBe('active');
  });

  it('P2 越权矩阵：他人连接 GET/refresh/revoke/DELETE → 404；匿名 401', async () => {
    const { connectionId } = await connect('code-idor');
    await request(app.getHttpServer()).get(`/api/v1/connections/${connectionId}`).set(XRW).expect(401);
    await request(app.getHttpServer()).get(`/api/v1/connections/${connectionId}`).set(XRW).set('Cookie', cookieB).expect(404);
    await request(app.getHttpServer()).post(`/api/v1/connections/${connectionId}/refresh`).set(XRW).set('Cookie', cookieB).expect(404);
    await request(app.getHttpServer()).post(`/api/v1/connections/${connectionId}/revoke`).set(XRW).set('Cookie', cookieB).expect(404);
    await request(app.getHttpServer()).delete(`/api/v1/connections/${connectionId}`).set(XRW).set('Cookie', cookieB).expect(404);
    // 归属未被破坏
    expect((await prisma.connection.findUnique({ where: { id: connectionId } }))?.status).toBe('active');
  });

  it('P2 DELETE：删除连接并级联凭证', async () => {
    const { connectionId } = await connect('code-delete');
    await request(app.getHttpServer()).delete(`/api/v1/connections/${connectionId}`).set(XRW).set('Cookie', cookie).expect(200);
    expect(await prisma.connection.count({ where: { id: connectionId } })).toBe(0);
    expect(await prisma.credential.count({ where: { connectionId } })).toBe(0);
    connectionIds = connectionIds.filter((id) => id !== connectionId);
  });

  it('P2 不支持的 provider → 404', async () => {
    await request(app.getHttpServer()).post('/api/v1/connections/shopify/start').set(XRW).set('Cookie', cookie).send({}).expect(404);
  });
});
