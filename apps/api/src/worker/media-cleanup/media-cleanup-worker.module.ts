import { Module } from '@nestjs/common';
import { GenerationsModule } from '../../modules/generations/generations.module';
import { MediaCleanupProcessor, MediaCleanupScheduler } from './media-cleanup.worker';

/** 仅 Worker 进程挂载：周期清扫 scheduling + sweep 处理器 */
@Module({ imports: [GenerationsModule], providers: [MediaCleanupProcessor, MediaCleanupScheduler] })
export class MediaCleanupWorkerModule {}
