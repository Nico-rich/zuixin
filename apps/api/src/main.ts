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
import { assertProductionSafety } from './modules/security/production-guards';
import { applyTrustedProxy } from './modules/security/trusted-proxy';

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

/**
 * M10-P1 SA-24：helmet **逐项显式配置**（不再用 `helmet()` 默认全集）。
 * 取舍逐条写明，任一项变更都必须同步 test/pre-m10-security-hardening.e2e-spec.ts 的响应头断言：
 *
 * - contentSecurityPolicy：**API 进程不渲染 HTML**（纯 JSON + SSE），默认 CSP 无实际保护价值，
 *   但 `default-src 'none'` 能在"被当作静态源/被错误反代"时把 XSS 面压到零；同时**必须**保留
 *   `frame-ancestors 'none'` 语义（等价默认的 X-Frame-Options: DENY）。
 * - hsts：仅在 https 部署下有意义。生产/显式开启时 1 年 + includeSubDomains；
 *   **不含 preload**（preload 是提交到浏览器预加载列表的不可逆操作，需域名全站 https 承诺，非本项目单方决定）。
 *   本地 http 开发不发送 HSTS——否则浏览器会把 localhost 也升级到 https 导致本地调试失效。
 * - frameguard：deny（老浏览器兜底；与 CSP frame-ancestors 双写）。
 * - noSniff：X-Content-Type-Options: nosniff（JSON 响应被嗅探成 HTML 是典型 XSS 入口）。
 * - referrerPolicy：no-referrer（API 响应无外链需求，避免把内部 URL 经 Referer 外泄）。
 * - crossOriginResourcePolicy：API 面向跨源 SPA + SSE，需允许跨源读取；用 cross-origin 而非默认 same-origin
 *   （same-origin 会让 web 域读不到 API 响应，属功能性破坏）。
 * - crossOriginOpenerPolicy / crossOriginEmbedderPolicy：**关闭**。两者是文档/嵌入隔离策略，
 *   API 无文档上下文；开启 COEP 会连带要求所有子资源 CORP，对 API 无收益。
 * - originAgentCluster / xssFilter / dnsPrefetchControl / ieNoOpen / permittedCrossDomainPolicies：
 *   沿用 helmet 默认（均为安全方向且无副作用：Origin-Agent-Cluster 隔离、
 *   X-XSS-Protection: 0 关闭过时的反射过滤、X-DNS-Prefetch-Control: off、X-Download-Options: noopen、
 *   X-Permitted-Cross-Domain-Policies: none）。
 */
function helmetOptions(): Parameters<typeof helmet>[0] {
  const httpsDeployment = process.env.NODE_ENV === 'production' || process.env.COOKIE_SECURE === 'true';
  return {
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        defaultSrc: ["'none'"],
        frameAncestors: ["'none'"],
        baseUri: ["'none'"],
        formAction: ["'none'"],
      },
    },
    hsts: httpsDeployment
      ? { maxAge: 31_536_000, includeSubDomains: true, preload: false }
      : false,
    frameguard: { action: 'deny' },
    noSniff: true,
    referrerPolicy: { policy: 'no-referrer' },
    crossOriginResourcePolicy: { policy: 'cross-origin' },
    crossOriginOpenerPolicy: false,
    crossOriginEmbedderPolicy: false,
  };
}

async function bootstrap() {
  // M10-P1 D2/D8/PR-8：生产 fail-fast（占位密钥 / 开发替身开关 / 默认 seed 口令 → 拒绝启动）。
  // 必须在 NestFactory.create 之前：绝不"先建好资源再发现配置不可用"。
  assertProductionSafety();
  const app = await NestFactory.create(AppModule, { bufferLogs: true, bodyParser: false });
  app.useLogger(app.get(Logger));
  // M10-P1 × M10-P8：TRUSTED_PROXY_HOPS 显式生效于 Express `trust proxy` —— 使 auth 失败计数用的
  // `req.ip` 与全局限流的 resolveClientIp(hops) 同口径（右起第 N 跳）。未配置（默认 0）时不动 Express，
  // 即不信任任何 X-Forwarded-For：**不把可伪造头部当作分桶/计数依据**。见 modules/security/trusted-proxy.ts
  applyTrustedProxy(app);
  app.use(helmet(helmetOptions()));
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
// 启动失败（含生产安全守卫 fail-fast）必须显式非零退出：绝不留下"半启动"进程
bootstrap().catch((err) => {
  console.error('[bootstrap] 启动失败，进程退出:', (err as Error).message);
  process.exit(1);
});
