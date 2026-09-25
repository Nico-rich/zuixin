import './env';
import { NestFactory } from '@nestjs/core';
import { Logger } from 'nestjs-pino';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import express from 'express';
import { AppModule } from './app.module';
import { GlobalExceptionFilter } from './common/filters/global-exception.filter';
import { TransformInterceptor } from './common/interceptors/transform.interceptor';
import { csrfProtection } from './modules/auth/csrf.middleware';
import { bodyLimitErrorHandler } from './modules/security/body-limit.middleware';
import { corsOriginsFromEnv } from './modules/security/cors-policy';
import { TracingMiddleware } from './core/tracing/tracing.middleware';
import { registerGracefulShutdown } from './lifecycle/graceful-shutdown';

/**
 * M8-P8 API 安全：请求体上限显式化（关闭 Nest 默认 body parser，改为在此集中注册，顺序可控可审计）：
 * - /api/v1/hooks：express.raw（webhook 需原始字节做 HMAC 验签）—— 1mb；
 * - 其余 JSON：express.json —— 1mb（显式上限；Nest 默认 100kb，此处放宽到与 webhook 同量级但仍受硬上限约束）；
 * - 表单：express.urlencoded —— 100kb（保持原默认量级；平台无表单型写接口）。
 * 契约：所有上限都必须在测试中断言（见 test/m8-p8-security.e2e-spec.ts）。
 */
const HOOK_BODY_LIMIT = process.env.HOOK_BODY_LIMIT ?? '1mb';
const JSON_BODY_LIMIT = process.env.JSON_BODY_LIMIT ?? '1mb';
const FORM_BODY_LIMIT = process.env.FORM_BODY_LIMIT ?? '100kb';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { bufferLogs: true, bodyParser: false });
  app.useLogger(app.get(Logger));
  app.use(helmet());
  // M8-P8：CORS 来源白名单解析抽到 modules/security/cors-policy（唯一来源、可被单测/契约测试覆盖）
  app.enableCors({ origin: corsOriginsFromEnv(), credentials: true });
  app.use(cookieParser());
  app.use(app.get(TracingMiddleware).handler); // M8-P3 追踪传播 + HTTP 指标采样（先于 csrf/路由注册）
  // M7-P6：webhook 端点需要原始字节做 HMAC 验签（先于 JSON parser 注册）
  app.use('/api/v1/hooks', express.raw({ type: '*/*', limit: HOOK_BODY_LIMIT }));
  app.use(express.json({ limit: JSON_BODY_LIMIT }));
  app.use(express.urlencoded({ extended: true, limit: FORM_BODY_LIMIT }));
  app.use(bodyLimitErrorHandler); // body parser 错误 → 统一 JSON 信封（否则落 Express finalhandler：HTML + 堆栈泄露）
  app.use('/api/v1', csrfProtection);
  app.setGlobalPrefix('api/v1');
  app.useGlobalFilters(app.get(GlobalExceptionFilter));
  app.useGlobalInterceptors(new TransformInterceptor());
  const port = Number(process.env.API_PORT ?? 3001);
  await app.listen(port);
  console.log(`API 已启动: http://localhost:${port}/api/v1/health`);
  registerGracefulShutdown(app); // M8-P9 优雅停机：SIGTERM/SIGINT → 停收新请求 → 等在途收尾 → 30s 兜底强退
}
bootstrap();
