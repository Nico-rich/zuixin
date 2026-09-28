import { Module } from '@nestjs/common';
import { EvaluationModule } from './evaluation.module';
import { EvaluationController } from './evaluation.controller';
import { OrganizationsModule } from '../organizations/organizations.module';

/** HTTP 面（仅 API 进程挂载）：controller + JWT 守卫；Worker 只引 EvaluationModule 服务层 */
@Module({
  imports: [EvaluationModule, OrganizationsModule],
  controllers: [EvaluationController],
})
export class EvaluationApiModule {}
