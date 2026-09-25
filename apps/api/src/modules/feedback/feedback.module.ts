import { Module } from '@nestjs/common';
import { FeedbackService } from './feedback.service';
import { MemoryModule } from '../../core/memory/memory.module';

/** M7-P8 服务层（API 与 Worker 共用；HTTP 面在 FeedbackApiModule——Worker 不引入 JWT 守卫） */
@Module({
  imports: [MemoryModule],
  providers: [FeedbackService],
  exports: [FeedbackService],
})
export class FeedbackModule {}
