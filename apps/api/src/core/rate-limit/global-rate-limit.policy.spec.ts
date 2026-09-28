import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  DEFAULT_AUTH_PER_MIN, DEFAULT_READ_PER_MIN, DEFAULT_UPLOAD_PER_MIN, DEFAULT_WINDOW_MS, DEFAULT_WRITE_PER_MIN,
  GRL_ENV, NON_PROD_RELAX_FACTOR, evaluateGlobalRateLimit, globalRateLimitConfig, isStreamingRoute,
  normalizePath, resetGlobalRateLimitConfigCache, resolveClientIp,
} from './global-rate-limit.policy';

/** 与生产/非生产默认值相关的 env：逐用例控制并在结束时还原（同进程内的其它 spec 不受影响） */
const ENV_KEYS = Object.values(GRL_ENV);
const saved: Record<string, string | undefined> = {};
const savedNodeEnv = process.env.NODE_ENV;

function clearAll(): void {
  for (const k of ENV_KEYS) delete process.env[k];
  resetGlobalRateLimitConfigCache();
}

beforeEach(() => {
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  clearAll();
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  process.env.NODE_ENV = savedNodeEnv;
  resetGlobalRateLimitConfigCache();
});

/** 请求字面量（无需构造 Express 实例） */
function req(over: Partial<Parameters<typeof evaluateGlobalRateLimit>[0]> = {}) {
  return {
    method: 'GET',
    path: '/api/v1/conversations',
    headers: {} as Record<string, string>,
    socket: { remoteAddress: '::ffff:127.0.0.1' },
    ...over,
  };
}

describe('M10-P8 阈值与配置解析', () => {
  it('生产默认：read 300 / write 60 / auth 30 / upload 30 per min，窗口 60s，可信跳 0，默认启用', () => {
    process.env.NODE_ENV = 'production';
    const c = globalRateLimitConfig();
    expect(c).toMatchObject({
      enabled: true, trustedProxyHops: 0, windowMs: DEFAULT_WINDOW_MS, relaxed: false,
      limits: { read: DEFAULT_READ_PER_MIN, write: DEFAULT_WRITE_PER_MIN, auth: DEFAULT_AUTH_PER_MIN, upload: DEFAULT_UPLOAD_PER_MIN },
    });
    expect([DEFAULT_READ_PER_MIN, DEFAULT_WRITE_PER_MIN, DEFAULT_AUTH_PER_MIN, DEFAULT_UPLOAD_PER_MIN]).toEqual([300, 60, 30, 30]);
  });

  it('非生产默认：阈值放宽固定倍数（既有 e2e/开发不被回环 IP 误伤），窗口不放宽', () => {
    process.env.NODE_ENV = 'test';
    const c = globalRateLimitConfig();
    expect(c.relaxed).toBe(true);
    expect(c.limits).toEqual({
      read: DEFAULT_READ_PER_MIN * NON_PROD_RELAX_FACTOR,
      write: DEFAULT_WRITE_PER_MIN * NON_PROD_RELAX_FACTOR,
      auth: DEFAULT_AUTH_PER_MIN * NON_PROD_RELAX_FACTOR,
      upload: DEFAULT_UPLOAD_PER_MIN * NON_PROD_RELAX_FACTOR,
    });
    expect(c.windowMs).toBe(DEFAULT_WINDOW_MS); // 窗口若也放宽，"被拒绝"的桶会锁 100 分钟
  });

  it('显式 env 在**任何环境**都按显式值生效（e2e/运维收紧通道）', () => {
    process.env.NODE_ENV = 'test';
    process.env[GRL_ENV.READ] = '20';
    process.env[GRL_ENV.WRITE] = '3';
    process.env[GRL_ENV.WINDOW] = '3000';
    const c = globalRateLimitConfig();
    expect(c.limits.read).toBe(20);
    expect(c.limits.write).toBe(3);
    expect(c.windowMs).toBe(3000);
    expect(c.limits.auth).toBe(DEFAULT_AUTH_PER_MIN * NON_PROD_RELAX_FACTOR); // 未显式设置的桶仍走放宽默认
  });

  it('非法 env 值不产生 0/NaN 阈值（否则会"拒绝一切"），回退默认', () => {
    process.env.NODE_ENV = 'production';
    process.env[GRL_ENV.READ] = 'abc';
    process.env[GRL_ENV.WRITE] = '-5';
    process.env[GRL_ENV.WINDOW] = '0';
    envHops('x');
    const c = globalRateLimitConfig();
    expect(c.limits.read).toBe(DEFAULT_READ_PER_MIN);
    expect(c.limits.write).toBe(DEFAULT_WRITE_PER_MIN);
    expect(c.windowMs).toBe(DEFAULT_WINDOW_MS);
    expect(c.trustedProxyHops).toBe(0);
  });

  it('TRUSTED_PROXY_HOPS 解析：0 与正整数生效，负数回退 0', () => {
    envHops('2');
    expect(globalRateLimitConfig().trustedProxyHops).toBe(2);
    envHops('0');
    expect(globalRateLimitConfig().trustedProxyHops).toBe(0);
    envHops('-3');
    expect(globalRateLimitConfig().trustedProxyHops).toBe(0);
  });

  it('GLOBAL_RATE_LIMIT_ENABLED=false 仅显式关闭时生效；非法值按未设置（默认启用，绝不静默关闭防护）', () => {
    process.env[GRL_ENV.ENABLED] = 'false';
    expect(globalRateLimitConfig().enabled).toBe(false);
    expect(evaluateGlobalRateLimit(req()).bucket).toBe('disabled');
    process.env[GRL_ENV.ENABLED] = 'maybe';
    expect(globalRateLimitConfig().enabled).toBe(true);
    expect(evaluateGlobalRateLimit(req()).exempt).toBe(false);
  });

  function envHops(v: string): void {
    process.env[GRL_ENV.HOPS] = v;
  }
});

describe('M10-P8 客户端 IP 解析（可信跳 / 抗伪造）', () => {
  it('hops=0（默认）：完全忽略 X-Forwarded-For，用 socket 地址（伪造头无效）', () => {
    const r = req({ headers: { 'x-forwarded-for': '9.9.9.9' } });
    expect(resolveClientIp(r, 0)).toBe('127.0.0.1');
  });

  it('hops=1：取 XFF 链右起第 1 跳（= 边界代理追加项），客户端可伪造的左项被忽略', () => {
    expect(resolveClientIp(req({ headers: { 'x-forwarded-for': '9.9.9.9, 10.0.0.7' } }), 1)).toBe('10.0.0.7');
    expect(resolveClientIp(req({ headers: { 'x-forwarded-for': '10.0.0.7' } }), 1)).toBe('10.0.0.7');
  });

  it('hops=2：取右起第 2 跳（两级可信代理）', () => {
    expect(resolveClientIp(req({ headers: { 'x-forwarded-for': '203.0.113.5, 10.0.0.1, 10.0.0.2' } }), 2)).toBe('10.0.0.1');
  });

  it('链长不足可信跳 → 回退 socket（绝不用可伪造的最左项）', () => {
    expect(resolveClientIp(req({ headers: { 'x-forwarded-for': '9.9.9.9' } }), 3)).toBe('127.0.0.1');
    expect(resolveClientIp(req({ headers: {} }), 1)).toBe('127.0.0.1');
    expect(resolveClientIp(req({ headers: { 'x-forwarded-for': '   ' } }), 1)).toBe('127.0.0.1');
  });

  it('规范化：IPv4-mapped IPv6 前缀、端口、大小写、多值头合并', () => {
    expect(resolveClientIp(req({ socket: { remoteAddress: '::ffff:192.168.1.9' } }), 0)).toBe('192.168.1.9');
    expect(resolveClientIp(req({ headers: { 'x-forwarded-for': '10.0.0.7:4321' } }), 1)).toBe('10.0.0.7');
    expect(resolveClientIp(req({ headers: { 'x-forwarded-for': '2001:DB8::1' } }), 1)).toBe('2001:db8::1');
    expect(resolveClientIp(req({ headers: { 'x-forwarded-for': ['10.0.0.1, 10.0.0.2'] as unknown as string } }), 1)).toBe('10.0.0.2');
  });

  it('非法取值回退 socket（垃圾串不能变成"每请求一个新桶"的绕过通道）', () => {
    expect(resolveClientIp(req({ headers: { 'x-forwarded-for': 'not-an-ip' } }), 1)).toBe('127.0.0.1');
    expect(resolveClientIp(req({ headers: { 'x-forwarded-for': '999.999.1.1' } }), 1)).toBe('127.0.0.1');
    expect(resolveClientIp(req({ headers: { 'x-forwarded-for': '10.0.0.7, junk' } }), 1)).toBe('127.0.0.1');
  });
});

describe('M10-P8 端点桶键（有界键空间）', () => {
  it('优先用路由模板：带 UUID 的 URL 与不带 UUID 的同端点共享一个桶', () => {
    const pattern = '/api/v1/conversations/:id';
    const a = evaluateGlobalRateLimit(req({ method: 'GET', path: '/api/v1/conversations/11111111-1111-1111-1111-111111111111', route: { path: pattern } }));
    const b = evaluateGlobalRateLimit(req({ method: 'GET', path: '/api/v1/conversations/22222222-2222-2222-2222-222222222222', route: { path: pattern } }));
    expect(a.key).toBe(b.key);
    expect(a.key).toBe('global:read:127.0.0.1:GET:/api/v1/conversations/:id');
  });

  it('无路由模板时回退规范化原始路径（UUID/cuid/数字/超长段 → :id/:num）', () => {
    expect(normalizePath('/api/v1/agent-runs/0b6f7a1e-9c0d-4a5b-8e2f-1c2d3e4f5a6b/timeline')).toBe('/api/v1/agent-runs/:id/timeline');
    expect(normalizePath('/api/v1/tasks/clx1234567890abcdefghijkl/cancel')).toBe('/api/v1/tasks/:id/cancel');
    expect(normalizePath('/api/v1/events/42')).toBe('/api/v1/events/:num');
    const long = 'x'.repeat(40);
    expect(normalizePath(`/api/v1/hooks/${long}`)).toBe('/api/v1/hooks/:id');
  });

  it('方法进键：同路径的 GET 与 POST 是不同桶（读写阈值不同）', () => {
    const g = evaluateGlobalRateLimit(req({ method: 'GET', path: '/api/v1/conversations' }));
    const p = evaluateGlobalRateLimit(req({ method: 'POST', path: '/api/v1/conversations' }));
    expect(g.key).not.toBe(p.key);
    expect(g.bucket).toBe('read');
    expect(p.bucket).toBe('write');
  });

  it('IP 进键：不同 IP 各自成桶', () => {
    const a = evaluateGlobalRateLimit(req({ socket: { remoteAddress: '10.0.0.1' } }));
    const b = evaluateGlobalRateLimit(req({ socket: { remoteAddress: '10.0.0.2' } }));
    expect(a.key).not.toBe(b.key);
  });
});

describe('M10-P8 豁免矩阵', () => {
  it('健康探针（/health、/health/*、/live、/ready）一律豁免，不计数', () => {
    for (const path of ['/api/v1/health', '/api/v1/health/live', '/api/v1/health/ready', '/api/v1/live', '/api/v1/ready', '/api/v1/health/boom']) {
      const plan = evaluateGlobalRateLimit(req({ path, route: { path } }));
      expect(plan).toMatchObject({ exempt: true, bucket: 'probe', key: '' });
    }
  });

  it('CORS 预检（OPTIONS）豁免', () => {
    expect(evaluateGlobalRateLimit(req({ method: 'OPTIONS', path: '/api/v1/conversations' })).bucket).toBe('preflight');
  });

  it('webhook（hooks/*）豁免：已有 per-token 桶，避免双重限流压制平台回调', () => {
    const plan = evaluateGlobalRateLimit(req({ method: 'POST', path: '/api/v1/hooks/workflows/tok-1', route: { path: '/api/v1/hooks/workflows/:token' } }));
    expect(plan).toMatchObject({ exempt: true, bucket: 'webhook' });
  });

  it('SSE 长连接豁免；但集合型 /events 与写方法不豁免', () => {
    const sse = evaluateGlobalRateLimit(req({ method: 'GET', path: '/api/v1/agent-runs/abc/events', route: { path: '/api/v1/agent-runs/:id/events' } }));
    expect(sse).toMatchObject({ exempt: true, bucket: 'stream' });
    expect(isStreamingRoute('/agent-runs/:id/stream', 'GET')).toBe(true);
    expect(isStreamingRoute('/agent-runs/:id/events', 'POST')).toBe(false);
    // 事件列表 API（集合型）不是长连接 → 必须计桶
    expect(evaluateGlobalRateLimit(req({ method: 'GET', path: '/api/v1/events', route: { path: '/api/v1/events' } })).exempt).toBe(false);
    // 无路由模板时按规范化路径判定（UUID 段 → :id → 仍是长连接）
    expect(evaluateGlobalRateLimit(req({ method: 'GET', path: '/api/v1/agent-runs/0b6f7a1e-9c0d-4a5b-8e2f-1c2d3e4f5a6b/events' })).bucket).toBe('stream');
  });

  it('认证桶：login/refresh（POST）独立桶；GET 同路径仍按读桶', () => {
    const login = evaluateGlobalRateLimit(req({ method: 'POST', path: '/api/v1/auth/login' }));
    const refresh = evaluateGlobalRateLimit(req({ method: 'POST', path: '/api/v1/auth/refresh' }));
    expect(login.bucket).toBe('auth');
    expect(refresh.bucket).toBe('auth');
    expect(login.key).toContain('global:auth:');
    expect(evaluateGlobalRateLimit(req({ method: 'GET', path: '/api/v1/auth/me' })).bucket).toBe('read');
  });

  it('上传桶：POST /attachments（集合路由）独立桶且阈值更严；子路由/其它方法按通用桶', () => {
    const upload = evaluateGlobalRateLimit(req({ method: 'POST', path: '/api/v1/attachments', route: { path: '/api/v1/attachments' } }));
    expect(upload.bucket).toBe('upload');
    expect(upload.limit).toBe(globalRateLimitConfig().limits.upload);
    expect(evaluateGlobalRateLimit(req({ method: 'GET', path: '/api/v1/attachments/abc', route: { path: '/api/v1/attachments/:id' } })).bucket).toBe('read');
    expect(evaluateGlobalRateLimit(req({ method: 'DELETE', path: '/api/v1/conversations/x', route: { path: '/api/v1/conversations/:id' } })).bucket).toBe('write');
  });

  it('计划里带出真实阈值/窗口（守卫据它调用 RateLimitService.consume）', () => {
    process.env.NODE_ENV = 'production';
    const plan = evaluateGlobalRateLimit(req({ method: 'POST', path: '/api/v1/conversations' }));
    expect(plan).toMatchObject({ exempt: false, bucket: 'write', limit: DEFAULT_WRITE_PER_MIN, windowMs: DEFAULT_WINDOW_MS });
  });
});
