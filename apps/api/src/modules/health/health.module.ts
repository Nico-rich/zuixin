import { Module } from '@nestjs/common';
import { HealthController, ProbesController } from './health.controller';
import { HealthService } from './health.service';
import { QueueModule } from '../../core/queue/queue.module';

/**
 * M8-P9 Health 模块：三端点（/health 聚合、/live 存活、/ready 就绪）+ 根级别名（/api/v1/live|ready）。
 * 依赖 QueueModule 以复用进程内同一条 agent-run 队列连接（不新开 Redis 连接做计数）。
 */
@Module({
  imports: [QueueModule],
  controllers: [HealthController, ProbesController],
  providers: [HealthService],
  exports: [HealthService],
})
export class HealthModule {}
