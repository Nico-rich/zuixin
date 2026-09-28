import { describe, it, expect, vi } from 'vitest';
import { applyTrustedProxy, trustedProxyHops } from './trusted-proxy';

/** Express 实例的最小替身：只记录 set 调用（我们不 mock 整个 Nest app） */
function makeApp() {
  const set = vi.fn();
  const app = { getHttpAdapter: () => ({ getInstance: () => ({ set }) }) };
  return { app, set };
}

describe('M10-P1 × M10-P8 trusted proxy（req.ip 与全局限流同口径）', () => {
  describe('trustedProxyHops 解析', () => {
    it('未配置/空串 → 0（不信任 XFF，Express 默认）', () => {
      expect(trustedProxyHops({})).toBe(0);
      expect(trustedProxyHops({ TRUSTED_PROXY_HOPS: '' })).toBe(0);
      expect(trustedProxyHops({ TRUSTED_PROXY_HOPS: '   ' })).toBe(0);
    });

    it('正整数生效；小数截断（与限流策略同语义）', () => {
      expect(trustedProxyHops({ TRUSTED_PROXY_HOPS: '1' })).toBe(1);
      expect(trustedProxyHops({ TRUSTED_PROXY_HOPS: '2' })).toBe(2);
      expect(trustedProxyHops({ TRUSTED_PROXY_HOPS: '3.9' })).toBe(3);
    });

    it('非法/0/负数 → 0（**失败方向是不信任**：绝不因拼写错误或负值打开伪造面）', () => {
      for (const bad of ['0', '-1', 'abc', '1e', 'NaN', 'Infinity', 'null']) {
        expect(trustedProxyHops({ TRUSTED_PROXY_HOPS: bad }), bad).toBe(0);
      }
    });
  });

  describe('applyTrustedProxy 生效边界', () => {
    it('N > 0 → 写 Express trust proxy = N，并返回实际层数', () => {
      const { app, set } = makeApp();
      expect(applyTrustedProxy(app as never, { TRUSTED_PROXY_HOPS: '2' })).toBe(2);
      expect(set).toHaveBeenCalledTimes(1);
      expect(set).toHaveBeenCalledWith('trust proxy', 2);
    });

    it('未配置 / 非法值 → **完全不碰** Express（保持默认：XFF 被忽略）', () => {
      for (const env of [{}, { TRUSTED_PROXY_HOPS: '0' }, { TRUSTED_PROXY_HOPS: '-3' }, { TRUSTED_PROXY_HOPS: 'loopback' }]) {
        const { app, set } = makeApp();
        expect(applyTrustedProxy(app as never, env)).toBe(0);
        expect(set).not.toHaveBeenCalled();
      }
    });

    it('数值语义与限流策略的 hops 一致（1 = 取 XFF 右起第 1 跳）——口径统一的契约', () => {
      const { app, set } = makeApp();
      applyTrustedProxy(app as never, { TRUSTED_PROXY_HOPS: '1' });
      expect(set).toHaveBeenCalledWith('trust proxy', 1); // 不是布尔 true（true = 信任整条链，可被伪造）
    });
  });
});
