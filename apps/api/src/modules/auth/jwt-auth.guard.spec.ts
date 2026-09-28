import { describe, it, expect, vi, beforeEach } from 'vitest';
import { JwtAuthGuard, AuthedUser } from './jwt-auth.guard';
import { COOKIE_ACCESS } from './auth.constants';

interface FakeReq { cookies?: Record<string, string>; user?: AuthedUser }

function makeCtx(req: FakeReq) {
  return { switchToHttp: () => ({ getRequest: () => req }) } as never;
}

function makeGuard() {
  const jwt = { verifyAsync: vi.fn() };
  const access = {
    isUserActive: vi.fn().mockResolvedValue(true),
    isSessionLive: vi.fn().mockResolvedValue(true),
    // M11-P2：设备下线原因（默认"非设备下线" → 通用 UNAUTHORIZED）
    isSessionDeviceRevoked: vi.fn().mockResolvedValue(false),
  };
  return { guard: new JwtAuthGuard(jwt as never, access as never), jwt, access };
}

describe('JwtAuthGuard', () => {
  let ctxReq: FakeReq;

  beforeEach(() => { ctxReq = {}; });

  it('无 access cookie → 401 未登录', async () => {
    const { guard } = makeGuard();
    await expect(guard.canActivate(makeCtx({}))).rejects.toMatchObject({ code: 'UNAUTHORIZED', message: '未登录' });
  });

  it('验签失败/过期 → 401（统一文案，不泄露原因）', async () => {
    const { guard, jwt } = makeGuard();
    jwt.verifyAsync.mockRejectedValue(new Error('jwt expired'));
    await expect(guard.canActivate(makeCtx({ cookies: { [COOKIE_ACCESS]: 'bad' } })))
      .rejects.toMatchObject({ code: 'UNAUTHORIZED', message: '登录已过期' });
  });

  it('payload 无 sub → 401', async () => {
    const { guard, jwt } = makeGuard();
    jwt.verifyAsync.mockResolvedValue({ role: 'user' });
    await expect(guard.canActivate(makeCtx({ cookies: { [COOKIE_ACCESS]: 't' } }))).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
  });

  it('正常 token（带 sid）→ 通过并注入 sessionId', async () => {
    const { guard, jwt, access } = makeGuard();
    jwt.verifyAsync.mockResolvedValue({ sub: 'u1', role: 'user', sid: 's1' });
    const req: FakeReq = { cookies: { [COOKIE_ACCESS]: 't' } };
    expect(await guard.canActivate(makeCtx(req))).toBe(true);
    expect(req.user).toEqual({ userId: 'u1', role: 'user', sessionId: 's1' });
    expect(access.isSessionLive).toHaveBeenCalledWith('s1');
    expect(access.isUserActive).toHaveBeenCalledWith('u1');
  });

  it('会话已撤销（登出/轮换）→ 401，即使 JWT 本身未过期', async () => {
    const { guard, jwt, access } = makeGuard();
    jwt.verifyAsync.mockResolvedValue({ sub: 'u1', role: 'user', sid: 's1' });
    access.isSessionLive.mockResolvedValue(false);
    const req: FakeReq = { cookies: { [COOKIE_ACCESS]: 't' } };
    await expect(guard.canActivate(makeCtx(req))).rejects.toMatchObject({ code: 'UNAUTHORIZED', message: '登录已失效，请重新登录' });
    expect(req.user).toBeUndefined();
  });

  it('禁用用户 → 401 账号不可用（access token 未过期也必须阻断）', async () => {
    const { guard, jwt, access } = makeGuard();
    jwt.verifyAsync.mockResolvedValue({ sub: 'u1', role: 'user', sid: 's1' });
    access.isUserActive.mockResolvedValue(false);
    const req: FakeReq = { cookies: { [COOKIE_ACCESS]: 't' } };
    await expect(guard.canActivate(makeCtx(req))).rejects.toMatchObject({ code: 'UNAUTHORIZED', message: '账号不可用' });
    expect(req.user).toBeUndefined();
  });

  it('历史 token（无 sid，仅内部/测试签发）→ 跳过会话校验但仍在库校验用户状态', async () => {
    const { guard, jwt, access } = makeGuard();
    jwt.verifyAsync.mockResolvedValue({ sub: 'u1', role: 'user' });
    const req: FakeReq = { cookies: { [COOKIE_ACCESS]: 't' } };
    expect(await guard.canActivate(makeCtx(req))).toBe(true);
    expect(access.isSessionLive).not.toHaveBeenCalled();
    expect(access.isUserActive).toHaveBeenCalledWith('u1');
    expect(req.user).toEqual({ userId: 'u1', role: 'user' });
  });

  it('禁用用户 + 无 sid token → 同样阻断', async () => {
    const { guard, jwt, access } = makeGuard();
    jwt.verifyAsync.mockResolvedValue({ sub: 'u1', role: 'user' });
    access.isUserActive.mockResolvedValue(false);
    await expect(guard.canActivate(makeCtx({ cookies: { [COOKIE_ACCESS]: 't' } }))).rejects.toMatchObject({ message: '账号不可用' });
  });

  /**
   * M11-P2（D1-01）：**DEVICE_REVOKED 的唯一业务抛出点**。
   * 拒绝结论恒来自 DB 会话状态（isSessionLive=false）；原因标记只决定错误码/文案细度。
   */
  describe('M11-P2：设备下线后的 401 原因细化（DEVICE_REVOKED）', () => {
    it('会话因"设备下线"被撤销 → 401 DEVICE_REVOKED（客户端据此停止重试，而不是反复刷新）', async () => {
      const { guard, jwt, access } = makeGuard();
      jwt.verifyAsync.mockResolvedValue({ sub: 'u1', role: 'user', sid: 's1' });
      access.isSessionLive.mockResolvedValue(false);
      access.isSessionDeviceRevoked.mockResolvedValue(true);
      const req: FakeReq = { cookies: { [COOKIE_ACCESS]: 't' } };
      await expect(guard.canActivate(makeCtx(req)))
        .rejects.toMatchObject({ code: 'DEVICE_REVOKED', message: '该设备已被下线，请重新登录' });
      expect(access.isSessionDeviceRevoked).toHaveBeenCalledWith('s1');
      expect(req.user).toBeUndefined();
    });

    it('普通撤销（登出/轮换/管理踢出）→ 仍是通用 UNAUTHORIZED（不误报"设备下线"）', async () => {
      const { guard, jwt, access } = makeGuard();
      jwt.verifyAsync.mockResolvedValue({ sub: 'u1', role: 'user', sid: 's1' });
      access.isSessionLive.mockResolvedValue(false);
      access.isSessionDeviceRevoked.mockResolvedValue(false);
      await expect(guard.canActivate(makeCtx({ cookies: { [COOKIE_ACCESS]: 't' } })))
        .rejects.toMatchObject({ code: 'UNAUTHORIZED', message: '登录已失效，请重新登录' });
    });

    it('会话有效时不查"设备下线"原因（该查询只在已决定拒绝的路径上发生）', async () => {
      const { guard, jwt, access } = makeGuard();
      jwt.verifyAsync.mockResolvedValue({ sub: 'u1', role: 'user', sid: 's1' });
      expect(await guard.canActivate(makeCtx({ cookies: { [COOKIE_ACCESS]: 't' } }))).toBe(true);
      expect(access.isSessionDeviceRevoked).not.toHaveBeenCalled();
    });
  });

  it('安全面缺失（最小模块构造）时不降级为"放行一切"：仍要求有效签名', async () => {
    const jwt = { verifyAsync: vi.fn().mockResolvedValue({ sub: 'u1', role: 'user' }) };
    const guard = new JwtAuthGuard(jwt as never);
    expect(await guard.canActivate(makeCtx({ cookies: { [COOKIE_ACCESS]: 't' } }))).toBe(true);
    jwt.verifyAsync.mockRejectedValue(new Error('bad'));
    await expect(guard.canActivate(makeCtx({ cookies: { [COOKIE_ACCESS]: 't' } }))).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
  });
});
