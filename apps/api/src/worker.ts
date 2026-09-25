import './env';
import { NestFactory } from '@nestjs/core';
import { WorkerModule } from './worker.module';
import { registerGracefulShutdown } from './lifecycle/graceful-shutdown';
import { PinoNestLogger } from './common/logging/pino-logging';

/**
 * Pre-M9 F2：Worker 日志接入与 API 同源的 pino 体系（同一份 redact/serializer/深度擦洗配置），
 * 替换此前的默认 ConsoleLogger（无脱敏层 → credential/JWT 原样落盘）。
 * 装配点唯一：createPinoOptions 由 common/logging/pino-logging.ts 提供，API 与 Worker 共用。
 */
const workerLogger = new PinoNestLogger('worker');

async function bootstrap() {
  const app = await NestFactory.createApplicationContext(WorkerModule, { logger: workerLogger, bufferLogs: false });
  workerLogger.log('Worker 已启动（image/video/media-cleanup/agent-run/workflow/scheduler 队列消费端）', 'Bootstrap');
  // M6-P3 + M8-P9 优雅停机：SIGTERM/SIGINT → onApplicationShutdown（AgentRun/Workflow 释放 lease + 中止 Engine、
  // Scheduler 等在途作业收尾）→ BullMQ Worker close 等当前 job 结束 → 连接释放；30s 未完成强制退出。
  registerGracefulShutdown(app, { worker: true });
}
bootstrap();
