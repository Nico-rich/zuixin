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
import { TracingMiddleware } from './core/tracing/tracing.middleware';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { bufferLogs: true });
  app.useLogger(app.get(Logger));
  app.use(helmet());
  app.enableCors({
    origin: (process.env.CORS_ORIGINS ?? 'http://localhost:3000').split(','),
    credentials: true,
  });
  app.use(cookieParser());
  app.use(app.get(TracingMiddleware).handler); // M8-P3 追踪传播 + HTTP 指标采样（先于 csrf/路由注册）
  // M7-P6：webhook 端点需要原始字节做 HMAC 验签（先于 JSON parser 注册）
  app.use('/api/v1/hooks', express.raw({ type: '*/*', limit: '1mb' }));
  app.use('/api/v1', csrfProtection);
  app.setGlobalPrefix('api/v1');
  app.useGlobalFilters(app.get(GlobalExceptionFilter));
  app.useGlobalInterceptors(new TransformInterceptor());
  const port = Number(process.env.API_PORT ?? 3001);
  await app.listen(port);
  console.log(`API 已启动: http://localhost:${port}/api/v1/health`);
}
bootstrap();
