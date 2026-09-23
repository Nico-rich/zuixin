# M1 实施计划：认证 + 对话 + LLM Streaming

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 打通「登录 → 建会话 → 发消息 → AI Router → LLM Provider → SSE 流式 → 前端实时渲染 → 完整持久化」全链路，交付可用的 ChatGPT 类基础聊天系统（Mock Provider 全程可跑，无需真实 Key）。

**Architecture:** 复用 Phase 3 全部核心抽象（Router/LLMManager/ChatAgent/熔断/事件总线）。新增 auth/conversations/chat/usage 四个模块；SSE 线上协议采用规格命名（message_start/message_delta/message_end/status/task.*/error），内部 AgentEvent 层不变，chat 模块映射两层。并发用 Redis SETNX 会话锁；访问令牌 15min + 刷新令牌 30d（sessions 表哈希存储、轮换、可吊销），均 httpOnly Cookie。

**Tech Stack:** 新增依赖——api: `@nestjs/jwt`、`cookie-parser`；web: `react-markdown`、`remark-gfm`、`rehype-highlight`、`highlight.js`、`@tanstack/react-query`、`class-variance-authority`、`clsx`、`tailwind-merge`、`lucide-react`。

**测试约定：** TDD；e2e 依赖 docker 三服务 + seed 数据（admin 账号从 .env 读取）；SSEWriter 面向最小 Response 接口便于单测。

---

## 文件结构总览（新增/修改）

```
packages/shared/src/
├── events.ts (改)      # 新增 ChatStreamEvent 线上协议（保留 AgentEvent）
└── errors.ts (改)      # + CONCURRENT_CHAT
apps/api/
├── prisma/schema.prisma (改)  # MessageRole + tool → 迁移
├── src/main.ts (改)           # cookieParser + CSRF 中间件
├── src/app.module.ts (改)     # + AuthModule/CircuitBreakerModule/ConversationsModule/ChatModule/UsageModule
├── src/core/circuit-breaker/
│   ├── kv-store.interface.ts (改)  # + setNX + del
│   └── redis-kv.service.ts (改)
│   └── circuit-breaker.module.ts (新)
├── src/providers/llm/
│   ├── adapters/mock.adapter.ts (改)   # 分块延迟 + signal 中止
│   ├── adapters/mock.adapter.spec.ts (改)
│   ├── model-resolver.service.ts (新)  # 默认模型解析（settings → isDefault → priority）
│   └── llm-manager.service.ts (改)     # mock 延迟从 env 读取
├── src/agents/agent.types.ts (改)      # AgentContext + signal
├── src/agents/chat/chat.agent.ts (改)  # 传 signal、收集 usage、done 携带 usage
├── src/modules/auth/ (新)              # service/controller/guard/csrf/dto/module
├── src/modules/conversations/ (新)
├── src/modules/chat/ (新)              # dto/sse-writer/service/controller/module
├── src/modules/usage/ (新)
└── test/{auth.e2e-spec.ts, chat.e2e-spec.ts} (新)
apps/web/
├── package.json (改)
├── lib/{utils.ts, api.ts, sse.ts} (新)
├── components/ui/{button.tsx, input.tsx, textarea.tsx} (新)
├── components/providers.tsx (新)
├── app/layout.tsx (改)
├── app/login/page.tsx (新)
├── app/(chat)/layout.tsx (新)
├── app/(chat)/chat/[[id]]/page.tsx (新)
└── app/(chat)/chat/components/* (新: sidebar/chat-workspace/chat-input/message-bubble/markdown-renderer)
```

---

### Task 1: shared 层扩展（SSE 线上协议 + 错误码 + KVStore 扩展）

- [ ] **Step 1: 写失败测试**

`packages/shared/test/events.spec.ts`：
```ts
import { describe, it, expect } from 'vitest';
import { ChatStreamEventSchema } from '../src';

describe('ChatStreamEventSchema（SSE 线上协议）', () => {
  it('解析 message_start/message_delta/message_end', () => {
    expect(ChatStreamEventSchema.parse({ type: 'message_start', messageId: 'm1', conversationId: 'c1', role: 'assistant', createdAt: '2026-09-23T00:00:00Z' }).type).toBe('message_start');
    expect(ChatStreamEventSchema.parse({ type: 'message_delta', delta: '你好' }).delta).toBe('你好');
    expect(ChatStreamEventSchema.parse({ type: 'message_end', messageId: 'm1', status: 'completed' }).status).toBe('completed');
  });

  it('未来事件类型（task.progress/tool 占位）已在协议中', () => {
    const e = ChatStreamEventSchema.parse({ type: 'task.progress', taskId: 't1', progress: 50, message: '生成中 50%' });
    expect(e.progress).toBe(50);
  });

  it('未知 type 拒绝', () => {
    expect(() => ChatStreamEventSchema.parse({ type: 'nope', foo: 1 })).toThrow();
  });

  it('message_end 状态枚举严格', () => {
    expect(() => ChatStreamEventSchema.parse({ type: 'message_end', messageId: 'm', status: 'weird' })).toThrow();
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm --filter shared test`
Expected: FAIL——ChatStreamEventSchema 不存在。

- [ ] **Step 3: 实现**

`packages/shared/src/events.ts` 追加（保留原有 AgentEvent 部分不动）：

```ts
// ===== Chat SSE 线上协议（前端消费；M2+ 追加 task.completed.artifact / tool.* 事件）=====
export const ChatStreamEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('message_start'), messageId: z.string(), conversationId: z.string(), role: z.enum(['assistant']), createdAt: z.string() }),
  z.object({ type: z.literal('message_delta'), delta: z.string() }),
  z.object({ type: z.literal('message_end'), messageId: z.string(), status: z.enum(['completed', 'stopped', 'failed']) }),
  z.object({ type: z.literal('status'), stage: z.string(), message: z.string() }),
  z.object({ type: z.literal('task.created'), taskId: z.string(), kind: z.enum(['image', 'video']) }),
  z.object({ type: z.literal('task.progress'), taskId: z.string(), progress: z.number(), message: z.string().optional() }),
  z.object({ type: z.literal('task.completed'), taskId: z.string(), artifact: z.record(z.string(), z.unknown()).optional() }),
  z.object({ type: z.literal('error'), code: z.string(), message: z.string(), requestId: z.string().optional() }),
]);
export type ChatStreamEvent = z.infer<typeof ChatStreamEventSchema>;
```

同时把 `DoneEventSchema` 扩展 usage 字段：
```ts
export const DoneEventSchema = z.object({ type: z.literal('done'), messageId: z.string(), usage: z.object({ inputTokens: z.number(), outputTokens: z.number() }).optional() });
```

`packages/shared/src/errors.ts` 的 ErrorCode 增加：`CONCURRENT_CHAT: 'CONCURRENT_CHAT',`

`apps/api/src/core/circuit-breaker/kv-store.interface.ts`：
```ts
export interface KVStore {
  incr(key: string, ttlSec: number): Promise<number>;
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlSec?: number): Promise<void>;
  setNX(key: string, value: string, ttlSec: number): Promise<boolean>;  // 不存在才写入（锁）
  del(key: string): Promise<void>;
}
```

`apps/api/src/core/circuit-breaker/redis-kv.service.ts` 追加两个方法：
```ts
  async setNX(key: string, value: string, ttlSec: number): Promise<boolean> {
    return (await this.client.set(key, value, 'EX', ttlSec, 'NX')) === 'OK';
  }
  async del(key: string): Promise<void> { await this.client.del(key); }
```

`apps/api/src/core/circuit-breaker/circuit-breaker.service.spec.ts` 的 FakeKV 补两个方法：
```ts
  async setNX(key: string, value: string, ttlSec: number) { if (!this.store.get(key)) { this.set(key, value, ttlSec); return true; } return false; }
  async del(key: string) { this.store.delete(key); }
```

- [ ] **Step 4: 运行确认通过**

Run: `pnpm --filter shared test && pnpm --filter shared build && pnpm --filter api exec vitest run src/core/circuit-breaker`
Expected: shared 11 个测试 PASS（新增 4）、circuit-breaker 5 PASS。

- [ ] **Step 5: 提交**

```bash
git add -A && git commit -m "feat(shared): SSE 线上协议（message_start/delta/end + task.*）+ CONCURRENT_CHAT + KVStore setNX/del"
```

---

### Task 2: Prisma 迁移（MessageRole + tool）

- [ ] **Step 1: 修改 schema**

`apps/api/prisma/schema.prisma`：
```prisma
enum MessageRole {
  user
  assistant
  system
  tool
}
```

- [ ] **Step 2: 迁移**

Run: `cd /c/Users/87474/Desktop/agent && pnpm --filter api exec prisma migrate dev --name add_tool_message_role`
Expected: 迁移成功。

- [ ] **Step 3: 提交**

```bash
git add -A && git commit -m "feat(api): MessageRole 增加 tool 角色（迁移）"
```

---

### Task 3: Auth 模块（登录/刷新/登出/me + 限流 + CSRF）

**Files:** `src/modules/auth/{auth.constants.ts, auth.dto.ts, auth.service.ts, auth.service.spec.ts, auth.controller.ts, jwt-auth.guard.ts, csrf.middleware.ts, auth.module.ts}`、`test/auth.e2e-spec.ts`、`src/main.ts`（改）

- [ ] **Step 1: 写失败单测**

`apps/api/src/modules/auth/auth.service.spec.ts`：
```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AuthService } from './auth.service';
import { AppError } from '../../common/errors/app-error';

function makeAuth() {
  const prisma = {
    user: {
      findUnique: vi.fn(),
      update: vi.fn(),
    },
    session: {
      create: vi.fn(),
      findUnique: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
    },
  };
  const jwt = { signAsync: vi.fn().mockResolvedValue('jwt-token') };
  const kv = { get: vi.fn().mockResolvedValue('0'), incr: vi.fn().mockResolvedValue(1), set: vi.fn(), setNX: vi.fn(), del: vi.fn() };
  const svc = new AuthService(prisma as never, jwt as never, kv as never);
  return { svc, prisma, kv };
}

const activeUser = {
  id: 'u1', email: 'a@b.com', passwordHash: 'HASH', displayName: 'A',
  role: 'user', status: 'active',
};

describe('AuthService.login', () => {
  it('成功登录返回 accessToken/refreshToken 并创建 session', async () => {
    const argon2 = await import('argon2');
    const { svc, prisma } = makeAuth();
    prisma.user.findUnique.mockResolvedValue({ ...activeUser, passwordHash: await argon2.hash('secret123') });
    const r = await svc.login('a@b.com', 'secret123', { ip: '1.2.3.4', userAgent: 'ua' });
    expect(r.accessToken).toBe('jwt-token');
    expect(r.refreshToken).toBeTruthy();
    expect(prisma.session.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ userId: 'u1' }) }));
  });

  it('密码错误 → UNAUTHORIZED 且计数限流', async () => {
    const argon2 = await import('argon2');
    const { svc, prisma, kv } = makeAuth();
    prisma.user.findUnique.mockResolvedValue({ ...activeUser, passwordHash: await argon2.hash('right') });
    await expect(svc.login('a@b.com', 'wrong', { ip: '1.2.3.4', userAgent: 'ua' })).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    expect(kv.incr).toHaveBeenCalled();
  });

  it('禁用用户 → FORBIDDEN', async () => {
    const argon2 = await import('argon2');
    const { svc, prisma } = makeAuth();
    prisma.user.findUnique.mockResolvedValue({ ...activeUser, status: 'disabled', passwordHash: await argon2.hash('secret123') });
    await expect(svc.login('a@b.com', 'secret123', { ip: '1.2.3.4', userAgent: 'ua' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('连续失败 ≥5 次 → RATE_LIMITED（不再查询用户）', async () => {
    const { svc, prisma, kv } = makeAuth();
    kv.get.mockResolvedValue('5');
    await expect(svc.login('a@b.com', 'x', { ip: '1.2.3.4', userAgent: 'ua' })).rejects.toMatchObject({ code: 'RATE_LIMITED' });
    expect(prisma.user.findUnique).not.toHaveBeenCalled();
  });

  it('用户不存在 → 同样返回 UNAUTHORIZED（防枚举）', async () => {
    const { svc, prisma } = makeAuth();
    prisma.user.findUnique.mockResolvedValue(null);
    await expect(svc.login('nobody@b.com', 'x', { ip: '1.2.3.4', userAgent: 'ua' })).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
  });
});

describe('AuthService.refresh', () => {
  const goodSession = { id: 's1', userId: 'u1', expiresAt: new Date(Date.now() + 3600_000), revokedAt: null, tokenHash: 'H' };

  it('有效 refresh token → 轮换（旧会话吊销 + 新会话创建）', async () => {
    const { svc, prisma } = makeAuth();
    prisma.session.findUnique.mockResolvedValue(goodSession);
    prisma.user.findUnique.mockResolvedValue(activeUser);
    const r = await svc.refresh('raw-refresh', { ip: '1.2.3.4', userAgent: 'ua' });
    expect(prisma.session.update).toHaveBeenCalledWith({ where: { id: 's1' }, data: { revokedAt: expect.any(Date) } });
    expect(prisma.session.create).toHaveBeenCalled();
    expect(r.accessToken).toBe('jwt-token');
  });

  it('已吊销 → UNAUTHORIZED', async () => {
    const { svc, prisma } = makeAuth();
    prisma.session.findUnique.mockResolvedValue({ ...goodSession, revokedAt: new Date() });
    await expect(svc.refresh('raw', { ip: 'x', userAgent: 'ua' })).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
  });

  it('空 token → UNAUTHORIZED', async () => {
    const { svc } = makeAuth();
    await expect(svc.refresh('', { ip: 'x', userAgent: 'ua' })).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
  });
});

describe('AuthService.logout', () => {
  it('吊销对应会话', async () => {
    const { svc, prisma } = makeAuth();
    await svc.logout('raw-refresh');
    expect(prisma.session.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: { revokedAt: expect.any(Date) } }));
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `cd /c/Users/87474/Desktop/agent && pnpm --filter api exec vitest run src/modules/auth`
Expected: FAIL——模块不存在。

- [ ] **Step 3: 安装依赖并实现**

Run: `pnpm --filter api add @nestjs/jwt cookie-parser && pnpm --filter api add -D @types/cookie-parser`

`apps/api/src/modules/auth/auth.constants.ts`：
```ts
export const COOKIE_ACCESS = 'agent_access';
export const COOKIE_REFRESH = 'agent_refresh';
export const ACCESS_TTL_SEC = Number(process.env.JWT_ACCESS_TTL_SEC ?? 900);
export const REFRESH_TTL_SEC = Number(process.env.JWT_REFRESH_TTL_SEC ?? 30 * 24 * 3600);
export const LOGIN_MAX_FAILS = 5;
export const LOGIN_FAIL_WINDOW_SEC = 300;
```

`apps/api/src/modules/auth/auth.dto.ts`：
```ts
import { z } from 'zod';

export const LoginDtoSchema = z.object({
  email: z.string().email('邮箱格式不正确'),
  password: z.string().min(6, '密码至少 6 位').max(128),
});
export type LoginDto = z.infer<typeof LoginDtoSchema>;
```

`apps/api/src/modules/auth/auth.service.ts`：
```ts
import { Inject, Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { createHash, randomBytes } from 'node:crypto';
import * as argon2 from 'argon2';
import { AppError, ErrorCode } from '../../common/errors/app-error';
import { PrismaService } from '../prisma/prisma.service';
import { RedisKVService } from '../../core/circuit-breaker/redis-kv.service';
import { ACCESS_TTL_SEC, LOGIN_FAIL_WINDOW_SEC, LOGIN_MAX_FAILS, REFRESH_TTL_SEC } from './auth.constants';

export interface RequestMeta { ip: string; userAgent?: string; }

export interface AuthResult {
  accessToken: string; refreshToken: string;
  user: { id: string; email: string; displayName: string | null; role: string };
}

@Injectable()
export class AuthService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(JwtService) private readonly jwt: JwtService,
    @Inject(RedisKVService) private readonly kv: RedisKVService,
  ) {}

  async login(email: string, password: string, meta: RequestMeta): Promise<AuthResult> {
    const failKey = `auth:loginfail:${meta.ip}`;
    const fails = Number(await this.kv.get(failKey) ?? '0');
    if (fails >= LOGIN_MAX_FAILS) {
      throw new AppError(ErrorCode.RATE_LIMITED, '登录尝试过于频繁，请 5 分钟后再试');
    }
    const user = await this.prisma.user.findUnique({ where: { email } });
    const ok = user != null && await argon2.verify(user.passwordHash, password);
    if (!ok) {
      await this.kv.incr(failKey, LOGIN_FAIL_WINDOW_SEC);
      throw new AppError(ErrorCode.UNAUTHORIZED, '邮箱或密码错误'); // 统一文案防用户枚举
    }
    if (user.status !== 'active') throw new AppError(ErrorCode.FORBIDDEN, '账号已被禁用');
    await this.kv.set(failKey, '0', LOGIN_FAIL_WINDOW_SEC);
    await this.prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });
    return this.issueTokens(user, meta);
  }

  async refresh(rawRefresh: string | undefined, meta: RequestMeta): Promise<AuthResult> {
    if (!rawRefresh) throw new AppError(ErrorCode.UNAUTHORIZED, '未登录');
    const session = await this.prisma.session.findUnique({ where: { tokenHash: this.hash(rawRefresh) } });
    if (!session || session.revokedAt || session.expiresAt < new Date()) {
      throw new AppError(ErrorCode.UNAUTHORIZED, '登录已过期，请重新登录');
    }
    const user = await this.prisma.user.findUnique({ where: { id: session.userId } });
    if (!user || user.status !== 'active') throw new AppError(ErrorCode.UNAUTHORIZED, '账号不可用');
    await this.prisma.session.update({ where: { id: session.id }, data: { revokedAt: new Date() } }); // 轮换
    return this.issueTokens(user, meta);
  }

  async logout(rawRefresh: string | undefined): Promise<void> {
    if (!rawRefresh) return;
    await this.prisma.session.updateMany({
      where: { tokenHash: this.hash(rawRefresh), revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  private async issueTokens(user: { id: string; email: string; displayName: string | null; role: string }, meta: RequestMeta): Promise<AuthResult> {
    const accessToken = await this.jwt.signAsync({ sub: user.id, role: user.role });
    const refreshToken = randomBytes(48).toString('base64url');
    await this.prisma.session.create({
      data: {
        userId: user.id, tokenHash: this.hash(refreshToken),
        expiresAt: new Date(Date.now() + REFRESH_TTL_SEC * 1000),
        userAgent: meta.userAgent, ip: meta.ip,
      },
    });
    return {
      accessToken, refreshToken,
      user: { id: user.id, email: user.email, displayName: user.displayName, role: user.role },
    };
  }

  private hash(token: string): string { return createHash('sha256').update(token).digest('hex'); }
}
```

`apps/api/src/modules/auth/jwt-auth.guard.ts`：
```ts
import { CanActivate, ExecutionContext, Inject, Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Request } from 'express';
import { AppError, ErrorCode } from '../../common/errors/app-error';
import { COOKIE_ACCESS } from './auth.constants';

export interface AuthedUser { userId: string; role: string; }

@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(@Inject(JwtService) private readonly jwt: JwtService) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<Request & { user?: AuthedUser }>();
    const token = (req.cookies as Record<string, string> | undefined)?.[COOKIE_ACCESS];
    if (!token) throw new AppError(ErrorCode.UNAUTHORIZED, '未登录');
    try {
      const payload = await this.jwt.verifyAsync<{ sub: string; role: string }>(token);
      req.user = { userId: payload.sub, role: payload.role };
      return true;
    } catch {
      throw new AppError(ErrorCode.UNAUTHORIZED, '登录已过期');
    }
  }
}
```

`apps/api/src/modules/auth/csrf.middleware.ts`：
```ts
import { NextFunction, Request, Response } from 'express';

/** CSRF 防护：非安全方法要求自定义头 X-Requested-With（跨站表单无法携带）；前端 apiFetch 统一附加 */
export function csrfProtection(req: Request, res: Response, next: NextFunction) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  if (req.headers['x-requested-with'] !== 'XMLHttpRequest') {
    res.status(403).json({ error: { code: 'FORBIDDEN', message: '非法请求来源' } });
    return;
  }
  next();
}
```

`apps/api/src/modules/auth/auth.controller.ts`：
```ts
import { Body, Controller, Get, Post, Req, Res, UseGuards, UsePipes } from '@nestjs/common';
import { Request, Response } from 'express';
import { AuthService } from './auth.service';
import { LoginDtoSchema } from './auth.dto';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import { ACCESS_TTL_SEC, COOKIE_ACCESS, COOKIE_REFRESH, REFRESH_TTL_SEC } from './auth.constants';
import { JwtAuthGuard } from './jwt-auth.guard';

@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Post('login')
  @UsePipes(new ZodValidationPipe(LoginDtoSchema))
  async login(@Body() dto: { email: string; password: string }, @Req() req: Request, @Res() res: Response) {
    const result = await this.auth.login(dto.email, dto.password, { ip: req.ip ?? '', userAgent: req.headers['user-agent'] });
    this.setAuthCookies(res, result.accessToken, result.refreshToken);
    res.json({ data: { user: result.user } });
  }

  @Post('refresh')
  async refresh(@Req() req: Request, @Res() res: Response) {
    const result = await this.auth.refresh((req.cookies as Record<string, string> | undefined)?.[COOKIE_REFRESH], { ip: req.ip ?? '', userAgent: req.headers['user-agent'] });
    this.setAuthCookies(res, result.accessToken, result.refreshToken);
    res.json({ data: { user: result.user } });
  }

  @Post('logout')
  async logout(@Req() req: Request, @Res() res: Response) {
    await this.auth.logout((req.cookies as Record<string, string> | undefined)?.[COOKIE_REFRESH]);
    this.clearAuthCookies(res);
    res.json({ data: { ok: true } });
  }

  @Get('me')
  @UseGuards(JwtAuthGuard)
  async me(@Req() req: Request & { user: { userId: string } }) {
    return this.auth.me(req.user.userId);
  }

  private setAuthCookies(res: Response, access: string, refresh: string) {
    const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
    res.setHeader('Set-Cookie', [
      `${COOKIE_ACCESS}=${access}; HttpOnly; Path=/; Max-Age=${ACCESS_TTL_SEC}; SameSite=Lax${secure}`,
      `${COOKIE_REFRESH}=${refresh}; HttpOnly; Path=/api/v1/auth; Max-Age=${REFRESH_TTL_SEC}; SameSite=Lax${secure}`,
    ]);
  }

  private clearAuthCookies(res: Response) {
    res.setHeader('Set-Cookie', [
      `${COOKIE_ACCESS}=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax`,
      `${COOKIE_REFRESH}=; HttpOnly; Path=/api/v1/auth; Max-Age=0; SameSite=Lax`,
    ]);
  }
}
```

> AuthService 需补充 `me(userId)` 方法（controller 引用）：查询用户，不存在/禁用抛错，返回 `{data:{user}}` 所需字段。

`apps/api/src/modules/auth/auth.module.ts`：
```ts
import { Global, Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { AuthService } from './auth.service';
import { AuthController } from './auth.controller';
import { JwtAuthGuard } from './jwt-auth.guard';

@Global()
@Module({
  imports: [
    JwtModule.registerAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        secret: config.get<string>('JWT_SECRET') ?? 'dev-secret',
        signOptions: { expiresIn: Number(process.env.JWT_ACCESS_TTL_SEC ?? 900) },
      }),
    }),
  ],
  controllers: [AuthController],
  providers: [AuthService, JwtAuthGuard],
  exports: [JwtAuthGuard, JwtModule],
})
export class AuthModule {}
```

- [ ] **Step 4: 接线 main.ts / app.module.ts**

`src/main.ts`：新增
```ts
import cookieParser from 'cookie-parser';
import { csrfProtection } from './modules/auth/csrf.middleware';
// bootstrap 内（helmet 之后）：
app.use(cookieParser());
app.use('/api/v1', csrfProtection);
```

`src/core/circuit-breaker/circuit-breaker.module.ts`（新）：
```ts
import { Global, Module } from '@nestjs/common';
import { RedisKVService } from './redis-kv.service';
import { CircuitBreakerService } from './circuit-breaker.service';

@Global()
@Module({
  providers: [
    RedisKVService,
    { provide: CircuitBreakerService, useFactory: (kv: RedisKVService) => new CircuitBreakerService(kv), inject: [RedisKVService] },
  ],
  exports: [RedisKVService, CircuitBreakerService],
})
export class CircuitBreakerModule {}
```

`src/app.module.ts` imports 增加 `CircuitBreakerModule, AuthModule`。

- [ ] **Step 5: e2e 测试**

`apps/api/test/auth.e2e-spec.ts`：
```ts
import { Test } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import request from 'supertest';
import cookieParser from 'cookie-parser';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { AppModule } from '../src/app.module';
import { GlobalExceptionFilter } from '../src/common/filters/global-exception.filter';
import { csrfProtection } from '../src/modules/auth/csrf.middleware';

const XRW = { 'X-Requested-With': 'XMLHttpRequest' };

describe('Auth (e2e)', () => {
  let app: INestApplication;
  const email = process.env.SEED_ADMIN_EMAIL ?? 'admin@example.com';
  const password = process.env.SEED_ADMIN_PASSWORD ?? 'admin123456';

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.use(cookieParser());
    app.use('/api/v1', csrfProtection);
    app.setGlobalPrefix('api/v1');
    app.useGlobalFilters(moduleRef.get(GlobalExceptionFilter));
    await app.init();
  });

  afterAll(async () => { await app.close(); });

  it('登录成功 → Set-Cookie 含 HttpOnly 双 cookie + user 数据', async () => {
    const res = await request(app.getHttpServer()).post('/api/v1/auth/login').set(XRW).send({ email, password }).expect(201);
    const cookies = res.headers['set-cookie'] ?? [];
    expect(cookies.some((c: string) => c.includes('agent_access') && c.includes('HttpOnly'))).toBe(true);
    expect(cookies.some((c: string) => c.includes('agent_refresh') && c.includes('HttpOnly'))).toBe(true);
    expect(res.body.data.user.email).toBe(email);
  });

  it('密码错误 → 401 统一错误结构', async () => {
    const res = await request(app.getHttpServer()).post('/api/v1/auth/login').set(XRW).send({ email, password: 'wrong-pass' }).expect(401);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
  });

  it('me：带 cookie 200，无 cookie 401', async () => {
    const login = await request(app.getHttpServer()).post('/api/v1/auth/login').set(XRW).send({ email, password }).expect(201);
    const cookie = (login.headers['set-cookie'] as string[]).map((c) => c.split(';')[0]).join('; ');
    const ok = await request(app.getHttpServer()).get('/api/v1/auth/me').set('Cookie', cookie).expect(200);
    expect(ok.body.data.user.email).toBe(email);
    await request(app.getHttpServer()).get('/api/v1/auth/me').expect(401);
  });

  it('缺 CSRF 头 → 403', async () => {
    await request(app.getHttpServer()).post('/api/v1/auth/login').send({ email, password }).expect(403);
  });

  it('logout 后 refresh 失效', async () => {
    const login = await request(app.getHttpServer()).post('/api/v1/auth/login').set(XRW).send({ email, password }).expect(201);
    const refresh = (login.headers['set-cookie'] as string[]).find((c) => c.startsWith('agent_refresh='))!.split(';')[0];
    await request(app.getHttpServer()).post('/api/v1/auth/logout').set(XRW).set('Cookie', refresh).expect(201);
    await request(app.getHttpServer()).post('/api/v1/auth/refresh').set(XRW).set('Cookie', refresh).expect(401);
  });
});
```

> 注：POST 默认 201（NestJS），断言用 201。

- [ ] **Step 6: 运行全部测试**

Run: `cd /c/Users/87474/Desktop/agent && pnpm --filter api exec vitest run`
Expected: 全部 PASS（含 auth 单测 9 + e2e 5）。

- [ ] **Step 7: 提交**

```bash
git add -A && git commit -m "feat(api): 认证系统（登录/刷新轮换/登出/me + 登录限流 + CSRF + HttpOnly Cookie）"
```

---

### Task 4: Conversations 模块（含消息读取）

**Files:** `src/modules/conversations/{conversations.dto.ts, conversations.service.ts, conversations.service.spec.ts, conversations.controller.ts, conversations.module.ts}`

- [ ] **Step 1: 写失败单测**

`apps/api/src/modules/conversations/conversations.service.spec.ts`：
```ts
import { describe, it, expect, vi } from 'vitest';
import { ConversationsService } from './conversations.service';

function make() {
  const prisma = {
    conversation: { findMany: vi.fn(), findFirst: vi.fn(), create: vi.fn(), update: vi.fn(), findUnique: vi.fn() },
    message: { findMany: vi.fn() },
  };
  const svc = new ConversationsService(prisma as never);
  return { svc, prisma };
}

describe('ConversationsService', () => {
  it('list 只查询自己的非删除会话，按 updatedAt 倒序', async () => {
    const { svc, prisma } = make();
    prisma.conversation.findMany.mockResolvedValue([]);
    await svc.list('u1');
    expect(prisma.conversation.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { userId: 'u1', deletedAt: null },
      orderBy: { updatedAt: 'desc' },
    }));
  });

  it('create 创建会话并默认标题', async () => {
    const { svc, prisma } = make();
    prisma.conversation.create.mockResolvedValue({ id: 'c1' });
    const r = await svc.create('u1', { title: '测试' });
    expect(prisma.conversation.create).toHaveBeenCalledWith({ data: { userId: 'u1', title: '测试' } });
    expect(r.id).toBe('c1');
  });

  it('getMessages 先校验归属，非本人会话 → NOT_FOUND', async () => {
    const { svc, prisma } = make();
    prisma.conversation.findFirst.mockResolvedValue(null);
    await expect(svc.getMessages('u1', 'c-other')).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(prisma.message.findMany).not.toHaveBeenCalled();
  });

  it('getMessages 按 createdAt 正序返回', async () => {
    const { svc, prisma } = make();
    prisma.conversation.findFirst.mockResolvedValue({ id: 'c1', userId: 'u1' });
    prisma.message.findMany.mockResolvedValue([]);
    await svc.getMessages('u1', 'c1');
    expect(prisma.message.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { conversationId: 'c1' }, orderBy: { createdAt: 'asc' } }));
  });

  it('软删除：先校验归属再置 deletedAt', async () => {
    const { svc, prisma } = make();
    prisma.conversation.findFirst.mockResolvedValue(null);
    await expect(svc.softDelete('u1', 'c-other')).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});
```

- [ ] **Step 2: 运行确认失败 → Step 3: 实现**

`apps/api/src/modules/conversations/conversations.dto.ts`：
```ts
import { z } from 'zod';

export const CreateConversationDtoSchema = z.object({ title: z.string().min(1).max(100).optional() });
export type CreateConversationDto = z.infer<typeof CreateConversationDtoSchema>;

export const UpdateConversationDtoSchema = z.object({ title: z.string().min(1).max(100) });
export type UpdateConversationDto = z.infer<typeof UpdateConversationDtoSchema>;
```

`apps/api/src/modules/conversations/conversations.service.ts`：
```ts
import { Inject, Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AppError, ErrorCode } from '../../common/errors/app-error';

@Injectable()
export class ConversationsService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  list(userId: string) {
    return this.prisma.conversation.findMany({
      where: { userId, deletedAt: null },
      orderBy: { updatedAt: 'desc' },
      take: 50,
      select: { id: true, title: true, createdAt: true, updatedAt: true },
    });
  }

  create(userId: string, dto: { title?: string }) {
    return this.prisma.conversation.create({
      data: { userId, title: dto.title ?? '新对话' },
      select: { id: true, title: true, createdAt: true, updatedAt: true },
    });
  }

  async get(userId: string, id: string) {
    const c = await this.requireOwned(userId, id);
    return c;
  }

  async rename(userId: string, id: string, title: string) {
    await this.requireOwned(userId, id);
    return this.prisma.conversation.update({ where: { id }, data: { title } });
  }

  async softDelete(userId: string, id: string) {
    await this.requireOwned(userId, id);
    await this.prisma.conversation.update({ where: { id }, data: { deletedAt: new Date() } });
  }

  async getMessages(userId: string, conversationId: string) {
    await this.requireOwned(userId, conversationId);
    return this.prisma.message.findMany({
      where: { conversationId },
      orderBy: { createdAt: 'asc' },
      take: 200,
      select: { id: true, conversationId: true, role: true, content: true, status: true, errorCode: true, createdAt: true },
    });
  }

  /** 归属校验：非本人 → 404（防枚举） */
  private async requireOwned(userId: string, id: string) {
    const c = await this.prisma.conversation.findFirst({ where: { id, userId, deletedAt: null } });
    if (!c) throw new AppError(ErrorCode.NOT_FOUND, '对话不存在');
    return c;
  }
}
```

`apps/api/src/modules/conversations/conversations.controller.ts`：
```ts
import { Body, Controller, Delete, Get, Param, Patch, Post, Req, UseGuards, UsePipes } from '@nestjs/common';
import { ConversationsService } from './conversations.service';
import { CreateConversationDtoSchema, UpdateConversationDtoSchema } from './conversations.dto';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { AuthedUser } from '../auth/jwt-auth.guard';

@Controller('conversations')
@UseGuards(JwtAuthGuard)
export class ConversationsController {
  constructor(private readonly conversations: ConversationsService) {}

  @Get()
  list(@Req() req: Request & { user: AuthedUser }) { return this.conversations.list(req.user.userId); }

  @Post()
  @UsePipes(new ZodValidationPipe(CreateConversationDtoSchema))
  create(@Req() req: Request & { user: AuthedUser }, @Body() dto: { title?: string }) {
    return this.conversations.create(req.user.userId, dto);
  }

  @Get(':id')
  get(@Req() req: Request & { user: AuthedUser }, @Param('id') id: string) { return this.conversations.get(req.user.userId, id); }

  @Patch(':id')
  @UsePipes(new ZodValidationPipe(UpdateConversationDtoSchema))
  rename(@Req() req: Request & { user: AuthedUser }, @Param('id') id: string, @Body() dto: { title: string }) {
    return this.conversations.rename(req.user.userId, id, dto.title);
  }

  @Delete(':id')
  remove(@Req() req: Request & { user: AuthedUser }, @Param('id') id: string) { return this.conversations.softDelete(req.user.userId, id); }

  @Get(':id/messages')
  messages(@Req() req: Request & { user: AuthedUser }, @Param('id') id: string) { return this.conversations.getMessages(req.user.userId, id); }
}
```

`apps/api/src/modules/conversations/conversations.module.ts`：
```ts
import { Module } from '@nestjs/common';
import { ConversationsService } from './conversations.service';
import { ConversationsController } from './conversations.controller';

@Module({ controllers: [ConversationsController], providers: [ConversationsService], exports: [ConversationsService] })
export class ConversationsModule {}
```

`src/app.module.ts` imports 增加 `ConversationsModule`。

- [ ] **Step 4: 运行测试并提交**

Run: `cd /c/Users/87474/Desktop/agent && pnpm --filter api exec vitest run`
Expected: 全部 PASS。

```bash
git add -A && git commit -m "feat(api): Conversations 模块（CRUD+软删除+消息读取，归属校验防越权）"
```

---

### Task 5: Chat 模块（SSE 流式核心 + usage + 日志）

**Files:** `src/modules/chat/{chat.dto.ts, sse-writer.ts, sse-writer.spec.ts, chat.service.ts, chat.service.spec.ts, chat.controller.ts, chat.module.ts}`、`src/modules/usage/{usage.service.ts, usage.module.ts}`、`src/providers/llm/model-resolver.service.ts`、`src/providers/llm/adapters/mock.adapter.ts`（改）、`src/agents/agent.types.ts`（改）、`src/agents/chat/chat.agent.ts`（改）、`test/chat.e2e-spec.ts`

- [ ] **Step 1: 先改基础件（Agent signal / mock 延迟 / 默认模型解析）**

`src/agents/agent.types.ts` 的 AgentContext 增加：`signal?: AbortSignal;`

`src/agents/chat/chat.agent.ts`：
- execute 内 `adapter.stream({ model, messages, temperature: 0.7, signal: ctx.signal })`
- 收集 usage：循环中 `if (chunk.type === 'usage') usage = chunk.usage;`
- 结尾 `yield { type: 'done', messageId: ctx.messageId, usage }`

`src/providers/llm/adapters/mock.adapter.ts`：
```ts
export class MockLLMAdapter implements LLMProvider {
  readonly kind = 'llm' as const;
  constructor(private readonly chunkDelayMs = 20) {}

  async chat(params: ChatParams): Promise<ChatResponse> { ...同前... }

  async *stream(params: ChatParams): AsyncIterable<LLMChunk> {
    const text = this.reply(params);
    for (const ch of text) {
      if (params.signal?.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
      yield { type: 'text', text: ch };
      if (this.chunkDelayMs > 0) await new Promise((r) => setTimeout(r, this.chunkDelayMs));
    }
  }
  ...reply 同前...
}
```

`src/providers/llm/llm-manager.service.ts` 的 buildAdapter：`case 'mock': return new MockLLMAdapter(Number(process.env.MOCK_DELAY_MS ?? 20));`

`src/providers/llm/model-resolver.service.ts`（新）：
```ts
import { Inject, Injectable } from '@nestjs/common';
import { PrismaService } from '../../modules/prisma/prisma.service';
import { AppError, ErrorCode } from '../../common/errors/app-error';
import { LLMManagerService, ResolvedLLM } from './llm-manager.service';

@Injectable()
export class ModelResolverService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(LLMManagerService) private readonly llmManager: LLMManagerService,
  ) {}

  /** 默认 LLM 解析：routingPolicy.defaults.llm → isDefault → priority 最小；永不写死模型名 */
  async resolveDefaultLLM(): Promise<ResolvedLLM> {
    const settings = await this.prisma.systemSetting.findUnique({ where: { key: 'routingPolicy' } });
    const defaults = (settings?.value as { defaults?: Record<string, string | null> } | null)?.defaults;
    let modelId = defaults?.llm ?? null;
    if (!modelId) {
      const fallback = await this.prisma.model.findFirst({
        where: { type: 'llm', enabled: true },
        orderBy: [{ isDefault: 'desc' }, { priority: 'asc' }],
      });
      modelId = fallback?.id ?? null;
    }
    if (!modelId) throw new AppError(ErrorCode.PROVIDER_UNKNOWN, '没有可用的 LLM 模型，请在后台配置');
    return this.llmManager.resolve(modelId);
  }
}
```

`src/providers/providers.module.ts` providers/exports 增加 `ModelResolverService`。

- [ ] **Step 2: SSEWriter 测试（先写）**

`apps/api/src/modules/chat/sse-writer.spec.ts`：
```ts
import { describe, it, expect } from 'vitest';
import { SSEWriter, SSESink } from './sse-writer';

class FakeSink implements SSESink {
  chunks: string[] = [];
  ended = false;
  writeHead(headers: Record<string, string>) { this.chunks.push(`HEAD ${JSON.stringify(headers)}`); }
  write(s: string) { this.chunks.push(s); }
  flushHeaders() {}
  end() { this.ended = true; }
}

describe('SSEWriter', () => {
  it('init 写 SSE 响应头', () => {
    const sink = new FakeSink();
    const w = new SSEWriter(sink as never);
    w.init();
    expect(sink.chunks[0]).toContain('text/event-stream');
  });

  it('event 序列化为 event:/data: 双行 + 空行', () => {
    const sink = new FakeSink();
    const w = new SSEWriter(sink as never);
    w.event('message_delta', { delta: '你' });
    expect(sink.chunks.join('')).toBe('event: message_delta\ndata: {"delta":"你"}\n\n');
  });

  it('ping 为注释帧', () => {
    const sink = new FakeSink();
    const w = new SSEWriter(sink as never);
    w.ping();
    expect(sink.chunks.join('')).toBe(': ping\n\n');
  });

  it('end 关闭流', () => {
    const sink = new FakeSink();
    const w = new SSEWriter(sink as never);
    w.end();
    expect(sink.ended).toBe(true);
  });
});
```

- [ ] **Step 3: chat.service 测试（先写）**

`apps/api/src/modules/chat/chat.service.spec.ts`：
```ts
import { describe, it, expect, vi } from 'vitest';
import { ChatService, ChatRunContext } from './chat.service';
import { SSESink } from './sse-writer';
import { AgentEvent } from '@ai-agent/shared';

function makeChat(over: { agentEvents?: () => AsyncIterable<AgentEvent> } = {}) {
  const prisma = {
    conversation: {
      findFirst: vi.fn().mockResolvedValue({ id: 'c1', userId: 'u1', title: '旧标题' }),
      create: vi.fn().mockResolvedValue({ id: 'c-new', userId: 'u1', title: '新对话' }),
      update: vi.fn(),
    },
    message: {
      create: vi.fn().mockImplementation(({ data }) => Promise.resolve({ id: 'm-' + data.role, ...data })),
      findMany: vi.fn().mockResolvedValue([]),
      update: vi.fn(),
    },
    systemSetting: { findUnique: vi.fn().mockResolvedValue({ key: 'routingPolicy', value: { confidenceThreshold: 0.7, routerModelId: null } }) },
  };
  const kv = {
    get: vi.fn().mockResolvedValue('0'), incr: vi.fn(), set: vi.fn(),
    setNX: vi.fn().mockResolvedValue(true), del: vi.fn(),
  };
  const router = { classify: vi.fn().mockResolvedValue({ type: 'chat', confidence: 1, parameters: { prompt: 'x' } }) };
  const resolved = { providerId: 'p1', providerName: 'Mock', modelId: 'm1', apiModelId: 'mock-echo', timeoutMs: 1000, adapter: {} };
  const modelResolver = { resolveDefaultLLM: vi.fn().mockResolvedValue(resolved) };
  const usage = { recordChatUsage: vi.fn().mockResolvedValue(undefined) };
  const events = over.agentEvents ?? (async function* () {
    yield { type: 'status', stage: 'llm', message: '正在生成回答…' };
    yield { type: 'text.delta', text: '你好' };
    yield { type: 'done', messageId: 'm-assistant' };
  });
  const agentFactory = vi.fn(() => ({ id: 'chat', execute: () => events() }));
  const svc = new ChatService(prisma as never, kv as never, router as never, modelResolver as never, usage as never, agentFactory as never);
  return { svc, prisma, kv, usage, agentFactory };
}

function fakeSink(): SSESink & { frames: Array<[string, string]> } {
  const frames: Array<[string, string]> = [];
  return {
    writeHead: () => undefined, flushHeaders: () => undefined,
    write: (s: string) => {
      // 简单解析回帧（不依赖 SSEWriter 实现细节）
      void s;
    },
    end: () => undefined,
    frames,
  };
}

describe('ChatService.prepareChat', () => {
  it('conversationId 为空 → 自动创建会话', async () => {
    const { svc, prisma } = makeChat();
    await svc.prepareChat('u1', { conversationId: null, message: '你好' }, 'req1');
    expect(prisma.conversation.create).toHaveBeenCalled();
    expect(prisma.message.create).toHaveBeenCalledTimes(2); // user + assistant
  });

  it('锁被占用 → CONCURRENT_CHAT', async () => {
    const { svc, kv } = makeChat();
    kv.setNX.mockResolvedValue(false);
    await expect(svc.prepareChat('u1', { conversationId: 'c1', message: 'hi' }, 'req1'))
      .rejects.toMatchObject({ code: 'CONCURRENT_CHAT' });
  });

  it('非本人会话 → NOT_FOUND', async () => {
    const { svc, prisma } = makeChat();
    prisma.conversation.findFirst.mockResolvedValue(null);
    await expect(svc.prepareChat('u2', { conversationId: 'c1', message: 'hi' }, 'req1'))
      .rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('首条消息自动生成标题', async () => {
    const { svc, prisma } = makeChat();
    prisma.conversation.findFirst.mockResolvedValue({ id: 'c1', userId: 'u1', title: '新对话' });
    await svc.prepareChat('u1', { conversationId: 'c1', message: '帮我写个标题很长很长很长很长很长' }, 'req1');
    expect(prisma.conversation.update).toHaveBeenCalledWith({ where: { id: 'c1' }, data: { title: expect.any(String) } });
  });
});

describe('ChatService.streamChat', () => {
  const baseCtx = () => ({
    conversation: { id: 'c1' }, userMessage: { id: 'm-user' }, assistantMessage: { id: 'm-assistant' },
    intent: { type: 'chat', confidence: 1, parameters: { prompt: 'x' } }, resolved: {
      providerId: 'p1', providerName: 'Mock', modelId: 'm1', apiModelId: 'mock-echo', timeoutMs: 1000, adapter: {},
    }, history: [], lockKey: 'chat:lock:c1', startedAt: Date.now(),
  });

  function collectFrames(): { sink: ReturnType<typeof fakeSink>; events: Array<{ event: string; data: unknown }> } {
    const events: Array<{ event: string; data: unknown }> = [];
    const sink = {
      writeHead: () => undefined, flushHeaders: () => undefined,
      write: (s: string) => {
        const [eventLine, dataLine] = s.split('\n').filter(Boolean);
        if (eventLine?.startsWith('event:')) events.push({ event: eventLine.slice(6).trim(), data: dataLine ? JSON.parse(dataLine.slice(5).trim()) : null });
      },
      end: () => undefined,
    } as unknown as SSESink;
    return { sink, events };
  }

  it('正常流：message_start → status → message_delta → message_end(completed)，内容持久化', async () => {
    const { svc, prisma, kv, usage } = makeChat();
    const { sink, events } = collectFrames();
    await svc.streamChat(baseCtx() as never, sink, new AbortController().signal, 'req1');
    const types = events.map((e) => e.event);
    expect(types).toEqual(['message_start', 'status', 'message_delta', 'message_end']);
    expect(events.at(-1)!.data).toMatchObject({ status: 'completed', messageId: 'm-assistant' });
    expect(prisma.message.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'm-assistant' },
      data: expect.objectContaining({ content: '你好', status: 'completed' }),
    }));
    expect(kv.del).toHaveBeenCalledWith('chat:lock:c1');
    expect(usage.recordChatUsage).toHaveBeenCalled();
  });

  it('agent 出错：error + message_end(failed)，DB 状态 failed', async () => {
    const { svc, prisma } = makeChat({
      agentEvents: async function* () {
        yield { type: 'text.delta', text: '部分内容' };
        yield { type: 'error', code: 'PROVIDER_TIMEOUT', message: '超时' };
      },
    });
    const { sink, events } = collectFrames();
    await svc.streamChat(baseCtx() as never, sink, new AbortController().signal, 'req1');
    expect(events.map((e) => e.event)).toEqual(['message_start', 'message_delta', 'error', 'message_end']);
    expect(events.at(-1)!.data).toMatchObject({ status: 'failed' });
    expect(prisma.message.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ content: '部分内容', status: 'failed', errorCode: 'PROVIDER_TIMEOUT' }),
    }));
  });

  it('用户中止：不写 error，DB 状态 cancelled 保留部分内容', async () => {
    const { svc, prisma } = makeChat({
      agentEvents: async function* () {
        yield { type: 'text.delta', text: '部分' };
        throw Object.assign(new Error('aborted'), { name: 'AbortError' });
      },
    });
    const { sink } = collectFrames();
    await svc.streamChat(baseCtx() as never, sink, new AbortController().signal, 'req1');
    expect(prisma.message.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ content: '部分', status: 'cancelled' }),
    }));
  });
});
```

- [ ] **Step 4: 运行确认失败 → Step 5: 实现**

`apps/api/src/modules/chat/chat.dto.ts`：
```ts
import { z } from 'zod';

export const ChatDtoSchema = z.object({
  conversationId: z.string().uuid().nullable().optional(),
  message: z.string().min(1, '消息不能为空').max(20000),
});
export type ChatDto = z.infer<typeof ChatDtoSchema>;
```

`apps/api/src/modules/chat/sse-writer.ts`：
```ts
/** SSE 输出端最小接口（Express Response / 测试 fake） */
export interface SSESink {
  writeHead(code: number, headers: Record<string, string>): void;
  flushHeaders(): void;
  write(chunk: string): void;
  end(): void;
}

export class SSEWriter {
  constructor(private readonly sink: SSESink) {}

  init(): void {
    this.sink.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    this.sink.flushHeaders();
  }

  event(name: string, data: unknown): void {
    this.sink.write(`event: ${name}\n`);
    this.sink.write(`data: ${JSON.stringify(data)}\n\n`);
  }

  ping(): void { this.sink.write(': ping\n\n'); }

  end(): void { this.sink.end(); }
}
```

`apps/api/src/modules/usage/usage.service.ts`：
```ts
import { Inject, Injectable } from '@nestjs/common';
import { UsageKind, UsageStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

export interface ChatUsageInput {
  userId: string; conversationId: string; messageId: string;
  providerId: string; modelId: string;
  inputTokens: number; outputTokens: number;
  latencyMs: number; status: 'success' | 'failed'; errorCode?: string;
}

@Injectable()
export class UsageService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  /** 记录 LLM 调用用量并按后台配置价格估算成本（M5 后台可改单价） */
  async recordChatUsage(input: ChatUsageInput): Promise<void> {
    const model = await this.prisma.model.findUnique({ where: { id: input.modelId } });
    const estimatedCost = model
      ? (input.inputTokens * model.inputPrice + input.outputTokens * model.outputPrice) / 1_000_000
      : 0;
    await this.prisma.usageRecord.create({
      data: {
        userId: input.userId, conversationId: input.conversationId, messageId: input.messageId,
        providerId: input.providerId, modelId: input.modelId,
        kind: UsageKind.llm_chat,
        inputTokens: input.inputTokens, outputTokens: input.outputTokens,
        latencyMs: input.latencyMs, estimatedCost,
        status: input.status === 'success' ? UsageStatus.success : UsageStatus.failed,
        errorCode: input.errorCode,
      },
    });
  }
}
```

`apps/api/src/modules/usage/usage.module.ts`：
```ts
import { Global, Module } from '@nestjs/common';
import { UsageService } from './usage.service';

@Global()
@Module({ providers: [UsageService], exports: [UsageService] })
export class UsageModule {}
```

`apps/api/src/modules/chat/chat.service.ts`：
```ts
import { Inject, Injectable, Logger } from '@nestjs/common';
import { AgentEvent, AppError, ErrorCode, TaskIntent } from '@ai-agent/shared';
import { PrismaService } from '../prisma/prisma.service';
import { RedisKVService } from '../../core/circuit-breaker/redis-kv.service';
import { RouterService } from '../../core/router/router.service';
import { ModelResolverService, } from '../../providers/llm/model-resolver.service';
import { ResolvedLLM } from '../../providers/llm/llm-manager.service';
import { ChatMessage } from '../../providers/llm/llm.types';
import { ChatAgent } from '../../agents/chat/chat.agent';
import { Agent } from '../../agents/agent.types';
import { UsageService } from '../usage/usage.service';
import { ChatDto } from './chat.dto';
import { SSESink } from './sse-writer';

export interface ChatRunContext {
  conversationId: string; userMessageId: string; assistantMessageId: string;
  userMessage: string; history: ChatMessage[]; intent: TaskIntent;
  resolved: ResolvedLLM; lockKey: string; startedAt: number; userId: string;
}

type AgentFactory = (ctx: { resolved: ResolvedLLM }) => Agent;

@Injectable()
export class ChatService {
  private readonly logger = new Logger('Chat');

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(RedisKVService) private readonly kv: RedisKVService,
    @Inject(RouterService) private readonly router: RouterService,
    @Inject(ModelResolverService) private readonly modelResolver: ModelResolverService,
    @Inject(UsageService) private readonly usage: UsageService,
    @Inject('CHAT_AGENT_FACTORY') private readonly agentFactory: AgentFactory,
  ) {}

  /** 第一步（HTTP 阶段，出错返回正常 JSON 错误）：会话/消息/锁/路由/模型 */
  async prepareChat(userId: string, dto: ChatDto, requestId: string): Promise<ChatRunContext> {
    const startedAt = Date.now();
    const conversation = dto.conversationId
      ? await this.requireConversation(userId, dto.conversationId)
      : await this.prisma.conversation.create({ data: { userId } });

    const lockKey = `chat:lock:${conversation.id}`;
    const locked = await this.kv.setNX(lockKey, requestId, 120);
    if (!locked) throw new AppError(ErrorCode.CONCURRENT_CHAT, '上一条消息仍在生成中，请稍候');

    try {
      const userMessage = await this.prisma.message.create({
        data: { conversationId: conversation.id, userId, role: 'user', content: dto.message },
      });
      if (conversation.title === '新对话') {
        await this.prisma.conversation.update({ where: { id: conversation.id }, data: { title: dto.message.slice(0, 30) } });
      }
      const assistantMessage = await this.prisma.message.create({
        data: { conversationId: conversation.id, userId, role: 'assistant', content: '', status: 'streaming' },
      });
      const history = await this.buildHistory(conversation.id, userMessage.id);
      const intent = await this.router.classify({ userMessage: dto.message, attachments: [], history: history.slice(-2) });
      const resolved = await this.modelResolver.resolveDefaultLLM();
      // 落库意图可观测（M4 后台看分类命中率）
      await this.prisma.message.update({ where: { id: userMessage.id }, data: { intentType: intent.type as never, intentConfidence: intent.confidence } });
      return {
        conversationId: conversation.id, userMessageId: userMessage.id, assistantMessageId: assistantMessage.id,
        userMessage: dto.message, history, intent, resolved, lockKey, startedAt, userId,
      };
    } catch (err) {
      await this.kv.del(lockKey).catch(() => undefined);
      throw err;
    }
  }

  /** 第二步（SSE 阶段）：Agent 事件流 → 线上协议；终态必落库 */
  async streamChat(ctx: ChatRunContext, sink: SSESink, signal: AbortSignal, requestId: string): Promise<void> {
    let buffer = '';
    let usage: { inputTokens: number; outputTokens: number } | undefined;
    let finalStatus: 'completed' | 'failed' | 'cancelled' = 'completed';
    let errorCode: string | undefined;
    const emit = (event: string, data: Record<string, unknown>) => {
      try { sink.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); } catch { /* 客户端已断开 */ }
    };

    try {
      emit('message_start', { type: 'message_start', messageId: ctx.assistantMessageId, conversationId: ctx.conversationId, role: 'assistant', createdAt: new Date().toISOString() });
      const agent = this.agentFactory({ resolved: ctx.resolved });
      const events = agent.execute({
        userId: ctx.userId, conversationId: ctx.conversationId, messageId: ctx.assistantMessageId,
        userMessage: ctx.userMessage, attachments: [], history: ctx.history, intent: ctx.intent,
        mode: 'normal', signal,
      });
      for await (const ev of events) {
        switch (ev.type) {
          case 'status': emit('status', ev); break;
          case 'text.delta': buffer += ev.text; emit('message_delta', { type: 'message_delta', delta: ev.text }); break;
          case 'task.created': emit('task.created', ev); break;
          case 'done':
            usage = (ev as { usage?: { inputTokens: number; outputTokens: number } }).usage;
            finalStatus = 'completed';
            emit('message_end', { type: 'message_end', messageId: ctx.assistantMessageId, status: 'completed' });
            break;
          case 'error':
            errorCode = ev.code; finalStatus = 'failed';
            emit('error', { type: 'error', code: ev.code, message: ev.message, requestId });
            emit('message_end', { type: 'message_end', messageId: ctx.assistantMessageId, status: 'failed' });
            break;
        }
      }
    } catch (err) {
      if (signal.aborted || (err as { name?: string }).name === 'AbortError') {
        finalStatus = 'cancelled'; // 用户主动停止
      } else {
        const appErr = err instanceof AppError ? err : new AppError(ErrorCode.PROVIDER_UNKNOWN, (err as Error).message);
        errorCode = appErr.code; finalStatus = 'failed';
        emit('error', { type: 'error', code: appErr.code, message: appErr.message, requestId });
        emit('message_end', { type: 'message_end', messageId: ctx.assistantMessageId, status: 'failed' });
      }
    } finally {
      await this.finalize(ctx, buffer, finalStatus, errorCode, usage, requestId);
      await this.kv.del(ctx.lockKey).catch(() => undefined);
    }
  }

  private async finalize(ctx: ChatRunContext, content: string, status: 'completed' | 'failed' | 'cancelled', errorCode: string | undefined, usage: { inputTokens: number; outputTokens: number } | undefined, requestId: string) {
    const latencyMs = Date.now() - ctx.startedAt;
    await this.prisma.message.update({
      where: { id: ctx.assistantMessageId },
      data: { content, status, errorCode, tokenUsage: usage ?? undefined },
    }).catch((err) => this.logger.error(`消息落库失败: ${(err as Error).message}`));
    await this.usage.recordChatUsage({
      userId: ctx.userId, conversationId: ctx.conversationId, messageId: ctx.assistantMessageId,
      providerId: ctx.resolved.providerId, modelId: ctx.resolved.modelId,
      inputTokens: usage?.inputTokens ?? 0, outputTokens: usage?.outputTokens ?? 0,
      latencyMs, status: status === 'completed' ? 'success' : 'failed', errorCode,
    }).catch((err) => this.logger.error(`用量记录失败: ${(err as Error).message}`));
    // 结构化日志（M5 统计：成本/成功率/latency/provider 健康）
    this.logger.log({
      requestId, userId: ctx.userId, conversationId: ctx.conversationId, messageId: ctx.assistantMessageId,
      provider: ctx.resolved.providerName, model: ctx.resolved.apiModelId, intentType: ctx.intent.type,
      latencyMs, status, errorCode, tokens: usage,
    }, 'chat 完成');
  }

  private async requireConversation(userId: string, id: string) {
    const c = await this.prisma.conversation.findFirst({ where: { id, userId, deletedAt: null } });
    if (!c) throw new AppError(ErrorCode.NOT_FOUND, '对话不存在');
    return c;
  }

  /** 最近 8 条历史（不含本次 user/assistant 两条，按时间正序） */
  private async buildHistory(conversationId: string, currentUserMessageId: string): Promise<ChatMessage[]> {
    const rows = await this.prisma.message.findMany({
      where: { conversationId, id: { not: currentUserMessageId } },
      orderBy: { createdAt: 'desc' }, take: 8,
      select: { role: true, content: true, id: true },
    });
    return rows.reverse().map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content }));
  }
}
```

`apps/api/src/modules/chat/chat.controller.ts`：
```ts
import { Body, Controller, Post, Req, Res, UseGuards, UsePipes } from '@nestjs/common';
import { Request, Response } from 'express';
import { ChatService } from './chat.service';
import { ChatDtoSchema } from './chat.dto';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import { JwtAuthGuard, AuthedUser } from '../auth/jwt-auth.guard';
import { SSEWriter } from './sse-writer';

@Controller('chat')
@UseGuards(JwtAuthGuard)
export class ChatController {
  constructor(private readonly chat: ChatService) {}

  @Post()
  @UsePipes(new ZodValidationPipe(ChatDtoSchema))
  async chat(@Req() req: Request & { user: AuthedUser; id?: string }, @Res() res: Response, @Body() dto: { conversationId?: string | null; message: string }) {
    const requestId = req.id ?? 'req';
    // 锁/会话/消息在 SSE 开始前完成——此阶段错误走统一 JSON envelope
    const ctx = await this.chat.prepareChat(req.user.userId, dto, requestId);
    const sse = new SSEWriter(res as never);
    sse.init();
    const abort = new AbortController();
    const heartbeat = setInterval(() => sse.ping(), 15000);
    const onClose = () => abort.abort();
    req.on('close', onClose);
    try {
      await this.chat.streamChat(ctx, res as never, abort.signal, requestId);
    } finally {
      clearInterval(heartbeat);
      req.off('close', onClose);
      sse.end();
    }
  }
}
```

> 注：ChatService.streamChat 的 sink 参数直接用 Express Response（write 方法签名兼容 SSESink）。CHAT_AGENT_FACTORY 在 chat.module 中提供：
```ts
@Module({
  controllers: [ChatController],
  providers: [
    ChatService,
    {
      provide: 'CHAT_AGENT_FACTORY',
      useFactory: (llmManager: LLMManagerService) => ({
        create: (resolved: ResolvedLLM) => new ChatAgent({ llmManager }, { resolveLLM: async () => ({ adapter: resolved.adapter, apiModelId: resolved.apiModelId }) }),
      }),
      inject: [LLMManagerService],
    },
  ],
})
export class ChatModule {}
```
（AgentFactory 类型在 service 中相应调整为 `{ create(ctx): Agent }`——单测注入 `create: () => agent`。）

`src/app.module.ts` imports 增加 `ChatModule, UsageModule`。

- [ ] **Step 6: e2e**

`apps/api/test/chat.e2e-spec.ts`：
```ts
import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import cookieParser from 'cookie-parser';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { AppModule } from '../src/app.module';
import { GlobalExceptionFilter } from '../src/common/filters/global-exception.filter';
import { csrfProtection } from '../src/modules/auth/csrf.middleware';

const XRW = { 'X-Requested-With': 'XMLHttpRequest' };

describe('Chat (e2e, Mock Provider 全链路)', () => {
  let app: INestApplication;
  let cookie: string;
  const email = process.env.SEED_ADMIN_EMAIL ?? 'admin@example.com';
  const password = process.env.SEED_ADMIN_PASSWORD ?? 'admin123456';

  beforeAll(async () => {
    process.env.MOCK_DELAY_MS = '0'; // e2e 不等待分块延迟
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.use(cookieParser());
    app.use('/api/v1', csrfProtection);
    app.setGlobalPrefix('api/v1');
    app.useGlobalFilters(moduleRef.get(GlobalExceptionFilter));
    await app.init();
    const login = await request(app.getHttpServer()).post('/api/v1/auth/login').set(XRW).send({ email, password });
    cookie = (login.headers['set-cookie'] as string[]).map((c) => c.split(';')[0]).join('; ');
  });

  afterAll(async () => { await app.close(); });

  it('未登录 POST /chat → 401', async () => {
    await request(app.getHttpServer()).post('/api/v1/chat').set(XRW).send({ message: 'hi' }).expect(401);
  });

  it('SSE 全链路：message_start → status → message_delta → message_end(completed)', async () => {
    const res = await request(app.getHttpServer()).post('/api/v1/chat').set(XRW).set('Cookie', cookie)
      .send({ message: '你好，介绍一下你自己' })
      .buffer(true).parse((r, cb) => { let s = ''; r.on('data', (c) => (s += c)); r.on('end', () => cb(null, s)); })
      .expect(200);
    const text = res.body as string;
    expect(res.headers['content-type']).toContain('text/event-stream');
    expect(text).toContain('event: message_start');
    expect(text).toContain('event: message_delta');
    expect(text).toContain('event: message_end');
    expect(text).toContain('"status":"completed"');
    expect(text).toContain('mock'); // Mock 回复内容流式出现
  });

  it('消息完整持久化：conversations + messages 落库', async () => {
    const list = await request(app.getHttpServer()).get('/api/v1/conversations').set('Cookie', cookie).expect(200);
    expect(list.body.data.length).toBeGreaterThanOrEqual(1);
    const convId = list.body.data[0].id;
    const msgs = await request(app.getHttpServer()).get(`/api/v1/conversations/${convId}/messages`).set('Cookie', cookie).expect(200);
    const roles = msgs.body.data.map((m: { role: string }) => m.role);
    expect(roles[0]).toBe('user');
    expect(roles[1]).toBe('assistant');
    const assistant = msgs.body.data[1];
    expect(assistant.status).toBe('completed');
    expect(assistant.content).toContain('mock');
  });

  it('非法参数：空消息 → 400 VALIDATION_ERROR', async () => {
    const res = await request(app.getHttpServer()).post('/api/v1/chat').set(XRW).set('Cookie', cookie).send({ message: '' }).expect(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });
});
```

- [ ] **Step 7: 全量测试 + 提交**

Run: `cd /c/Users/87474/Desktop/agent && pnpm --filter api exec vitest run && pnpm --filter api typecheck`
Expected: 全部 PASS、零类型错误。

```bash
git add -A && git commit -m "feat(api): Chat 模块（SSE 流式/会话锁/默认模型解析/事务终态/用量记录/结构化日志）"
```

---

### Task 6: Web 基础设施（依赖/api client/SSE 解析/UI 组件/登录页）

- [ ] **Step 1: 安装依赖**

Run: `cd /c/Users/87474/Desktop/agent && pnpm --filter web add react-markdown remark-gfm rehype-highlight highlight.js @tanstack/react-query class-variance-authority clsx tailwind-merge lucide-react`

- [ ] **Step 2: 基础库**

`apps/web/lib/utils.ts`：
```ts
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';
export function cn(...inputs: ClassValue[]) { return twMerge(clsx(inputs)); }
```

`apps/web/lib/api.ts`：
```ts
export class ApiError extends Error {
  constructor(readonly code: string, message: string, readonly requestId?: string) { super(message); this.name = 'ApiError'; }
}

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';
const XRW = { 'X-Requested-With': 'XMLHttpRequest' };

let refreshing: Promise<boolean> | null = null;

/** 统一 API 客户端：cookie 凭据 + CSRF 头 + 401 自动刷新重试 + 错误归一化 */
export async function apiFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  const doFetch = () => fetch(`${API_BASE}${path}`, {
    ...init,
    credentials: 'include',
    headers: { ...XRW, ...(init.body ? { 'Content-Type': 'application/json' } : {}), ...init.headers },
  });

  let res = await doFetch();
  if (res.status === 401 && !path.startsWith('/auth/')) {
    refreshing ??= fetch(`${API_BASE}/api/v1/auth/refresh`, { method: 'POST', credentials: 'include', headers: XRW })
      .then((r) => r.ok).finally(() => { refreshing = null; });
    if (await refreshing) res = await doFetch();
  }
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new ApiError(body?.error?.code ?? 'INTERNAL', body?.error?.message ?? '请求失败', body?.error?.requestId);
  }
  return res.json() as Promise<T>;
}

export { API_BASE };
```

`apps/web/lib/sse.ts`：
```ts
export type SSEHandler = (event: string, data: string) => void;

/** fetch ReadableStream → SSE 事件流（POST+SSE 用 fetch 而非 EventSource） */
export async function consumeSSE(body: ReadableStream<Uint8Array>, onEvent: SSEHandler): Promise<void> {
  const decoder = new TextDecoder();
  let buf = '';
  for await (const chunk of readChunks(body)) {
    buf += decoder.decode(chunk, { stream: true });
    let idx: number;
    while ((idx = buf.indexOf('\n\n')) >= 0) {
      const frame = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      let event = 'message';
      const dataLines: string[] = [];
      for (const line of frame.split('\n')) {
        if (line.startsWith('event:')) event = line.slice(6).trim();
        else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
      }
      if (dataLines.length) onEvent(event, dataLines.join('\n'));
    }
  }
}

async function* readChunks(stream: ReadableStream<Uint8Array>): AsyncGenerator<Uint8Array> {
  const reader = stream.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      yield value;
    }
  } finally { reader.releaseLock(); }
}
```

- [ ] **Step 3: shadcn 风格组件（3 个）**

`apps/web/components/ui/button.tsx`：
```tsx
import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/utils';

const buttonVariants = cva(
  'inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-lg text-sm font-medium transition-colors focus-visible:outline-none disabled:pointer-events-none disabled:opacity-50 [&_svg]:size-4 [&_svg]:shrink-0',
  {
    variants: {
      variant: {
        default: 'bg-zinc-100 text-zinc-900 hover:bg-zinc-200',
        ghost: 'text-zinc-300 hover:bg-zinc-800 hover:text-zinc-100',
        outline: 'border border-zinc-700 bg-transparent hover:bg-zinc-800 hover:text-zinc-100',
        destructive: 'bg-red-600 text-white hover:bg-red-500',
      },
      size: {
        default: 'h-9 px-4 py-2',
        sm: 'h-8 rounded-md px-3 text-xs',
        icon: 'h-9 w-9',
      },
    },
    defaultVariants: { variant: 'default', size: 'default' },
  },
);

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement>, VariantProps<typeof buttonVariants> {}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(({ className, variant, size, ...props }, ref) => (
  <button ref={ref} className={cn(buttonVariants({ variant, size }), className)} {...props} />
));
Button.displayName = 'Button';
export { Button, buttonVariants };
```

`apps/web/components/ui/input.tsx` 与 `textarea.tsx`：同风格（zinc-800 背景、border-zinc-700、focus ring），textarea 带 `rows` 自适应属性透传。

- [ ] **Step 4: Providers + layout + 登录页**

`apps/web/components/providers.tsx`：
```tsx
'use client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useState } from 'react';

export function Providers({ children }: { children: React.ReactNode }) {
  const [client] = useState(() => new QueryClient({ defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false, staleTime: 30_000 } } }));
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}
```

`apps/web/app/layout.tsx`：包一层 `<Providers>`，body 加 `min-h-screen`。

`apps/web/app/login/page.tsx`：
```tsx
'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { apiFetch, ApiError } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const me = useQuery({ queryKey: ['me'], queryFn: () => apiFetch<{ data: { user: unknown } }>('/api/v1/auth/me') });
  if (me.data) router.replace('/chat'); // 已登录直接进入

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(''); setLoading(true);
    try {
      await apiFetch('/api/v1/auth/login', { method: 'POST', body: JSON.stringify({ email, password }) });
      router.replace('/chat');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : '登录失败，请稍后再试');
      setLoading(false);
    }
  };

  return (
    <main className="flex min-h-screen items-center justify-center px-4">
      <form onSubmit={submit} className="w-full max-w-sm space-y-5">
        <div className="text-center">
          <h1 className="text-2xl font-bold">AI Agent 智能创作平台</h1>
          <p className="mt-2 text-sm text-zinc-400">登录以开始与 AI 对话</p>
        </div>
        <Input type="email" placeholder="邮箱" value={email} onChange={(e) => setEmail(e.target.value)} required autoFocus />
        <Input type="password" placeholder="密码" value={password} onChange={(e) => setPassword(e.target.value)} required />
        {error && <p className="text-sm text-red-400">{error}</p>}
        <Button type="submit" disabled={loading} className="w-full">{loading ? '登录中…' : '登录'}</Button>
      </form>
    </main>
  );
}
```

- [ ] **Step 5: 构建验证 + 提交**

Run: `cd /c/Users/87474/Desktop/agent && pnpm --filter web build`
Expected: 构建成功。

```bash
git add -A && git commit -m "feat(web): 基础设施（api client/SSE 解析/shadcn 组件/登录页）"
```

---

### Task 7: 聊天页面（侧边栏 + 流式渲染 + Markdown + 停止/重试/复制）

**Files:** `app/(chat)/layout.tsx`、`app/(chat)/chat/[[id]]/page.tsx`、`app/(chat)/chat/components/{sidebar.tsx, chat-workspace.tsx, chat-input.tsx, message-bubble.tsx, markdown-renderer.tsx}`

- [ ] **Step 1: 布局与路由壳**

`apps/web/app/(chat)/layout.tsx`：
```tsx
'use client';
import { useRouter } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api';
import { useEffect } from 'react';

export default function ChatLayout({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const me = useQuery({ queryKey: ['me'], queryFn: () => apiFetch<{ data: { user: unknown } }>('/api/v1/auth/me') });
  useEffect(() => {
    if (me.isError) router.replace('/login'); // 未登录 → 登录页
  }, [me.isError, router]);
  if (me.isLoading || me.isError) {
    return <div className="flex min-h-screen items-center justify-center text-zinc-500">加载中…</div>;
  }
  return <>{children}</>;
}
```

`apps/web/app/(chat)/chat/[[id]]/page.tsx`：
```tsx
import { ChatWorkspace } from './components/chat-workspace';

export default async function ChatPage({ params }: { params: Promise<{ id?: string[] }> }) {
  const { id } = await params;
  return <ChatWorkspace conversationId={id?.[0]} />;
}
```

- [ ] **Step 2: 类型与状态**

`apps/web/app/(chat)/chat/components/types.ts`：
```ts
export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  status?: 'pending' | 'streaming' | 'completed' | 'failed' | 'cancelled';
  errorCode?: string | null;
  createdAt?: string;
}

export interface ConversationItem { id: string; title: string; updatedAt: string; }

export interface ChatStreamEventMap {
  message_start: { messageId: string; conversationId: string; createdAt: string };
  message_delta: { delta: string };
  message_end: { messageId: string; status: 'completed' | 'stopped' | 'failed' };
  status: { stage: string; message: string };
  error: { code: string; message: string; requestId?: string };
}
```

- [ ] **Step 3: chat-workspace（核心）**

```tsx
'use client';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch, ApiError, API_BASE } from '@/lib/api';
import { consumeSSE } from '@/lib/sse';
import { Sidebar } from './sidebar';
import { ChatInput } from './chat-input';
import { MessageBubble } from './message-bubble';
import { ChatMessage, ChatStreamEventMap } from './types';

export function ChatWorkspace({ conversationId }: { conversationId?: string }) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [thinking, setThinking] = useState('');
  const [streaming, setStreaming] = useState(false);
  const [fatalError, setFatalError] = useState('');
  const abortRef = useRef<AbortController | null>(null);
  const deltaTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const deltaBuf = useRef('');
  const activeIdRef = useRef(conversationId);

  // 历史消息加载
  const history = useQuery({
    queryKey: ['messages', conversationId],
    queryFn: async () => {
      if (!conversationId) return [];
      const res = await apiFetch<{ data: Array<{ id: string; role: 'user' | 'assistant'; content: string; status: string; errorCode: string | null; createdAt: string }> }>(`/api/v1/conversations/${conversationId}/messages`);
      return res.data.map((m) => ({ ...m, status: m.status as ChatMessage['status'] }));
    },
    enabled: !!conversationId,
  });

  useEffect(() => {
    setMessages(history.data ?? []);
    setThinking(''); setFatalError('');
  }, [history.data]);

  const flushDelta = useCallback((targetId: string) => {
    const delta = deltaBuf.current;
    deltaBuf.current = '';
    if (!delta) return;
    setMessages((prev) => prev.map((m) => (m.id === targetId ? { ...m, content: m.content + delta } : m)));
  }, []);

  const appendDelta = useCallback((messageId: string, delta: string) => {
    deltaBuf.current += delta;
    if (deltaTimer.current) clearTimeout(deltaTimer.current);
    deltaTimer.current = setTimeout(() => flushDelta(messageId), 40); // 40ms 节流合并渲染
  }, [flushDelta]);

  const send = useCallback(async (text: string) => {
    if (streaming || !text.trim()) return;
    setFatalError('');
    const tempUser: ChatMessage = { id: `local-${Date.now()}`, role: 'user', content: text, status: 'completed' };
    setMessages((prev) => [...prev, tempUser]);
    setStreaming(true); setThinking('正在分析需求…');
    const ac = new AbortController();
    abortRef.current = ac;
    try {
      const res = await fetch(`${API_BASE}/api/v1/chat`, {
        method: 'POST', credentials: 'include', signal: ac.signal,
        headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
        body: JSON.stringify({ conversationId: activeIdRef.current ?? null, message: text }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new ApiError(body?.error?.code ?? 'INTERNAL', body?.error?.message ?? '生成失败');
      }
      let assistantId: string | null = null;
      await consumeSSE(res.body!, (event, raw) => {
        let data: ChatStreamEventMap[keyof ChatStreamEventMap] | null = null;
        try { data = JSON.parse(raw); } catch { return; }
        switch (event) {
          case 'message_start': {
            const d = data as ChatStreamEventMap['message_start'];
            assistantId = d.messageId;
            if (!activeIdRef.current) {
              activeIdRef.current = d.conversationId;
              router.replace(`/chat/${d.conversationId}`, { scroll: false });
              queryClient.invalidateQueries({ queryKey: ['conversations'] });
            }
            setMessages((prev) => prev.filter((m) => !m.id.startsWith('local-')).concat(
              prev.some((m) => m.id === d.messageId) ? [] :
              [{ id: d.messageId, role: 'assistant', content: '', status: 'streaming' }],
            ));
            break;
          }
          case 'message_delta': {
            const d = data as ChatStreamEventMap['message_delta'];
            if (assistantId) appendDelta(assistantId, d.delta);
            break;
          }
          case 'status': { setThinking((data as ChatStreamEventMap['status']).message); break; }
          case 'message_end': {
            const d = data as ChatStreamEventMap['message_end'];
            flushDelta(d.messageId);
            const status = d.status === 'stopped' ? 'cancelled' : d.status;
            setMessages((prev) => prev.map((m) => (m.id === d.messageId ? { ...m, status } : m)));
            setThinking('');
            break;
          }
          case 'error': {
            const d = data as ChatStreamEventMap['error'];
            setFatalError(d.message);
            if (assistantId) setMessages((prev) => prev.map((m) => (m.id === assistantId ? { ...m, status: 'failed', errorCode: d.code } : m)));
            break;
          }
        }
      });
    } catch (err) {
      if ((err as Error).name === 'AbortError') {
        flushDelta(assistantIdLocal());
        setMessages((prev) => prev.map((m) => (m.status === 'streaming' ? { ...m, status: 'cancelled' } : m)));
      } else {
        setFatalError(err instanceof ApiError ? err.message : '网络错误，请重试');
        setMessages((prev) => prev.map((m) => (m.status === 'streaming' ? { ...m, status: 'failed' } : m)));
      }
    } finally {
      setStreaming(false); setThinking('');
      abortRef.current = null;
      queryClient.invalidateQueries({ queryKey: ['conversations'] });
    }
  }, [streaming, router, queryClient, appendDelta, flushDelta]);

  const stop = useCallback(() => { abortRef.current?.abort(); }, []);

  const retry = useCallback((messageId: string) => {
    const idx = messages.findIndex((m) => m.id === messageId);
    const userMsg = [...messages.slice(0, idx)].reverse().find((m) => m.role === 'user');
    if (userMsg) void send(userMsg.content);
  }, [messages, send]);

  const scrollRef = useRef<HTMLDivElement>(null);
  useEffect(() => { scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight }); }, [messages, thinking]);

  return (
    <div className="flex h-screen">
      <Sidebar activeId={conversationId} onNew={() => { activeIdRef.current = undefined; setMessages([]); setFatalError(''); router.push('/chat'); }} />
      <main className="flex flex-1 flex-col">
        <div ref={scrollRef} className="flex-1 overflow-y-auto">
          <div className="mx-auto max-w-3xl px-4 py-6 space-y-6">
            {messages.length === 0 && (
              <div className="pt-32 text-center">
                <h2 className="text-2xl font-semibold">你好，我是 AI 助手</h2>
                <p className="mt-2 text-zinc-400">可以问我任何问题，或试试："帮我解释一下 React 和 Vue 的区别"</p>
              </div>
            )}
            {messages.map((m) => (
              <MessageBubble key={m.id} message={m} streaming={m.status === 'streaming'} onRetry={() => retry(m.id)} />
            ))}
            {thinking && <p className="text-xs text-zinc-500">💭 {thinking}</p>}
            {fatalError && <p className="text-sm text-red-400">⚠ {fatalError}</p>}
          </div>
        </div>
        <div className="border-t border-zinc-800 p-4">
          <div className="mx-auto max-w-3xl">
            <ChatInput onSend={send} onStop={stop} streaming={streaming} />
          </div>
        </div>
      </main>
    </div>
  );
}
```

- [ ] **Step 4: 其余组件**

`sidebar.tsx`：左侧 260px 栏——顶部「+ 新对话」按钮（onNew）、会话列表（useQuery ['conversations']，选中高亮，悬停显示删除按钮→ DELETE + invalidate）、底部用户信息 + 退出登录（POST /auth/logout → router.replace('/login')）。相对时间用简单格式化（`formatRelative`：刚刚/x 分钟前/x 小时前/日期）。

`chat-input.tsx`：textarea（Enter 发送 / Shift+Enter 换行 / IME 组合中不发送）+ 发送/停止按钮切换：
```tsx
'use client';
import { useRef, useState } from 'react';
import { Send, Square } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';

export function ChatInput({ onSend, onStop, streaming }: { onSend: (t: string) => void; onStop: () => void; streaming: boolean }) {
  const [value, setValue] = useState('');
  const ref = useRef<HTMLTextAreaElement>(null);

  const submit = () => {
    const text = value.trim();
    if (!text || streaming) return;
    onSend(text);
    setValue('');
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      submit();
    }
  };

  return (
    <div className="flex items-end gap-2 rounded-2xl border border-zinc-800 bg-zinc-900 p-2">
      <Textarea
        ref={ref} value={value} placeholder="输入你的问题…（Enter 发送 / Shift+Enter 换行）"
        onChange={(e) => setValue(e.target.value)} onKeyDown={onKeyDown}
        rows={1} className="max-h-40 min-h-[40px] flex-1 resize-none border-0 bg-transparent focus-visible:ring-0"
      />
      {streaming
        ? <Button variant="outline" size="icon" onClick={onStop} title="停止生成"><Square className="fill-current" /></Button>
        : <Button size="icon" onClick={submit} disabled={!value.trim()} title="发送"><Send /></Button>}
    </div>
  );
}
```

`message-bubble.tsx`：用户消息右对齐（bg-zinc-800 圆角气泡）；助手消息左对齐全宽——`<MarkdownRenderer content>`、流式时末尾光标 `▍`（animate-pulse）、failed 显示「生成失败」+ 重试按钮、cancelled 显示「已停止」；右上角复制按钮（Check 反馈 2s）。复制内容取原始 markdown 文本。

`markdown-renderer.tsx`：
```tsx
'use client';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import 'highlight.js/styles/github-dark.css';
import { Check, Copy } from 'lucide-react';
import { useState } from 'react';
import { cn } from '@/lib/utils';

function CodeBlock({ language, code }: { language: string; code: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    await navigator.clipboard.writeText(code);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };
  return (
    <div className="group relative my-3 overflow-hidden rounded-lg border border-zinc-800">
      <div className="flex items-center justify-between bg-zinc-900 px-3 py-1.5 text-xs text-zinc-400">
        <span>{language || 'text'}</span>
        <button onClick={copy} className="flex items-center gap-1 hover:text-zinc-200">
          {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />} {copied ? '已复制' : '复制'}
        </button>
      </div>
      <pre className="overflow-x-auto p-3 text-sm leading-relaxed"><code>{code}</code></pre>
    </div>
  );
}

export function MarkdownRenderer({ content, className }: { content: string; className?: string }) {
  return (
    <div className={cn('prose-invert max-w-none space-y-2 text-[15px] leading-relaxed text-zinc-200', className)}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeHighlight]}
        components={{
          pre: ({ children }) => <>{children}</>, // pre 由 CodeBlock 接管
          code(props) {
            const { children, className: cls, ...rest } = props;
            const match = /language-([\w-]+)/.exec(cls ?? '');
            if (match) return <CodeBlock language={match[1]} code={String(children).replace(/\n$/, '')} />;
            return <code className="rounded bg-zinc-800 px-1.5 py-0.5 text-sm" {...rest}>{children}</code>;
          },
          h1: (p) => <h1 className="mt-4 mb-2 text-xl font-bold" {...p} />,
          h2: (p) => <h2 className="mt-4 mb-2 text-lg font-bold" {...p} />,
          h3: (p) => <h3 className="mt-3 mb-1 text-base font-semibold" {...p} />,
          ul: (p) => <ul className="list-disc space-y-1 pl-5" {...p} />,
          ol: (p) => <ol className="list-decimal space-y-1 pl-5" {...p} />,
          a: (p) => <a className="text-blue-400 underline" target="_blank" rel="noreferrer" {...p} />,
          p: (p) => <p className="my-2" {...p} />,
          blockquote: (p) => <blockquote className="border-l-2 border-zinc-600 pl-3 text-zinc-400" {...p} />,
          table: (p) => <table className="my-2 w-full border-collapse text-sm" {...p} />,
          th: (p) => <th className="border border-zinc-700 px-2 py-1 text-left" {...p} />,
          td: (p) => <td className="border border-zinc-700 px-2 py-1" {...p} />,
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}
```

- [ ] **Step 5: 构建 + 提交**

Run: `cd /c/Users/87474/Desktop/agent && pnpm --filter web build && pnpm --filter web typecheck`
Expected: 构建成功、零类型错误。

```bash
git add -A && git commit -m "feat(web): 聊天页面（侧边栏/流式渲染/Markdown 高亮/停止/重试/复制）"
```

---

### Task 8: 全链路验证 + 文档同步

- [ ] **Step 1: 全仓验证**

Run:
```bash
cd /c/Users/87474/Desktop/agent
pnpm test
pnpm build
pnpm typecheck
```
Expected: 全部通过。

- [ ] **Step 2: 全栈冒烟（真实浏览器链路）**

Run（三个后台进程）：`pnpm --filter api dev`、`pnpm --filter web dev`（worker 不需要）。然后：
```bash
curl -s -c /tmp/agent-cookies -X POST http://localhost:3001/api/v1/auth/login -H "Content-Type: application/json" -H "X-Requested-With: XMLHttpRequest" -d '{"email":"admin@example.com","password":"admin123456"}'
curl -s -b /tmp/agent-cookies -X POST http://localhost:3001/api/v1/chat -H "Content-Type: application/json" -H "X-Requested-With: XMLHttpRequest" -d '{"message":"你好"}' | head -20
```
Expected: 登录返回用户数据；chat 输出 `event: message_start` → `message_delta` 多帧 → `message_end`，Mock 回复逐字流式出现。

- [ ] **Step 3: 架构文档同步**

`docs/architecture/...v1.md` 三处更新：
1. §11.1 端点表：`POST /conversations/:id/chat` → `POST /chat`（conversationId 可空自动建会话）
2. §12.2 SSE 协议示例改为 `message_start/message_delta/message_end/status/task.*/error`
3. §3.1 表格：`shiki` → `rehype-highlight`（客户端 async 初始化复杂度，M1 求稳）
4. §19 M1 行标注 ✅ 已完成

- [ ] **Step 4: 计划执行偏差记录 + 最终提交**

在 `docs/plans/2026-09-23-m1-auth-chat-streaming.md` 末尾追加偏差记录（如实际执行中发现的问题），最终：
```bash
git add -A && git commit -m "docs: M1 完成——架构文档同步 + 执行偏差记录"
```

---

## 计划自审

**Spec 覆盖对照（M1 规格 1~21 节）**：认证/用户(T3)、登录+HttpOnly Cookie+refresh 轮换+logout+disabled(T3)、seed 管理员(已有)、auth API(T3)、Conversation CRUD+越权校验(T4)、Message 含 role/status 扩展(T2/T5)、POST /chat 自动建会话(T5)、LLM Streaming SSE(T5)、SSE 协议可扩展(T1)、Router 架构保留(T5)、Provider 抽象复用+Mock 全程可跑(T5)、模型不写死(默认模型解析器 T5)、Mock 模式无 Key 可体验(T5 e2e)、前端聊天页(T6/T7)、Markdown/高亮/流式/停止/重试/复制/新建/历史(T7)、统一错误结构(T1/T5)、数据库事务终态(T5)、并发锁(T5)、结构化日志(T5)、JWT/Cookie/CORS/CSRF/Rate(T3)。

**占位符扫描**：无。**类型一致性**：`ChatStreamEvent`/`AgentEvent(含 usage)`/`KVStore(setNX/del)` 三处接口变更均已列出对应测试与实现。**已知边界**：Router 的 routerModelId 为 null 时 M1 全部走 chat 快速兜底（零额外 LLM 调用），M4 配置路由模型后自动激活分类；消息分页 M1 取最新 50/200 条（游标留待 M5）。

---

## 执行偏差记录（2026-09-23 实际执行）

| # | 计划 | 实际 | 原因 |
|---|---|---|---|
| 1 | Controller 构造注入靠类型元数据 | 所有构造注入显式 `@Inject`（项目约定固化） | vitest/esbuild 下元数据不可靠（M1 复现两次：AuthController、ChatController） |
| 2 | ChatController 构造参数属性名 `chat` | 改名 `chatService` | **实例字段遮蔽同名路由方法** → `callback.apply is not a function`（Nest 路由查找取到的是字段） |
| 3 | 控制器返回裸数据 | 新增全局 TransformInterceptor 统一包 `{data}` | 与统一信封约定一致；SSE 等 headersSent 场景自动跳过 |
| 4 | e2e 断言 `toContain('mock')` | 解析 message_delta 帧拼接后断言 | mock 逐字符流式，原始文本中不存在连续子串 |
| 5 | `RouterService` 直接可用 | 补建 RouterModule（@Global） | Phase 3 只做了单测未挂模块，M1 ChatService 注入时暴露 |
| 6 | `/chat/[[id]]` 可选参数路由 | 拆为 `/chat` + `/chat/[id]` 两个页面 | Next.js 15.1 不支持可选动态段 |
| 7 | 计划中 e2e 的 MOCK_DELAY_MS 调整 | 保留（beforeAll 设 0） | 与 curl 冒烟共用同一 dev server 时需注意端口冲突（本机 3000/3001 曾有残留进程，已清理） |

**最终验证**：`pnpm test`（89 全绿）、`pnpm build`（3 包）、`pnpm typecheck` 零错误；全栈冒烟通过——登录/SSE 流式（message_start→status→逐字符 delta→message_end）/消息持久化/并发锁/越权校验/CSRF/限流。

**M1 交付能力**：Mock Provider 零 Key 完整链路（浏览器登录 admin@example.com / admin123456 → /chat 对话流式）；填入真实 Key 后（M5 后台或 seed）自动切真实模型，前端零改动。

---

# M2 执行记录（2026-09-23 追加）

M2 方案文档：`docs/architecture/m2-database-module-design.md`（用户确认 6 决策点 + 3 追加架构要求）。

## 阶段与提交

| 阶段 | 内容 | commit |
|---|---|---|
| M2-1 | 数据模型（Project/Memory 含 lastUsedAt/Summary/Artifact + projectId + generated_file）+ seed（mock-router/生图 Provider/路由与限额） | 5041756 |
| M2-2 | Project CRUD/软删除/归属校验 + @UsePipes→@Body(pipe) 修复 | 9e04bcd, b8cfd4e |
| M2-3 | Conversation↔Project（挂载/移动/过滤/校验，ChatDto.projectId） | 24839bc |
| M2-4 | Memory（core/memory 单表 + ILIKE + confidence≠importance + markUsed） | 729f240 |
| M2-5 | ContextAssembler 接入（两个 MemorySource + CONTEXT_ORDER + 集成 e2e） | 6d61115 |
| M2-6 | MemoryExtractor（阈值 0.7 + 每日上限 + fire-and-forget + Symbol DI token） | 8fad992 |
| M2-7 | Attachment 上传/下载（multer/校验/getStream/attachmentIds→图片上下文） | 47cf4c8 |
| M2-8 | Image Generation 独立能力（四 adapter/ImageManager/GenerationService/Worker/ImageAgent/tasks API/mock-router） | 6e9652a, ecd1727 |
| M2-9 | 前端（上传/TaskCard/附件渲染/Project 选择器/同源代理） | fa6cd68 |

## 关键执行发现（架构级）

1. **Router 污染**：记忆块进意图分类会把"用户偏好主图尺寸"误判为生图意图 → 修复：Router 只接收 conversation scope 的块（prepareChat 过滤），Agent 上下文仍含全部记忆。这是 M2 接入记忆后暴露的真实设计问题。
2. **接口 DI token**：`MemoryExtractor` 接口不能作 Nest token（类型擦除）→ Symbol token 约定固化。
3. **@Optional 缺失**：EventBusService 可选构造参数未标 @Optional 导致 dev server 启动崩溃（单测直构未暴露）→ 修复。教训：可选构造注入必须 @Optional 或走工厂。
4. **e2e 共享 DB 隔离**：chat e2e 取"列表第一条"会被并行套件的会话污染 → 改为从自身 SSE 流捕获 conversationId。
5. **前端媒体鉴权**：`<img>` 跨域不带 cookie → Next rewrites 同源代理 `/api/*`（生产由 nginx 同域反代）。
6. **Prisma Json 更新**：显式 null 需 `Prisma.JsonNull`；zod 字面量 vs Prisma 字符串枚举名义不兼容需显式收窄。

## 最终验证

- `pnpm test`：shared 11 + api 148 = **159 全绿**；`pnpm build` 3 包；`pnpm typecheck` 零错误
- 冒烟（真实三进程）：登录 → 建项目 → 项目内对话 → 中文"帮我做一张海报图" → mock-router 分类 image_generation → SSE task.created → Worker 消费 → 任务 completed(100) → generated_image 附件挂到 assistant 消息 → 项目过滤查询正确
- M1 能力零回归（chat SSE/多轮/停止/重试/上传/记忆注入均测试覆盖）

---

# M3 执行记录（2026-09-23 追加）

## 阶段与提交

| 阶段 | 内容 | commit |
|---|---|---|
| M3-1/2 | 任务可靠性（原子 claim/条件终态/MEDIA_TASK_TIMEOUT/孤儿清扫 repeatable job/usage 失败归因修复）+ 统一 Media 抽象（ImageGenerationService → MediaGenerationService + MediaExecutor 策略，Image 零回归迁移） | cc23677 |
| M3-3/4 | VideoProvider 独立接口 + mock-video/dashscope-video + VideoManager + VideoExecutor（capability 校验 UNSUPPORTED_PARAMETER）+ VideoAgent + video 队列处理器 + seed 视频模型/限额 | be1cbae |
| M3-5 | 前端视频附件渲染（<video controls> + 下载回退） | 94a1918 |

## 关键执行发现

1. **Worker 模块缺 QueueModule**：BullQueue_media-cleanup 注入失败导致 worker 启动崩溃（队列 provider 非全局，MediaCleanupWorkerModule 需显式 import QueueModule）——修复。
2. **接口能力校验落位**：capability 复用 models.capabilities（未扩展 provider 接口），UNSUPPORTED_PARAMETER 不可重试 → ModelRouter 不回退、不静默改写参数。
3. **单任务单结果**：claim 与终态全部 updateMany 条件更新；清扫竞态（慢 worker 完成 vs 已标 failed）→ 放弃完成写入并回收已创建附件（e2e 验证附件数=1）。
4. mock-video 结果为占位 MP4 容器（ftyp+mdat，39B）——真实 Provider 接入后为可播放视频（前端有下载回退）。

## 最终验证

- `pnpm test`：shared 11 + api 173 = **184 全绿**；build 3 包；typecheck 零错误
- 冒烟（真实三进程）：登录 → 中文"帮我做一个产品视频" → mock-router 分类 video_generation → SSE task.created(kind=video) → 独立 video 队列 → Worker 消费 → completed(100) → generated_video 附件(video/mp4) → 下载 200
- **Image 回归**：image e2e 全链路继续全绿（统一服务迁移零回归）
- **可靠性验收**：孤儿清扫 e2e（人为 processing 超时 → sweep → failed MEDIA_TASK_TIMEOUT，幂等）；重复执行已完成任务 → 附件数仍为 1
- 隔离：任务/附件/项目/记忆的 userId 归属校验沿用 M2 审计结论，M3 未新增暴露面

---

# M4 执行记录（2026-09-23 追加）

M4 设计：`docs/architecture/m4-agent-tool-design.md`（用户确认 + 6 项约束修订）。

## 阶段与提交

| 阶段 | 内容 | commit |
|---|---|---|
| P1 基础模型 | AgentRun/Step/ToolCall 表 + 状态机枚举 + agents.kind/version + usage.runId + task.idempotencyKey(UNIQUE) + seed 三 Agent/agentMapping；迁移经 migrate diff + deploy（dev 交互提示绕过） | 060e9b1, 7fd4941 |
| P2 LLM Tool Calling | 内部协议（LLMTurn/ToolCallRequest/tool 消息/流式 delta 聚合）+ openai-compatible 映射 + mock function-calling 替身 | f21dffe |
| P3/4 Tool 层 | ToolRegistry + 4 Tool（strictObject 防身份注入）+ ArtifactService 最小实现 + idempotencyKey 透传 | 9edf09b |
| P5 Agent Loop | 决策循环（权限边界/幂等复用/循环检测/终态状态机/不存 CoT/用量记录 runId 关联/task.created 转发） | 4d9eb9d |
| P6 注册表接线 | AgentRegistryService（DB 驱动）替代 ChatService 硬编码 switch + GeneralAssistantAgent + agent-runs 只读 API + agent.end→message_end 映射 | 09c09c5 |
| P7/8 SSE+前端 | agent.*/tool.*/run.* schema + 事件透传 + 前端当前工具徽标 | 0ff2670 |

## 关键执行发现

1. **zod 无 z.toJSONSchema**（3.25 实测）→ 采用 zod-to-json-schema + 非泛型边界切断类型实例化。
2. **Prisma migrate dev 非交互环境**对 UNIQUE 警告触发交互 → migrate diff（--from-url）+ 手工迁移目录 + deploy；shadow DB 需先建库。
3. **strictObject 而非 object**：zod 默认剥离未知键——防身份注入必须 strict。
4. **意图→Agent 映射语义**：image/video 意图直接映射 Image/Video Agent（设计如此）；Loop 经 chat 意图 + 非媒体工具（artifact/memory）验证——e2e 用"营销方案"/"记住"关键词避开媒体路由。
5. **Loop 流式兼容**：纯回答走实时 text.delta（M1 流式体验保持）；工具回合文本先输出后调用工具为可接受边缘。
6. 终态迁移全条件更新（where status='running'），数据库层杜绝终态复活。

## 最终验证

- `pnpm test`：shared 11 + api 194 = **205 全绿**（35+ 测试文件）；build 3 包；typecheck 零错误
- 冒烟（真实三进程）：登录 → "帮我做一个营销方案" → **run.created → agent.start → status → tool.start(artifact.create) → tool.end → message_delta×126 → agent.end(completed) → run.completed** → 制品落库 → agent-runs API 返回 completed run（general-assistant）
- **M1/M2/M3 全量回归**：chat/image/video/context-memory/projects/attachments/auth 全部 e2e 继续全绿
- 验收矩阵：Idempotency（ToolCall UNIQUE(runId,key) + task.idempotencyKey e2e 断言）/ Security（agent-runs 越权 404）/ Loop（AGENT_LOOP_DETECTED 单测 + 连续同参同工具只执行 1 次）/ Terminal State（updateMany 条件终态 + 7 种失败路径）
