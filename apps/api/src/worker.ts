import './env';
import { NestFactory } from '@nestjs/core';
import { WorkerModule } from './worker.module';
import { registerGracefulShutdown } from './lifecycle/graceful-shutdown';

async function bootstrap() {
  const app = await NestFactory.createApplicationContext(WorkerModule, { bufferLogs: false });
  console.log('Worker 已启动（image/video/media-cleanup/agent-run/workflow/scheduler 队列消费端）');
  // M6-P3 + M8-P9 优雅停机：SIGTERM/SIGINT → onApplicationShutdown（AgentRun/Workflow 释放 lease + 中止 Engine、
  // Scheduler 等在途作业收尾）→ BullMQ Worker close 等当前 job 结束 → 连接释放；30s 未完成强制退出。
  registerGracefulShutdown(app, { worker: true });
}
bootstrap();
