import { Body, Controller, Get, Inject, Post, Req, Res, UseGuards, UsePipes } from '@nestjs/common';
import { Request, Response } from 'express';
import { AuthService } from './auth.service';
import { LoginDtoSchema } from './auth.dto';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import { ACCESS_TTL_SEC, COOKIE_ACCESS, COOKIE_REFRESH, REFRESH_TTL_SEC } from './auth.constants';
import { AuthedUser, JwtAuthGuard } from './jwt-auth.guard';

@Controller('auth')
export class AuthController {
  constructor(@Inject(AuthService) private readonly auth: AuthService) {}

  @Post('login')
  @UsePipes(new ZodValidationPipe(LoginDtoSchema))
  async login(@Body() dto: { email: string; password: string }, @Req() req: Request, @Res() res: Response) {
    const result = await this.auth.login(dto.email, dto.password, { ip: req.ip ?? '', userAgent: req.headers['user-agent'] });
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

  @Get('me')
  @UseGuards(JwtAuthGuard)
  me(@Req() req: Request & { user: AuthedUser }) {
    return this.auth.me(req.user.userId); // 全局 TransformInterceptor 统一包 {data}
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
