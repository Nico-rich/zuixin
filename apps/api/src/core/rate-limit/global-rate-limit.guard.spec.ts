import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ExecutionContext } from '@nestjs/common';
import { GlobalRateLimitGuard, resetRelaxedWarning } from './global-rate-limit.guard';
import { GRL_ENV, resetGlobalRateLimitConfigCache } from './global-rate-limit.policy';
import { RateLimitService } from './rate-limit.service';

const savedNodeEnv = process.env.NODE_ENV;
const savedEnv: Record<string, string | undefined> = {};

/** 假限流器：不触 Redis（守卫单测只验证"取计划 → 计数 → 抛错"的接线） */
function fakeLimiter(result: boolean | Promise<boolean>) {
  const calls: Array<{ key: string; limit: number; windowMs: number }> = [];
  const service = {
    consume: vi.fn(async (key: string, limit: number, windowMs: number) => {
      calls.push({ key, limit, windowMs });
      return result;
    }),
  } as unknown as RateLimitService;
  return { service, calls };
}

function httpCtx(requestLike: Record<string, unknown>, type = 'http'): ExecutionContext {
  return {
    getType: () => type,
    switchToHttp: () => ({ getRequest: () => requestLike, getResponse: () => ({}), getNext: () => ({}) }),
  } as unknown as ExecutionContext;
}

function req(over: Record<string, unknown> = {}) {
  return { method: 'GET', path: '/api/v1/conversations', headers: {}, socket: { remoteAddress: '::ffff:127.0.0.1' }, ...over };
}

beforeEach(() => {
  savedEnv[GRL_ENV.READ] = process.env[GRL_ENV.READ];
  savedEnv[GRL_ENV.WINDOW] = process.env[GRL_ENV.WINDOW];
  process.env.NODE_ENV = 'production'; // 生产阈值：断言真实默认值，且不触发"非生产放宽"告警
  process.env[GRL_ENV.READ] = '20';
  process.env[GRL_ENV.WINDOW] = '3000';
  resetGlobalRateLimitConfigCache();
  resetRelaxedWarning();
});

afterEach(() => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  process.env.NODE_ENV = savedNodeEnv;
  resetGlobalRateLimitConfigCache();
});

describe('M10-P8 GlobalRateLimitGuard', () => {
  it('放行时用「计划」里的键/阈值/窗口调用限流器（IP × 方法 × 端点）', async () => {
    const { service, calls } = fakeLimiter(true);
    const guard = new GlobalRateLimitGuard(service);
    await expect(guard.canActivate(httpCtx(req()))).resolves.toBe(true);
    expect(calls).toEqual([{ key: 'global:read:127.0.0.1:GET:/api/v1/conversations', limit: 20, windowMs: 3000 }]);
  });

  it('超限 → AppError(RATE_LIMITED)（统一过滤器映射 429），文案与路由级限流一致', async () => {
    const { service } = fakeLimiter(false);
    const guard = new GlobalRateLimitGuard(service);
    await expect(guard.canActivate(httpCtx(req()))).rejects.toMatchObject({
      code: 'RATE_LIMITED', message: '请求过于频繁，请稍后再试',
    });
  });

  it('豁免路径（健康探针/预检/webhook/SSE）**不调用限流器**（零 Redis 依赖）', async () => {
    const { service, calls } = fakeLimiter(false); // 即便"限流器说拒绝"，豁免也不受影响
    const guard = new GlobalRateLimitGuard(service);
    const requests = [
      req({ path: '/api/v1/health/live' }),
      req({ method: 'OPTIONS', path: '/api/v1/conversations' }),
      req({ method: 'POST', path: '/api/v1/hooks/workflows/tok' }),
      // 无路由模板时按规范化路径判定（资源段 id-like → :id → 仍识别为长连接）
      req({ method: 'GET', path: '/api/v1/agent-runs/0b6f7a1e-9c0d-4a5b-8e2f-1c2d3e4f5a6b/events' }),
    ];
    for (const r of requests) await expect(guard.canActivate(httpCtx(r))).resolves.toBe(true);
    expect(calls).toHaveLength(0);
  });

  it('鉴权失败的请求同样计数（全局守卫先于控制器守卫执行）——用带 cookie 缺失的 401 路径断言计数发生', async () => {
    const { service, calls } = fakeLimiter(true);
    const guard = new GlobalRateLimitGuard(service);
    // 未带任何凭证访问受保护端点：守卫层（全局）先跑，计数照做
    await guard.canActivate(httpCtx(req({ path: '/api/v1/conversations/11111111-1111-1111-1111-111111111111', route: { path: '/api/v1/conversations/:id' } })));
    expect(calls[0].key).toBe('global:read:127.0.0.1:GET:/api/v1/conversations/:id');
  });

  it('非 HTTP 上下文（未来 WS/RPC）直接放行，不计数', async () => {
    const { service, calls } = fakeLimiter(true);
    const guard = new GlobalRateLimitGuard(service);
    await expect(guard.canActivate(httpCtx(req(), 'ws'))).resolves.toBe(true);
    expect(calls).toHaveLength(0);
  });

  it('可信跳生效：TRUSTED_PROXY_HOPS=1 时按 XFF 右起第 1 跳分桶（不同客户端各自成桶）', async () => {
    process.env[GRL_ENV.HOPS] = '1';
    resetGlobalRateLimitConfigCache();
    const { service, calls } = fakeLimiter(true);
    const guard = new GlobalRateLimitGuard(service);
    await guard.canActivate(httpCtx(req({ headers: { 'x-forwarded-for': '9.9.9.9, 10.0.0.7' } })));
    await guard.canActivate(httpCtx(req({ headers: { 'x-forwarded-for': '10.0.0.8' } })));
    expect(calls.map((c) => c.key)).toEqual([
      'global:read:10.0.0.7:GET:/api/v1/conversations',
      'global:read:10.0.0.8:GET:/api/v1/conversations',
    ]);
    delete process.env[GRL_ENV.HOPS];
    resetGlobalRateLimitConfigCache();
  });
});
