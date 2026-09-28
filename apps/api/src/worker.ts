import './env';
import { NestFactory } from '@nestjs/core';
import { WorkerModule } from './worker.module';
import { registerGracefulShutdown } from './lifecycle/graceful-shutdown';
import { PinoNestLogger } from './common/logging/pino-logging';
import { assertProductionSafety } from './modules/security/production-guards';

/**
 * Pre-M9 F2：Worker 日志接入与 API 同源的 pino 体系（同一份 redact/serializer/深度擦洗配置），
 * 替换此前的默认 ConsoleLogger（无脱敏层 → credential/JWT 原样落盘）。
 * 装配点唯一：createPinoOptions 由 common/logging/pino-logging.ts 提供，API 与 Worker 共用。
 */
const workerLogger = new PinoNestLogger('worker');

async function bootstrap() {
  // M11-P10 E-08：生产 fail-fast 接线（与 main.ts:78 同源、同一份实现 modules/security/production-guards.ts）。
  // 必须在 createApplicationContext 之前：占位 JWT_SECRET/ENCRYPTION_KEY、开发替身开关（MOCK_*）、
  // 缺失/占位/默认的 SEED_ADMIN_PASSWORD 一律拒绝启动——绝不"先连上 DB/Redis 再把队列消费端跑起来"。
  assertProductionSafety();
  const app = await NestFactory.createApplicationContext(WorkerModule, { logger: workerLogger, bufferLogs: false });
  workerLogger.log('Worker 已启动（image/video/media-cleanup/agent-run/workflow/scheduler 队列消费端）', 'Bootstrap');
  // M6-P3 + M8-P9 优雅停机：SIGTERM/SIGINT → onApplicationShutdown（AgentRun/Workflow 释放 lease + 中止 Engine、
  // Scheduler 等在途作业收尾）→ BullMQ Worker close 等当前 job 结束 → 连接释放；30s 未完成强制退出。
  registerGracefulShutdown(app, { worker: true });
}
// 启动失败（含生产安全守卫 fail-fast）必须显式非零退出：绝不留下"半启动"的消费端进程
// （进程挂着但队列不推进 = 静默停摆，编排层看不见——见 k8s/worker-deployment.yaml 的探针盲区说明）
bootstrap().catch((err) => {
  console.error('[bootstrap] Worker 启动失败，进程退出:', (err as Error).message);
  process.exit(1);
});
