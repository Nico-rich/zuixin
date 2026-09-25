import { Module } from '@nestjs/common';
import { ConnectionsService } from './connections.service';
import { CredentialService } from './credentials.service';
import { OAuthProvidersService } from './oauth/oauth-providers.service';
import { MockOAuthProvider } from './oauth/mock-oauth.provider';
import { OrganizationsModule } from '../organizations/organizations.module';

/**
 * 服务层（API 与 Worker 共用；P3/P4 的 ExternalAction/Commerce 经此解析连接与凭证）。
 * HTTP 面在 ConnectionsApiModule——Worker 不引入 JWT 守卫。
 */
@Module({
  imports: [OrganizationsModule],
  providers: [ConnectionsService, CredentialService, OAuthProvidersService, MockOAuthProvider],
  exports: [ConnectionsService, CredentialService, OAuthProvidersService],
})
export class ConnectionsModule {}
