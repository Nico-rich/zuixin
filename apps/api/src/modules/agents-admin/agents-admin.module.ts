import { Module } from '@nestjs/common';
import { AgentsAdminService } from './agents-admin.service';
import { AgentsAdminController } from './agents-admin.controller';
import { AgentsModule } from '../../agents/agents.module';
import { RolesGuard } from '../../common/guards/roles.guard';

@Module({
  imports: [AgentsModule],
  controllers: [AgentsAdminController],
  providers: [AgentsAdminService, RolesGuard],
  exports: [AgentsAdminService],
})
export class AgentsAdminModule {}
