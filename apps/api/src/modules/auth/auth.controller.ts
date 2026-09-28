import { Body, Controller, Delete, Get, Inject, Param, Post, Req, Res, UseGuards, UsePipes } from '@nestjs/common';
import { Request, Response } from 'express';
import { AuthService } from './auth.service';
import { LoginDtoSchema } from './auth.dto';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import {
  ACCESS_TTL_SEC, COOKIE_ACCESS, COOKIE_REFRESH, DEVICE_ID_HEADER, REFRESH_TTL_SEC, normalizeDeviceId,
} from './auth.constants';
import { AuthedUser, JwtAuthGuard } from './jwt-auth.guard';

@Controller('auth')
export class AuthController {
  constructor(@Inject(AuthService) private readonly auth: AuthService) {}

  @Post('login')
  @UsePipes(new ZodValidationPipe(LoginDtoSchema))
  async login(@Body() dto: { email: string; password: string; deviceId?: string }, @Req() req: Request, @Res() res: Response) {
    // M11-P2：设备标识来源 = header `X-Device-Id` 优先，body `deviceId` 兜底（契约见 auth.constants）。
    // 仅作分组标识：服务端不信任其内容（按设备下线的查询恒带 userId = 令牌主体）。
    const deviceId = normalizeDeviceId(req.headers[DEVICE_ID_HEADER]) ?? normalizeDeviceId(dto.deviceId);
    const result = await this.auth.login(dto.email, dto.password, {
      ip: req.ip ?? '', userAgent: req.headers['user-agent'], deviceId,
    });
    this.setAuthCookies(res, result.accessToken, result.refreshToken);
    res.json({ data: { user: result.user } });
  }

  @Post('refresh')
  async refresh(@Req() req: Request, @Res() res: Response) {
    const result = await this.auth.refresh((req.cookies as Record<string, string> | undefined)?.[COOKIE_REFRESH], { ip: req.ip ?? '', userAgent: req.headers['user-agent'] });
    this.setAuthCookies(res, result.accessToken, result.refreshToken);
    res.json({ data: { user: result.user } });
  }

  @Post('logout')
  async logout(@Req() req: Request, @Res() res: Response) {
    const cookies = req.cookies as Record<string, string> | undefined;
    // M8-P8：除 refresh 会话外，同时按 access token 的 sid 撤销会话（refresh cookie 缺失时 access token 也不残留）
    // M10-P1 SA-4：同时取 jti/exp → 顺手把本次 access token 拉黑（TTL = 剩余寿命）
    const claims = await this.auth.accessTokenClaims(cookies?.[COOKIE_ACCESS]);
    await this.auth.logout(cookies?.[COOKIE_REFRESH], claims?.sessionId, claims);
    this.clearAuthCookies(res);
    res.json({ data: { ok: true } });
  }

  /**
   * M10-P1 SA-4/X-20：登出全部（撤销该用户全部会话 + 拉黑全部有效 jti + 跨实例传播）。
   * 安全边界：**作用域恒为令牌主体自身**（userId 取自验签后的 access token，绝不接受请求体里的 userId）
   * —— 因此不存在 IDOR 面；也不需要额外 RBAC（自服务操作）。
   */
  @Post('logout-all')
  @UseGuards(JwtAuthGuard)
  async logoutAll(@Req() req: Request & { user: AuthedUser }, @Res() res: Response) {
    const claims = await this.auth.accessTokenClaims((req.cookies as Record<string, string> | undefined)?.[COOKIE_ACCESS]);
    const result = await this.auth.logoutAll(req.user.userId, claims);
    this.clearAuthCookies(res);
    res.json({ data: { ok: true, ...result } });
  }

  /**
   * M11-P2（D1-10）：**主动轮换**——旧 access/refresh 换新的一对（jti 更换、旧 jti 进黑名单、旧会话撤销）。
   * 安全边界（与 logout-all 同口径）：作用域恒为令牌主体自身，不存在 IDOR 面；
   * 额外绑定性：请求携带的 access token 与 refresh token 必须属于**同一会话**（见 AuthService.rotate）。
   */
  @Post('rotate')
  @UseGuards(JwtAuthGuard)
  async rotate(@Req() req: Request & { user: AuthedUser }, @Res({ passthrough: true }) res: Response) {
    const cookies = req.cookies as Record<string, string> | undefined;
    const claims = await this.auth.accessTokenClaims(cookies?.[COOKIE_ACCESS]);
    const result = await this.auth.rotate(cookies?.[COOKIE_REFRESH], claims, {
      ip: req.ip ?? '', userAgent: req.headers['user-agent'],
    });
    this.setAuthCookies(res, result.accessToken, result.refreshToken);
    return { user: result.user };
  }

  @Get('me')
  @UseGuards(JwtAuthGuard)
  me(@Req() req: Request & { user: AuthedUser }) {
    return this.auth.me(req.user.userId); // 全局 TransformInterceptor 统一包 {data}
  }

  /**
   * M11-P2（D1-10）：本人活跃会话列表（会话管理）。
   * 作用域 = 令牌主体（无 IDOR 面、无跨租户面）；响应**白名单字段**，tokenHash/任何 token 绝不回传。
   */
  @Get('sessions')
  @UseGuards(JwtAuthGuard)
  async sessions(@Req() req: Request & { user: AuthedUser }) {
    return { sessions: await this.auth.listSessions(req.user.userId, req.user.sessionId) };
  }

  /**
   * M11-P2（D1-01）：按**设备**下线（撤销本人在该设备上的全部会话 + 发布 session-events）。
   * 幂等：该设备已无活跃会话 → `revokedSessions: 0`（不报错——把"重复下线"变成错误会让客户端误判登出）。
   * 该设备随后的请求由 JwtAuthGuard 以 `DEVICE_REVOKED`（401）拒绝。
   */
  @Delete('sessions/device/:deviceId')
  @UseGuards(JwtAuthGuard)
  async revokeDevice(
    @Param('deviceId') deviceId: string,
    @Req() req: Request & { user: AuthedUser },
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = await this.auth.revokeDeviceSessions(req.user.userId, deviceId);
    // 把自己当前所在的设备也下线时：顺手清 cookie（否则客户端会一直带着死 token 循环 401）
    if (req.user.sessionId && result.sessionIds.includes(req.user.sessionId)) this.clearAuthCookies(res);
    return { ok: true, revokedSessions: result.revokedSessions };
  }

  /**
   * M11-P2（D1-10）：本人**单会话**下线。
   * IDOR 口径：他人会话与幽灵 id **同码同文案**（404，防枚举）；已撤销会话幂等返回 `revokedSessions: 0`。
   */
  @Delete('sessions/:id')
  @UseGuards(JwtAuthGuard)
  async revokeSession(
    @Param('id') id: string,
    @Req() req: Request & { user: AuthedUser },
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = await this.auth.revokeSession(req.user.userId, id);
    if (req.user.sessionId === id) this.clearAuthCookies(res);
    return { ok: true, revokedSessions: result.revokedSessions };
  }

  /** M8-P8 cookie 属性审计：HttpOnly + SameSite=Lax +（生产/显式开启时）Secure。
   *  Secure 默认仅在 NODE_ENV=production 生效（本地 http 开发不被破坏）；https 非生产环境可显式 COOKIE_SECURE=true。 */
  private secureSuffix(): string {
    return process.env.NODE_ENV === 'production' || process.env.COOKIE_SECURE === 'true' ? '; Secure' : '';
  }

  private setAuthCookies(res: Response, access: string, refresh: string) {
    const secure = this.secureSuffix();
    res.setHeader('Set-Cookie', [
      `${COOKIE_ACCESS}=${access}; HttpOnly; Path=/; Max-Age=${ACCESS_TTL_SEC}; SameSite=Lax${secure}`,
      `${COOKIE_REFRESH}=${refresh}; HttpOnly; Path=/api/v1/auth; Max-Age=${REFRESH_TTL_SEC}; SameSite=Lax${secure}`,
    ]);
  }

  private clearAuthCookies(res: Response) {
    const secure = this.secureSuffix();
    res.setHeader('Set-Cookie', [
      `${COOKIE_ACCESS}=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax${secure}`,
      `${COOKIE_REFRESH}=; HttpOnly; Path=/api/v1/auth; Max-Age=0; SameSite=Lax${secure}`,
    ]);
  }
}
