import { Module } from '@nestjs/common';
import { ExternalActionsService } from './external-actions.service';
import { ExternalActionProvidersService } from './external-action-providers.service';
import { MockExternalActionProvider } from './mock-external-action.provider';
import { ConnectionsModule } from '../connections/connections.module';
import { BillingModule } from '../billing/billing.module';

/** 服务层（API 与 Worker 共用——Tool 在 Worker 进程执行；HTTP 面在 ExternalActionsApiModule） */
@Module({
  imports: [ConnectionsModule, BillingModule],
  providers: [ExternalActionsService, ExternalActionProvidersService, MockExternalActionProvider],
  exports: [ExternalActionsService, ExternalActionProvidersService],
})
export class ExternalActionsModule {}
