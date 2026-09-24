import './env';
import { NestFactory } from '@nestjs/core';
import { WorkerModule } from './worker.module';

async function bootstrap() {
  const app = await NestFactory.createApplicationContext(WorkerModule, { bufferLogs: false });
  console.log('Worker 已启动（image/video/media-cleanup/agent-run 队列消费端）');
  // M6-P3 优雅停机：SIGTERM/SIGINT → OnApplicationShutdown（AgentRunProcessor 释放 lease + 中止 Engine）→ BullMQ 队列关闭
  for (const sig of ['SIGTERM', 'SIGINT'] as const) {
    process.on(sig, () => {
      console.log(`收到 ${sig}，优雅停机中…`);
      void app.close().then(() => process.exit(0));
    });
  }
}
bootstrap();
