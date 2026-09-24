import { Module } from '@nestjs/common';
import { ConnectionsModule } from './connections.module';
import { ConnectionsController } from './connections.controller';

/** HTTP 面（仅 API 进程挂载）：controller + JWT 守卫 */
@Module({
  imports: [ConnectionsModule],
  controllers: [ConnectionsController],
})
export class ConnectionsApiModule {}
