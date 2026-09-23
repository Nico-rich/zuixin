# Phase 3 项目初始化（M0）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 初始化 monorepo（NestJS API + Next.js Web + shared 包）、PostgreSQL/Redis/MinIO 基础设施、Prisma 数据层、环境变量、Provider/Agent/Router/Task 核心接口与日志系统——产出可运行、可测试的项目骨架。

**Architecture:** 依据 `docs/architecture/ai-agent-platform-architecture-v1.md`（V1.1 已确认）。pnpm workspaces + Turborepo；`apps/api`（NestJS 11 + Express）、`apps/web`（Next.js 15 占位骨架）、`packages/shared`（zod schema + 错误码，tsup 构建）。API 与 Worker 同代码库双入口（main.ts / worker.ts）。

**Tech Stack:** TypeScript 5.6、NestJS 11、Prisma 6 + PostgreSQL 16、BullMQ 5 + ioredis 5 + Redis 7、zod 3、openai SDK 4、@aws-sdk/client-s3、pino（nestjs-pino）、argon2、Vitest 3 + supertest、tsup、Turborepo、pnpm 9、Docker Compose（postgres/redis/minio）。

**范围约定：** 本计划只覆盖 Phase 3（M0）。认证/对话（M1）、附件/生图（M2）、视频（M3）、Router 接入聊天流（M4）、后台（M5）各写独立计划。本计划中的 Router/CircuitBreaker/ModelRouter/Agent 层为**可独立单测的完整实现**，尚未接线到 HTTP 层。

**测试约定：** TDD（红-绿-重构）。纯脚手架文件用"创建 → 命令验证 → 提交"替代测试。所有 Provider/外部依赖注入接口或工厂，测试用 fake/mock，不触碰网络。

---

## 文件结构总览

```
agent-platform/
├── package.json / pnpm-workspace.yaml / turbo.json / .npmrc / .gitignore / README.md
├── .env.example                          # 全部环境变量模板（唯一事实源）
├── docker/compose.yml                    # postgres + redis + minio + createbuckets
├── packages/shared/
│   ├── package.json / tsconfig.json / tsup.config.ts / vitest.config.ts
│   └── src/{index.ts, errors.ts, intent.ts, events.ts, constants.ts}
│   └── test/{errors.spec.ts, intent.spec.ts}
├── apps/api/
│   ├── package.json / nest-cli.json / tsconfig.json / tsconfig.build.json / vitest.config.ts
│   ├── prisma/{schema.prisma, seed.ts}
│   ├── src/
│   │   ├── main.ts / worker.ts / app.module.ts
│   │   ├── common/{errors/app-error.ts, filters/global-exception.filter.ts, pipes/zod-validation.pipe.ts}
│   │   ├── modules/{prisma/, health/}
│   │   ├── providers/llm/{llm.types.ts, errors.ts, llm-registry.ts, adapters/{openai-compatible.adapter.ts, mock.adapter.ts}}
│   │   ├── agents/{agent.types.ts, agent.registry.ts, chat/chat.agent.ts}
│   │   └── core/
│   │       ├── crypto/crypto.service.ts
│   │       ├── router/router.service.ts
│   │       ├── circuit-breaker/{kv-store.interface.ts, redis-kv.service.ts, circuit-breaker.service.ts}
│   │       ├── model-router/model-router.service.ts
│   │       ├── queue/queue.module.ts
│   │       ├── events/event-bus.service.ts
│   │       └── storage/{storage.types.ts, storage.module.ts, local/storage-local.adapter.ts, s3/storage-s3.adapter.ts}
│   └── test/{health.e2e-spec.ts}
└── apps/web/                             # Next.js 15 占位骨架（M1 填充）
    ├── package.json / next.config.ts / tsconfig.json / postcss.config.mjs / next-env.d.ts
    └── app/{layout.tsx, page.tsx, globals.css}
```

接口定义与架构文档 §6~§9 严格一致（LLMProvider/ImageProvider/VideoProvider/StorageAdapter/Agent/AgentEvent/TaskIntent）。本计划只实现 LLM Provider 与 Storage 两个接口族 + Agent/Router/CircuitBreaker/ModelRouter/Queue/EventBus——Image/Video Provider 接口在 M2/M3 计划中实现。

---

### Task 1: Git 仓库 + Monorepo 骨架

**Files:**
- Create: `.gitignore`、`.npmrc`、`package.json`、`pnpm-workspace.yaml`、`turbo.json`、`README.md`

- [ ] **Step 1: 创建骨架文件**

`.gitignore`：
```gitignore
node_modules/
dist/
.next/
coverage/
.env
.env.local
data/
*.log
.DS_Store
```

`.npmrc`：
```ini
shamefully-hoist=true
```

`package.json`：
```json
{
  "name": "ai-agent-platform",
  "private": true,
  "packageManager": "pnpm@9.15.0",
  "scripts": {
    "dev": "turbo run dev",
    "build": "turbo run build",
    "test": "turbo run test",
    "typecheck": "turbo run typecheck",
    "db:migrate": "pnpm --filter api prisma:migrate",
    "db:seed": "pnpm --filter api prisma:seed"
  },
  "devDependencies": {
    "turbo": "^2.3.0",
    "typescript": "^5.6.3"
  }
}
```

`pnpm-workspace.yaml`：
```yaml
packages:
  - "apps/*"
  - "packages/*"
```

`turbo.json`：
```json
{
  "$schema": "https://turbo.build/schema.json",
  "tasks": {
    "dev": { "cache": false, "persistent": true },
    "build": { "dependsOn": ["^build"], "outputs": ["dist/**", ".next/**"] },
    "test": { "dependsOn": ["^build"] },
    "typecheck": { "dependsOn": ["^build"] }
  }
}
```

`README.md`：
```markdown
# AI Agent 智能创作平台

架构文档：`docs/architecture/ai-agent-platform-architecture-v1.md`（V1.1 已确认）

## 快速开始

1. `docker compose -f docker/compose.yml up -d`（PostgreSQL/Redis/MinIO）
2. `cp .env.example .env` 并填写配置
3. `pnpm install`
4. `pnpm db:migrate && pnpm db:seed`
5. `pnpm dev`（API :3001 / Web :3000）

## 目录

- `apps/api` NestJS 后端（main.ts API / worker.ts 队列 Worker）
- `apps/web` Next.js 前端
- `packages/shared` 前后端共享类型与 zod schema
- `docs/` 架构与实施计划
```

- [ ] **Step 2: 初始化 git 并安装**

Run:
```bash
cd /c/Users/87474/Desktop/agent
git init -b main
pnpm install
```
Expected: `pnpm install` 无报错（此时 workspace 为空包）。

- [ ] **Step 3: 提交**

```bash
git add -A && git commit -m "chore: monorepo 骨架（pnpm + turborepo + git init）"
```

---

### Task 2: Docker 基础设施 + 环境变量模板

**Files:**
- Create: `docker/compose.yml`、`.env.example`

- [ ] **Step 1: 创建 compose 文件**

`docker/compose.yml`：
```yaml
services:
  postgres:
    image: postgres:16-alpine
    environment:
      POSTGRES_USER: agent
      POSTGRES_PASSWORD: agent_dev_password
      POSTGRES_DB: agent_platform
    ports: ["5432:5432"]
    volumes: [pgdata:/var/lib/postgresql/data]
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U agent -d agent_platform"]
      interval: 5s
      timeout: 3s
      retries: 10

  redis:
    image: redis:7-alpine
    ports: ["6379:6379"]
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 5s
      timeout: 3s
      retries: 10

  minio:
    image: minio/minio:latest
    command: server /data --console-address ":9001"
    environment:
      MINIO_ROOT_USER: minioadmin
      MINIO_ROOT_PASSWORD: minioadmin
    ports: ["9000:9000", "9001:9001"]
    volumes: [miniodata:/data]
    healthcheck:
      test: ["CMD", "mc", "ready", "local"]
      interval: 5s
      timeout: 3s
      retries: 10

  createbuckets:
    image: minio/mc:latest
    depends_on:
      minio:
        condition: service_healthy
    entrypoint: >
      /bin/sh -c "
      mc alias set local http://minio:9000 minioadmin minioadmin;
      mc mb -p local/agent-storage || true;
      mc anonymous set none local/agent-storage;
      exit 0"

volumes:
  pgdata:
  miniodata:
```

`.env.example`：
```bash
# ===== 数据库 =====
DATABASE_URL=postgresql://agent:agent_dev_password@localhost:5432/agent_platform

# ===== Redis / 队列 =====
REDIS_URL=redis://localhost:6379

# ===== 安全 =====
# 生成方式: openssl rand -base64 32
JWT_SECRET=change_me_openssl_rand_base64_32
# 生成方式: openssl rand -base64 32（API Key 落库加密用，设置后不可更改）
ENCRYPTION_KEY=change_me_openssl_rand_base64_32

# ===== 服务 =====
API_PORT=3001
WEB_PORT=3000
APP_URL=http://localhost:3001
WEB_URL=http://localhost:3000
# CORS 白名单（逗号分隔）
CORS_ORIGINS=http://localhost:3000

# ===== 对象存储 =====
# local（开发，写 ./data/storage）| s3-compatible（MinIO/R2/S3）
STORAGE_DRIVER=local
STORAGE_LOCAL_DIR=./data/storage
STORAGE_BUCKET=agent-storage
STORAGE_ENDPOINT=http://localhost:9000
STORAGE_ACCESS_KEY_ID=minioadmin
STORAGE_SECRET_ACCESS_KEY=minioadmin
STORAGE_REGION=us-east-1

# ===== 种子数据 =====
# 初始管理员账号（seed 创建）
SEED_ADMIN_EMAIL=admin@example.com
SEED_ADMIN_PASSWORD=admin123456
```

- [ ] **Step 2: 验证并启动**

Run:
```bash
docker compose -f docker/compose.yml config -q
docker compose -f docker/compose.yml up -d
docker compose -f docker/compose.yml ps
```
Expected: config 校验无输出（通过）；`ps` 显示 4 个服务，postgres/redis/minio 为 healthy。

- [ ] **Step 3: 提交**

```bash
git add -A && git commit -m "chore: docker compose 基础设施（PG/Redis/MinIO）+ 环境变量模板"
```

---

### Task 3: packages/shared（zod 共享层）

**Files:**
- Create: `packages/shared/package.json`、`tsconfig.json`、`tsup.config.ts`、`vitest.config.ts`、`test/errors.spec.ts`、`test/intent.spec.ts`、`src/errors.ts`、`src/intent.ts`、`src/events.ts`、`src/constants.ts`、`src/index.ts`

- [ ] **Step 1: 写失败测试（errors.spec.ts + intent.spec.ts）**

`packages/shared/test/errors.spec.ts`：
```ts
import { describe, it, expect } from 'vitest';
import { ErrorCode, AppError, RETRYABLE_CODES } from '../src';

describe('ErrorCode / AppError', () => {
  it('RETRYABLE_CODES 只包含可重试的 provider 错误', () => {
    expect(RETRYABLE_CODES).toContain('PROVIDER_TIMEOUT');
    expect(RETRYABLE_CODES).toContain('PROVIDER_RATE_LIMITED');
    expect(RETRYABLE_CODES).toContain('PROVIDER_OVERLOADED');
    expect(RETRYABLE_CODES).not.toContain('PROVIDER_AUTH');
    expect(RETRYABLE_CODES).not.toContain('PROVIDER_BAD_REQUEST');
  });

  it('AppError 携带 requestId 并可序列化为响应 envelope', () => {
    const err = new AppError('QUOTA_EXCEEDED', '今日生图次数已达上限', 'req_1');
    expect(err.toJSON()).toEqual({
      code: 'QUOTA_EXCEEDED', message: '今日生图次数已达上限', requestId: 'req_1',
    });
  });

  it('PROVIDER_UNKNOWN 不是可重试错误', () => {
    expect(RETRYABLE_CODES.has('PROVIDER_UNKNOWN')).toBe(false);
  });
});
```

`packages/shared/test/intent.spec.ts`：
```ts
import { describe, it, expect } from 'vitest';
import { TaskIntentSchema } from '../src';

describe('TaskIntentSchema', () => {
  const valid = {
    type: 'image_generation', confidence: 0.98,
    parameters: { prompt: '科技感智能插排广告图', aspectRatio: '1:1' },
  };

  it('解析合法意图', () => {
    expect(TaskIntentSchema.parse(valid)).toEqual(valid);
  });

  it('拒绝未知意图类型', () => {
    expect(() => TaskIntentSchema.parse({ ...valid, type: 'sing_a_song' })).toThrow();
  });

  it('confidence 越界报错', () => {
    expect(() => TaskIntentSchema.parse({ ...valid, confidence: 1.5 })).toThrow();
    expect(() => TaskIntentSchema.parse({ ...valid, confidence: -0.1 })).toThrow();
  });

  it('parameters.prompt 必填', () => {
    expect(() => TaskIntentSchema.parse({ type: 'chat', confidence: 0.9, parameters: {} })).toThrow();
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `cd /c/Users/87474/Desktop/agent && pnpm --filter shared test`
Expected: FAIL——模块 `../src` 不存在。

- [ ] **Step 3: 实现 shared 包**

`packages/shared/package.json`：
```json
{
  "name": "@ai-agent/shared",
  "version": "0.1.0",
  "private": true,
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": { ".": { "types": "./dist/index.d.ts", "default": "./dist/index.js" } },
  "scripts": {
    "build": "tsup",
    "dev": "tsup --watch",
    "test": "vitest run",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": { "zod": "^3.24.2" },
  "devDependencies": {
    "tsup": "^8.3.5",
    "vitest": "^3.0.5",
    "typescript": "^5.6.3"
  }
}
```

`packages/shared/tsconfig.json`：
```json
{
  "compilerOptions": {
    "target": "ES2022", "module": "ESNext", "moduleResolution": "Bundler",
    "strict": true, "declaration": true, "skipLibCheck": true,
    "outDir": "dist"
  },
  "include": ["src"]
}
```

`packages/shared/tsup.config.ts`：
```ts
import { defineConfig } from 'tsup';
export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm', 'cjs'],
  dts: true,
  clean: true,
});
```

`packages/shared/vitest.config.ts`：
```ts
import { defineConfig } from 'vitest/config';
export default defineConfig({ test: { environment: 'node' } });
```

`packages/shared/src/errors.ts`：
```ts
export const ErrorCode = {
  VALIDATION_ERROR: 'VALIDATION_ERROR', NOT_FOUND: 'NOT_FOUND', FORBIDDEN: 'FORBIDDEN',
  UNAUTHORIZED: 'UNAUTHORIZED', QUOTA_EXCEEDED: 'QUOTA_EXCEEDED', RATE_LIMITED: 'RATE_LIMITED',
  TASK_NOT_CANCELLABLE: 'TASK_NOT_CANCELLABLE',
  PROVIDER_TIMEOUT: 'PROVIDER_TIMEOUT', PROVIDER_RATE_LIMITED: 'PROVIDER_RATE_LIMITED',
  PROVIDER_AUTH: 'PROVIDER_AUTH', PROVIDER_OVERLOADED: 'PROVIDER_OVERLOADED',
  PROVIDER_BAD_REQUEST: 'PROVIDER_BAD_REQUEST', PROVIDER_CONTENT_FILTERED: 'PROVIDER_CONTENT_FILTERED',
  PROVIDER_UNKNOWN: 'PROVIDER_UNKNOWN',
  ROUTER_FALLBACK: 'ROUTER_FALLBACK', INTERNAL: 'INTERNAL',
} as const;
export type ErrorCodeType = (typeof ErrorCode)[keyof typeof ErrorCode];

/** 可重试（进入回退/熔断计数）的 provider 错误 */
export const RETRYABLE_CODES = new Set<ErrorCodeType>([
  ErrorCode.PROVIDER_TIMEOUT, ErrorCode.PROVIDER_RATE_LIMITED, ErrorCode.PROVIDER_OVERLOADED,
]);

export class AppError extends Error {
  readonly retryable: boolean;
  constructor(
    readonly code: ErrorCodeType,
    message: string,
    readonly requestId?: string,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'AppError';
    this.retryable = RETRYABLE_CODES.has(code);
  }
  toJSON() {
    return { code: this.code, message: this.message, requestId: this.requestId };
  }
}
```

`packages/shared/src/intent.ts`：
```ts
import { z } from 'zod';

export const IntentType = ['chat', 'image_generation', 'video_generation', 'image_analysis', 'file_analysis', 'agent_task', 'workflow'] as const;

export const TaskIntentSchema = z.object({
  type: z.enum(IntentType),
  confidence: z.number().min(0).max(1),
  parameters: z.object({
    prompt: z.string().min(1),
    aspectRatio: z.string().optional(),
    duration: z.number().positive().optional(),
    referenceMessageId: z.string().uuid().optional(),
  }),
  agent: z.string().optional(),
});
export type TaskIntent = z.infer<typeof TaskIntentSchema>;
```

`packages/shared/src/events.ts`（SSE 事件协议，与架构文档 §12.2 一致）：
```ts
import { z } from 'zod';

export const StatusEventSchema = z.object({ type: z.literal('status'), stage: z.string(), message: z.string() });
export const TextDeltaEventSchema = z.object({ type: z.literal('text.delta'), text: z.string() });
export const TaskCreatedEventSchema = z.object({ type: z.literal('task.created'), taskId: z.string(), kind: z.enum(['image', 'video']) });
export const DoneEventSchema = z.object({ type: z.literal('done'), messageId: z.string() });
export const ErrorEventSchema = z.object({ type: z.literal('error'), code: z.string(), message: z.string(), requestId: z.string().optional() });

export const AgentEventSchema = z.discriminatedUnion('type', [
  StatusEventSchema, TextDeltaEventSchema, TaskCreatedEventSchema, DoneEventSchema, ErrorEventSchema,
]);
export type AgentEvent = z.infer<typeof AgentEventSchema>;
```

`packages/shared/src/constants.ts`：
```ts
export const LIMITS = {
  IMAGE_MAX_MB: 20, VIDEO_MAX_MB: 200, FILE_MAX_MB: 50,
  IMAGE_TASK_TIMEOUT_MS: 5 * 60_000, VIDEO_TASK_TIMEOUT_MS: 30 * 60_000,
  DAILY_IMAGE_LIMIT_DEFAULT: 50, VIDEO_CONCURRENCY_DEFAULT: 1,
} as const;
export const ROUTER_DEFAULTS = { CONFIDENCE_THRESHOLD: 0.7 } as const;
```

`packages/shared/src/index.ts`：
```ts
export * from './errors';
export * from './intent';
export * from './events';
export * from './constants';
```

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm --filter shared test && pnpm --filter shared build`
Expected: 5 个测试 PASS；dist 生成。

- [ ] **Step 5: 提交**

```bash
git add -A && git commit -m "feat(shared): zod 共享层（错误码/意图/SSE 事件/常量）"
```

---

### Task 4: Prisma 数据层（schema + migrate + seed）

**Files:**
- Create: `apps/api/prisma/schema.prisma`、`apps/api/prisma/seed.ts`、`apps/api/package.json`、`src/modules/prisma/prisma.module.ts`、`src/modules/prisma/prisma.service.ts`
- Modify: 根 `package.json`（无，api 包自带脚本）

- [ ] **Step 1: 创建 apps/api/package.json**

```json
{
  "name": "api",
  "version": "0.1.0",
  "private": true,
  "scripts": {
    "dev": "nest start --watch",
    "dev:worker": "tsx watch src/worker.ts",
    "build": "nest build",
    "start": "node dist/main.js",
    "test": "vitest run",
    "test:e2e": "vitest run --config vitest.config.ts test",
    "typecheck": "tsc --noEmit",
    "prisma:migrate": "prisma migrate dev",
    "prisma:seed": "tsx prisma/seed.ts",
    "prisma:generate": "prisma generate"
  },
  "dependencies": {
    "@ai-agent/shared": "workspace:*",
    "@aws-sdk/client-s3": "^3.700.0",
    "@nestjs/bullmq": "^11.0.0",
    "@nestjs/common": "^11.0.0",
    "@nestjs/config": "^4.0.0",
    "@nestjs/core": "^11.0.0",
    "@nestjs/platform-express": "^11.0.0",
    "@prisma/client": "^6.2.0",
    "argon2": "^0.41.1",
    "bullmq": "^5.34.0",
    "helmet": "^8.0.0",
    "ioredis": "^5.4.2",
    "nestjs-pino": "^4.1.0",
    "openai": "^4.78.1",
    "pino": "^9.6.0",
    "pino-http": "^10.3.0",
    "pino-pretty": "^13.0.0",
    "reflect-metadata": "^0.2.2",
    "rxjs": "^7.8.1",
    "zod": "^3.24.2"
  },
  "devDependencies": {
    "@nestjs/cli": "^11.0.0",
    "@nestjs/schematics": "^11.0.0",
    "@nestjs/testing": "^11.0.0",
    "@types/express": "^5.0.0",
    "@types/node": "^22.10.0",
    "@types/supertest": "^6.0.2",
    "prisma": "^6.2.0",
    "supertest": "^7.0.0",
    "tsx": "^4.19.2",
    "typescript": "^5.6.3",
    "vitest": "^3.0.5"
  },
  "prisma": { "seed": "tsx prisma/seed.ts" }
}
```

- [ ] **Step 2: 编写 schema.prisma（与架构文档 §10 完全一致）**

```prisma
generator client {
  provider = "prisma-client-js"
}

datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}

// ===== 枚举 =====
enum UserRole { user admin }
enum UserStatus { active disabled }
enum MessageRole { user assistant system }
enum MessageStatus { pending streaming completed failed cancelled }
enum IntentType { chat image_generation video_generation image_analysis file_analysis agent_task workflow }
enum AttachmentType { image video file }
enum AttachmentKind { upload generated_image generated_video }
enum AttachmentStatus { uploading ready failed }
enum ProviderType { llm image video }
enum HealthStatus { untested healthy unhealthy }
enum ModelType { llm image video }
enum TaskType { image video }
enum TaskStatus { pending processing completed failed cancelled }
enum UsageKind { llm_chat llm_router image video }
enum UsageStatus { success failed }

// ===== 用户与认证 =====
model User {
  id           String    @id @default(uuid())
  email        String    @unique
  passwordHash String
  displayName  String?
  role         UserRole  @default(user)
  status       UserStatus @default(active)
  createdAt    DateTime  @default(now())
  updatedAt    DateTime  @updatedAt
  lastLoginAt  DateTime?
  conversations Conversation[]
  messages      Message[]
  attachments   Attachment[]
  tasks         GenerationTask[]
  usages        UsageRecord[]
  sessions      Session[]
}

model Session {
  id        String    @id @default(uuid())
  userId    String
  user      User      @relation(fields: [userId], references: [id], onDelete: Cascade)
  tokenHash String    @unique
  expiresAt DateTime
  revokedAt DateTime?
  userAgent String?
  ip        String?
  createdAt DateTime  @default(now())
  @@index([userId])
}

// ===== 对话 =====
model Conversation {
  id        String   @id @default(uuid())
  userId    String
  user      User     @relation(fields: [userId], references: [id], onDelete: Cascade)
  title     String   @default("新对话")
  deletedAt DateTime?
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt
  messages  Message[]
  @@index([userId, updatedAt])
}

model Message {
  id               String          @id @default(uuid())
  conversationId   String
  conversation     Conversation    @relation(fields: [conversationId], references: [id], onDelete: Cascade)
  userId           String
  user             User            @relation(fields: [userId], references: [id])
  role             MessageRole
  content          String          @db.Text
  intentType       IntentType?
  intentConfidence Float?
  agentId          String?
  agent            Agent?          @relation(fields: [agentId], references: [id])
  modelId          String?
  status           MessageStatus   @default(completed)
  errorCode        String?
  tokenUsage       Json?
  createdAt        DateTime        @default(now())
  attachments      Attachment[]
  tasks            GenerationTask[]
  @@index([conversationId, createdAt])
}

// ===== 附件（上传与生成产物统一管理）=====
model Attachment {
  id             String           @id @default(uuid())
  userId         String
  user           User             @relation(fields: [userId], references: [id])
  conversationId String?
  messageId      String?
  message        Message?         @relation(fields: [messageId], references: [id])
  kind           AttachmentKind
  type           AttachmentType
  mimeType       String
  storageKey     String
  storageProvider String          @default("local")
  originalName   String?
  sizeBytes      Int
  metadata       Json?
  status         AttachmentStatus @default(ready)
  taskId         String?
  createdAt      DateTime         @default(now())
  @@index([userId, createdAt])
  @@index([messageId])
}

// ===== Agent =====
model Agent {
  id           String    @id @default(uuid())
  slug         String    @unique
  name         String
  description  String?
  systemPrompt String    @db.Text
  modelId      String?
  model        Model?    @relation(fields: [modelId], references: [id])
  tools        Json      @default("[]")
  temperature  Float     @default(0.7)
  maxTokens    Int?
  enabled      Boolean   @default(true)
  priority     Int       @default(100)
  builtin      Boolean   @default(false)
  config       Json?
  createdAt    DateTime  @default(now())
  updatedAt    DateTime  @updatedAt
  messages     Message[]
}

// ===== Provider 与模型 =====
model Provider {
  id               String       @id @default(uuid())
  name             String
  type             ProviderType
  adapter          String
  baseUrl          String
  apiKeyEncrypted  String       @default("")
  enabled          Boolean      @default(false)
  priority         Int          @default(100)
  timeoutMs        Int          @default(60000)
  retryConfig      Json?
  healthStatus     HealthStatus @default(untested)
  health           Json?
  createdAt        DateTime     @default(now())
  updatedAt        DateTime     @updatedAt
  models           Model[]
  tasks            GenerationTask[]
  usages           UsageRecord[]
  @@index([type, enabled])
}

model Model {
  id               String      @id @default(uuid())
  providerId       String
  provider         Provider    @relation(fields: [providerId], references: [id], onDelete: Cascade)
  name             String
  apiModelId       String
  type             ModelType
  capabilities     Json?
  inputPrice       Float       @default(0)
  outputPrice      Float       @default(0)
  unitPrice        Float       @default(0)
  contextWindow    Int?
  enabled          Boolean     @default(true)
  priority         Int         @default(100)
  isDefault        Boolean     @default(false)
  createdAt        DateTime    @default(now())
  updatedAt        DateTime    @updatedAt
  agents           Agent[]
  tasks            GenerationTask[]
  usages           UsageRecord[]
  @@index([type, enabled])
}

// ===== 生成任务 =====
model GenerationTask {
  id             String      @id @default(uuid())
  userId         String
  user           User        @relation(fields: [userId], references: [id])
  conversationId String?
  messageId      String?
  message        Message?    @relation(fields: [messageId], references: [id])
  type           TaskType
  providerId     String?
  provider       Provider?   @relation(fields: [providerId], references: [id])
  modelId        String?
  model          Model?      @relation(fields: [modelId], references: [id])
  status         TaskStatus  @default(pending)
  progress       Int?
  statusMessage  String?
  input          Json
  output         Json?
  remoteTaskId   String?
  errorCode      String?
  errorMessage   String?
  attempts       Int         @default(0)
  costEstimate   Float?
  startedAt      DateTime?
  completedAt    DateTime?
  createdAt      DateTime    @default(now())
  attachments    Attachment[]
  @@index([userId, createdAt])
  @@index([status])
}

// ===== 用量与成本 =====
model UsageRecord {
  id             String      @id @default(uuid())
  userId         String?
  user           User?       @relation(fields: [userId], references: [id])
  conversationId String?
  messageId      String?
  taskId         String?
  providerId     String?
  provider       Provider?   @relation(fields: [providerId], references: [id])
  modelId        String?
  model          Model?      @relation(fields: [modelId], references: [id])
  kind           UsageKind
  inputTokens    Int         @default(0)
  outputTokens   Int         @default(0)
  imageCount     Int         @default(0)
  videoSeconds   Int         @default(0)
  latencyMs      Int?
  estimatedCost  Float       @default(0)
  status         UsageStatus @default(success)
  errorCode      String?
  createdAt      DateTime    @default(now())
  @@index([createdAt])
  @@index([userId, createdAt])
}

// ===== 系统配置 =====
model SystemSetting {
  key       String   @id
  value     Json
  updatedAt DateTime @updatedAt
}
```

- [ ] **Step 3: 安装依赖 + 生成 client + 迁移**

Run:
```bash
cd /c/Users/87474/Desktop/agent && pnpm install
cp .env.example .env
cd apps/api && pnpm exec prisma migrate dev --name init
```
Expected: 迁移成功（docker compose 的 postgres 需已启动），`prisma/migrations/` 生成。

- [ ] **Step 4: 编写 Prisma 全局模块与 seed**

`apps/api/src/modules/prisma/prisma.service.ts`：
```ts
import { Injectable, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  async onModuleInit() { await this.$connect(); }
  async onModuleDestroy() { await this.$disconnect(); }
}
```

`apps/api/src/modules/prisma/prisma.module.ts`：
```ts
import { Global, Module } from '@nestjs/common';
import { PrismaService } from './prisma.service';

@Global()
@Module({ providers: [PrismaService], exports: [PrismaService] })
export class PrismaModule {}
```

`apps/api/prisma/seed.ts`：
```ts
import { PrismaClient, ProviderType, ModelType, HealthStatus } from '@prisma/client';
import * as argon2 from 'argon2';

const prisma = new PrismaClient();

/** LLM 六家厂商（全部走 openai-compatible adapter；apiKey 留空，M5 后台填写） */
const LLM_PROVIDERS = [
  { name: 'OpenAI',    baseUrl: 'https://api.openai.com/v1' },
  { name: 'DeepSeek',  baseUrl: 'https://api.deepseek.com/v1' },
  { name: 'Kimi(月之暗面)', baseUrl: 'https://api.moonshot.cn/v1' },
  { name: '阿里百炼(Qwen)', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1' },
  { name: '火山方舟(豆包)', baseUrl: 'https://ark.cn-beijing.volces.com/api/v3' },
  { name: '智谱(GLM)',  baseUrl: 'https://open.bigmodel.cn/api/paas/v4' },
];

async function main() {
  const email = process.env.SEED_ADMIN_EMAIL ?? 'admin@example.com';
  const password = process.env.SEED_ADMIN_PASSWORD ?? 'admin123456';

  const admin = await prisma.user.upsert({
    where: { email },
    update: {},
    create: { email, passwordHash: await argon2.hash(password), displayName: '管理员', role: 'admin' },
  });
  console.log('admin user:', admin.email);

  for (const p of LLM_PROVIDERS) {
    const provider = await prisma.provider.upsert({
      where: { id: `seed-llm-${p.name}` },
      update: { baseUrl: p.baseUrl },
      create: { id: `seed-llm-${p.name}`, name: p.name, type: ProviderType.llm, adapter: 'openai-compatible', baseUrl: p.baseUrl, enabled: false, healthStatus: HealthStatus.untested },
    });
    const models = p.name === 'OpenAI'
      ? [{ name: 'GPT-4o mini', api: 'gpt-4o-mini', vision: true, ctx: 128000 }]
      : [{ name: '默认模型', api: providerDefaultApiModel(p.name), vision: p.name !== 'DeepSeek' && p.name !== 'Kimi(月之暗面)', ctx: 128000 }];
    for (const m of models) {
      await prisma.model.upsert({
        where: { id: `seed-model-${provider.id}-${m.api}` },
        update: {},
        create: {
          id: `seed-model-${provider.id}-${m.api}`, providerId: provider.id, name: m.name, apiModelId: m.api,
          type: ModelType.llm, capabilities: { vision: m.vision, jsonObject: true, jsonSchema: p.name === 'OpenAI' },
          contextWindow: m.ctx, enabled: true, priority: 100,
        },
      });
    }
  }

  // 本地 mock provider（无真实 key 时开发/测试用）
  const mock = await prisma.provider.upsert({
    where: { id: 'seed-llm-mock' },
    update: {},
    create: { id: 'seed-llm-mock', name: '本地Mock', type: ProviderType.llm, adapter: 'mock', baseUrl: '', enabled: true, healthStatus: HealthStatus.healthy },
  });
  await prisma.model.upsert({
    where: { id: 'seed-model-mock-echo' },
    update: {},
    create: { id: 'seed-model-mock-echo', providerId: mock.id, name: 'Mock Echo', apiModelId: 'mock-echo', type: ModelType.llm, capabilities: {}, enabled: true, priority: 1, isDefault: true },
  });

  await prisma.systemSetting.upsert({
    where: { key: 'routingPolicy' },
    update: {},
    create: {
      key: 'routingPolicy',
      value: { confidenceThreshold: 0.7, routerModelId: null, defaults: { llm: null, image: null, video: null, vision: null } },
    },
  });
  await prisma.systemSetting.upsert({
    where: { key: 'limits' },
    update: {},
    create: { key: 'limits', value: { dailyImage: 50, videoConcurrency: 1, monthlyTokenBudget: 0 } },
  });

  console.log('seed done');
}

/** 各家默认 api_model_id（admin 可在后台改） */
function providerDefaultApiModel(name: string): string {
  switch (name) {
    case 'DeepSeek': return 'deepseek-chat';
    case 'Kimi(月之暗面)': return 'kimi-k2-0711-preview';
    case '阿里百炼(Qwen)': return 'qwen-plus';
    case '火山方舟(豆包)': return 'doubao-pro-32k';
    case '智谱(GLM)': return 'glm-4-plus';
    default: return 'gpt-4o-mini';
  }
}

main().catch((e) => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
```

- [ ] **Step 5: 运行 seed 并验证**

Run:
```bash
cd /c/Users/87474/Desktop/agent && pnpm db:seed
cd apps/api && pnpm exec tsx -e "import {PrismaClient} from '@prisma/client'; const p=new PrismaClient(); Promise.all([p.user.count(),p.provider.count(),p.model.count()]).then(r=>{console.log('users/providers/models:',r); if(r[0]!==1||r[1]<7||r[2]<7) process.exit(1)}).finally(()=>p.\$disconnect())"
```
Expected: `admin user: admin@example.com`、`seed done`、`users/providers/models: [1,7,7]`（≥7 providers：6 LLM + mock）。

- [ ] **Step 6: 提交**

```bash
git add -A && git commit -m "feat(api): Prisma schema（14 表）+ 迁移 + seed（管理员/六厂商/mock/系统配置）"
```

---

### Task 5: NestJS 应用骨架（配置/日志/错误/校验/健康）

**Files:**
- Create: `apps/api/nest-cli.json`、`tsconfig.json`、`tsconfig.build.json`、`vitest.config.ts`、`src/main.ts`、`src/app.module.ts`、`src/common/errors/app-error.ts`、`src/common/filters/global-exception.filter.ts`、`src/common/pipes/zod-validation.pipe.ts`、`src/modules/health/health.module.ts`、`src/modules/health/health.controller.ts`、`test/health.e2e-spec.ts`

- [ ] **Step 1: 写失败 e2e 测试**

`apps/api/test/health.e2e-spec.ts`：
```ts
import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { AppModule } from '../src/app.module';

describe('Health (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api/v1');
    await app.init();
  });

  afterAll(async () => { await app.close(); });

  it('GET /api/v1/health 返回 200 ok', async () => {
    const res = await request(app.getHttpServer()).get('/api/v1/health').expect(200);
    expect(res.body).toEqual({ status: 'ok' });
  });

  it('未捕获异常返回统一 envelope（含 requestId）', async () => {
    const res = await request(app.getHttpServer()).get('/api/v1/health/boom').expect(500);
    expect(res.body.error.code).toBe('INTERNAL');
    expect(res.body.error.requestId).toBeTruthy();
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `cd /c/Users/87474/Desktop/agent/apps/api && pnpm exec vitest run test/health.e2e-spec.ts`
Expected: FAIL——`../src/app.module` 不存在。

- [ ] **Step 3: 实现骨架**

`apps/api/nest-cli.json`：
```json
{
  "$schema": "https://json.schemastore.org/nest-cli",
  "collection": "@nestjs/schematics",
  "sourceRoot": "src",
  "compilerOptions": { "deleteOutDir": true }
}
```

`apps/api/tsconfig.json`：
```json
{
  "compilerOptions": {
    "module": "commonjs",
    "target": "ES2022",
    "moduleResolution": "node",
    "declaration": false,
    "removeComments": true,
    "emitDecoratorMetadata": true,
    "experimentalDecorators": true,
    "allowSyntheticDefaultImports": true,
    "esModuleInterop": true,
    "sourceMap": true,
    "outDir": "./dist",
    "baseUrl": "./",
    "incremental": true,
    "skipLibCheck": true,
    "strict": true,
    "strictPropertyInitialization": false,
    "paths": { "@ai-agent/shared": ["../../packages/shared/dist"] }
  },
  "include": ["src", "test", "prisma/seed.ts"]
}
```

`apps/api/tsconfig.build.json`：
```json
{ "extends": "./tsconfig.json", "exclude": ["node_modules", "test", "dist", "**/*spec.ts"] }
```

`apps/api/vitest.config.ts`：
```ts
import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

export default defineConfig({
  test: { environment: 'node', globals: false, include: ['test/**/*.e2e-spec.ts', 'src/**/*.spec.ts'] },
  resolve: { alias: { '@ai-agent/shared': resolve(__dirname, '../../packages/shared/dist') } },
});
```

`apps/api/src/common/errors/app-error.ts`：
```ts
export { AppError, ErrorCode, RETRYABLE_CODES } from '@ai-agent/shared';
export type { ErrorCodeType } from '@ai-agent/shared';
```

`apps/api/src/common/pipes/zod-validation.pipe.ts`：
```ts
import { BadRequestException, Injectable, PipeTransform } from '@nestjs/common';
import { ZodSchema } from 'zod';

/** 用法：@UsePipes(new ZodValidationPipe(LoginSchema)) —— zod 单源校验 */
@Injectable()
export class ZodValidationPipe<T> implements PipeTransform {
  constructor(private readonly schema: ZodSchema<T>) {}
  transform(value: unknown): T {
    const result = this.schema.safeParse(value);
    if (!result.success) {
      const detail = result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
      throw new BadRequestException({ code: 'VALIDATION_ERROR', message: `参数校验失败：${detail}` });
    }
    return result.data;
  }
}
```

`apps/api/src/common/filters/global-exception.filter.ts`：
```ts
import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus, Logger } from '@nestjs/common';
import { Request, Response } from 'express';
import { AppError, ErrorCode } from '../errors/app-error';

@Catch()
export class GlobalExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger('GlobalExceptionFilter');

  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const res = ctx.getResponse<Response>();
    const req = ctx.getRequest<Request & { id?: string }>();
    const requestId = req.id;

    if (exception instanceof AppError) {
      this.logger.warn({ code: exception.code, requestId }, exception.message);
      const status = this.httpStatusOf(exception.code);
      res.status(status).json({ error: { code: exception.code, message: exception.message, requestId } });
      return;
    }
    if (exception instanceof HttpException) {
      const body = exception.getResponse();
      const payload = typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : { message: body };
      res.status(exception.getStatus()).json({ error: { code: (payload.code as string) ?? ErrorCode.INTERNAL, message: (payload.message as string) ?? '请求失败', requestId } });
      return;
    }
    this.logger.error({ requestId, stack: (exception as Error)?.stack }, '未捕获异常');
    res.status(HttpStatus.INTERNAL_SERVER_ERROR).json({ error: { code: ErrorCode.INTERNAL, message: '服务器内部错误', requestId } });
  }

  private httpStatusOf(code: string): number {
    switch (code) {
      case 'VALIDATION_ERROR': return HttpStatus.BAD_REQUEST;
      case 'UNAUTHORIZED': return HttpStatus.UNAUTHORIZED;
      case 'FORBIDDEN': return HttpStatus.FORBIDDEN;
      case 'NOT_FOUND': return HttpStatus.NOT_FOUND;
      case 'QUOTA_EXCEEDED': case 'RATE_LIMITED': return HttpStatus.TOO_MANY_REQUESTS;
      case 'TASK_NOT_CANCELLABLE': return HttpStatus.CONFLICT;
      default: return HttpStatus.BAD_GATEWAY; // provider 类错误
    }
  }
}
```

`apps/api/src/modules/health/health.controller.ts`：
```ts
import { Controller, Get, InternalServerErrorException } from '@nestjs/common';

@Controller('health')
export class HealthController {
  @Get()
  check() { return { status: 'ok' }; }

  @Get('boom') // 仅用于 e2e 验证统一错误 envelope
  boom() { throw new InternalServerErrorException('boom'); }
}
```

`apps/api/src/modules/health/health.module.ts`：
```ts
import { Module } from '@nestjs/common';
import { HealthController } from './health.controller';

@Module({ controllers: [HealthController] })
export class HealthModule {}
```

`apps/api/src/app.module.ts`：
```ts
import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { LoggerModule } from 'nestjs-pino';
import { randomUUID } from 'node:crypto';
import { PrismaModule } from './modules/prisma/prisma.module';
import { HealthModule } from './modules/health/health.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, envFilePath: ['.env', '../../.env'] }),
    LoggerModule.forRoot({
      pinoHttp: {
        level: process.env.LOG_LEVEL ?? 'info',
        transport: process.env.NODE_ENV === 'production' ? undefined : { target: 'pino-pretty', options: { singleLine: true } },
        genReqId: (req, res) => {
          const id = (req.headers['x-request-id'] as string) ?? randomUUID();
          res.setHeader('X-Request-Id', id);
          return id;
        },
        redact: ['req.headers.authorization', 'req.headers.cookie', 'apiKey'],
        autoLogging: { ignore: (req) => req.url === '/api/v1/health' },
      },
    }),
    PrismaModule,
    HealthModule,
  ],
})
export class AppModule {}
```

`apps/api/src/main.ts`：
```ts
import { NestFactory } from '@nestjs/core';
import { Logger } from 'nestjs-pino';
import helmet from 'helmet';
import { AppModule } from './app.module';
import { GlobalExceptionFilter } from './common/filters/global-exception.filter';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { bufferLogs: true });
  app.useLogger(app.get(Logger));
  app.use(helmet());
  app.enableCors({
    origin: (process.env.CORS_ORIGINS ?? 'http://localhost:3000').split(','),
    credentials: true,
  });
  app.setGlobalPrefix('api/v1');
  app.useGlobalFilters(new GlobalExceptionFilter());
  const port = Number(process.env.API_PORT ?? 3001);
  await app.listen(port);
  console.log(`API 已启动: http://localhost:${port}/api/v1/health`);
}
bootstrap();
```

- [ ] **Step 4: 运行测试确认通过**

Run: `cd /c/Users/87474/Desktop/agent/apps/api && pnpm exec vitest run test/health.e2e-spec.ts`
Expected: 2 个测试 PASS。
> 注：AppModule 引入 PrismaModule 会连接数据库——e2e 需 compose 的 postgres 运行中。

- [ ] **Step 5: 启动冒烟**

Run: `cd /c/Users/87474/Desktop/agent/apps/api && pnpm dev`（后台），然后 `curl -s http://localhost:3001/api/v1/health`
Expected: `{"status":"ok"}`；然后停止 dev 进程。

- [ ] **Step 6: 提交**

```bash
git add -A && git commit -m "feat(api): NestJS 骨架（pino 日志/requestId/全局错误/健康检查）"
```

---

### Task 6: crypto（AES-256-GCM）

**Files:**
- Create: `src/core/crypto/crypto.service.ts`、`src/core/crypto/crypto.service.spec.ts`

- [ ] **Step 1: 写失败测试**

`apps/api/src/core/crypto/crypto.service.spec.ts`：
```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { CryptoService } from './crypto.service';

const KEY = 'dGVzdC1rZXktMzItYnl0ZXMtbG9uZy1hYmNkZWY='; // base64 32 字节

describe('CryptoService', () => {
  let svc: CryptoService;
  beforeEach(() => { svc = new CryptoService(KEY); });

  it('加解密往返一致', () => {
    const plain = 'sk-test-api-key-12345';
    expect(svc.decrypt(svc.encrypt(plain))).toBe(plain);
  });

  it('每次加密产生不同密文（随机 IV）', () => {
    const a = svc.encrypt('same'); const b = svc.encrypt('same');
    expect(a).not.toBe(b);
  });

  it('密文被篡改后解密抛错', () => {
    const c = svc.encrypt('secret');
    const tampered = c.slice(0, -4) + 'AAAA';
    expect(() => svc.decrypt(tampered)).toThrow();
  });

  it('密钥非 32 字节时报错', () => {
    expect(() => new CryptoService('too-short')).toThrow();
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `cd /c/Users/87474/Desktop/agent/apps/api && pnpm exec vitest run src/core/crypto`
Expected: FAIL——模块不存在。

- [ ] **Step 3: 实现**

`apps/api/src/core/crypto/crypto.service.ts`：
```ts
import { Injectable } from '@nestjs/common';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const ALGO = 'aes-256-gcm';

@Injectable()
export class CryptoService {
  private readonly key: Buffer;

  /** keyBase64 来自环境变量 ENCRYPTION_KEY（openssl rand -base64 32） */
  constructor(keyBase64: string) {
    const key = Buffer.from(keyBase64, 'base64');
    if (key.length !== 32) throw new Error('ENCRYPTION_KEY 必须是 base64 编码的 32 字节密钥');
    this.key = key;
  }

  encrypt(plain: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv(ALGO, this.key, iv);
    const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return [iv, tag, enc].map((b) => b.toString('base64')).join('.');
  }

  decrypt(payload: string): string {
    const [ivB64, tagB64, dataB64] = payload.split('.');
    if (!ivB64 || !tagB64 || !dataB64) throw new Error('密文格式非法');
    const decipher = createDecipheriv(ALGO, this.key, Buffer.from(ivB64, 'base64'));
    decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(dataB64, 'base64')), decipher.final()]).toString('utf8');
  }
}
```

`apps/api/src/core/crypto/crypto.module.ts`：
```ts
import { Global, Module } from '@nestjs/common';
import { CryptoService } from './crypto.service';

@Global()
@Module({
  providers: [{ provide: CryptoService, useFactory: () => new CryptoService(process.env.ENCRYPTION_KEY ?? '') }],
  exports: [CryptoService],
})
export class CryptoModule {}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `cd /c/Users/87474/Desktop/agent/apps/api && pnpm exec vitest run src/core/crypto`
Expected: 4 个测试 PASS。

- [ ] **Step 5: 提交**

```bash
git add -A && git commit -m "feat(api): crypto 服务（AES-256-GCM，API Key 落库加密）"
```

---

### Task 7: LLM Provider 层（接口 + 适配器 + 注册表）

**Files:**
- Create: `src/providers/llm/llm.types.ts`、`src/providers/llm/errors.ts`、`src/providers/llm/errors.spec.ts`、`src/providers/llm/adapters/openai-compatible.adapter.ts`、`src/providers/llm/adapters/openai-compatible.adapter.spec.ts`、`src/providers/llm/adapters/mock.adapter.ts`、`src/providers/llm/adapters/mock.adapter.spec.ts`、`src/providers/llm/llm-manager.service.ts`、`src/providers/llm/llm-manager.service.spec.ts`
- Modify: `src/app.module.ts`（挂载 ProvidersModule + CryptoModule）

- [ ] **Step 1: 写失败测试（errors.spec.ts）**

```ts
import { describe, it, expect } from 'vitest';
import { mapProviderError, toChatError } from './errors';

describe('mapProviderError', () => {
  it('429 → PROVIDER_RATE_LIMITED 可重试', () => {
    const err = mapProviderError(Object.assign(new Error('rate'), { status: 429 }));
    expect(err.code).toBe('PROVIDER_RATE_LIMITED'); expect(err.retryable).toBe(true);
  });
  it('401 → PROVIDER_AUTH 不可重试', () => {
    const err = mapProviderError(Object.assign(new Error('auth'), { status: 401 }));
    expect(err.code).toBe('PROVIDER_AUTH'); expect(err.retryable).toBe(false);
  });
  it('400 → PROVIDER_BAD_REQUEST 不可重试', () => {
    const err = mapProviderError(Object.assign(new Error('bad'), { status: 400 }));
    expect(err.code).toBe('PROVIDER_BAD_REQUEST'); expect(err.retryable).toBe(false);
  });
  it('5xx → PROVIDER_OVERLOADED 可重试', () => {
    const err = mapProviderError(Object.assign(new Error('boom'), { status: 503 }));
    expect(err.code).toBe('PROVIDER_OVERLOADED'); expect(err.retryable).toBe(true);
  });
  it('AbortError → PROVIDER_TIMEOUT 可重试', () => {
    const err = mapProviderError(Object.assign(new Error('aborted'), { name: 'AbortError' }));
    expect(err.code).toBe('PROVIDER_TIMEOUT'); expect(err.retryable).toBe(true);
  });
  it('未知错误 → PROVIDER_UNKNOWN 不可重试', () => {
    const err = mapProviderError(new Error('?'));
    expect(err.code).toBe('PROVIDER_UNKNOWN'); expect(err.retryable).toBe(false);
  });
});

describe('toChatError', () => {
  it('把任意异常包装为 AppError', () => {
    const err = toChatError(Object.assign(new Error('x'), { status: 429 }), 'req_9');
    expect(err.code).toBe('PROVIDER_RATE_LIMITED'); expect(err.requestId).toBe('req_9');
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `cd /c/Users/87474/Desktop/agent/apps/api && pnpm exec vitest run src/providers/llm/errors.spec.ts`
Expected: FAIL。

- [ ] **Step 3: 实现类型与错误映射**

`apps/api/src/providers/llm/llm.types.ts`（与架构文档 §6.1 一致）：
```ts
export type ContentPart = { type: 'text'; text: string } | { type: 'image'; imageUrl: string };

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string | ContentPart[];
}

export interface ChatParams {
  model: string;
  messages: ChatMessage[];
  temperature?: number;
  maxTokens?: number;
  responseFormat?: { type: 'json_object' | 'json_schema'; schema?: unknown };
  signal?: AbortSignal;
}

export interface ChatUsage { inputTokens: number; outputTokens: number; }

export interface ChatResponse { content: string; usage?: ChatUsage; }

export type LLMChunk = { type: 'text'; text: string } | { type: 'usage'; usage: ChatUsage };

export interface LLMProvider {
  readonly kind: 'llm';
  chat(params: ChatParams): Promise<ChatResponse>;
  stream(params: ChatParams): AsyncIterable<LLMChunk>;
}
```

`apps/api/src/providers/llm/errors.ts`：
```ts
import { AppError, ErrorCode } from '../../common/errors/app-error';

interface ProviderLikeError extends Error { status?: number; code?: string; name?: string; }

/** 厂商错误 → 归一化 AppError（retryable 标记驱动回退/熔断决策） */
export function mapProviderError(err: ProviderLikeError): AppError {
  if (err.name === 'AbortError' || err.code === 'ETIMEDOUT' || err.code === 'ECONNRESET') {
    return new AppError(ErrorCode.PROVIDER_TIMEOUT, '模型请求超时');
  }
  switch (err.status) {
    case 429: return new AppError(ErrorCode.PROVIDER_RATE_LIMITED, '模型服务限流');
    case 401: case 403: return new AppError(ErrorCode.PROVIDER_AUTH, '模型服务鉴权失败');
    case 400: case 404: case 422: return new AppError(ErrorCode.PROVIDER_BAD_REQUEST, '模型请求参数错误');
    case 500: case 502: case 503: case 504: return new AppError(ErrorCode.PROVIDER_OVERLOADED, '模型服务过载');
    default: return new AppError(ErrorCode.PROVIDER_UNKNOWN, err.message || '模型服务未知错误');
  }
}

export function toChatError(err: unknown, requestId?: string): AppError {
  if (err instanceof AppError) return err;
  return mapProviderError(err as ProviderLikeError);
}
```

- [ ] **Step 4: 适配器测试（先写）**

> 说明：adapter 构造函数直接接收注入的 `chat`/`stream` 函数（而非整个 client），便于测试。

`apps/api/src/providers/llm/adapters/openai-compatible.adapter.spec.ts`：

```ts
import { describe, it, expect } from 'vitest';
import { OpenAICompatibleAdapter } from './openai-compatible.adapter';
import { ChatParams } from '../llm.types';

const cfg = { baseUrl: 'https://x.test/v1', apiKey: 'sk-test', timeoutMs: 1000 };
const params: ChatParams = { model: 'm1', messages: [{ role: 'user', content: '你好' }] };

describe('OpenAICompatibleAdapter', () => {
  it('chat 返回内容与 usage', async () => {
    const adapter = new OpenAICompatibleAdapter(cfg, {
      chat: async (p) => {
        expect(p.model).toBe('m1');
        return { choices: [{ message: { content: '你好！' } }], usage: { prompt_tokens: 3, completion_tokens: 2 } };
      },
    });
    const r = await adapter.chat(params);
    expect(r.content).toBe('你好！');
    expect(r.usage).toEqual({ inputTokens: 3, outputTokens: 2 });
  });

  it('stream 逐块输出 text', async () => {
    const adapter = new OpenAICompatibleAdapter(cfg, {
      stream: async function* () {
        yield { choices: [{ delta: { content: '你' } }] };
        yield { choices: [{ delta: { content: '好' } }] };
      },
    });
    const chunks = [];
    for await (const c of adapter.stream(params)) chunks.push(c);
    expect(chunks).toEqual([{ type: 'text', text: '你' }, { type: 'text', text: '好' }]);
  });

  it('stream 异常经 mapProviderError 归一化', async () => {
    const adapter = new OpenAICompatibleAdapter(cfg, {
      stream: async function* () { throw Object.assign(new Error('limited'), { status: 429 }); },
    });
    const it = adapter.stream(params)[Symbol.asyncIterator]();
    await expect(it.next()).rejects.toMatchObject({ code: 'PROVIDER_RATE_LIMITED', retryable: true });
  });

  it('messages 透传多模态 content', async () => {
    const adapter = new OpenAICompatibleAdapter(cfg, {
      chat: async (p) => {
        expect(p.messages[0].content).toEqual([{ type: 'image', image_url: { url: 'http://x/a.png' } }, { type: 'text', text: '分析' }]);
        return { choices: [{ message: { content: 'ok' } }] };
      },
    });
    await adapter.chat({ model: 'm1', messages: [{ role: 'user', content: [{ type: 'image', imageUrl: 'http://x/a.png' }, { type: 'text', text: '分析' }] }] });
  });
});
```

`apps/api/src/providers/llm/adapters/mock.adapter.spec.ts`：
```ts
import { describe, it, expect } from 'vitest';
import { MockLLMAdapter } from './mock.adapter';

describe('MockLLMAdapter', () => {
  it('chat 返回固定回复', async () => {
    const a = new MockLLMAdapter();
    const r = await a.chat({ model: 'm', messages: [{ role: 'user', content: 'hi' }] });
    expect(r.content).toContain('mock');
    expect(r.usage).toEqual({ inputTokens: 1, outputTokens: 1 });
  });

  it('stream 输出多个 text chunk 后结束', async () => {
    const a = new MockLLMAdapter();
    const chunks = [];
    for await (const c of a.stream({ model: 'm', messages: [{ role: 'user', content: 'hi' }] })) chunks.push(c);
    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks.every((c) => c.type === 'text')).toBe(true);
    expect(chunks.map((c) => (c.type === 'text' ? c.text : '')).join('')).toContain('mock');
  });
});
```

- [ ] **Step 5: 实现适配器**

`apps/api/src/providers/llm/adapters/openai-compatible.adapter.ts`：
```ts
import OpenAI from 'openai';
import { ChatMessage, ChatParams, ChatResponse, LLMChunk, LLMProvider } from '../llm.types';
import { mapProviderError } from '../errors';

export interface OpenAICompatibleConfig { baseUrl: string; apiKey: string; timeoutMs: number; }

type ChatFn = (body: Record<string, unknown>) => Promise<Record<string, unknown>>;
type StreamFn = (body: Record<string, unknown>) => Promise<AsyncIterable<Record<string, unknown>>>;

/** OpenAI / DeepSeek / Kimi / 阿里百炼 / 火山方舟 / 智谱 六家共用一个 adapter（baseUrl + key 配置化） */
export class OpenAICompatibleAdapter implements LLMProvider {
  readonly kind = 'llm' as const;
  private readonly chatFn: ChatFn;
  private readonly streamFn: StreamFn;

  constructor(cfg: OpenAICompatibleConfig, injected?: { chat?: ChatFn; stream?: StreamFn }) {
    const client = new OpenAI({ baseURL: cfg.baseUrl, apiKey: cfg.apiKey, timeout: cfg.timeoutMs, maxRetries: 0 });
    this.chatFn = injected?.chat ?? (async (body) => (await client.chat.completions.create(body as never)) as unknown as Record<string, unknown>);
    this.streamFn = injected?.stream ?? (async (body) => (await client.chat.completions.create({ ...body, stream: true } as never)) as unknown as AsyncIterable<Record<string, unknown>>);
  }

  async chat(params: ChatParams): Promise<ChatResponse> {
    try {
      const r = await this.chatFn(this.buildBody(params, false));
      const choice = (r.choices as Array<{ message?: { content?: string } }>)?.[0];
      const usage = r.usage as { prompt_tokens?: number; completion_tokens?: number } | undefined;
      return {
        content: choice?.message?.content ?? '',
        usage: usage ? { inputTokens: usage.prompt_tokens ?? 0, outputTokens: usage.completion_tokens ?? 0 } : undefined,
      };
    } catch (err) { throw mapProviderError(err as Error); }
  }

  async *stream(params: ChatParams): AsyncIterable<LLMChunk> {
    try {
      const s = await this.streamFn(this.buildBody(params, true));
      for await (const chunk of s) {
        const delta = (chunk.choices as Array<{ delta?: { content?: string } }>)?.[0]?.delta?.content;
        if (delta) yield { type: 'text', text: delta };
      }
    } catch (err) { throw mapProviderError(err as Error); }
  }

  private buildBody(p: ChatParams, isStream: boolean): Record<string, unknown> {
    const body: Record<string, unknown> = {
      model: p.model,
      messages: p.messages.map((m) => ({ role: m.role, content: this.mapContent(m) })),
      stream: isStream,
    };
    if (p.temperature != null) body.temperature = p.temperature;
    if (p.maxTokens != null) body.max_tokens = p.maxTokens;
    if (p.responseFormat) {
      body.response_format = p.responseFormat.type === 'json_schema' && p.responseFormat.schema
        ? { type: 'json_schema', json_schema: { name: 'intent', strict: true, schema: p.responseFormat.schema } }
        : { type: 'json_object' };
    }
    if (p.signal) body.signal = p.signal;
    return body;
  }

  private mapContent(m: ChatMessage): unknown {
    if (typeof m.content === 'string') return m.content;
    return m.content.map((part) =>
      part.type === 'text' ? { type: 'text', text: part.text } : { type: 'image_url', image_url: { url: part.imageUrl } },
    );
  }
}
```

`apps/api/src/providers/llm/adapters/mock.adapter.ts`：
```ts
import { ChatParams, ChatResponse, LLMChunk, LLMProvider } from '../llm.types';

/** 开发/测试用 echo 适配器（无真实 API Key 时跑通全链路） */
export class MockLLMAdapter implements LLMProvider {
  readonly kind = 'llm' as const;

  async chat(params: ChatParams): Promise<ChatResponse> {
    return { content: this.reply(params), usage: { inputTokens: 1, outputTokens: 1 } };
  }

  async *stream(params: ChatParams): AsyncIterable<LLMChunk> {
    const text = this.reply(params);
    for (const ch of text) yield { type: 'text', text: ch };
  }

  private reply(params: ChatParams): string {
    const q = typeof params.messages.at(-1)?.content === 'string' ? params.messages.at(-1)!.content : '(多模态)';
    return `[mock] 收到你的消息："${q}"。这是本地 mock 模型回复，配置真实 Provider 后即可获得真实回答。`;
  }
}
```

- [ ] **Step 6: 运行测试确认通过**

Run: `cd /c/Users/87474/Desktop/agent/apps/api && pnpm exec vitest run src/providers/llm`
Expected: 全部 PASS（errors 5+1、openai-compatible 4、mock 2）。

- [ ] **Step 7: LLM Manager（注册表：DB 配置 → 实例）**

`apps/api/src/providers/llm/llm-manager.service.ts`：
```ts
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../../modules/prisma/prisma.service';
import { CryptoService } from '../../core/crypto/crypto.service';
import { LLMProvider } from './llm.types';
import { OpenAICompatibleAdapter } from './adapters/openai-compatible.adapter';
import { MockLLMAdapter } from './adapters/mock.adapter';

export interface ResolvedLLM { providerId: string; providerName: string; modelId: string; apiModelId: string; adapter: LLMProvider; timeoutMs: number; }

@Injectable()
export class LLMManagerService implements OnModuleInit {
  private readonly logger = new Logger('LLMManager');
  private providers = new Map<string, LLMProvider>();

  constructor(private readonly prisma: PrismaService, private readonly crypto: CryptoService) {}

  async onModuleInit() { await this.refresh(); }

  /** 从 DB 重建所有启用 LLM provider 实例（后台变更后调用） */
  async refresh(): Promise<void> {
    const rows = await this.prisma.provider.findMany({ where: { type: 'llm' } });
    const next = new Map<string, LLMProvider>();
    for (const row of rows) {
      const apiKey = row.apiKeyEncrypted ? this.crypto.decrypt(row.apiKeyEncrypted) : '';
      try {
        next.set(row.id, this.buildAdapter(row.adapter, { baseUrl: row.baseUrl, apiKey, timeoutMs: row.timeoutMs }));
      } catch (err) {
        this.logger.error(`provider ${row.name} 初始化失败: ${(err as Error).message}`);
      }
    }
    this.providers = next;
    this.logger.log(`LLM providers 已加载: ${this.providers.size} 个`);
  }

  /** 按 modelId 解析出可调用的组合（provider + adapter + api_model_id） */
  async resolve(modelId: string): Promise<ResolvedLLM> {
    const model = await this.prisma.model.findUnique({ where: { id: modelId }, include: { provider: true } });
    if (!model || !model.enabled || !model.provider.enabled) throw new Error(`模型不可用: ${modelId}`);
    const adapter = this.providers.get(model.providerId);
    if (!adapter) throw new Error(`provider 未加载: ${model.providerId}`);
    return {
      providerId: model.providerId, providerName: model.provider.name,
      modelId: model.id, apiModelId: model.apiModelId,
      adapter, timeoutMs: model.provider.timeoutMs,
    };
  }

  getProvider(providerId: string): LLMProvider | undefined { return this.providers.get(providerId); }

  private buildAdapter(name: string, cfg: { baseUrl: string; apiKey: string; timeoutMs: number }): LLMProvider {
    switch (name) {
      case 'openai-compatible': return new OpenAICompatibleAdapter(cfg);
      case 'mock': return new MockLLMAdapter();
      default: throw new Error(`未知 LLM adapter: ${name}`);
    }
  }
}
```

`apps/api/src/providers/providers.module.ts`：
```ts
import { Global, Module } from '@nestjs/common';
import { LLMManagerService } from './llm/llm-manager.service';

@Global()
@Module({ providers: [LLMManagerService], exports: [LLMManagerService] })
export class ProvidersModule {}
```

- [ ] **Step 8: manager 测试**

`apps/api/src/providers/llm/llm-manager.service.spec.ts`：
```ts
import { describe, it, expect, vi } from 'vitest';
import { LLMManagerService } from './llm-manager.service';

function makeManager() {
  const prisma = {
    provider: { findMany: vi.fn().mockResolvedValue([
      { id: 'p1', name: 'Test', type: 'llm', adapter: 'mock', baseUrl: '', apiKeyEncrypted: '', timeoutMs: 1000, enabled: true },
    ]) },
    model: { findUnique: vi.fn().mockResolvedValue({
      id: 'm1', apiModelId: 'mock-echo', enabled: true,
      provider: { id: 'p1', name: 'Test', enabled: true },
    }) },
  };
  const crypto = { decrypt: vi.fn().mockReturnValue('sk-x') };
  return { svc: new LLMManagerService(prisma as never, crypto as never), prisma };
}

describe('LLMManagerService', () => {
  it('refresh 加载 mock provider', async () => {
    const { svc } = makeManager();
    await svc.refresh();
    expect(svc.getProvider('p1')).toBeTruthy();
  });

  it('resolve 返回 adapter + apiModelId', async () => {
    const { svc } = makeManager();
    await svc.refresh();
    const r = await svc.resolve('m1');
    expect(r.apiModelId).toBe('mock-echo');
    expect(r.adapter.kind).toBe('llm');
  });

  it('resolve 不存在的模型抛错', async () => {
    const { svc, prisma } = makeManager();
    await svc.refresh();
    (prisma.model.findUnique as ReturnType<typeof vi.fn>).mockResolvedValueOnce(null);
    await expect(svc.resolve('nope')).rejects.toThrow('模型不可用');
  });
});
```

- [ ] **Step 9: 挂载模块 + 运行全部测试**

Modify `apps/api/src/app.module.ts` imports：`imports: [ ..., CryptoModule, ProvidersModule, ... ]`。

Run: `cd /c/Users/87474/Desktop/agent/apps/api && pnpm exec vitest run`
Expected: 全部 PASS（health e2e 2 + crypto 4 + llm 12）。

- [ ] **Step 10: 提交**

```bash
git add -A && git commit -m "feat(api): LLM Provider 层（接口/错误归一/openai-compatible 六厂商适配器/mock/注册表）"
```

---

### Task 8: Agent 层 + AI Router + CircuitBreaker + ModelRouter

**Files:**
- Create: `src/agents/agent.types.ts`、`src/agents/agent.registry.ts`、`src/agents/chat/chat.agent.ts`、`src/agents/chat/chat.agent.spec.ts`、`src/core/router/router.service.ts`、`src/core/router/router.service.spec.ts`、`src/core/circuit-breaker/kv-store.interface.ts`、`src/core/circuit-breaker/redis-kv.service.ts`、`src/core/circuit-breaker/circuit-breaker.service.ts`、`src/core/circuit-breaker/circuit-breaker.service.spec.ts`、`src/core/model-router/model-router.service.ts`、`src/core/model-router/model-router.service.spec.ts`

- [ ] **Step 1: 写失败测试（chat.agent.spec.ts + router.service.spec.ts）**

`apps/api/src/agents/chat/chat.agent.spec.ts`：
```ts
import { describe, it, expect } from 'vitest';
import { ChatAgent } from './chat.agent';
import { AgentContext } from '../agent.types';
import { AppError } from '../../common/errors/app-error';

const ctx = (over: Partial<AgentContext> = {}): AgentContext => ({
  userId: 'u1', conversationId: 'c1', messageId: 'm1', userMessage: '你好',
  attachments: [], history: [],
  intent: { type: 'chat', confidence: 0.99, parameters: { prompt: '你好' } },
  mode: 'normal', ...over,
});

describe('ChatAgent', () => {
  it('输出 status → text.delta… → done 事件序列', async () => {
    const agent = new ChatAgent({
      stream: async function* () { yield { type: 'text', text: '你' }; yield { type: 'text', text: '好' }; },
      chat: async () => ({ content: '' }),
    });
    const events = [];
    for await (const e of agent.execute(ctx())) events.push(e);
    expect(events[0]).toMatchObject({ type: 'status', stage: 'llm' });
    expect(events.filter((e) => e.type === 'text.delta')).toHaveLength(2);
    expect(events.at(-1)).toMatchObject({ type: 'done' });
  });

  it('provider 出错 → error 事件且不再有 done', async () => {
    const agent = new ChatAgent({
      stream: async function* () { throw new AppError('PROVIDER_TIMEOUT', '超时'); },
      chat: async () => ({ content: '' }),
    });
    const events = [];
    for await (const e of agent.execute(ctx())) events.push(e);
    const err = events.find((e) => e.type === 'error');
    expect(err).toMatchObject({ code: 'PROVIDER_TIMEOUT' });
    expect(events.some((e) => e.type === 'done')).toBe(false);
  });

  it('history 注入 systemPrompt 并排在历史之前', async () => {
    let captured: unknown;
    const agent = new ChatAgent({
      stream: async function* () { yield { type: 'text', text: 'x' }; },
      chat: async () => ({ content: '' }),
    }, { systemPrompt: '你是电商助手', resolveLLM: async () => ({ adapter: { kind: 'llm', chat: async (p: unknown) => { captured = p; return { content: '' }; }, stream: async function* () { yield { type: 'text', text: 'x' }; } } as never, apiModelId: 'm', timeoutMs: 1000, providerId: 'p', providerName: 'p', modelId: 'm1' }) });
    await agent.execute(ctx({ history: [{ role: 'user', content: '上一条' }] }));
    const p = captured as { messages: Array<{ role: string; content: string }> };
    expect(p.messages[0]).toEqual({ role: 'system', content: '你是电商助手' });
    expect(p.messages[1]).toEqual({ role: 'user', content: '上一条' });
  });
});
```

`apps/api/src/core/router/router.service.spec.ts`：
```ts
import { describe, it, expect } from 'vitest';
import { RouterService } from './router.service';
import { ChatMessage, LLMProvider } from '../../providers/llm/llm.types';

function makeRouter(llm: LLMProvider, threshold = 0.7) {
  return new RouterService({ resolve: async () => ({ adapter: llm, apiModelId: 'm', timeoutMs: 1000, providerId: 'p', providerName: 'p', modelId: 'm1' }) } as never, { get: async () => ({ confidenceThreshold: threshold, routerModelId: 'rm' }) } as never);
}

describe('RouterService', () => {
  const fakeLLM = (reply: string): LLMProvider => ({
    kind: 'llm',
    chat: async () => ({ content: reply }),
    stream: async function* () { yield { type: 'text', text: reply }; },
  });

  it('高置信度意图直接返回', async () => {
    const r = makeRouter(fakeLLM(JSON.stringify({ type: 'image_generation', confidence: 0.98, parameters: { prompt: '科技感插排广告图', aspectRatio: '1:1' } })));
    const intent = await r.classify({ userMessage: '生成一张科技感插排广告图', attachments: [], history: [] });
    expect(intent.type).toBe('image_generation');
  });

  it('低于阈值降级为 chat', async () => {
    const r = makeRouter(fakeLLM(JSON.stringify({ type: 'video_generation', confidence: 0.3, parameters: { prompt: 'x' } })));
    const intent = await r.classify({ userMessage: '随便聊聊', attachments: [], history: [] });
    expect(intent.type).toBe('chat');
  });

  it('LLM 返回非法 JSON → 重试后仍非法 → chat 兜底', async () => {
    let calls = 0;
    const badLLM: LLMProvider = {
      kind: 'llm',
      chat: async () => { calls++; return { content: '不是JSON' }; },
      stream: async function* () {},
    };
    const r = makeRouter(badLLM);
    const intent = await r.classify({ userMessage: 'hi', attachments: [], history: [] });
    expect(calls).toBe(2); // 1 次原始 + 1 次重试
    expect(intent.type).toBe('chat');
  });

  it('LLM 直接抛错 → chat 兜底（Router 永不阻塞聊天）', async () => {
    const broken: LLMProvider = {
      kind: 'llm',
      chat: async () => { throw new Error('provider down'); },
      stream: async function* () {},
    };
    const r = makeRouter(broken);
    const intent = await r.classify({ userMessage: 'hi', attachments: [], history: [] });
    expect(intent.type).toBe('chat');
  });

  it('无文字 + 单图片附件 → 快路径 image_analysis', async () => {
    let called = false;
    const spy: LLMProvider = { kind: 'llm', chat: async () => { called = true; return { content: '{}' }; }, stream: async function* () {} };
    const r = makeRouter(spy);
    const intent = await r.classify({ userMessage: '', attachments: [{ type: 'image' }], history: [] });
    expect(intent.type).toBe('image_analysis');
    expect(called).toBe(false);
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `cd /c/Users/87474/Desktop/agent/apps/api && pnpm exec vitest run src/agents src/core/router`
Expected: FAIL——模块不存在。

- [ ] **Step 3: 实现 Agent 层**

`apps/api/src/agents/agent.types.ts`：
```ts
import { AgentEvent, TaskIntent } from '@ai-agent/shared';
import { ChatMessage } from '../providers/llm/llm.types';

export interface AttachmentMeta { id: string; type: 'image' | 'video' | 'file'; mimeType: string; url: string; }

export interface AgentContext {
  userId: string;
  conversationId: string;
  messageId: string;
  userMessage: string;
  attachments: AttachmentMeta[];
  history: ChatMessage[];
  intent: TaskIntent;
  mode: 'normal' | 'thinking';
}

export interface Agent {
  readonly id: string;
  execute(ctx: AgentContext): AsyncIterable<AgentEvent>;
}
```

`apps/api/src/agents/agent.registry.ts`：
```ts
import { Injectable } from '@nestjs/common';
import { Agent } from './agent.types';

@Injectable()
export class AgentRegistry {
  private readonly agents = new Map<string, Agent>();

  register(agent: Agent): void {
    if (this.agents.has(agent.id)) throw new Error(`Agent 重复注册: ${agent.id}`);
    this.agents.set(agent.id, agent);
  }

  get(id: string): Agent | undefined { return this.agents.get(id); }
  list(): Agent[] { return [...this.agents.values()]; }
}
```

`apps/api/src/agents/chat/chat.agent.ts`：
```ts
import { AgentEvent } from '@ai-agent/shared';
import { LLMManagerService } from '../../providers/llm/llm-manager.service';
import { ChatMessage, LLMProvider } from '../../providers/llm/llm.types';
import { Agent, AgentContext } from '../agent.types';

export interface ChatAgentOptions {
  systemPrompt?: string;
  resolveLLM?: (ctx: AgentContext) => Promise<{ adapter: LLMProvider; apiModelId: string }>;
}

/** 通用聊天 Agent：LLM 流式输出（支持多模态附件 → vision 模型） */
export class ChatAgent implements Agent {
  readonly id = 'chat';
  constructor(
    private readonly deps: { llmManager: LLMManagerService },
    private readonly options: ChatAgentOptions = {},
  ) {}

  async *execute(ctx: AgentContext): AsyncIterable<AgentEvent> {
    yield { type: 'status', stage: 'llm', message: '正在生成回答…' };
    try {
      const { adapter, apiModelId } = this.options.resolveLLM
        ? await this.options.resolveLLM(ctx)
        : await this.resolveDefault(ctx);
      const messages = this.buildMessages(ctx);
      const stream = adapter.stream({ model: apiModelId, messages, temperature: 0.7, signal: undefined });
      for await (const chunk of stream) {
        if (chunk.type === 'text') yield { type: 'text.delta', text: chunk.text };
      }
      yield { type: 'done', messageId: ctx.messageId };
    } catch (err) {
      const e = err as { code?: string; message?: string };
      yield { type: 'error', code: e.code ?? 'PROVIDER_UNKNOWN', message: e.message ?? '生成失败' };
    }
  }

  private async resolveDefault(ctx: AgentContext): Promise<{ adapter: LLMProvider; apiModelId: string }> {
    // 默认模型解析在 M4 接线（读 routingPolicy.defaults.llm）；M4 之前必须通过 options.resolveLLM 注入
    throw new Error(`ChatAgent 未配置 resolveLLM（conversationId=${ctx.conversationId}），M4 接线后启用默认模型解析`);
  }

  private buildMessages(ctx: AgentContext): ChatMessage[] {
    const parts: ChatMessage[] = [];
    if (this.options.systemPrompt) parts.push({ role: 'system', content: this.options.systemPrompt });
    parts.push(...ctx.history);
    if (ctx.attachments.length > 0 && ctx.userMessage) {
      const content = [
        ...ctx.attachments.filter((a) => a.type === 'image').map((a) => ({ type: 'image' as const, imageUrl: a.url })),
        { type: 'text' as const, text: ctx.userMessage },
      ];
      parts.push({ role: 'user', content });
    } else {
      parts.push({ role: 'user', content: ctx.userMessage });
    }
    return parts;
  }
}
```

> 注：测试中 ChatAgent 通过 options.resolveLLM 注入 fake；生产路径走 llmManager.resolve。`ctx.intent.modelId` 在 M4 接线（TaskIntent 增补 modelId 字段由 Router 填充——本计划 Router 输出不含 modelId，chat agent 的 resolve 由 options 提供，M4 计划中再定默认模型解析）。

- [ ] **Step 4: 实现 Router**

`apps/api/src/core/router/router.service.ts`：
```ts
import { Injectable, Logger } from '@nestjs/common';
import { TaskIntent, TaskIntentSchema, ErrorCode } from '@ai-agent/shared';
import { PrismaService } from '../../modules/prisma/prisma.service';
import { LLMManagerService } from '../../providers/llm/llm-manager.service';
import { ChatMessage } from '../../providers/llm/llm.types';
import { AppError } from '../../common/errors/app-error';

export interface ClassifyInput {
  userMessage: string;
  attachments: Array<{ type: 'image' | 'video' | 'file' }>;
  history: ChatMessage[]; // 最近 2 轮（由 M1 chat 模块裁剪传入）
}

const FALLBACK_INTENT: TaskIntent = { type: 'chat', confidence: 1, parameters: { prompt: '' } };

@Injectable()
export class RouterService {
  private readonly logger = new Logger('Router');

  constructor(private readonly llmManager: LLMManagerService, private readonly prisma: PrismaService) {}

  async classify(input: ClassifyInput): Promise<TaskIntent> {
    // 快路径：无文字 + 单图片 → 图片理解（省一次 LLM 调用）
    if (!input.userMessage.trim() && input.attachments.length === 1 && input.attachments[0].type === 'image') {
      return { type: 'image_analysis', confidence: 1, parameters: { prompt: '' } };
    }
    const settings = await this.prisma.systemSetting.findUnique({ where: { key: 'routingPolicy' } });
    const threshold = (settings?.value as { confidenceThreshold?: number } | null)?.confidenceThreshold ?? 0.7;
    const routerModelId = (settings?.value as { routerModelId?: string | null } | null)?.routerModelId;
    if (!routerModelId) return FALLBACK_INTENT; // 未配置路由模型 → 聊天兜底

    const system = this.buildSystemPrompt();
    const messages: ChatMessage[] = [
      { role: 'system', content: system },
      ...input.history,
      { role: 'user', content: this.buildUserMessage(input) },
    ];

    try {
      const { adapter, apiModelId } = await this.llmManager.resolve(routerModelId);
      // 第一次尝试结构化输出；非法 JSON 重试一次
      for (let attempt = 0; attempt < 2; attempt++) {
        const r = await adapter.chat({ model: apiModelId, messages, temperature: 0, responseFormat: { type: 'json_object' } });
        const parsed = this.parseJSON(r.content);
        if (!parsed) continue;
        const result = TaskIntentSchema.safeParse(parsed);
        if (result.success) {
          return result.data.confidence >= threshold ? result.data : { ...FALLBACK_INTENT, parameters: { prompt: input.userMessage } };
        }
      }
      this.logger.warn('Router 结构化输出失败，降级 chat');
      return { ...FALLBACK_INTENT, parameters: { prompt: input.userMessage } };
    } catch (err) {
      this.logger.warn(`Router LLM 调用失败（${(err as Error).message}），降级 chat`);
      return { ...FALLBACK_INTENT, parameters: { prompt: input.userMessage } };
    }
  }

  private parseJSON(text: string): unknown {
    try { return JSON.parse(text); } catch { return null; }
  }

  private buildSystemPrompt(): string {
    return `你是 AI 平台的意图路由器。根据用户消息判断任务类型，只输出 JSON，不要输出其他内容。
类型枚举: chat(普通对话/知识问答/写作), image_generation(生成/设计图片、海报、插画), video_generation(生成/制作视频), image_analysis(分析图片内容), file_analysis(分析文档文件), agent_task(交给特定 Agent), workflow(多步骤任务)。
输出格式: {"type":"...","confidence":0.0~1.0,"parameters":{"prompt":"<生成或分析任务的优化提示词，chat 类型填用户原话>","aspectRatio":"可选 1:1/16:9/9:16","duration":可选秒数,"referenceMessageId":"可选，用户说换一个风格/基于上一张图时填写引用消息"}}
规则: 1) 普通问答必须归为 chat；2) 拿不准时 confidence 低于 0.7；3) parameters.prompt 必填。`;
  }

  private buildUserMessage(input: ClassifyInput): string {
    const att = input.attachments.length ? `\n附件: ${input.attachments.map((a) => a.type).join(', ')}` : '';
    const history = input.history.length ? `\n最近对话: ${JSON.stringify(input.history.map((m) => ({ role: m.role, content: typeof m.content === 'string' ? m.content.slice(0, 200) : '(多模态)' })))}` : '';
    return `用户消息: "${input.userMessage}"${att}${history}`;
  }
}
```

- [ ] **Step 5: 实现 CircuitBreaker（KV 接口 + Redis + 状态机）**

`apps/api/src/core/circuit-breaker/kv-store.interface.ts`：
```ts
/** 熔断计数用 KV 抽象（Redis 生产 / 内存 fake 测试） */
export interface KVStore {
  incr(key: string, ttlSec: number): Promise<number>;
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlSec?: number): Promise<void>;
}
```

`apps/api/src/core/circuit-breaker/redis-kv.service.ts`：
```ts
import { Injectable, OnModuleDestroy } from '@nestjs/common';
import Redis from 'ioredis';
import { KVStore } from './kv-store.interface';

@Injectable()
export class RedisKVService implements KVStore, OnModuleDestroy {
  private readonly client: Redis;
  constructor() {
    this.client = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379', { maxRetriesPerRequest: null });
  }
  async incr(key: string, ttlSec: number): Promise<number> {
    const n = await this.client.incr(key);
    if (n === 1) await this.client.expire(key, ttlSec);
    return n;
  }
  async get(key: string) { return this.client.get(key); }
  async set(key: string, value: string, ttlSec?: number) {
    if (ttlSec) await this.client.set(key, value, 'EX', ttlSec);
    else await this.client.set(key, value);
  }
  onModuleDestroy() { this.client.disconnect(); }
}
```

`apps/api/src/core/circuit-breaker/circuit-breaker.service.ts`：
```ts
import { Injectable } from '@nestjs/common';
import { KVStore } from './kv-store.interface';

export type BreakerState = 'healthy' | 'open' | 'half_open';
export interface BreakerConfig { failureThreshold?: number; cooldownSec?: number; }

const WINDOW_SEC = 60;

@Injectable()
export class CircuitBreakerService {
  constructor(private readonly kv: KVStore, private readonly now: () => number = Date.now) {}

  private key(p: string, s: string) { return `cb:${p}:${s}`; }

  async state(providerId: string, cfg: BreakerConfig = {}): Promise<BreakerState> {
    const openedAt = await this.kv.get(this.key(providerId, 'openedAt'));
    if (openedAt) {
      const cooldown = (cfg.cooldownSec ?? 60) * 1000;
      return this.now() - Number(openedAt) >= cooldown ? 'half_open' : 'open';
    }
    return 'healthy';
  }

  /** 判定该 provider 当前是否允许调用（open 拒绝；half_open 只放行一次探测——由调用方传入 isProbe） */
  async canCall(providerId: string, cfg: BreakerConfig = {}, isProbe = false): Promise<boolean> {
    const s = await this.state(providerId, cfg);
    if (s === 'healthy') return true;
    if (s === 'half_open') return isProbe;
    return false;
  }

  async recordSuccess(providerId: string): Promise<void> {
    await this.kv.set(this.key(providerId, 'consecutiveFailures'), '0', WINDOW_SEC);
    await this.kv.set(this.key(providerId, 'openedAt'), '', WINDOW_SEC); // 清除标记
    await this.kv.incr(this.key(providerId, 'success'), WINDOW_SEC);
  }

  async recordFailure(providerId: string, cfg: BreakerConfig = {}): Promise<boolean> {
    const fails = await this.kv.incr(this.key(providerId, 'consecutiveFailures'), WINDOW_SEC);
    const openedAt = await this.kv.get(this.key(providerId, 'openedAt'));
    if (!openedAt && fails >= (cfg.failureThreshold ?? 5)) {
      await this.kv.set(this.key(providerId, 'openedAt'), String(this.now()));
      return true; // 本次触发熔断
    }
    return false;
  }
}
```

- [ ] **Step 6: CircuitBreaker 测试**

`apps/api/src/core/circuit-breaker/circuit-breaker.service.spec.ts`：
```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { CircuitBreakerService } from './circuit-breaker.service';
import { KVStore } from './kv-store.interface';

class FakeKV implements KVStore {
  store = new Map<string, { v: string; expireAt: number }>();
  now = 0;
  async incr(key: string) { const cur = this.store.get(key); const n = (cur ? Number(cur.v) : 0) + 1; this.store.set(key, { v: String(n), expireAt: this.now + 60_000 }); return n; }
  async get(key: string) { const e = this.store.get(key); return e && e.expireAt > this.now ? e.v : null; }
  async set(key: string, value: string) { if (value === '') this.store.delete(key); else this.store.set(key, { v: value, expireAt: this.now + 60_000 }); }
}

describe('CircuitBreakerService', () => {
  let kv: FakeKV; let cb: CircuitBreakerService;
  beforeEach(() => { kv = new FakeKV(); cb = new CircuitBreakerService(kv, () => kv.now); });

  it('连续 5 次失败 → open，拒绝调用', async () => {
    for (let i = 0; i < 4; i++) { expect(await cb.recordFailure('p1')).toBe(false); }
    expect(await cb.recordFailure('p1')).toBe(true); // 第 5 次触发
    expect(await cb.state('p1')).toBe('open');
    expect(await cb.canCall('p1')).toBe(false);
  });

  it('冷却期后 half_open，仅探测放行', async () => {
    for (let i = 0; i < 5; i++) await cb.recordFailure('p1');
    kv.now = 61_000; // 60s 冷却过去
    expect(await cb.state('p1')).toBe('half_open');
    expect(await cb.canCall('p1')).toBe(false);
    expect(await cb.canCall('p1', {}, true)).toBe(true); // 探测请求放行
  });

  it('探测成功 → healthy', async () => {
    for (let i = 0; i < 5; i++) await cb.recordFailure('p1');
    kv.now = 61_000;
    await cb.recordSuccess('p1');
    expect(await cb.state('p1')).toBe('healthy');
  });

  it('成功重置连续失败计数', async () => {
    for (let i = 0; i < 3; i++) await cb.recordFailure('p1');
    await cb.recordSuccess('p1');
    expect(await cb.recordFailure('p1')).toBe(false); // 计数已重置
    expect(await cb.recordFailure('p1')).toBe(false);
    expect(await cb.recordFailure('p1')).toBe(false);
    expect(await cb.recordFailure('p1')).toBe(false); // 累计第 4 次
    expect(await cb.recordFailure('p1')).toBe(true);  // 第 5 次触发
  });
});
```

- [ ] **Step 7: ModelRouter 测试 + 实现**

`apps/api/src/core/model-router/model-router.service.spec.ts`：
```ts
import { describe, it, expect } from 'vitest';
import { ModelRouterService, ModelCandidate } from './model-router.service';
import { CircuitBreakerService } from '../circuit-breaker/circuit-breaker.service';
import { KVStore } from '../circuit-breaker/kv-store.interface';

const kv: KVStore = {
  incr: async () => 1, get: async () => null,
  set: async () => undefined,
};
const cb = new CircuitBreakerService(kv, () => 0);

const candidates: ModelCandidate[] = [
  { modelId: 'm-cheap', providerId: 'p1', priority: 200, cost: 0.01, latencyMs: 500 },
  { modelId: 'm-fast', providerId: 'p2', priority: 100, cost: 0.05, latencyMs: 100 },
  { modelId: 'm-best', providerId: 'p3', priority: 50, cost: 0.1, latencyMs: 300 },
];

describe('ModelRouterService', () => {
  it('候选按 priority 升序（健康优先于排序前过滤）', async () => {
    const r = new ModelRouterService(cb, async () => 0);
    const ordered = await r.order(candidates);
    expect(ordered.map((c) => c.modelId)).toEqual(['m-best', 'm-fast', 'm-cheap']);
  });

  it('execute 依次回退：p3 失败(可重试) → p2 成功', async () => {
    const r = new ModelRouterService(cb, async () => 0);
    const calls: string[] = [];
    const { result, usedModel, fallbacks } = await r.execute(candidates, async (c) => {
      calls.push(c.modelId);
      if (c.modelId === 'm-best') { const e = new Error('x') as Error & { status?: number }; e.status = 429; throw e; }
      return `ok-${c.modelId}`;
    });
    expect(result).toBe('ok-m-fast');
    expect(usedModel.modelId).toBe('m-fast');
    expect(fallbacks.map((c) => c.modelId)).toEqual(['m-best']);
    expect(calls).toEqual(['m-best', 'm-fast']);
  });

  it('不可重试错误不触发回退，直接抛出', async () => {
    const r = new ModelRouterService(cb, async () => 0);
    const e = new Error('bad') as Error & { status?: number }; e.status = 401;
    await expect(r.execute(candidates, async () => { throw e; })).rejects.toMatchObject({ code: 'PROVIDER_AUTH' });
  });

  it('全部失败 → 聚合错误（含失败记录）', async () => {
    const r = new ModelRouterService(cb, async () => 0);
    await expect(r.execute(candidates, async () => { throw new Error('down'); }))
      .rejects.toMatchObject({ code: 'PROVIDER_UNKNOWN' });
  });
});
```

`apps/api/src/core/model-router/model-router.service.ts`：
```ts
import { Injectable, Logger } from '@nestjs/common';
import { AppError } from '../../common/errors/app-error';
import { CircuitBreakerService } from '../circuit-breaker/circuit-breaker.service';

export interface ModelCandidate {
  modelId: string; providerId: string;
  priority: number; cost: number; latencyMs: number;
}

export interface ExecuteResult<T> { result: T; usedModel: ModelCandidate; fallbacks: ModelCandidate[]; }

/** 选模执行器：health → priority → cost → latency 排序；可重试错误逐个回退 */
@Injectable()
export class ModelRouterService {
  private readonly logger = new Logger('ModelRouter');
  constructor(private readonly cb: CircuitBreakerService, private readonly sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms))) {}

  /** 过滤熔断中 provider 并按 priority → cost → latency 排序 */
  async order(candidates: ModelCandidate[]): Promise<ModelCandidate[]> {
    const filtered: ModelCandidate[] = [];
    for (const c of candidates) {
      if (await this.cb.canCall(c.providerId)) filtered.push(c);
    }
    return filtered.sort((a, b) => a.priority - b.priority || a.cost - b.cost || a.latencyMs - b.latencyMs);
  }

  async execute<T>(candidates: ModelCandidate[], fn: (c: ModelCandidate) => Promise<T>): Promise<ExecuteResult<T>> {
    const ordered = await this.order(candidates);
    const fallbacks: ModelCandidate[] = [];
    let lastErr: AppError | undefined;
    for (const c of ordered) {
      try {
        const result = await fn(c);
        await this.cb.recordSuccess(c.providerId);
        return { result, usedModel: c, fallbacks };
      } catch (err) {
        lastErr = err instanceof AppError ? err : new AppError('PROVIDER_UNKNOWN', (err as Error).message);
        await this.cb.recordFailure(c.providerId);
        if (!lastErr.retryable) break; // 参数/鉴权类错误回退无意义
        fallbacks.push(c);
        this.logger.warn(`provider ${c.providerId} 调用失败（${lastErr.code}），回退下一个候选`);
        await this.sleep(1000);
      }
    }
    throw new AppError(
      lastErr?.code ?? 'PROVIDER_UNKNOWN',
      `所有可用模型均失败（已尝试 ${ordered.length} 个）`,
      undefined, lastErr,
    );
  }
}
```

- [ ] **Step 8: 运行全部测试**

Run: `cd /c/Users/87474/Desktop/agent/apps/api && pnpm exec vitest run src/agents src/core`
Expected: 全部 PASS（chat.agent 3 + router 5 + circuit-breaker 5 + model-router 4）。

- [ ] **Step 9: 提交**

```bash
git add -A && git commit -m "feat(api): Agent 层 + AI Router + 熔断器 + ModelRouter（核心抽象，含单测）"
```

---

### Task 9: 队列 + 事件总线 + Storage 层 + Worker 入口

**Files:**
- Create: `src/core/queue/queue.module.ts`、`src/core/events/event-bus.service.ts`、`src/core/events/event-bus.service.spec.ts`、`src/core/storage/storage.types.ts`、`src/core/storage/local/storage-local.adapter.ts`、`src/core/storage/local/storage-local.adapter.spec.ts`、`src/core/storage/s3/storage-s3.adapter.ts`、`src/core/storage/storage.module.ts`、`src/worker.ts`、`src/worker.module.ts`

- [ ] **Step 1: 写失败测试**

`apps/api/src/core/events/event-bus.service.spec.ts`：
```ts
import { describe, it, expect, vi } from 'vitest';
import { EventBusService } from './event-bus.service';

interface FakePubSub { publish: (ch: string, msg: string) => Promise<number>; subscribe: (ch: string, cb: (ch: string, msg: string) => void) => Promise<void>; }

function make() {
  const subs = new Map<string, Array<(ch: string, msg: string) => void>>();
  const pubsub: FakePubSub = {
    publish: async (ch, msg) => { (subs.get(ch) ?? []).forEach((cb) => cb(ch, msg)); return 1; },
    subscribe: async (ch, cb) => { subs.set(ch, [...(subs.get(ch) ?? []), cb]); },
  };
  const bus = new EventBusService(pubsub as never);
  return { bus, pubsub };
}

describe('EventBusService', () => {
  it('publish 后订阅者收到解析后的 JSON 事件', async () => {
    const { bus } = make();
    const received: unknown[] = [];
    await bus.subscribe('task', (evt) => received.push(evt));
    await bus.publish('task', { type: 'task.progress', taskId: 't1', progress: 50 });
    expect(received).toEqual([{ type: 'task.progress', taskId: 't1', progress: 50 }]);
  });

  it('订阅回调抛错不影响 publish', async () => {
    const { bus } = make();
    await bus.subscribe('task', () => { throw new Error('boom'); });
    await expect(bus.publish('task', { type: 'task.progress', taskId: 't1', progress: 1 })).resolves.toBeUndefined();
  });
});
```

`apps/api/src/core/storage/local/storage-local.adapter.spec.ts`：
```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { StorageLocalAdapter } from './storage-local.adapter';

describe('StorageLocalAdapter', () => {
  let dir: string; let adapter: StorageLocalAdapter;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'storage-test-')); adapter = new StorageLocalAdapter(dir); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('put 写入文件，delete 删除', async () => {
    await adapter.put('u1/2026/09/a.txt', Readable.from(['hello']), { contentType: 'text/plain', sizeBytes: 5 });
    const path = join(dir, 'u1', '2026', '09', 'a.txt');
    expect(readFileSync(path, 'utf8')).toBe('hello');
    await adapter.delete('u1/2026/09/a.txt');
    expect(existsSync(path)).toBe(false);
  });

  it('createPresignedUrl 返回 local:// URI（由 API 附件端点流式回源）', async () => {
    const url = await adapter.createPresignedUrl('u1/x.png', 900);
    expect(url).toBe('local://u1/x.png');
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `cd /c/Users/87474/Desktop/agent/apps/api && pnpm exec vitest run src/core/events src/core/storage`
Expected: FAIL。

- [ ] **Step 3: 实现事件总线与 Storage**

`apps/api/src/core/events/event-bus.service.ts`：
```ts
import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import Redis from 'ioredis';

const CHANNEL_PREFIX = 'agent:events:';

/** Worker → API 的事件推送总线（Redis Pub-Sub；M5 起接 SSE 任务通道） */
@Injectable()
export class EventBusService implements OnModuleDestroy {
  private readonly logger = new Logger('EventBus');
  private readonly pub: Redis;
  private readonly sub: Redis;

  constructor(injected?: { publish: (ch: string, msg: string) => Promise<number>; subscribe: (ch: string, cb: (ch: string, msg: string) => void) => Promise<void> }) {
    if (injected) {
      this.pub = injected as Redis; this.sub = injected as Redis;
      return;
    }
    const url = process.env.REDIS_URL ?? 'redis://localhost:6379';
    this.pub = new Redis(url, { maxRetriesPerRequest: null });
    this.sub = new Redis(url, { maxRetriesPerRequest: null });
  }

  async publish(channel: string, event: Record<string, unknown>): Promise<void> {
    try { await this.pub.publish(CHANNEL_PREFIX + channel, JSON.stringify(event)); }
    catch (err) { this.logger.error(`事件发布失败: ${(err as Error).message}`); }
  }

  async subscribe(channel: string, handler: (event: Record<string, unknown>) => void): Promise<void> {
    await this.sub.subscribe(CHANNEL_PREFIX + channel);
    this.sub.on('message', (ch, msg) => {
      if (ch !== CHANNEL_PREFIX + channel) return;
      try { handler(JSON.parse(msg)); } catch (err) { this.logger.error(`事件处理失败: ${(err as Error).message}`); }
    });
  }

  onModuleDestroy() { this.pub.disconnect(); this.sub.disconnect(); }
}
```

`apps/api/src/core/storage/storage.types.ts`（与架构文档 §13 一致）：
```ts
import { Readable } from 'node:stream';

export interface StorageAdapter {
  put(key: string, stream: Readable, meta: { contentType: string; sizeBytes: number }): Promise<void>;
  createPresignedUrl(key: string, expiresInSec: number): Promise<string>;
  delete(key: string): Promise<void>;
}
```

`apps/api/src/core/storage/local/storage-local.adapter.ts`：
```ts
import { createWriteStream, mkdirSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { StorageAdapter } from '../storage.types';

/** 开发环境本地磁盘驱动；createPresignedUrl 返回 local:// URI 由 API 附件端点流式回源（M2 实现） */
export class StorageLocalAdapter implements StorageAdapter {
  constructor(private readonly rootDir: string) {}

  async put(key: string, stream: Readable, _meta: { contentType: string; sizeBytes: number }): Promise<void> {
    const safeKey = key.split('/').filter((s) => s && s !== '..').join(sep);
    const path = resolve(this.rootDir, safeKey);
    if (!path.startsWith(resolve(this.rootDir))) throw new Error('非法 storage key');
    mkdirSync(dirname(path), { recursive: true });
    await pipeline(stream, createWriteStream(path));
  }

  async createPresignedUrl(key: string): Promise<string> { return `local://${key}`; }

  async delete(key: string): Promise<void> {
    const { rm } = await import('node:fs/promises');
    const safeKey = key.split('/').filter((s) => s && s !== '..').join(sep);
    const path = resolve(this.rootDir, safeKey);
    await rm(path, { force: true });
  }
}
```

`apps/api/src/core/storage/s3/storage-s3.adapter.ts`：
```ts
import { DeleteObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { Readable } from 'node:stream';
import { StorageAdapter } from '../storage.types';

export interface S3Config {
  endpoint: string; region: string; bucket: string;
  accessKeyId: string; secretAccessKey: string; forcePathStyle: boolean;
}

/** S3 兼容驱动（MinIO / Cloudflare R2 / AWS S3 一套） */
export class StorageS3Adapter implements StorageAdapter {
  private readonly client: S3Client;
  constructor(private readonly cfg: S3Config) {
    this.client = new S3Client({
      endpoint: cfg.endpoint, region: cfg.region, forcePathStyle: cfg.forcePathStyle,
      credentials: { accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey },
    });
  }

  async put(key: string, stream: Readable, meta: { contentType: string; sizeBytes: number }): Promise<void> {
    await this.client.send(new PutObjectCommand({
      Bucket: this.cfg.bucket, Key: key, Body: stream,
      ContentType: meta.contentType, ContentLength: meta.sizeBytes,
    }));
  }

  async createPresignedUrl(key: string, expiresInSec: number): Promise<string> {
    return getSignedUrl(this.client, new PutObjectCommand({ Bucket: this.cfg.bucket, Key: key }), { expiresIn: expiresInSec });
  }

  async delete(key: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.cfg.bucket, Key: key }));
  }
}
```

`apps/api/src/core/storage/storage.module.ts`：
```ts
import { Global, Module } from '@nestjs/common';
import { StorageAdapter } from './storage.types';
import { StorageLocalAdapter } from './local/storage-local.adapter';
import { StorageS3Adapter } from './s3/storage-s3.adapter';

@Global()
@Module({
  providers: [
    {
      provide: 'STORAGE_ADAPTER',
      useFactory: (): StorageAdapter => {
        const driver = process.env.STORAGE_DRIVER ?? 'local';
        if (driver === 's3-compatible') {
          return new StorageS3Adapter({
            endpoint: process.env.STORAGE_ENDPOINT ?? '',
            region: process.env.STORAGE_REGION ?? 'us-east-1',
            bucket: process.env.STORAGE_BUCKET ?? 'agent-storage',
            accessKeyId: process.env.STORAGE_ACCESS_KEY_ID ?? '',
            secretAccessKey: process.env.STORAGE_SECRET_ACCESS_KEY ?? '',
            forcePathStyle: true,
          });
        }
        return new StorageLocalAdapter(process.env.STORAGE_LOCAL_DIR ?? './data/storage');
      },
    },
  ],
  exports: ['STORAGE_ADAPTER'],
})
export class StorageModule {}
```

- [ ] **Step 4: 队列与 Worker 入口**

`apps/api/src/core/queue/queue.module.ts`：
```ts
import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';

export const IMAGE_QUEUE = 'image';
export const VIDEO_QUEUE = 'video';

@Module({
  imports: [
    BullModule.forRoot({
      connection: { url: process.env.REDIS_URL ?? 'redis://localhost:6379', maxRetriesPerRequest: null },
    }),
    BullModule.registerQueue({ name: IMAGE_QUEUE }, { name: VIDEO_QUEUE }),
  ],
  exports: [BullModule],
})
export class QueueModule {}
```

`apps/api/src/worker.module.ts`：
```ts
import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { PrismaModule } from './modules/prisma/prisma.module';
import { CryptoModule } from './core/crypto/crypto.module';
import { ProvidersModule } from './providers/providers.module';
import { QueueModule } from './core/queue/queue.module';
// M2/M3 在此注册 image/video 队列处理器

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, envFilePath: ['.env', '../../.env'] }),
    PrismaModule, CryptoModule, ProvidersModule, QueueModule,
  ],
})
export class WorkerModule {}
```

`apps/api/src/worker.ts`：
```ts
import { NestFactory } from '@nestjs/core';
import { Logger } from 'nestjs-pino';
import { WorkerModule } from './worker.module';

async function bootstrap() {
  const app = await NestFactory.createApplicationContext(WorkerModule, { bufferLogs: true });
  app.useLogger(app.get(Logger));
  console.log('Worker 已启动（image/video 队列消费端，处理器在 M2/M3 注册）');
}
bootstrap();
```

- [ ] **Step 5: 挂载模块 + 运行全部测试**

Modify `apps/api/src/app.module.ts` imports：`imports: [ ..., StorageModule, QueueModule, ... ]`。

Run: `cd /c/Users/87474/Desktop/agent/apps/api && pnpm exec vitest run`
Expected: 全部 PASS（health 2 + crypto 4 + llm 12 + agent/router 17 + events 2 + storage 2）。

- [ ] **Step 6: 提交**

```bash
git add -A && git commit -m "feat(api): 队列 + 事件总线 + Storage 适配层 + Worker 入口"
```

---

### Task 10: Next.js Web 骨架 + 全仓验证

**Files:**
- Create: `apps/web/package.json`、`next.config.ts`、`tsconfig.json`、`postcss.config.mjs`、`app/layout.tsx`、`app/page.tsx`、`app/globals.css`

- [ ] **Step 1: 创建 web 骨架**

`apps/web/package.json`：
```json
{
  "name": "web",
  "version": "0.1.0",
  "private": true,
  "scripts": {
    "dev": "next dev -p 3000",
    "build": "next build",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "@ai-agent/shared": "workspace:*",
    "next": "15.1.6",
    "react": "19.0.0",
    "react-dom": "19.0.0"
  },
  "devDependencies": {
    "@tailwindcss/postcss": "^4.0.0",
    "@types/node": "^22.10.0",
    "@types/react": "^19.0.0",
    "@types/react-dom": "^19.0.0",
    "tailwindcss": "^4.0.0",
    "typescript": "^5.6.3"
  }
}
```

`apps/web/next.config.ts`：
```ts
import type { NextConfig } from 'next';
const nextConfig: NextConfig = { output: 'standalone' };
export default nextConfig;
```

`apps/web/tsconfig.json`：
```json
{
  "compilerOptions": {
    "target": "ES2022", "lib": ["dom", "dom.iterable", "esnext"],
    "allowJs": true, "skipLibCheck": true, "strict": true, "noEmit": true,
    "esModuleInterop": true, "module": "esnext", "moduleResolution": "bundler",
    "resolveJsonModule": true, "isolatedModules": true, "jsx": "preserve",
    "incremental": true, "plugins": [{ "name": "next" }],
    "paths": { "@/*": ["./*"], "@ai-agent/shared": ["../../packages/shared/dist"] }
  },
  "include": ["next-env.d.ts", "**/*.ts", "**/*.tsx", ".next/types/**/*.ts"],
  "exclude": ["node_modules"]
}
```

`apps/web/postcss.config.mjs`：
```js
export default { plugins: { '@tailwindcss/postcss': {} } };
```

`apps/web/app/globals.css`：
```css
@import "tailwindcss";

:root { color-scheme: dark; }
body { @apply bg-zinc-950 text-zinc-100 antialiased; }
```

`apps/web/app/layout.tsx`：
```tsx
import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = { title: 'AI Agent 智能创作平台', description: '万能 AI 助手：对话、生图、生视频' };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
```

`apps/web/app/page.tsx`：
```tsx
export default function Home() {
  return (
    <main className="flex min-h-screen items-center justify-center">
      <div className="text-center">
        <h1 className="text-3xl font-bold">AI Agent 智能创作平台</h1>
        <p className="mt-3 text-zinc-400">项目初始化完成 —— 聊天界面将在 M1 里程碑交付</p>
      </div>
    </main>
  );
}
```

- [ ] **Step 2: 构建验证**

Run:
```bash
cd /c/Users/87474/Desktop/agent && pnpm install
pnpm --filter web build
```
Expected: Next.js 构建成功（`.next` 生成）。

- [ ] **Step 3: 全仓验证**

Run:
```bash
cd /c/Users/87474/Desktop/agent
pnpm test
pnpm build
```
Expected: shared 5 测试 + api 全部测试 PASS；`pnpm build` 三个包全部成功。

- [ ] **Step 4: 全栈冒烟**

Run（两个终端）：
```bash
cd /c/Users/87474/Desktop/agent/apps/api && pnpm dev
cd /c/Users/87474/Desktop/agent/apps/web && pnpm dev
```
然后 `curl -s http://localhost:3001/api/v1/health` → `{"status":"ok"}`；浏览器打开 http://localhost:3000 显示占位页。

- [ ] **Step 5: 提交**

```bash
git add -A && git commit -m "feat(web): Next.js 骨架 + 全仓构建/测试通过（Phase 3 完成）"
```

---

## 计划自审

**Spec 覆盖**：用户 Phase 3 清单逐项对照——初始化项目(T1)、数据库(T4)、ORM(T4)、Redis(T2/T9)、Queue(T9)、环境变量(T2)、Provider Interface(T7)、Agent Interface(T8)、Router(T8)、日志系统(T5)。✓ 无遗漏。

**占位符扫描**：无 TBD/TODO；所有代码块完整。✓

**类型一致性**：`TaskIntent` 来自 `@ai-agent/shared`（zod 推断），与架构文档 §8.2 一致；`AgentEvent` 与 §12.2 SSE 协议一致；`ChatParams/LLMChunk` 与 §6.1 一致；`StorageAdapter` 与 §13 一致；任务状态枚举与 §9 状态机一致（pending/processing/completed/failed/cancelled）。✓

**已知边界（后续里程碑处理）**：ChatAgent 的默认模型解析（M4）、SSE HTTP 接线（M1）、Image/Video Provider 接口与队列处理器（M2/M3）、任务进度事件与 SSE 任务通道（M5）、限流与配额（M1/M2）。
