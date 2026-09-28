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
import { ACCESS_TTL_SEC, COOKIE_ACCESS, COOKIE_REFRESH, DEVICE_ID_HEADER } from '../src/modules/auth/auth.constants';
import { AccessGuardService } from '../src/modules/security/access-guard.service';
import { SessionEventsService } from '../src/modules/security/session-events.service';
import { PrismaService } from '../src/modules/prisma/prisma.service';

const XRW = { 'X-Requested-With': 'XMLHttpRequest' };
const PASSWORD = 'Str0ng-Passw0rd-2026!';
/** 本文件独占 Redis DB 22（并行 worktree 铁律：每个 Agent 一个 DB 号） */
const REDIS_URL = 'redis://localhost:6379/22';

/** 轮询等待（最终一致）：断言**收敛后的持久事实**，不做"等固定毫秒"的脆弱假设 */
async function waitFor(check: () => boolean | Promise<boolean>, timeoutMs: number, label: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
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

/** cookie 值（不含 `name=` 前缀）——用于断言"响应体里绝不出现 token 原材料" */
function cookieValue(res: request.Response, name: string): string {
  return cookieOf(res, name).slice(name.length + 1);
}

/** 解出 JWT 载荷（仅测试侧解码，不做验签） */
function decodeJwt(token: string): { sub: string; sid?: string; jti?: string; exp?: number } {
  const payload = token.split('.')[1];
  return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
}

interface SessionRow {
  id: string; deviceId: string | null; userAgent: string | null; ip: string | null;
  createdAt: string; expiresAt: string; current: boolean;
}

/**
 * M11-P2（D1-01/D1-10/D1-11）会话治理 e2e（**双 API 实例 + 独立 Redis DB 22**）。
 *
 * 覆盖：
 * 1. **设备下线**：登录带 `X-Device-Id` → 落库；`DELETE /auth/sessions/device/:id` 撤销该设备全部会话，
 *    随后该设备的 access token 在**两个实例**上均被 `DEVICE_REVOKED`（401）拒绝——
 *    B 实例的缓存 TTL 设为 60s，因此"B 立即拒绝"不可能由 TTL 到期解释（必须是 pub/sub 传播）；
 * 2. **幂等与再登录**：重复下线 → `revokedSessions: 0`；下线不是设备封禁，同设备可重新登录；
 * 3. **会话列表**：只回自己 + 白名单字段（tokenHash/refresh token 绝不出现）；
 * 4. **IDOR**：他人会话 id 与幽灵 id **同码同文案**（404），且他人会话零副作用；
 * 5. **token 轮换**：旧 access/refresh 双双失效（新 sid/新 jti + 旧 jti 墓碑），新凭证跨实例可用；
 *    绑定性与并发（旧 refresh 不可重放）；
 * 6. **并发上限不回归**：设备分组/轮换都不突破会话数上限，也不误踢其他设备。
 *
 * **共享通道纪律**：Redis DB 号只隔离 keyspace，**pub/sub 通道是实例全局的**——`session-events` 是跨 Agent
 * 固定契约名，其他 Agent 的实例也会在这条通道上收发。因此本文件全部断言按**自己的** userId/sessionId 收敛
 * （只认自己造成的事实变化），绝不写"通道上不应出现 X"这类全局断言。
 */
describe('Pre-M11 Session Governance (e2e, 2 API instances, DEVICE_REVOKED / rotate / sessions)', () => {
  let appA: INestApplication;
  let appB: INestApplication;
  let prisma: PrismaService;
  let redis: Redis;
  let guardB: AccessGuardService;
  const userIds: string[] = [];

  const serverA = () => appA.getHttpServer();
  const serverB = () => appB.getHttpServer();

  async function makeUser(tag: string) {
    const email = `prem11-${tag}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@example.com`;
    const user = await prisma.user.create({ data: { email, passwordHash: await argon2.hash(PASSWORD) } });
    userIds.push(user.id);
    return { user, email };
  }

  /** 登录（可带设备标识头——M11-P2 的 deviceId 来源契约） */
  const login = (server: unknown, email: string, deviceId?: string) => {
    const req = request(server as never).post('/api/v1/auth/login').set(XRW);
    return (deviceId ? req.set(DEVICE_ID_HEADER, deviceId) : req).send({ email, password: PASSWORD });
  };

  const listSessions = (server: unknown, cookie: string) =>
    request(server as never).get('/api/v1/auth/sessions').set('Cookie', cookie);

  const revokeDevice = (server: unknown, cookie: string, deviceId: string) =>
    request(server as never).delete(`/api/v1/auth/sessions/device/${encodeURIComponent(deviceId)}`)
      .set(XRW).set('Cookie', cookie);

  const revokeOne = (server: unknown, cookie: string, id: string) =>
    request(server as never).delete(`/api/v1/auth/sessions/${id}`).set(XRW).set('Cookie', cookie);

  beforeAll(async () => {
    // 独立 Redis DB（本文件自包含）；TTL 拉长到 60s → 传播断言不可能被"TTL 到期"蒙对
    process.env.REDIS_URL = REDIS_URL;
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

    redis = new Redis(REDIS_URL);
    // 就绪判定用**本实例自己的事实**（isSubscribed），不用 `PUBSUB NUMSUB session-events`：
    // 通道是实例全局的（其他 Agent 进程的订阅者也会被数进来）→ NUMSUB 会给出"我还没订阅"的假阳性。
    await waitFor(
      () => a.moduleRef.get(SessionEventsService).isSubscribed() && b.moduleRef.get(SessionEventsService).isSubscribed(),
      10_000,
      '两个实例都已订阅 session-events',
    );
  });

  afterAll(async () => {
    await prisma.session.deleteMany({ where: { userId: { in: userIds } } }).catch(() => undefined);
    await prisma.organization.deleteMany({ where: { ownerUserId: { in: userIds } } }).catch(() => undefined);
    await prisma.user.deleteMany({ where: { id: { in: userIds } } }).catch(() => undefined);
    redis?.disconnect();
    await appA?.close();
    await appB?.close();
    delete process.env.SESSION_MAX_CONCURRENT;
  });

  it('设备下线：撤销该设备全部会话 → 该设备 access token 在两个实例上均被 DEVICE_REVOKED（401）；其他设备不受影响', async () => {
    const { user, email } = await makeUser('dev');
    // 同一设备两次登录（分组标识生效）+ 另一台设备一次登录
    const d1a = await login(serverA(), email, 'phone-1').expect(201);
    const d1b = await login(serverA(), email, 'phone-1').expect(201);
    const d2 = await login(serverA(), email, 'laptop-2').expect(201);
    const cD1a = cookieOf(d1a, COOKIE_ACCESS);
    const cD1b = cookieOf(d1b, COOKIE_ACCESS);
    const cD2 = cookieOf(d2, COOKIE_ACCESS);

    // 持久事实：deviceId 落库（两台设备分组正确）
    const rows = await prisma.session.findMany({
      where: { userId: user.id, revokedAt: null }, select: { id: true, deviceId: true },
    });
    expect(rows).toHaveLength(3);
    expect(rows.filter((r) => r.deviceId === 'phone-1')).toHaveLength(2);
    expect(rows.filter((r) => r.deviceId === 'laptop-2')).toHaveLength(1);

    // 预热 B 实例的肯定缓存（有肯定结论才能暴露"没被事件清掉"）
    await request(serverB()).get('/api/v1/auth/me').set('Cookie', cD1a).expect(200);
    await request(serverB()).get('/api/v1/auth/me').set('Cookie', cD1b).expect(200);
    await request(serverB()).get('/api/v1/auth/me').set('Cookie', cD2).expect(200);
    const before = guardB.stats();

    // A 实例按设备下线（用 D2 的会话发起：下线的是 phone-1）
    const res = await revokeDevice(serverA(), cD2, 'phone-1').expect(200);
    expect(res.body.data).toMatchObject({ ok: true, revokedSessions: 2 });

    // 持久事实：phone-1 的两条会话已撤销，laptop-2 的仍活跃（不误伤）
    const afterRevoke = await prisma.session.findMany({
      where: { userId: user.id }, select: { id: true, deviceId: true, revokedAt: true },
    });
    expect(afterRevoke.filter((r) => r.deviceId === 'phone-1' && r.revokedAt != null)).toHaveLength(2);
    expect(afterRevoke.filter((r) => r.deviceId === 'laptop-2' && r.revokedAt == null)).toHaveLength(1);

    // 被下线设备：401 + **DEVICE_REVOKED**（DEVICE_REVOKED 的真实业务路径 = 守卫对"已下线会话"的细化）
    for (const cookie of [cD1a, cD1b]) {
      const denied = await request(serverA()).get('/api/v1/auth/me').set('Cookie', cookie);
      expect(denied.status).toBe(401);
      expect(denied.body.error.code).toBe('DEVICE_REVOKED');
    }
    // 其他设备照常可用（同实例）
    await request(serverA()).get('/api/v1/auth/me').set('Cookie', cD2).expect(200);

    // 跨实例：B 的肯定缓存被 pub/sub 清掉（TTL=60s：只有事件能解释这个转变）→ 立即同样 401 DEVICE_REVOKED
    await waitFor(() => guardB.stats().sessions < before.sessions, 10_000, 'B 实例的会话缓存应因远端事件失效');
    await waitFor(async () => {
      const r = await request(serverB()).get('/api/v1/auth/me').set('Cookie', cD1a);
      return r.status === 401 && r.body?.error?.code === 'DEVICE_REVOKED';
    }, 10_000, 'B 实例对已下线设备的请求应返回 401 DEVICE_REVOKED');
    await request(serverB()).get('/api/v1/auth/me').set('Cookie', cD2).expect(200);

    // 机制事实（Redis 共享）：原因标记存在（仅用于错误码细化；撤销权威仍在 DB revokedAt）
    const revokedIds = afterRevoke.filter((r) => r.deviceId === 'phone-1').map((r) => r.id);
    for (const id of revokedIds) {
      expect(await redis.exists(`auth:session:device-revoked:${id}`)).toBe(1);
      // 标记是**有界的**（TTL ≤ access token 寿命上限），不会永久堆积
      expect(await redis.ttl(`auth:session:device-revoked:${id}`)).toBeLessThanOrEqual(ACCESS_TTL_SEC);
    }

    // 幂等：再次下线同一设备 → 200 + 0（不报错、不再发布、不影响其他设备）
    const again = await revokeDevice(serverA(), cD2, 'phone-1').expect(200);
    expect(again.body.data.revokedSessions).toBe(0);

    // 下线不是设备封禁：同一设备可重新登录（新会话、新 sid，不被原因标记误伤）
    const relogin = await login(serverA(), email, 'phone-1').expect(201);
    const cRelogin = cookieOf(relogin, COOKIE_ACCESS);
    await request(serverA()).get('/api/v1/auth/me').set('Cookie', cRelogin).expect(200);
    await request(serverB()).get('/api/v1/auth/me').set('Cookie', cRelogin).expect(200);
  }, 90_000);

  it('会话列表：只回本人活跃会话的白名单字段（tokenHash/refresh token 绝不出现）+ current 标记', async () => {
    const { email } = await makeUser('list');
    const first = await login(serverA(), email, 'dev-list-1').expect(201);
    await login(serverA(), email, 'dev-list-2').expect(201);
    const firstAccess = cookieOf(first, COOKIE_ACCESS);
    const firstRefreshValue = cookieValue(first, COOKIE_REFRESH);

    const res = await listSessions(serverA(), firstAccess).expect(200);
    const sessions = res.body.data.sessions as SessionRow[];
    expect(sessions).toHaveLength(2);
    // 白名单字段（字段集合本身就是契约：多一个字段都可能泄漏敏感面）
    expect(Object.keys(sessions[0]).sort()).toEqual(
      ['createdAt', 'current', 'deviceId', 'expiresAt', 'id', 'ip', 'userAgent'],
    );
    expect(sessions.map((s) => s.deviceId).sort()).toEqual(['dev-list-1', 'dev-list-2']);
    // 只有发起本次请求的会话 current=true
    expect(sessions.filter((s) => s.current)).toHaveLength(1);
    const current = sessions.find((s) => s.current)!;
    expect(current.id).toBe(decodeJwt(firstAccess).sid);
    // 脱敏：响应体内不含 refresh token 原材料，也不含 tokenHash 字段名
    const raw = JSON.stringify(res.body);
    expect(raw).not.toContain(firstRefreshValue);
    expect(raw).not.toContain('tokenHash');
  }, 60_000);

  it('IDOR：下线他人会话与幽灵 id **同码同文案**（404）；他人会话零副作用，仍可正常使用', async () => {
    const victim = await makeUser('victim');
    const attacker = await makeUser('attacker');
    const victimLogin = await login(serverA(), victim.email, 'victim-dev').expect(201);
    const victimAccess = cookieOf(victimLogin, COOKIE_ACCESS);
    const victimSid = decodeJwt(victimAccess).sid as string;
    const attackerLogin = await login(serverA(), attacker.email, 'attacker-dev').expect(201);
    const attackerAccess = cookieOf(attackerLogin, COOKIE_ACCESS);

    // 他人会话：攻击者用**受害者真实 sessionId** 下线 → 404（与幽灵 id 同形）
    const crossUser = await revokeOne(serverA(), attackerAccess, victimSid);
    const ghost = await revokeOne(serverA(), attackerAccess, '00000000-0000-4000-8000-000000000000');
    expect(crossUser.status).toBe(404);
    expect(ghost.status).toBe(404);
    expect(crossUser.body.error.code).toBe('NOT_FOUND');
    expect(crossUser.body.error.code).toBe(ghost.body.error.code);
    expect(crossUser.body.error.message).toBe(ghost.body.error.message); // 文案逐字相同（防枚举）

    // 零副作用（持久事实）：受害者会话仍活跃且可用
    const row = await prisma.session.findUnique({ where: { id: victimSid }, select: { revokedAt: true } });
    expect(row?.revokedAt).toBeNull();
    await request(serverA()).get('/api/v1/auth/me').set('Cookie', victimAccess).expect(200);

    // 他人的**设备**：攻击者按该 deviceId 下线 → 只对攻击者自己生效（受害者会话不受影响）
    const byDevice = await revokeDevice(serverA(), attackerAccess, 'victim-dev').expect(200);
    expect(byDevice.body.data.revokedSessions).toBe(0);
    expect((await prisma.session.findUnique({ where: { id: victimSid }, select: { revokedAt: true } }))?.revokedAt).toBeNull();
    await request(serverA()).get('/api/v1/auth/me').set('Cookie', victimAccess).expect(200);

    // 会话列表同理：列表里**绝不含**他人会话（按 userId 过滤）
    const mine = await listSessions(serverA(), attackerAccess).expect(200);
    const ids = (mine.body.data.sessions as SessionRow[]).map((s) => s.id);
    expect(ids).not.toContain(victimSid);
  }, 60_000);

  it('token 轮换：旧凭证双双失效（新 sid/新 jti + 旧 jti 墓碑），新凭证跨实例可用且设备分组保留', async () => {
    const { user, email } = await makeUser('rotate');
    const loginRes = await login(serverA(), email, 'rotate-dev').expect(201);
    const oldAccess = cookieOf(loginRes, COOKIE_ACCESS);
    const oldRefresh = cookieOf(loginRes, COOKIE_REFRESH);
    const oldClaims = decodeJwt(oldAccess);
    await request(serverA()).get('/api/v1/auth/me').set('Cookie', oldAccess).expect(200); // 轮换前可用

    const rotated = await request(serverA()).post('/api/v1/auth/rotate')
      .set(XRW).set('Cookie', `${oldAccess}; ${oldRefresh}`).expect(201);
    const newAccess = cookieOf(rotated, COOKIE_ACCESS);
    const newRefresh = cookieOf(rotated, COOKIE_REFRESH);
    const newClaims = decodeJwt(newAccess);
    // 新凭证：sid 与 jti 都换（旧 token 无法复用）
    expect(newClaims.sid).toBeTruthy();
    expect(newClaims.sid).not.toBe(oldClaims.sid);
    expect(newClaims.jti).not.toBe(oldClaims.jti);
    // 旧会话在 DB 面即失效（不依赖 Redis 墓碑）
    expect((await prisma.session.findUnique({ where: { id: oldClaims.sid }, select: { revokedAt: true } }))?.revokedAt).not.toBeNull();
    // 旧 jti 进了黑名单，且 TTL ≤ 剩余寿命（不留比 token 更久的墓碑）
    const tombTtl = await redis.ttl(`auth:jti:blacklist:${oldClaims.jti}`);
    const remaining = (oldClaims.exp ?? 0) - Math.floor(Date.now() / 1000);
    expect(tombTtl).toBeGreaterThan(0);
    expect(tombTtl).toBeLessThanOrEqual(remaining + 1);

    // 旧 access → 401；旧 refresh 也换不回会话（旧会话已撤销）
    await request(serverA()).get('/api/v1/auth/me').set('Cookie', oldAccess).expect(401);
    await request(serverA()).post('/api/v1/auth/refresh').set(XRW).set('Cookie', oldRefresh).expect(401);
    // 新凭证：两个实例都可用（新会话在共享 DB，无陈旧缓存风险）
    await request(serverA()).get('/api/v1/auth/me').set('Cookie', newAccess).expect(200);
    await request(serverB()).get('/api/v1/auth/me').set('Cookie', newAccess).expect(200);

    // 设备分组保留：轮换不改变"哪台设备"，按设备下线仍能命中轮换后的会话
    const list = await listSessions(serverA(), newAccess).expect(200);
    const current = (list.body.data.sessions as SessionRow[]).find((s) => s.current)!;
    expect(current.deviceId).toBe('rotate-dev');
    const killed = await revokeDevice(serverA(), newAccess, 'rotate-dev').expect(200);
    expect(killed.body.data.revokedSessions).toBe(1);
    await request(serverA()).get('/api/v1/auth/me').set('Cookie', newAccess).expect(401);
    // 轮换后的会话被设备下线 → 同样是 DEVICE_REVOKED（原因标记按会话 id 写入，与 sid 是否轮换无关）
    const denied = await request(serverA()).get('/api/v1/auth/me').set('Cookie', newAccess);
    expect(denied.body.error.code).toBe('DEVICE_REVOKED');
    expect(await prisma.session.count({ where: { userId: user.id, revokedAt: null } })).toBe(0);
  }, 90_000);

  it('轮换绑定性/并发：access 与 refresh 不属同一会话 → 401 且零副作用；旧 refresh 不可重放', async () => {
    const { email } = await makeUser('bind');
    const s1 = await login(serverA(), email, 'bind-dev-1').expect(201);
    const s2 = await login(serverA(), email, 'bind-dev-2').expect(201);
    const a1 = cookieOf(s1, COOKIE_ACCESS);
    const r2 = cookieOf(s2, COOKIE_REFRESH);

    // 混用（s1 的 access + s2 的 refresh）→ 401，且两个会话都不受影响
    const mixed = await request(serverA()).post('/api/v1/auth/rotate').set(XRW).set('Cookie', `${a1}; ${r2}`);
    expect(mixed.status).toBe(401);
    expect(mixed.body.error.code).toBe('UNAUTHORIZED');
    await request(serverA()).get('/api/v1/auth/me').set('Cookie', a1).expect(200);
    expect(await prisma.session.count({
      where: { userId: decodeJwt(a1).sub, revokedAt: null },
    })).toBe(2);

    // 缺 refresh（只带 access）→ 401（轮换必须同时持有两枚凭证）
    const accessOnly = await request(serverA()).post('/api/v1/auth/rotate').set(XRW).set('Cookie', a1);
    expect(accessOnly.status).toBe(401);

    // 正常轮换一次后，旧 refresh 不可重放
    const r1 = cookieOf(s1, COOKIE_REFRESH);
    const ok = await request(serverA()).post('/api/v1/auth/rotate')
      .set(XRW).set('Cookie', `${a1}; ${r1}`).expect(201);
    const a1New = cookieOf(ok, COOKIE_ACCESS);
    const r1New = cookieOf(ok, COOKIE_REFRESH);
    // 用**新 access** 配**旧 refresh** → 401（绑定性：refresh 的会话 ≠ access 的会话）
    const replay = await request(serverA()).post('/api/v1/auth/rotate').set(XRW).set('Cookie', `${a1New}; ${r1}`);
    expect(replay.status).toBe(401);
    expect(replay.body.error.code).toBe('UNAUTHORIZED');
    // 旧 refresh 也不能单独换出新会话
    await request(serverA()).post('/api/v1/auth/refresh').set(XRW).set('Cookie', r1).expect(401);
    // 重放失败不反噬新会话：新凭证仍可用，且新一对可以再次正常轮换
    await request(serverA()).get('/api/v1/auth/me').set('Cookie', a1New).expect(200);
    const second = await request(serverA()).post('/api/v1/auth/rotate')
      .set(XRW).set('Cookie', `${a1New}; ${r1New}`).expect(201);
    await request(serverA()).get('/api/v1/auth/me').set('Cookie', cookieOf(second, COOKIE_ACCESS)).expect(200);
  }, 60_000);

  it('并发上限不回归：设备分组与轮换都不突破上限，也不误踢其他设备', async () => {
    const { user, email } = await makeUser('conc');
    process.env.SESSION_MAX_CONCURRENT = '2';
    try {
      const a = await login(serverA(), email, 'conc-A').expect(201);
      const b = await login(serverA(), email, 'conc-B').expect(201);
      const cA = cookieOf(a, COOKIE_ACCESS);
      const cB = cookieOf(b, COOKIE_ACCESS);
      // 上限内：两条并存
      expect(await prisma.session.count({ where: { userId: user.id, revokedAt: null } })).toBe(2);

      // 轮换**不额外占用额度**（先撤销旧会话再签发）：活跃数恒 ≤ 上限，且不误踢另一台设备
      const rotated = await request(serverA()).post('/api/v1/auth/rotate')
        .set(XRW).set('Cookie', `${cA}; ${cookieOf(a, COOKIE_REFRESH)}`).expect(201);
      const cA2 = cookieOf(rotated, COOKIE_ACCESS);
      expect(await prisma.session.count({ where: { userId: user.id, revokedAt: null } })).toBe(2);
      await request(serverA()).get('/api/v1/auth/me').set('Cookie', cB).expect(200); // 另一设备未被挤掉
      await request(serverA()).get('/api/v1/auth/me').set('Cookie', cA2).expect(200);

      // 超限：evict-oldest 挤最旧（不拒绝登录），活跃数**恒 ≤ 上限**。
      // 此刻活跃 = conc-A(轮换后) + conc-B；最旧 = conc-B（轮换会重排"最旧"）→ 被挤掉的是 conc-B
      const c = await login(serverA(), email, 'conc-C').expect(201);
      const cC = cookieOf(c, COOKIE_ACCESS);
      expect(await prisma.session.count({ where: { userId: user.id, revokedAt: null } })).toBe(2);
      await request(serverA()).get('/api/v1/auth/me').set('Cookie', cC).expect(200);
      await request(serverA()).get('/api/v1/auth/me').set('Cookie', cA2).expect(200); // conc-A 存活
      await request(serverA()).get('/api/v1/auth/me').set('Cookie', cB).expect(401); // conc-B 被挤掉

      // 设备分组不受挤占影响：按设备下线只命中该设备的会话
      const killed = await revokeDevice(serverA(), cC, 'conc-A').expect(200);
      expect(killed.body.data.revokedSessions).toBe(1); // 只下线 conc-A 的那一条
      await request(serverA()).get('/api/v1/auth/me').set('Cookie', cC).expect(200); // 调用者（conc-C）不受影响
      await request(serverA()).get('/api/v1/auth/me').set('Cookie', cA2).expect(401);
      expect(await prisma.session.count({ where: { userId: user.id, revokedAt: null } })).toBe(1);
    } finally {
      delete process.env.SESSION_MAX_CONCURRENT;
    }
  }, 90_000);

  it('自服务边界：未登录 → 401；缺 CSRF 头 → 403（新端点沿用既有鉴权/CSRF 面）', async () => {
    const { email } = await makeUser('bound');
    const res = await login(serverA(), email, 'bound-dev').expect(201);
    const cookie = cookieOf(res, COOKIE_ACCESS);

    // 未登录（无 cookie）→ 401
    await request(serverA()).get('/api/v1/auth/sessions').expect(401);
    await request(serverA()).delete('/api/v1/auth/sessions/device/x').set(XRW).expect(401);
    await request(serverA()).delete('/api/v1/auth/sessions/x').set(XRW).expect(401);
    await request(serverA()).post('/api/v1/auth/rotate').set(XRW).expect(401);

    // 非安全方法缺 X-Requested-With → 403（跨站请求无法携带该头）
    await request(serverA()).delete('/api/v1/auth/sessions/device/bound-dev').set('Cookie', cookie).expect(403);
    await request(serverA()).delete('/api/v1/auth/sessions/whatever').set('Cookie', cookie).expect(403);
    await request(serverA()).post('/api/v1/auth/rotate').set('Cookie', cookie).expect(403);

    // 带 CSRF 头时自己的会话照常可读（对照组）
    await listSessions(serverA(), cookie).expect(200);
  }, 60_000);

  it('单会话下线：本人会话 200 + 该 access token 立即 401；已撤销 → 幂等 0', async () => {
    const { email } = await makeUser('single');
    const s1 = await login(serverA(), email, 'kill-me').expect(201);
    const s2 = await login(serverA(), email, 'keep-me').expect(201);
    const killAccess = cookieOf(s1, COOKIE_ACCESS);
    const killee = decodeJwt(killAccess).sid as string;

    const res = await revokeOne(serverA(), cookieOf(s2, COOKIE_ACCESS), killee).expect(200);
    expect(res.body.data.revokedSessions).toBe(1);
    // 被下线会话：401（其 access token 立即失效——撤销走 DB revokedAt，权威且即时）
    expect((await request(serverA()).get('/api/v1/auth/me').set('Cookie', killAccess)).status).toBe(401);
    // 未使用 DEVICE_REVOKED（这是单会话下线，不是设备下线——原因码不混淆）
    const denied = await request(serverA()).get('/api/v1/auth/me').set('Cookie', killAccess);
    expect(denied.body.error.code).toBe('UNAUTHORIZED');
    // 另一个会话不受影响
    await request(serverA()).get('/api/v1/auth/me').set('Cookie', cookieOf(s2, COOKIE_ACCESS)).expect(200);
    // 幂等：重复下线同一会话 → 0（不报错）
    const again = await revokeOne(serverA(), cookieOf(s2, COOKIE_ACCESS), killee).expect(200);
    expect(again.body.data.revokedSessions).toBe(0);
    // 列表里不再出现已撤销会话（只列活跃）
    const list = await listSessions(serverA(), cookieOf(s2, COOKIE_ACCESS)).expect(200);
    expect((list.body.data.sessions as SessionRow[]).map((s) => s.id)).not.toContain(killee);
  }, 60_000);

  it('下线自己所在的设备：清双 cookie（Max-Age=0）+ 本请求 cookie 立即 DEVICE_REVOKED；下线他设备不清 cookie', async () => {
    const { email } = await makeUser('self');
    const me = await login(serverA(), email, 'self-dev-1').expect(201);
    const other = await login(serverA(), email, 'self-dev-2').expect(201);
    const cMe = cookieOf(me, COOKIE_ACCESS);
    const cOther = cookieOf(other, COOKIE_ACCESS);

    // 下线**他设备**：调用者 cookie 不清（否则会把自己无故踢出）
    const otherRes = await revokeDevice(serverA(), cMe, 'self-dev-2').expect(200);
    expect(otherRes.body.data.revokedSessions).toBe(1);
    const otherCookies = (otherRes.headers['set-cookie'] as unknown as string[]) ?? [];
    expect(otherCookies.some((c) => c.includes('Max-Age=0'))).toBe(false);
    await request(serverA()).get('/api/v1/auth/me').set('Cookie', cMe).expect(200);

    // 下线**自己所在设备**：双 cookie 清零 + 后续请求 401 DEVICE_REVOKED
    const selfRes = await revokeDevice(serverA(), cMe, 'self-dev-1').expect(200);
    expect(selfRes.body.data.revokedSessions).toBe(1);
    const cleared = (selfRes.headers['set-cookie'] as unknown as string[]) ?? [];
    expect(cleared.filter((c) => c.includes('Max-Age=0'))).toHaveLength(2);
    const denied = await request(serverA()).get('/api/v1/auth/me').set('Cookie', cMe);
    expect(denied.status).toBe(401);
    expect(denied.body.error.code).toBe('DEVICE_REVOKED');
    // 被下线的另一个设备同样是 401（同一用户、不同设备，但都已撤销）
    expect((await request(serverA()).get('/api/v1/auth/me').set('Cookie', cOther)).status).toBe(401);
    expect(await prisma.session.count({ where: { userId: decodeJwt(cMe).sub, revokedAt: null } })).toBe(0);
  }, 60_000);

  it('deviceId 来源契约：header 优先于 body；非法/缺失不阻断登录且不写 deviceId', async () => {
    const { user, email } = await makeUser('src');
    // header 与 body 同时给 → header 胜出
    const both = await request(serverA()).post('/api/v1/auth/login').set(XRW)
      .set(DEVICE_ID_HEADER, 'from-header').send({ email, password: PASSWORD, deviceId: 'from-body' }).expect(201);
    await request(serverA()).get('/api/v1/auth/me').set('Cookie', cookieOf(both, COOKIE_ACCESS)).expect(200);
    // body 兜底（不便设置 header 的客户端）
    await request(serverA()).post('/api/v1/auth/login').set(XRW)
      .send({ email, password: PASSWORD, deviceId: 'from-body-only' }).expect(201);
    // 未提供 → 仍可登录（deviceId 为 null，只是不参与设备分组）
    await login(serverA(), email).expect(201);

    const rows = await prisma.session.findMany({
      where: { userId: user.id, revokedAt: null }, select: { deviceId: true }, orderBy: { createdAt: 'asc' },
    });
    expect(rows.map((r) => r.deviceId)).toEqual(['from-header', 'from-body-only', null]);
    // 该用户可按 header 上报的设备下线（body 来源同样是合法的分组键）
    const res = await request(serverA()).post('/api/v1/auth/login').set(XRW)
      .send({ email, password: PASSWORD, deviceId: 'from-body-only' }).expect(201);
    const killed = await revokeDevice(serverA(), cookieOf(res, COOKIE_ACCESS), 'from-body-only').expect(200);
    expect(killed.body.data.revokedSessions).toBe(2); // 首次 + 本次共两条同设备会话，整组下线

    // 清洗契约（header 路径不经 DTO 校验 → 由 normalizeDeviceId 清洗；超长**截断**而非拒绝登录）
    const deviceIdOf = async (r: request.Response) => {
      const sid = decodeJwt(cookieOf(r, COOKIE_ACCESS)).sid as string;
      return (await prisma.session.findUnique({ where: { id: sid }, select: { deviceId: true } }))!.deviceId;
    };
    const odd = await request(serverA()).post('/api/v1/auth/login').set(XRW)
      .set(DEVICE_ID_HEADER, '  phone\t-A  ').send({ email, password: PASSWORD }).expect(201);
    expect(await deviceIdOf(odd)).toBe('phone-A'); // 控制字符（TAB）+ 首尾空白被清洗
    // 注入面：body 里的 CR/LF/TAB 绝不入库（deviceId 会进日志/索引 → 防日志注入）；
    // 同时非 ASCII（中文设备名）**原样保留**（清洗只针对控制字符，不做 ASCII 化）
    const injected = await request(serverA()).post('/api/v1/auth/login').set(XRW)
      .send({ email, password: PASSWORD, deviceId: '手机\r\n甲\tb c' }).expect(201);
    expect(await deviceIdOf(injected)).toBe('手机甲b c');
    const long = await request(serverA()).post('/api/v1/auth/login').set(XRW)
      .set(DEVICE_ID_HEADER, 'x'.repeat(300)).send({ email, password: PASSWORD }).expect(201);
    expect(await deviceIdOf(long)).toBe('x'.repeat(128)); // 截断到上限
    const blank = await request(serverA()).post('/api/v1/auth/login').set(XRW)
      .set(DEVICE_ID_HEADER, '   ').send({ email, password: PASSWORD }).expect(201);
    expect(await deviceIdOf(blank)).toBeNull(); // 清洗后为空 = 未提供
    // 超长标识可整组下线：下线端点对参数做**同一套**清洗 → 截断后的分组键仍能命中
    const killedLong = await revokeDevice(serverA(), cookieOf(long, COOKIE_ACCESS), 'x'.repeat(300)).expect(200);
    expect(killedLong.body.data.revokedSessions).toBe(1);
    // body 路径受 DTO 校验：>128 直接 400（header 路径不设上限、只截断——两条路径的差异是**有意**的）
    const tooLongBody = await request(serverA()).post('/api/v1/auth/login').set(XRW)
      .send({ email, password: PASSWORD, deviceId: 'y'.repeat(129) });
    expect(tooLongBody.status).toBe(400);
    expect(tooLongBody.body.error.code).toBe('VALIDATION_ERROR');
  }, 60_000);
});
