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
    const accessSid = await this.auth.sessionIdFromAccessToken(cookies?.[COOKIE_ACCESS]);
    await this.auth.logout(cookies?.[COOKIE_REFRESH], accessSid ?? undefined);
    this.clearAuthCookies(res);
    res.json({ data: { ok: true } });
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
