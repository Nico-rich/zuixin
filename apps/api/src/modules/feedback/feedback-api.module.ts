import { Module } from '@nestjs/common';
import { FeedbackModule } from './feedback.module';
import { FeedbackController } from './feedback.controller';

/** HTTP 面（仅 API 进程挂载）：controller + JWT 守卫 */
@Module({
  imports: [FeedbackModule],
  controllers: [FeedbackController],
})
export class FeedbackApiModule {}
