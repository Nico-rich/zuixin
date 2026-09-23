import { Module } from '@nestjs/common';
import { GenerationsModule } from '../../modules/generations/generations.module';
import { VideoProcessor } from './video.processor';

/** 仅 Worker 进程挂载（API 进程不消费队列） */
@Module({ imports: [GenerationsModule], providers: [VideoProcessor] })
export class VideoWorkerModule {}
