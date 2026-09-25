import { Module } from '@nestjs/common';
import { AnalyticsService } from './analytics.service';

/** M8-P4 Analytics 服务层（纯读投影：无 LLM 依赖、无外部 IO——可被 API 与未来定时刷新复用） */
@Module({
  providers: [AnalyticsService],
  exports: [AnalyticsService],
})
export class AnalyticsModule {}
