import { Inject, Injectable, OnModuleInit } from '@nestjs/common';
import { InjectQueue, Processor, WorkerHost } from '@nestjs/bullmq';
import { Job, Queue } from 'bullmq';
import { MEDIA_CLEANUP_QUEUE } from '../../core/queue/queue.module';
import { MediaCleanupService } from '../../modules/generations/media-cleanup.service';
import { AgentRunLeaseService } from '../../core/agent-run-lease/agent-run-lease.service';
import { WorkflowLeaseService } from '../workflow/workflow-lease.service';

const SWEEP_INTERVAL_MS = 5 * 60_000;

/** 清扫处理器：孤儿任务扫描 + 同步 run 清扫 + async run stale recovery（全幂等，多 Worker 安全） */
@Processor(MEDIA_CLEANUP_QUEUE)
export class MediaCleanupProcessor extends WorkerHost {
  constructor(
    @Inject(MediaCleanupService) private readonly cleanup: MediaCleanupService,
    @Inject(AgentRunLeaseService) private readonly lease: AgentRunLeaseService,
    @Inject(WorkflowLeaseService) private readonly workflowLease: WorkflowLeaseService,
  ) {
    super();
  }

  async process(_job: Job): Promise<{
    tasks: number; runs: number;
    recovered: { reEnqueued: number; timedOut: number };
    workflowRecovered: { reEnqueued: number; timedOut: number };
  }> {
    const tasks = await this.cleanup.sweep();
    const runs = await this.cleanup.sweepAgentRuns();
    const recovered = await this.lease.recoverStale(); // M6-P3：lease 过期重入队 / run deadline 超期 timeout
    // M8-P9 接线：WorkflowLeaseService.recoverStale（M7-P6 原语）此前**只被测试直接调用，没有任何周期任务调用它**
    // → worker 崩溃后 workflow run 会永久停在 running（lease 过期也无人接管）、丢 job 的 queued run 无人重投、
    //   超 1h deadline 的 run 无人判超时。此处接进同一清扫周期（5min）：条件更新 + 唯一 jobId，幂等且多 Worker 安全。
    const workflowRecovered = await this.workflowLease.recoverStale();
    return { tasks, runs, recovered, workflowRecovered };
  }
}

/** 周期调度：每 5 分钟投递一次 sweep 作业（Worker 进程侧） */
@Injectable()
export class MediaCleanupScheduler implements OnModuleInit {
  constructor(@InjectQueue(MEDIA_CLEANUP_QUEUE) private readonly queue: Queue) {}

  async onModuleInit(): Promise<void> {
    await this.queue.upsertJobScheduler('media-cleanup-scheduler', { every: SWEEP_INTERVAL_MS }, { name: 'sweep' });
  }
}
