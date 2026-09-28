import { describe, it, expect, vi, afterEach } from 'vitest';
import { ExecutionContext } from '@nestjs/common';
import {
  WEBHOOK_GLOBAL_KEY, WEBHOOK_GLOBAL_LIMIT_DEFAULT, WEBHOOK_GLOBAL_WINDOW_MS_DEFAULT,
  WebhookGlobalThrottleGuard, webhookGlobalLimit, webhookGlobalWindowMs,
} from './webhook-global-throttle.guard';

/** 最小 ExecutionContext 替身：只暴露"可控的请求"以证明**键与请求无关** */
function ctxWith(request: Record<string, unknown>): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => request }),
    getHandler: () => undefined,
    getClass: () => undefined,
  } as unknown as ExecutionContext;
}

function make(consume = vi.fn(async (_key: string, _limit: number, _windowMs: number) => true)) {
  const guard = new WebhookGlobalThrottleGuard({ consume } as never);
  return { guard, consume };
}

afterEach(() => { delete process.env.WEBHOOK_GLOBAL_LIMIT; delete process.env.WEBHOOK_GLOBAL_WINDOW_MS; });

/**
 * M10-P5 SA-16/SA-17：webhook **全局总闸**。
 * 关键性质：键固定且与 token/IP 无关（换 token 无法绕过 —— per-token 闸的漏洞正源于此）；
 * 超限 → RATE_LIMITED（429）；限流设施异常 → 放行（fail-open，绝不把防护设施故障放大成业务中断）。
 */
describe('WebhookGlobalThrottleGuard（M10-P5 SA-16/SA-17 全局总闸）', () => {
  it('固定键 + 默认阈值（与请求内容无关：换 token/换 IP 都不改变键）', async () => {
    const { guard, consume } = make();
    await expect(guard.canActivate(ctxWith({ params: { token: 'a' }, ip: '1.1.1.1' }))).resolves.toBe(true);
    await expect(guard.canActivate(ctxWith({ params: { token: 'b' }, ip: '2.2.2.2' }))).resolves.toBe(true);
    expect(consume).toHaveBeenCalledTimes(2);
    for (const call of consume.mock.calls) {
      expect(call[0]).toBe(WEBHOOK_GLOBAL_KEY);
      expect(call[1]).toBe(WEBHOOK_GLOBAL_LIMIT_DEFAULT);
      expect(call[2]).toBe(WEBHOOK_GLOBAL_WINDOW_MS_DEFAULT);
    }
    // 契约锁定：全局键是**常量**（改名 = 计数空间漂移，必须显式改测）。
    // 与 per-token 键（`webhook:<token>`）同前缀但不冲突：token 是 16 字节随机 hex，永不等于 'global'。
    expect(WEBHOOK_GLOBAL_KEY).toBe('webhook:global');
  });

  it('超限 → RATE_LIMITED（全局异常过滤器映射 429），且不暴露阈值细节之外的内部信息', async () => {
    const { guard } = make(vi.fn(async () => false));
    const err = await guard.canActivate(ctxWith({})).catch((e) => e);
    expect(err).toMatchObject({ code: 'RATE_LIMITED' });
    expect(err.message).toBe('webhook 请求过于频繁，请稍后再试');
  });

  it('env 可覆盖阈值/窗口（e2e 用小阈值断言真实 429）', () => {
    process.env.WEBHOOK_GLOBAL_LIMIT = '5';
    process.env.WEBHOOK_GLOBAL_WINDOW_MS = '1000';
    expect(webhookGlobalLimit()).toBe(5);
    expect(webhookGlobalWindowMs()).toBe(1000);
    // 非法值 → 默认（绝不把 NaN 塞进限流器）
    process.env.WEBHOOK_GLOBAL_LIMIT = 'abc';
    process.env.WEBHOOK_GLOBAL_WINDOW_MS = '-1';
    expect(webhookGlobalLimit()).toBe(WEBHOOK_GLOBAL_LIMIT_DEFAULT);
    expect(webhookGlobalWindowMs()).toBe(WEBHOOK_GLOBAL_WINDOW_MS_DEFAULT);
  });

  it('限流器异常 → 放行（fail-open；限流是保护面，绝不放大故障）', async () => {
    const { guard } = make(vi.fn(async () => { throw new Error('redis down'); }));
    await expect(guard.canActivate(ctxWith({}))).resolves.toBe(true);
  });
});
