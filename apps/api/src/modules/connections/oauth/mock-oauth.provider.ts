import { Injectable } from '@nestjs/common';
import { OAuthProvider, OAuthTokenSet } from './oauth-provider.interface';
import { AppError, ErrorCode } from '../../../common/errors/app-error';

/**
 * M7-P2 Mock OAuth Provider（无真实第三方凭据时的完整生命周期实现）：
 * 确定性 token 映射（code/refresh → 可预测账号与凭证），支持注入失败向量：
 * - code='fail' → exchange 抛 PROVIDER_AUTH；
 * - refreshToken 含 'expired' → refresh 抛 PROVIDER_AUTH（模拟远端吊销/过期）。
 * 计数器公开（e2e 断言 refresh 竞态只执行一次远端调用）。
 * 绝不伪造真实平台（shopify/amazon/...）的 OAuth 成功。
 */
@Injectable()
export class MockOAuthProvider implements OAuthProvider {
  readonly name = 'mock';
  exchangeCount = 0;
  refreshCount = 0;
  revokeCount = 0;

  buildAuthorizeUrl(state: string): string {
    return `http://mock-oauth.local/authorize?provider=mock&state=${encodeURIComponent(state)}`;
  }

  async exchangeCode(code: string): Promise<OAuthTokenSet> {
    this.exchangeCount++;
    if (code === 'fail') throw new AppError(ErrorCode.PROVIDER_AUTH, 'mock: 授权码无效');
    return {
      accessToken: `mock_access_${code}`,
      refreshToken: `mock_refresh_${code}`,
      expiresInSeconds: 3600,
      scope: ['read', 'write'],
      providerAccountId: `mock-account-${code}`,
    };
  }

  async refreshToken(refreshToken: string): Promise<OAuthTokenSet> {
    this.refreshCount++;
    if (refreshToken.includes('expired')) throw new AppError(ErrorCode.PROVIDER_AUTH, 'mock: refresh token 已吊销');
    const base = refreshToken.replace('mock_refresh_', '');
    return {
      accessToken: `mock_access_${base}_r${this.refreshCount}`,
      refreshToken,
      expiresInSeconds: 3600,
      scope: ['read', 'write'],
      providerAccountId: `mock-account-${base}`,
    };
  }

  async revoke(_refreshToken: string): Promise<void> {
    this.revokeCount++;
  }
}
