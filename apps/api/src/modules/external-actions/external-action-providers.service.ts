import { Inject, Injectable } from '@nestjs/common';
import { ExternalActionProvider } from './external-action-provider.interface';
import { MockExternalActionProvider } from './mock-external-action.provider';

/** M7-P3 外部动作 Provider 注册表；真实平台适配器（shopify/amazon/...）在此追加注册 */
@Injectable()
export class ExternalActionProvidersService {
  private readonly providers = new Map<string, ExternalActionProvider>();

  constructor(@Inject(MockExternalActionProvider) mock: MockExternalActionProvider) {
    this.register(mock);
  }

  register(provider: ExternalActionProvider): void {
    if (this.providers.has(provider.name)) throw new Error(`ExternalAction Provider 重复注册: ${provider.name}`);
    this.providers.set(provider.name, provider);
  }

  get(name: string): ExternalActionProvider | undefined {
    return this.providers.get(name);
  }
}
