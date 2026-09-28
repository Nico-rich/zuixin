import { Module } from '@nestjs/common';
import { OrganizationsModule } from '../organizations/organizations.module';
import { ToolsModule } from '../../core/tools/tools.module';
import { MarketplaceAccessService } from './marketplace-access.service';
import { PublicationsService } from './publications.service';
import { ReviewsService } from './reviews.service';
import { MarketplaceCatalogService } from './marketplace-catalog.service';

/**
 * M9-P6 Marketplace 服务层（API 与 Worker 共用；HTTP 面在 MarketplaceApiModule）。
 *
 * 复用（**绝不重复实现**）：
 * - OrganizationsModule → AuthorizationService（M8-P1 RBAC 矩阵；本模块读/写面复用既有位，
 *   治理面用 M11-P12 新增的 **`marketplace.moderate`** 专用位——矩阵定义仍唯一在 authorization.service.ts）；
 * - ToolsModule → ToolRegistry（权限披露现算：effective = 请求 ∩ 注册表 ∩ 可包装面——唯一实现
 *   `resolveEffectiveAgentTools`，见 extensions/effective-agent-tools.ts）；
 * - extensions/manifest.ts 导出的 `parseManifest` / `verifySignature`：上架门禁的平台校验复算
 *   （与 ExtensionsService.install 同口径；**不复制校验规则，只调用**）；
 * - AuditModule 为 @Global（发布/撤回/驳回/审核全部落审计，best-effort）。
 * PrismaModule 为 @Global，无需显式 import。
 */
@Module({
  imports: [OrganizationsModule, ToolsModule],
  providers: [MarketplaceAccessService, PublicationsService, ReviewsService, MarketplaceCatalogService],
  exports: [MarketplaceAccessService, PublicationsService, ReviewsService, MarketplaceCatalogService],
})
export class MarketplaceModule {}
