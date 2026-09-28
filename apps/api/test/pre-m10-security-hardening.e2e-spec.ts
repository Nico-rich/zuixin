import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import cookieParser from 'cookie-parser';
import Redis from 'ioredis';
import * as argon2 from 'argon2';
import { AppModule } from '../src/app.module';
import { GlobalExceptionFilter } from '../src/common/filters/global-exception.filter';
import { TransformInterceptor } from '../src/common/interceptors/transform.interceptor';
import { csrfProtection } from '../src/modules/auth/csrf.middleware';
import { COOKIE_ACCESS, COOKIE_REFRESH } from '../src/modules/auth/auth.constants';
import { AccessGuardService } from '../src/modules/security/access-guard.service';
import { SESSION_EVENTS_CHANNEL } from '../src/modules/security/session-events.service';
import { PrismaService } from '../src/modules/prisma/prisma.service';

const XRW = { 'X-Requested-With': 'XMLHttpRequest' };
const PASSWORD = 'Str0ng-Passw0rd-2026!';

/** 轮询等待（最终一致）：断言**收敛后的持久事实**，不做"等固定毫秒"的脆弱假设 */
async function waitFor(check: () => boolean | Promise<boolean>, timeoutMs: number, label: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let last = false;
  while (Date.now() < deadline) {
    last = await check();
    if (last) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`等待超时（${timeoutMs}ms）：${label}`);
}

/** 从 Set-Cookie 里取 `name=value` 段（supertest 不带 cookie jar） */
function cookieOf(res: request.Response, name: string): string {
  const all = (res.headers['set-cookie'] as unknown as string[] | undefined) ?? [];
  const hit = all.find((c) => c.startsWith(`${name}=`));
  if (!hit) throw new Error(`响应中没有 ${name} cookie`);
  return hit.split(';')[0];
}

/** 解出 JWT 载荷（仅测试侧解码，不做验签） */
function decodeJwt(token: string): { sub: string; sid?: string; jti?: string; exp?: number } {
  const payload = token.split('.')[1];
  return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
}

/**
 * M10-P1 生产安全守卫与会话治理 e2e（**双 API 实例 + 独立 Redis DB 21**）。
 *
 * 覆盖：
 * 1. 跨实例会话撤销传播（Redis pub/sub `session-events`）——**缓存 TTL 设成 60s**，
 *    因此"B 实例在几百毫秒内失效"不可能由 TTL 到期解释（必须是事件到达）；
 * 2. jti 黑名单（登出全部）：Redis 墓碑存在 + TTL ≤ token 剩余寿命 + 会话被"复活"后仍拦得住（第二层独立生效）；
 * 3. 会话并发上限（默认 evict-oldest 挤最旧；显式 reject 策略返回 SESSION_CONCURRENCY_EXCEEDED）；
 * 4. 组织禁用态登录拒绝（ORG_DISABLED）。
 *
 * 说明：本文件不新增任何队列/基础设施，只用既有 PG/Redis/MinIO。
 */
describe('Pre-M10 Security Hardening (e2e, 2 API instances)', () => {
  let appA: INestApplication;
  let appB: INestApplication;
  let prisma: PrismaService;
  let redis: Redis;
  /** 断言用：B 实例的访问判定缓存（跨实例传播必须能清掉它） */
  let guardB: AccessGuardService;
  const userIds: string[] = [];

  const serverA = () => appA.getHttpServer();
  const serverB = () => appB.getHttpServer();

  /** 造一个"密码已知"的测试用户（+ 可选个人组织状态） */
  async function makeUser(tag: string, orgStatus?: 'active' | 'disabled') {
    const email = `prem10-${tag}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@example.com`;
    const user = await prisma.user.create({ data: { email, passwordHash: await argon2.hash(PASSWORD) } });
    userIds.push(user.id);
    if (orgStatus) {
      await prisma.organization.create({
        data: {
          id: `personal-${user.id}`, name: `PreM10-${tag}`, slug: `personal-${user.id}`,
          isPersonal: true, ownerUserId: user.id, status: orgStatus,
        },
      });
    }
    return { user, email };
  }

  const login = (server: unknown, email: string) =>
    request(server as never).post('/api/v1/auth/login').set(XRW).send({ email, password: PASSWORD });

  beforeAll(async () => {
    // 独立 Redis DB（本文件自包含）；TTL 拉长到 60s → 传播断言不可能被"TTL 到期"蒙对
    process.env.REDIS_URL = 'redis://localhost:6379/21';
    process.env.SECURITY_GUARD_CACHE_TTL_MS = '60000';
    process.env.MOCK_DELAY_MS = '0';

    const buildApp = async () => {
      const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
      const app = moduleRef.createNestApplication();
      app.use(cookieParser());
      app.use('/api/v1', csrfProtection);
      app.setGlobalPrefix('api/v1');
      app.useGlobalFilters(moduleRef.get(GlobalExceptionFilter));
      app.useGlobalInterceptors(new TransformInterceptor());
      await app.init();
      await app.listen(0);
      return { app, moduleRef };
    };

    const a = await buildApp();
    appA = a.app;
    prisma = a.moduleRef.get(PrismaService);
    const b = await buildApp();
    appB = b.app;
    guardB = b.moduleRef.get(AccessGuardService);

    redis = new Redis('redis://localhost:6379/21');
    // 预热：确认两个实例都已订阅 `session-events`（否则早发的事件会丢，测试变成时序碰运气）
    await waitFor(async () => {
      const [, count] = (await redis.pubsub('NUMSUB', SESSION_EVENTS_CHANNEL)) as [string, string | number];
      return Number(count) >= 2;
    }, 10_000, '两个实例都订阅 session-events');
  });

  afterAll(async () => {
    await prisma.session.deleteMany({ where: { userId: { in: userIds } } }).catch(() => undefined);
    await prisma.organization.deleteMany({ where: { ownerUserId: { in: userIds } } }).catch(() => undefined);
    await prisma.user.deleteMany({ where: { id: { in: userIds } } }).catch(() => undefined);
    redis?.disconnect();
    await appA?.close();
    await appB?.close();
    delete process.env.SESSION_MAX_CONCURRENT;
    delete process.env.SESSION_CONCURRENCY_POLICY;
  });

  it('跨实例会话撤销传播：A 登出后 B **立即**拒绝该 access token（缓存 TTL=60s，不可能是 TTL 到期）', async () => {
    const { email } = await makeUser('xinst');
    const login1 = await login(serverA(), email).expect(201);
    const login2 = await login(serverA(), email).expect(201);
    const cookie1 = cookieOf(login1, COOKIE_ACCESS);
    const refresh1 = cookieOf(login1, COOKIE_REFRESH);
    const cookie2 = cookieOf(login2, COOKIE_ACCESS);

    // 预热 B 的肯定缓存：两个会话都先在 B 上成功访问过（缓存里有肯定结论才会暴露"没被清掉"）
    await request(serverB()).get('/api/v1/auth/me').set('Cookie', cookie1).expect(200);
    await request(serverB()).get('/api/v1/auth/me').set('Cookie', cookie2).expect(200);
    const before = guardB.stats();
    expect(before.sessions).toBeGreaterThanOrEqual(2);
    expect(before.users).toBeGreaterThanOrEqual(1);

    // A 上登出（session1）
    await request(serverA()).post('/api/v1/auth/logout').set(XRW).set('Cookie', `${refresh1}; ${cookie1}`).expect(201);

    // 事件到达 B → 该会话的肯定缓存被清（TTL=60s：只有 pub/sub 能解释这个转变）
    await waitFor(() => guardB.stats().sessions < before.sessions, 10_000, 'B 实例的会话缓存应因远端事件失效');

    // 持久事实（不依赖任何缓存）：B 立即拒绝已撤销的 access token，未撤销的照常可用
    const revoked = await request(serverB()).get('/api/v1/auth/me').set('Cookie', cookie1);
    expect(revoked.status).toBe(401);
    expect(revoked.body.error.code).toBe('UNAUTHORIZED');
    await request(serverB()).get('/api/v1/auth/me').set('Cookie', cookie2).expect(200);
  }, 60_000);

  it('jti 黑名单（登出全部）：墓碑写入 Redis 且 TTL ≤ 剩余寿命；会话被"复活"后仍被单独拦下（第二层独立生效）', async () => {
    const { user, email } = await makeUser('jti');
    const res = await login(serverA(), email).expect(201);
    const cookie = cookieOf(res, COOKIE_ACCESS);
    const claims = decodeJwt(cookie);
    expect(typeof claims.jti).toBe('string');
    expect(typeof claims.sid).toBe('string');

    // 201：与既有 `POST /auth/logout` 的契约保持一致（Nest POST 默认状态，前端按 res.ok 判定）
    const out = await request(serverA()).post('/api/v1/auth/logout-all').set(XRW).set('Cookie', cookie).expect(201);
    expect(out.body.data.ok).toBe(true);
    expect(out.body.data.revokedSessions).toBeGreaterThanOrEqual(1);
    expect(out.body.data.blacklistedJtis).toBeGreaterThanOrEqual(1);
    // 双 cookie 都被清（Max-Age=0）：登出全部后浏览器侧不留残留
    const cleared = (out.headers['set-cookie'] as unknown as string[]) ?? [];
    expect(cleared.filter((c) => c.includes('Max-Age=0'))).toHaveLength(2);

    // Redis 事实：墓碑存在，且 TTL 有界（> 0 且 ≤ token 剩余寿命，绝不留更久的墓碑）
    const ttl = await redis.ttl(`auth:jti:blacklist:${claims.jti}`);
    const remaining = (claims.exp ?? 0) - Math.floor(Date.now() / 1000);
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(remaining + 1);
    // 记账集合被清空（避免重复拉黑）
    expect(await redis.exists(`auth:jti:${user.id}`)).toBe(0);
    // 跨实例：B 也拒绝（黑名单在共享 Redis 上）
    await request(serverB()).get('/api/v1/auth/me').set('Cookie', cookie).expect(401);

    // 独立生效性证明：把会话行"复活"（模拟被其他路径恢复）→ 会话判定为 live，仍只能由 jti 墓碑拦下
    await prisma.session.update({ where: { id: claims.sid }, data: { revokedAt: null } });
    expect(await guardB.isSessionLive(claims.sid as string)).toBe(true);
    const afterRevive = await request(serverB()).get('/api/v1/auth/me').set('Cookie', cookie);
    expect(afterRevive.status).toBe(401); // 会话是活的、用户是 active 的 → 唯一原因就是 jti 已拉黑
  }, 60_000);

  it('会话并发上限：默认 evict-oldest 挤掉最旧（用户始终能登录）；显式 reject 策略返回 SESSION_CONCURRENCY_EXCEEDED', async () => {
    const { user, email } = await makeUser('conc');
    process.env.SESSION_MAX_CONCURRENT = '2';
    try {
      const c1 = cookieOf(await login(serverA(), email).expect(201), COOKIE_ACCESS);
      const c2 = cookieOf(await login(serverA(), email).expect(201), COOKIE_ACCESS);
      const c3res = await login(serverA(), email).expect(201); // 第 3 次：达上限 → 挤掉最旧后仍成功
      const c3 = cookieOf(c3res, COOKIE_ACCESS);

      // 持久事实：活跃会话数**恒 ≤ 上限**
      expect(await prisma.session.count({ where: { userId: user.id, revokedAt: null } })).toBe(2);
      // 最旧会话立即下线（同实例直接失效，不依赖 pub/sub），新会话与次旧会话可用
      await request(serverA()).get('/api/v1/auth/me').set('Cookie', c1).expect(401);
      await request(serverA()).get('/api/v1/auth/me').set('Cookie', c2).expect(200);
      await request(serverA()).get('/api/v1/auth/me').set('Cookie', c3).expect(200);

      // 显式 reject 策略：不静默下线任何设备，直接拒绝新登录
      process.env.SESSION_CONCURRENCY_POLICY = 'reject';
      const rejected = await login(serverA(), email);
      // 注意：HTTP 状态映射在 global-exception.filter（非本 Phase 所有权）——此处只断言**错误码**，
      // 状态码待 A14/Coordinator 补 httpStatusOf 映射后收紧为 429。
      expect(rejected.body.error.code).toBe('SESSION_CONCURRENCY_EXCEEDED');
      expect(rejected.status).toBeGreaterThanOrEqual(400);
      expect(await prisma.session.count({ where: { userId: user.id, revokedAt: null } })).toBe(2); // 拒绝时不留痕
    } finally {
      delete process.env.SESSION_MAX_CONCURRENT;
      delete process.env.SESSION_CONCURRENCY_POLICY;
    }
  }, 60_000);

  it('组织禁用态（ORG_DISABLED）：个人组织 disabled → 凭证正确也拒绝签发会话；active 用户不受影响', async () => {
    const disabled = await makeUser('orgdis', 'disabled');
    const ok = await makeUser('orgok', 'active');

    const res = await login(serverA(), disabled.email);
    expect(res.body.error.code).toBe('ORG_DISABLED');
    expect(res.status).toBeGreaterThanOrEqual(400);
    // 持久事实：**没有**任何会话被创建（拒绝发生在签发之前）；cookie 也不下发
    expect(await prisma.session.count({ where: { userId: disabled.user.id } })).toBe(0);
    expect(res.headers['set-cookie']).toBeUndefined();

    const good = await login(serverA(), ok.email).expect(201);
    expect(cookieOf(good, COOKIE_ACCESS)).toBeTruthy();
  }, 60_000);
});
