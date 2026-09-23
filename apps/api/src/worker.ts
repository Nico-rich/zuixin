import './env';
import { NestFactory } from '@nestjs/core';
import { WorkerModule } from './worker.module';

async function bootstrap() {
  const app = await NestFactory.createApplicationContext(WorkerModule, { bufferLogs: false });
  console.log('Worker 已启动（image/video 队列消费端，处理器在 M2/M3 注册）');
  void app;
}
bootstrap();
