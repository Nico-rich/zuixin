import { Inject, Injectable } from '@nestjs/common';
import { OAuthProvider } from './oauth-provider.interface';
import { MockOAuthProvider } from './mock-oauth.provider';

/** M7-P2 Provider 注册表：按名称路由 OAuth 生命周期调用；真实平台适配器在此追加注册 */
@Injectable()
export class OAuthProvidersService {
  private readonly providers = new Map<string, OAuthProvider>();

  constructor(@Inject(MockOAuthProvider) mock: MockOAuthProvider) {
    this.register(mock);
  }

  register(provider: OAuthProvider): void {
    if (this.providers.has(provider.name)) throw new Error(`OAuth Provider 重复注册: ${provider.name}`);
    this.providers.set(provider.name, provider);
  }

  get(name: string): OAuthProvider | undefined {
    return this.providers.get(name);
  }

  list(): string[] {
    return [...this.providers.keys()];
  }
}
