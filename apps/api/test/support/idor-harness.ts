import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { JwtService } from '@nestjs/jwt';
import request from 'supertest';
import cookieParser from 'cookie-parser';
import express from 'express';
import { AppModule } from '../../src/app.module';
import { GlobalExceptionFilter } from '../../src/common/filters/global-exception.filter';
import { TransformInterceptor } from '../../src/common/interceptors/transform.interceptor';
import { csrfProtection } from '../../src/modules/auth/csrf.middleware';
import { PrismaService } from '../../src/modules/prisma/prisma.service';
import { OrganizationsService } from '../../src/modules/organizations/organizations.service';

/**
 * M10-P15 全端点 IDOR/RBAC 枚举矩阵的共享夹具。
 *
 * 只被 `test/m10-p15-*.e2e-spec.ts` 引用（不在 vitest include 的收集范围内：include 是
 * `test/**\/*.e2e-spec.ts` + `src/**\/*.spec.ts`）——与既有 `test/support/attachment-fixtures.ts` 同一约定。
 *
 * 组成与生产一致的最小面：`AppModule`（含全局 GlobalRateLimitGuard）+ cookieParser + CSRF +
 * `api/v1` 前缀 + 统一异常过滤 + TransformInterceptor。断言一律针对**真实 HTTP 语义**
 * （状态码 + 错误码 + 响应体字段集合），不 mock 授权层。
 */

export const XRW = { 'X-Requested-With': 'XMLHttpRequest' };

export interface IdorApp {
  app: INestApplication;
  prisma: PrismaService;
  jwt: JwtService;
  orgs: OrganizationsService;
}

/** 建应用（与既有 m8-p1/m8-p8 e2e 同一套最小生产面） */
export async function createIdorApp(): Promise<IdorApp> {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  const app = moduleRef.createNestApplication();
  app.use(cookieParser());
  // 与 main.ts 同构：webhook 验签需要**原始字节**（express.raw 先于默认 json 解析器接管 /hooks）
  app.use('/api/v1/hooks', express.raw({ type: '*/*', limit: '1mb' }));
  app.use('/api/v1', csrfProtection);
  app.setGlobalPrefix('api/v1');
  app.useGlobalFilters(moduleRef.get(GlobalExceptionFilter));
  app.useGlobalInterceptors(new TransformInterceptor());
  await app.init();
  await app.listen(0);
  return {
    app,
    prisma: moduleRef.get(PrismaService),
    jwt: moduleRef.get(JwtService),
    orgs: moduleRef.get(OrganizationsService),
  };
}

export type OrgRole = 'owner' | 'admin' | 'member' | 'viewer';

export interface Actor {
  userId: string;
  email: string;
  cookie: string;
  /** 个人组织 id（自动创建；owner） */
  personalOrgId: string;
}

let seq = 0;

/**
 * 造一个"已登录"的主体：真实 `User` 行 + 个人组织（owner 成员行）+ 服务端签发的 access token。
 * 不走 `/auth/login`（argon2 哈希是纯开销，且与本矩阵无关）；token 载荷与登录路径一致。
 */
export async function createActor(
  h: IdorApp,
  tag: string,
  opts: { platformRole?: 'user' | 'admin' } = {},
): Promise<Actor> {
  seq += 1;
  const email = `m10p15-${tag}-${Date.now()}-${seq}@example.com`;
  const user = await h.prisma.user.create({
    data: { email, passwordHash: 'unused-hash', role: opts.platformRole ?? 'user' },
  });
  const personalOrgId = (await h.orgs.ensurePersonalOrganization(user.id)).id;
  const cookie = `agent_access=${await h.jwt.signAsync({ sub: user.id, role: opts.platformRole ?? 'user' })}`;
  return { userId: user.id, email, cookie, personalOrgId };
}

/** 建组织（owner = 传入用户），返回组织 id */
export async function createOrg(h: IdorApp, ownerId: string, name: string): Promise<string> {
  const slug = `m10p15-${Date.now()}-${(seq += 1)}`;
  const org = await h.prisma.organization.create({
    data: { name, slug, ownerUserId: ownerId, members: { create: { userId: ownerId, role: 'owner' } } },
  });
  return org.id;
}

/** 把用户以指定角色加入组织 */
export async function addMember(h: IdorApp, organizationId: string, userId: string, role: OrgRole): Promise<void> {
  await h.prisma.organizationMember.create({ data: { organizationId, userId, role } });
}

// ─────────────────────────── HTTP 便捷封装 ───────────────────────────

export interface Res {
  status: number;
  body: unknown;
}

export type HttpMethod = 'get' | 'post' | 'patch' | 'put' | 'delete';

export interface HttpApi {
  get: (path: string, cookie: string | null) => request.Test;
  post: (path: string, cookie: string | null) => request.Test;
  patch: (path: string, cookie: string | null) => request.Test;
  put: (path: string, cookie: string | null) => request.Test;
  delete: (path: string, cookie: string | null) => request.Test;
  /** 数据驱动探针用（方法名运行时给出） */
  call: (method: HttpMethod, path: string, cookie: string | null) => request.Test;
}

export function http(app: INestApplication): HttpApi {
  const server = app.getHttpServer();
  const call = (method: HttpMethod, path: string, cookie: string | null) => {
    const req = request(server)[method](path).set(XRW);
    return cookie ? req.set('Cookie', cookie) : req;
  };
  return {
    get: (path, cookie) => call('get', path, cookie),
    post: (path, cookie) => call('post', path, cookie),
    patch: (path, cookie) => call('patch', path, cookie),
    put: (path, cookie) => call('put', path, cookie),
    delete: (path, cookie) => call('delete', path, cookie),
    call,
  };
}

/** 错误信封断言：`{ error: { code, message, requestId } }`，绝不含堆栈/SQL/内部路径 */
export function errorCode(res: Res): string | undefined {
  const body = res.body as { error?: { code?: string } } | undefined;
  return body?.error?.code;
}

export function errorMessage(res: Res): string | undefined {
  const body = res.body as { error?: { message?: string } } | undefined;
  return body?.error?.message;
}

/** 成功响应体（TransformInterceptor 包裹为 `{ data }`） */
export function data<T = unknown>(res: Res): T {
  return (res.body as { data: T }).data;
}

/**
 * 响应体不得泄漏的通用面：序列化后的整包文本不得出现这些子串
 * （他租户资源 id / 敏感字段名 / 内部实现痕迹）。
 */
export function assertNoLeak(res: Res, forbidden: string[], label = '响应体'): void {
  const text = JSON.stringify(res.body ?? '');
  for (const needle of forbidden) {
    if (needle && text.includes(needle)) {
      throw new Error(`${label}泄漏了禁止子串「${needle}」：${text.slice(0, 400)}`);
    }
  }
  // 通用脱敏：堆栈 / SQL / 驱动痕迹一律不得出现在任何响应体
  for (const pattern of ['at Object.', 'node_modules', 'prisma.', 'SELECT ', 'Traceback']) {
    if (text.includes(pattern)) {
      throw new Error(`${label}含内部实现痕迹「${pattern}」：${text.slice(0, 400)}`);
    }
  }
}

/**
 * 「不存在」与「他人资源」响应必须**零信息差**：同状态码 + 同错误码 + 同文案。
 * 这是防枚举的核心断言（既有的响应差异会让攻击者判定资源是否存在）。
 */
export function assertIndistinguishable(missing: Res, foreign: Res, label: string): void {
  if (missing.status !== foreign.status) {
    throw new Error(`${label}：不存在(${missing.status}) 与他人资源(${foreign.status}) 状态码不同 → 可枚举`);
  }
  const mc = errorCode(missing);
  const fc = errorCode(foreign);
  if (mc !== fc) {
    throw new Error(`${label}：错误码不同（${mc} vs ${fc}）→ 可枚举`);
  }
  if (errorMessage(missing) !== errorMessage(foreign)) {
    throw new Error(`${label}：错误文案不同（${errorMessage(missing)} vs ${errorMessage(foreign)}）→ 可枚举`);
  }
}

/** 不存在 id 的响应体不得回显该 id（防反射型枚举辅助） */
export function assertDoesNotEcho(res: Res, id: string, label: string): void {
  const text = JSON.stringify(res.body ?? '');
  if (text.includes(id)) throw new Error(`${label}：响应体回显了请求的 id（${id}）`);
}

/** 等待条件成立（最终一致写入） */
export async function waitFor<T>(fn: () => Promise<T | null | undefined>, what: string, timeoutMs = 20_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const v = await fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`等待超时：${what}`);
}

/** 唯一 id 收敛断言用：随机不存在 id（UUID 形态，绝不与任何真实行碰撞） */
export function ghostId(): string {
  return `00000000-0000-4000-8000-${String(Date.now() % 1e12).padStart(12, '0')}`;
}
