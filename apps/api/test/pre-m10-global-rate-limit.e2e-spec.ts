import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import cookieParser from 'cookie-parser';
import Redis from 'ioredis';
import { randomUUID } from 'node:crypto';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { AppModule } from '../src/app.module';
import { GlobalExceptionFilter } from '../src/common/filters/global-exception.filter';
import { TransformInterceptor } from '../src/common/interceptors/transform.interceptor';
import { csrfProtection } from '../src/modules/auth/csrf.middleware';
import { GRL_ENV } from '../src/core/rate-limit/global-rate-limit.policy';

/**
 * M10-P8 全局 per-IP 限流 e2e（审计 SA-25；真实 PostgreSQL/Redis/HTTP）。
 *
 * 断言的是**可观测后果**，不是"守卫被挂载过"：
 *  ① 真实 HTTP 连打 → 第 N+1 次 429 RATE_LIMITED（阈值由 env 显式压到 20/min，不依赖生产默认值）；
 *  ② Redis 键形状 = `ratelimit:global:{bucket}:{ip}:{method}:{路由模板}`（键空间有界：UUID 段是 `:id` 而非原始 URL）；
 *  ③ 窗口恢复语义（固定窗口：窗口到期后计数清零、放行）；
 *  ④ 维度隔离：IP / 端点 / 方法（读写桶）互不牵连；
 *  ⑤ 伪造 `X-Forwarded-For`：默认（可信跳 0）**完全无效**；可信跳 1 时只认右起第 1 跳（左侧伪造项被忽略）；
 *  ⑥ 豁免面**零 Redis 操作**：健康探针 / CORS 预检 / webhook（已有 per-token 桶）/ SSE 长连接路径；
 *  ⑦ 桶分层：auth（login）与 upload（POST /attachments）各有独立桶，不占用通用读写桶。
 *
 * 独立 Redis DB：本文件**强制**指向独立库 `/28`（限流键绝不落在共享 DB0，否则本 spec 压低的阈值会与
 * 其他 spec 的键互相污染）。前置条件：Redis 的 `databases` ≥ 29（本仓库 docker/compose.yml 已重建为
 * `databases 64`；redis 默认值 16 会让 `/28` 报 `ERR DB index is out of range` 并静默落到 db0，隔离失效）。
 * 运行：
 *   cd apps/api && npx vitest run test/pre-m10-global-rate-limit.e2e-spec.ts
 */

// —— 独立 DB（隔离铁律）+ 显式低压阈值（验证真实限流语义，而不是"非生产放宽默认"）——
process.env.REDIS_URL = 'redis://localhost:6379/28';
const READ_LIMIT = 20;
const WRITE_LIMIT = 3;
const AUTH_LIMIT = 2;
const UPLOAD_LIMIT = 2;
const WINDOW_MS = 3_000;
process.env[GRL_ENV.READ] = String(READ_LIMIT);
process.env[GRL_ENV.WRITE] = String(WRITE_LIMIT);
process.env[GRL_ENV.AUTH] = String(AUTH_LIMIT);
process.env[GRL_ENV.UPLOAD] = String(UPLOAD_LIMIT);
process.env[GRL_ENV.WINDOW] = String(WINDOW_MS);
process.env[GRL_ENV.HOPS] = '1'; // 单层反代（本 spec 用伪造 XFF 构造"不同客户端 IP"）

const XRW = { 'X-Requested-With': 'XMLHttpRequest' };
/** 唯一不存在的 id（404 路径也会被计数——守卫先于处理器执行） */
const MISSING_ID = '00000000-0000-0000-0000-0000000000ff';

describe('M10-P8 全局 per-IP 限流 (e2e)', () => {
  let app: INestApplication;
  let cookie = '';
  let redis: Redis;

  /** 伪造客户端 IP（TRUSTED_PROXY_HOPS=1 → 取 XFF 右起第 1 跳） */
  const xff = (ip: string) => ({ 'x-forwarded-for': ip });

  const get = (path: string, ip: string) =>
    request(app.getHttpServer()).get(path).set(xff(ip)).set('Cookie', cookie);
  const post = (path: string, ip: string, body: unknown = {}) =>
    request(app.getHttpServer()).post(path).set(XRW).set(xff(ip)).set('Cookie', cookie).send(body as object);

  interface HttpRes { status: number; body?: { error?: { code?: string; message?: string } } }

  const is429 = (res: HttpRes) => res.status === 429 && res.body?.error?.code === 'RATE_LIMITED';

  /** 连打 count 次（fn 收到序号，可按序号换伪造 IP 等）：返回 [响应序] */
  async function hammer(count: number, fn: (i: number) => PromiseLike<HttpRes>): Promise<HttpRes[]> {
    const out: HttpRes[] = [];
    for (let i = 0; i < count; i++) out.push(await fn(i));
    return out;
  }

  /** 删除匹配到的键（空数组时直接跳过——ioredis 对空参数会报错） */
  async function delKeys(keys: string[]): Promise<void> {
    if (keys.length) await redis.del(keys);
  }

  const globalKeys = () => redis.keys('ratelimit:global:*');

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
    await app.listen(0);

    redis = new Redis(process.env.REDIS_URL!);
    await redis.flushdb(); // 本 spec 独占 DB28：清掉上一轮的桶，保证计数从 0 开始

    // 登录（用独立伪造 IP：不占用其它用例的 auth 桶）
    const login = await request(app.getHttpServer()).post('/api/v1/auth/login').set(XRW).set(xff('10.9.9.9'))
      .send({ email: process.env.SEED_ADMIN_EMAIL ?? 'admin@example.com', password: process.env.SEED_ADMIN_PASSWORD ?? 'admin123456' });
    expect(login.status).toBe(201);
    cookie = (login.headers['set-cookie'] as unknown as string[]).map((c) => c.split(';')[0]).join('; ');
  }, 60_000);

  afterAll(async () => {
    await redis.keys('ratelimit:global:*').then((keys) => delKeys(keys)).catch(() => undefined);
    redis?.disconnect();
    await app?.close();
  });

  it('① 真实 HTTP 连打到阈值 → 第 21 次 429 RATE_LIMITED（22/23 次仍 429）', async () => {
    const ip = '10.1.0.1';
    const ok = await hammer(READ_LIMIT, () => get('/api/v1/conversations', ip));
    expect(ok.every((r) => r.status === 200)).toBe(true);

    const overflow = await hammer(3, () => get('/api/v1/conversations', ip));
    expect(overflow.every(is429)).toBe(true);
    expect(overflow[0].body?.error?.message).toBe('请求过于频繁，请稍后再试');
  });

  it('② Redis 键形状：global:{bucket}:{ip}:{method}:{路由模板}（键空间有界，非原始 URL）', async () => {
    const ip = '10.1.0.2';
    // 带 UUID 的详情路由：桶必须落在路由模板上（否则键空间随 id 无限膨胀 / 限流可被 id 轮换绕过）
    const detail = await hammer(2, () => get(`/api/v1/conversations/${MISSING_ID}`, ip));
    expect(detail.every((r) => r.status === 404)).toBe(true);

    const keys = await globalKeys();
    const detailKey = keys.find((k) => k.includes(`global:read:${ip}:GET:`));
    expect(detailKey).toBeDefined();
    expect(detailKey).toMatch(/:GET:(\/api\/v1)?\/conversations\/:id$/); // 路由模板（`:id`）
    expect(detailKey).not.toContain(MISSING_ID); // 绝不出现原始 UUID
    // 幂等：同端点不同 id 命中同一个桶（键只有一条）
    expect(keys.filter((k) => k.includes(`global:read:${ip}:GET:`))).toHaveLength(1);
    const ttl = await redis.ttl(detailKey!);
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(Math.ceil(WINDOW_MS / 1000));
  });

  it('③ 窗口恢复语义：固定窗口到期后计数清零并放行', async () => {
    const ip = '10.3.0.1';
    await hammer(READ_LIMIT, () => get('/api/v1/conversations', ip));
    expect(is429(await get('/api/v1/conversations', ip))).toBe(true);

    await new Promise((r) => setTimeout(r, WINDOW_MS + 400)); // 固定窗口：等窗口过期（X-08 滑动窗口为 Deferred）
    expect((await get('/api/v1/conversations', ip)).status).toBe(200);
  }, 20_000);

  it('④ 维度隔离：端点（同 IP 不同端点）与方法（读桶满 ≠ 写桶受影响）各自成桶', async () => {
    const ip = '10.2.0.1';
    // 打满 GET /conversations 的读桶
    await hammer(READ_LIMIT, () => get('/api/v1/conversations', ip));
    expect(is429(await get('/api/v1/conversations', ip))).toBe(true);
    // 同 IP 的另一端点不受影响
    expect((await get('/api/v1/projects', ip)).status).toBe(200);
    // 同端点的另一 IP 不受影响
    expect((await get('/api/v1/projects', '10.2.0.2')).status).toBe(200);
    expect((await get('/api/v1/conversations', '10.2.0.2')).status).toBe(200);
    // 写桶另有阈值（见 ⑦ 的写桶用例）：这里断言同 IP 的写请求不被读桶牵连
    expect((await post('/api/v1/tasks/' + MISSING_ID + '/cancel', ip)).status).not.toBe(429);
  });

  it('⑤ 伪造 X-Forwarded-For：可信跳 0 时完全无效（同 socket IP 共享一个桶）', async () => {
    process.env[GRL_ENV.HOPS] = '0';
    try {
      // 每次换一个伪造 IP：若实现信任 XFF，则永远打不满桶；正确实现下它们全部计到 socket IP（127.0.0.1）
      const ip = '127.0.0.1';
      await delKeys((await globalKeys()).filter((k) => k.includes('/memories'))); // 只清本用例用到的端点
      const res = await hammer(READ_LIMIT + 1, (_i: number) => {
        const forged = `203.0.113.${(_i % 250) + 1}`;
        return request(app.getHttpServer()).get('/api/v1/memories').set(xff(forged)).set('Cookie', cookie);
      });
      expect(res.slice(0, READ_LIMIT).every((r) => r.status === 200)).toBe(true);
      expect(is429(res[READ_LIMIT])).toBe(true); // 伪造 21 个"不同 IP"仍被同一桶拦下
      const keys = await globalKeys();
      expect(keys.some((k) => k.includes(`global:read:${ip}:GET:`) && k.includes('/memories'))).toBe(true);
      expect(keys.some((k) => k.includes('203.0.113.'))).toBe(false); // 伪造项绝不进键
    } finally {
      process.env[GRL_ENV.HOPS] = '1';
    }
  });

  it('⑥ 可信跳 1：只认 XFF 右起第 1 跳（左侧伪造项被忽略，无法制造新桶）', async () => {
    const real = '10.4.0.1';
    const left = ['9.9.9.9', '8.8.8.8', '7.7.7.7'];
    const res = await hammer(READ_LIMIT + 1, (i: number) => {
      const spoofed = `${left[i % left.length]}, ${real}`;
      return request(app.getHttpServer()).get('/api/v1/projects').set(xff(spoofed)).set('Cookie', cookie);
    });
    expect(res.slice(0, READ_LIMIT).every((r) => r.status === 200)).toBe(true);
    expect(is429(res[READ_LIMIT])).toBe(true); // 左侧伪造变体全部归入同一桶（右起第 1 跳）
  });

  it('⑦ 写端点收紧：write 桶 3/min 生效，且不影响同 IP 的其它写端点', async () => {
    const ip = '10.5.0.1';
    const res = await hammer(WRITE_LIMIT + 1, () => post(`/api/v1/tasks/${MISSING_ID}/cancel`, ip));
    expect(res.slice(0, WRITE_LIMIT).every((r) => r.status === 404)).toBe(true); // 处理器结果无关：守卫先计数
    expect(is429(res[WRITE_LIMIT])).toBe(true);
    // 写桶按端点分桶：另一写端点仍然可用（首请求即 400 校验错误，不是 429）
    expect((await post('/api/v1/projects', ip, { name: '' })).status).not.toBe(429);
  });

  it('⑧ 认证桶独立：POST /auth/login 连续尝试到 auth 桶上限 → 429（先于 auth 的失败计数 5 次生效）', async () => {
    const ip = '10.6.0.1';
    const login = (i: number) => request(app.getHttpServer()).post('/api/v1/auth/login').set(XRW).set(xff(ip))
      .send({ email: `grl-${i}@example.com`, password: 'wrong-password' });
    const first = await hammer(AUTH_LIMIT, () => login(1));
    // auth 桶（2/min）足够宽松于失败计数（5 次/5 分钟）→ 前 2 次是业务 401，不是限流
    expect(first.every((r) => r.status === 401)).toBe(true);
    const third = await login(2);
    // 统一过滤器把 RATE_LIMITED 映射 429；文案是全局限流文案（区别于 auth 失败计数的"登录尝试过于频繁"）
    expect(is429(third)).toBe(true);
    expect(third.body?.error?.message).toBe('请求过于频繁，请稍后再试');
  });

  it('⑨ 上传桶独立（更严）：POST /attachments 到上限 → 429，且不占用通用写桶', async () => {
    const ip = '10.7.0.1';
    const upload = () => request(app.getHttpServer()).post('/api/v1/attachments').set(XRW).set(xff(ip)).set('Cookie', cookie);
    const res = await hammer(UPLOAD_LIMIT + 1, upload);
    expect(res.slice(0, UPLOAD_LIMIT).every((r) => r.status === 400)).toBe(true); // 缺少文件（校验错误）也计数
    expect(is429(res[UPLOAD_LIMIT])).toBe(true);
    const keys = await globalKeys();
    expect(keys.some((k) => k.includes(`global:upload:${ip}:POST:`))).toBe(true);
    // 上传桶满 ≠ 通用写桶满
    expect((await post('/api/v1/projects', ip, { name: '' })).status).not.toBe(429);
  });

  describe('⑩ 豁免面：不计数、不落 Redis（既有行为不被破坏）', () => {
    it('健康探针（/health/live、/health）连打 25 次绝不 429，且不产生任何限流键', async () => {
      await redis.flushdb(); // 从干净键空间开始：本用例断言"零 Redis 操作"，必须排除历史键/过期抖动
      const res = await hammer(25, () => request(app.getHttpServer()).get('/api/v1/health/live').set(xff('10.8.0.1')));
      expect(res.every((r) => r.status === 200)).toBe(true); // 阈值 20 却全部放行 → 探针豁免（否则编排层会摘流量/重启）
      expect((await request(app.getHttpServer()).get('/api/v1/health').set(xff('10.8.0.1'))).status).toBe(200);
      expect((await request(app.getHttpServer()).get('/api/v1/ready').set(xff('10.8.0.1'))).status).toBe(200);
      expect(await globalKeys()).toEqual([]); // 零 Redis 操作
    }, 30_000);

    it('webhook（hooks/*）豁免：已有 per-token 桶，不叠加 per-IP（25 次均 401 而非 429）', async () => {
      const res = await hammer(25, () => request(app.getHttpServer()).post('/api/v1/hooks/workflows/unknown-token').set(xff('10.8.0.2')).send({ ping: 1 }));
      expect(res.every((r) => r.status === 401)).toBe(true);
      expect(res.every((r) => r.body?.error?.code === 'WEBHOOK_SIGNATURE_INVALID')).toBe(true);
    });

    it('SSE 长连接路径豁免：未认证连打 25 次是 401（全局守卫先跑却因长连接豁免不计数），绝不 429', async () => {
      const runId = randomUUID();
      const res = await hammer(25, () => request(app.getHttpServer()).get(`/api/v1/agent-runs/${runId}/events`).set(xff('10.8.0.3')));
      expect(res.every((r) => r.status === 401)).toBe(true);
      const keys = await globalKeys();
      expect(keys.some((k) => k.includes('/events'))).toBe(false); // 长连接不产生桶
    });

    it('CORS 预检（OPTIONS）不计数', async () => {
      const res = await hammer(25, () => request(app.getHttpServer()).options('/api/v1/conversations').set(xff('10.8.0.4')).set('Origin', 'http://localhost:3000'));
      expect(res.every((r) => r.status !== 429)).toBe(true);
      // 集合型 /events（事件列表 API）不是长连接 → 仍然计桶（防"自选豁免"）
      await request(app.getHttpServer()).get('/api/v1/events').set(xff('10.8.0.5')).set('Cookie', cookie);
      const keys = await globalKeys();
      expect(keys.some((k) => k.includes('/events'))).toBe(true);
    });
  });
});
