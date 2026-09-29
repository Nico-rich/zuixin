import { Module } from '@nestjs/common';
import { MemoryService } from './memory.service';
import { LLMMemoryExtractor, MEMORY_EXTRACTOR } from './memory-extractor';
import { SummaryRefinerService } from './summary-refiner.service';
import { MemoryCandidateService } from './memory-candidate.service';
import { MemoryLifecycleService } from './memory-lifecycle.service';
import { UsageModule } from '../../modules/usage/usage.module';
import { SchedulerModule } from '../../modules/scheduler/scheduler.module';

/**
 * 记忆域（M2 基础 + M9-P2 增量摘要/候选提炼 + M12-P3 结果驱动生命周期）。
 * 依赖 PrismaService / ModelResolverService 均为全局模块提供（PrismaModule / ProvidersModule）。
 * M10 Final Audit H4：引入 UsageModule——摘要重建 LLM 调用计量（UsageService）。
 * M12-P3：引入 SchedulerModule——生命周期周期作业走既有 Scheduler（`MetricRetentionService` 同范式，
 * 不新开队列/不加基础设施）。本模块被 API 进程（MemoriesModule/ChatModule…）与 Worker 进程
 * （AgentRunWorkerModule → ContextModule）共同导入 → 两进程都注册 handler 并探测开通作业，
 * 真实执行方仍是持有 scheduler 队列的 worker。
 * 依赖方向：scheduler → organizations（无反向依赖）→ 与本模块无环。
 */
@Module({
  imports: [UsageModule, SchedulerModule],
  providers: [
    MemoryService,
    { provide: MEMORY_EXTRACTOR, useClass: LLMMemoryExtractor },
    SummaryRefinerService,
    MemoryCandidateService,
    MemoryLifecycleService,
  ],
  exports: [MemoryService, MEMORY_EXTRACTOR, SummaryRefinerService, MemoryCandidateService, MemoryLifecycleService],
})
export class MemoryModule {}
