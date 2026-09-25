import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import cookieParser from 'cookie-parser';
import pino from 'pino';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { GlobalExceptionFilter } from '../src/common/filters/global-exception.filter';
import { TransformInterceptor } from '../src/common/interceptors/transform.interceptor';
import { csrfProtection } from '../src/modules/auth/csrf.middleware';
import { createPinoOptions } from '../src/common/logging/pino-logging';
import { PrismaService } from '../src/modules/prisma/prisma.service';

/**
 * Pre-M9 F1/F2 e2e：真实 AppModule + 真实 pino 落盘（LOG_FILE），端到端验证"日志里绝不出现 JWT"。
 *
 * F1 泄漏点：登录/刷新响应通过 Set-Cookie 下发 access+refresh JWT，pino-http 默认 serializer 会把
 * 响应头整体写进请求日志 → 明文落盘。本文件走**真实应用**（登录/刷新/401/403/带 Bearer 的 401/403），
 * 再读日志文件断言：无 JWT、无 set-cookie、无 cookie 值。
 * F2：worker 与 API 共用 createPinoOptions —— 同一份配置 + 真实 pino + 真实文件，断言 queue payload
 * 与错误对象（stack 内含 Bearer）同样不泄凭证。
 *
 * 说明：LOG_FILE 在 AppModule 动态 import **之前**设置（createHttpLoggerParams 在模块加载时求值）。
 */

const XRW = { 'X-Requested-With': 'XMLHttpRequest' };
const STAMP = Date.now();
const LOG_DIR = mkdtempSync(join(tmpdir(), 'pre-m9-log-'));
const API_LOG_FILE = join(LOG_DIR, 'api.jsonl');
const WORKER_LOG_FILE = join(LOG_DIR, 'worker.jsonl');
process.env.LOG_FILE = API_LOG_FILE; // 必须在 import AppModule 之前

/** JWT 形态（非全局副本，避免 lastIndex 状态） */
const JWT_RE = /eyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{4,}/;

describe('Pre-M9 Logging (e2e)：请求/错误日志 JWT 脱敏（F1）与 worker 同源脱敏（F2）', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let userId: string;
  let otherUserId: string;
  let otherOrgId: string;
  const email = `pre-m9-log-${STAMP}@example.com`;
  const password = `pre-m9-pass-${STAMP}`;

  beforeAll(async () => {
    const { AppModule } = await import('../src/app.module'); // 动态 import：确保 LOG_FILE 已生效
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.use(cookieParser());
    app.use('/api/v1', csrfProtection);
    app.setGlobalPrefix('api/v1');
    app.useGlobalFilters(moduleRef.get(GlobalExceptionFilter));
    app.useGlobalInterceptors(new TransformInterceptor());
    await app.init();
    prisma = app.get(PrismaService);
    const argon2 = await import('argon2');
    const user = await prisma.user.create({
      data: { email, passwordHash: await argon2.hash(password) },
      select: { id: true },
    });
    userId = user.id;
    // 他人的组织：用于制造应用层 403（非成员访问 organizationId）
    const { OrganizationsService } = await import('../src/modules/organizations/organizations.service');
    const other = await prisma.user.create({
      data: { email: `pre-m9-org-${STAMP}@example.com`, passwordHash: 'unused-hash' },
      select: { id: true },
    });
    otherUserId = other.id;
    otherOrgId = (await moduleRef.get(OrganizationsService).ensurePersonalOrganization(otherUserId)).id;
  });

  afterAll(async () => {
    await prisma.session.deleteMany({ where: { userId } }).catch(() => undefined);
    await prisma.organization.deleteMany({ where: { id: otherOrgId } }).catch(() => undefined);
    await prisma.session.deleteMany({ where: { userId: otherUserId } }).catch(() => undefined);
    await prisma.user.deleteMany({ where: { id: { in: [userId, otherUserId] } } }).catch(() => undefined);
    await app?.close();
    rmSync(LOG_DIR, { recursive: true, force: true });
  });

  it('F1：登录（Set-Cookie 双 JWT）/ 刷新 / 401 / 403 全链路日志中绝不出现 JWT 或 cookie 值', async () => {
    const server = () => request(app.getHttpServer());
    // ① 登录：响应头 Set-Cookie 携带 access + refresh JWT（F1 的原始泄漏点）
    const login = await server().post('/api/v1/auth/login').set(XRW).set('User-Agent', 'pre-m9-agent')
      .send({ email, password }).expect(201);
    const setCookies = (login.headers['set-cookie'] as unknown as string[]) ?? [];
    const accessToken = /agent_access=([^;]+)/.exec(setCookies.join('; '))?.[1] ?? '';
    const refreshToken = /agent_refresh=([^;]+)/.exec(setCookies.join('; '))?.[1] ?? '';
    // 前置断言：确实签发了凭证（否则"日志里没有 JWT"是空断言）
    // access = JWT；refresh = 不透明随机串（不是 JWT 形态 → 只能靠键名/白名单脱敏，必须单独断言值不落盘）
    expect(accessToken).toMatch(JWT_RE);
    expect(refreshToken.length).toBeGreaterThan(20);
    expect(refreshToken).not.toMatch(/\s/);
    const cookie = setCookies.map((c) => c.split(';')[0]).join('; ');

    // ② 刷新：再次下发新的 access JWT（同一泄漏点）
    const refreshed = await server().post('/api/v1/auth/refresh').set(XRW).set('Cookie', cookie).expect(201);
    const refreshedCookies = ((refreshed.headers['set-cookie'] as unknown as string[]) ?? []).join('; ');
    const newAccess = /agent_access=([^;]+)/.exec(refreshedCookies)?.[1] ?? '';
    expect(newAccess).toMatch(JWT_RE);
    const liveCookie = refreshedCookies.length
      ? (refreshed.headers['set-cookie'] as unknown as string[]).map((c) => c.split(';')[0]).join('; ')
      : cookie;

    // ③ 401（无凭证）与 401（伪 Bearer JWT 形态）
    await server().get('/api/v1/auth/me').expect(401);
    await server().get('/api/v1/auth/me').set('Authorization', `Bearer ${accessToken}`).expect(401);
    // ④ 403（缺 CSRF 头；express 中间件层短路，不经过 pino-http —— 保留请求证明该路径也不泄凭证）
    await server().post('/api/v1/auth/login').send({ email, password }).expect(403);
    // ⑤ 403（应用层授权拒绝：非成员的 organizationId）—— 走完整请求日志链路
    await server().get('/api/v1/auth/me').set('Cookie', liveCookie).expect(200); // 前置：刷新后的 cookie 确实有效
    await server().get(`/api/v1/analytics/overview?organizationId=${otherOrgId}`).set('Cookie', liveCookie).expect(403);

    const log = readFileSync(API_LOG_FILE, 'utf8');
    // 断言日志确实记录了这些请求（覆盖成立才有意义）
    expect(log).toContain('/api/v1/auth/login');
    expect(log).toContain('/api/v1/auth/refresh');
    expect(log).toContain('/api/v1/auth/me');
    expect(log).toContain('"statusCode":403');
    expect(log).toContain('"statusCode":401');
    // 绝不出现 JWT / cookie 头 / cookie 值
    expect(log).not.toMatch(JWT_RE);
    expect(log).not.toContain('eyJ');
    expect(log.toLowerCase()).not.toContain('set-cookie');
    expect(log.toLowerCase()).not.toContain('cookie');
    expect(log).not.toContain(accessToken);
    expect(log).not.toContain(refreshToken);
    expect(log).not.toContain('agent_access');
    expect(log).not.toContain('agent_refresh');
    // Authorization 头同样不得落盘
    expect(log.toLowerCase()).not.toContain('authorization');
  });

  it('F2：worker 同源 pino 配置（createPinoOptions）落盘 → queue payload 与错误对象均不泄凭证', () => {
    const secretish = `Bearer ${'prem9fakejwtpayload'}.${'x'.repeat(40)}`;
    const dest = pino.destination({ dest: WORKER_LOG_FILE, mkdir: true, sync: true });
    const logger = pino(createPinoOptions('worker'), dest);
    // 模拟 worker 真实日志形态：queue payload 只应留下安全 ID；错误对象 message/stack 可能夹带凭证
    logger.info(
      { queue: 'agent-run', jobId: 'job-1', userId: 'u-1', payload: { agentId: 'a-1', accessToken: secretish } },
      `job 开始 ${secretish}`,
    );
    logger.error(new Error(`provider 调用失败 Authorization: ${secretish}`), 'job 失败');
    logger.flush();

    const log = readFileSync(WORKER_LOG_FILE, 'utf8');
    expect(log).toContain('job-1'); // 安全 ID 保留（可观测性不牺牲）
    expect(log).toContain('job 失败');
    expect(log).not.toContain(secretish);
    expect(log).not.toMatch(JWT_RE);
    expect(log).toContain('[Redacted]'); // 凭证位置留痕（可观测性：脱敏而非丢字段）
  });
});
