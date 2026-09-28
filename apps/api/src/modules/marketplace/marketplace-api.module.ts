import { Module } from '@nestjs/common';
import { MarketplaceModule } from './marketplace.module';
import { MarketplaceController } from './marketplace.controller';

/** HTTP 面（仅 API 进程挂载）：controller + JWT 守卫（RateLimitModule 为 @Global，评审限流守卫可直接使用） */
@Module({
  imports: [MarketplaceModule],
  controllers: [MarketplaceController],
})
export class MarketplaceApiModule {}
