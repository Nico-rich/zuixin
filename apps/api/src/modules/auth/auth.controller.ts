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
    await this.auth.logout((req.cookies as Record<string, string> | undefined)?.[COOKIE_REFRESH]);
    this.clearAuthCookies(res);
    res.json({ data: { ok: true } });
  }

  @Get('me')
  @UseGuards(JwtAuthGuard)
  async me(@Req() req: Request & { user: AuthedUser }) {
    return { data: await this.auth.me(req.user.userId) };
  }

  private setAuthCookies(res: Response, access: string, refresh: string) {
    const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
    res.setHeader('Set-Cookie', [
      `${COOKIE_ACCESS}=${access}; HttpOnly; Path=/; Max-Age=${ACCESS_TTL_SEC}; SameSite=Lax${secure}`,
      `${COOKIE_REFRESH}=${refresh}; HttpOnly; Path=/api/v1/auth; Max-Age=${REFRESH_TTL_SEC}; SameSite=Lax${secure}`,
    ]);
  }

  private clearAuthCookies(res: Response) {
    res.setHeader('Set-Cookie', [
      `${COOKIE_ACCESS}=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax`,
      `${COOKIE_REFRESH}=; HttpOnly; Path=/api/v1/auth; Max-Age=0; SameSite=Lax`,
    ]);
  }
}
