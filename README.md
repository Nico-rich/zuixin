# AI Agent 智能创作平台

前后端一体的 AI Agent 创作与运营平台:NestJS 11 后端(API + BullMQ 队列 Worker)+ Next.js 15 前端 + Prisma 6 / PostgreSQL(pgvector)+ Redis + MinIO/S3 对象存储,pnpm + Turborepo 单仓。

架构文档:`docs/architecture/ai-agent-platform-architecture-v1.md`(V1.1 已确认);生产运维手册见 [文档导航](#文档导航)。

## 环境要求

| 依赖 | 版本 | 说明 |
|---|---|---|
| Node.js | ≥ 20(推荐 22 LTS) | NestJS 11 要求 Node ≥ 20;仓库按 @types/node 22 开发 |
| pnpm | 9.15.0(仓库 packageManager 锁定) | `corepack enable` 后自动使用锁定版本;或 `npm i -g pnpm@9.15.0` |
| Docker | Desktop(Win/Mac)或 Engine(Linux) | 开发依赖的三个中间件全部用 Compose 起 |
| Git | 任意 | 克隆源码 |

可选:Playwright 浏览器(Web e2e,见 [常用命令](#常用命令))。

## 快速开始(新电脑从零)

```bash
# 1. 克隆
git clone https://github.com/Nico-rich/agent.git
cd agent

# 2. 装好上表环境(Node 22 LTS + pnpm 9.15 + Docker Desktop 已启动)

# 3. 启动中间件:PostgreSQL(pgvector,端口 5433)+ Redis(:6379)+ MinIO(:9000/控制台 :9001)
#    MinIO 会随 Compose 自动创建 agent-storage 桶
docker compose -f docker/compose.yml up -d

# 4. 环境变量:开发默认值即可直接跑;建议至少改掉 SEED_ADMIN_PASSWORD
cp .env.example .env

# 5. 安装依赖
pnpm install

# 6. 建表 + 种子数据(创建初始管理员,账号见 .env 的 SEED_ADMIN_EMAIL / SEED_ADMIN_PASSWORD)
pnpm db:migrate && pnpm db:seed

# 7. 启动:API :3001 + Web :3000
pnpm dev

# 8. 另开一个终端启动队列 Worker(异步 Agent 运行/定时任务必需)
pnpm --filter api dev:worker
```

浏览器打开 http://localhost:3000,用种子管理员账号登录即可。

> **关于 LLM 密钥**:LLM 密钥**不在 .env 配置**。启动后在管理界面「模型配置」页(设置 → 模型配置)添加 Provider:选择适配器、填 baseUrl 与 API Key(密钥落库加密)。本地无密钥可先加一个 mock 适配器占位(mock 允许空 baseUrl);测试环境自动启用 mock 替身走 `TEST_ENSURE_MOCK_PROVIDERS=1`(见 `.env.example`)。

## 常用命令

| 命令 | 作用 |
|---|---|
| `pnpm dev` | 启动 API + Web(不含 Worker) |
| `pnpm --filter api dev:worker` | 单独启动队列 Worker |
| `pnpm build` | 全仓构建 |
| `pnpm test` | 全仓单测(vitest) |
| `pnpm typecheck` | 全仓类型检查 |
| `pnpm db:migrate` | Prisma 迁移(开发) |
| `pnpm db:seed` | 种子数据(幂等,可重复执行) |
| `pnpm --filter web test:e2e` | Web 端到端测试(首次先 `npx playwright install`) |

## 环境变量要点

- `JWT_SECRET` / `ENCRYPTION_KEY`:生产环境**缺失或为占位值会 fail-fast 拒绝启动**;生产生成方式 `openssl rand -base64 32`(详见 `.env.example` 注释)
- `STORAGE_DRIVER`:`local`(开发,写 `./data/storage`)| `s3-compatible`(MinIO/R2/S3)
- 会话治理、全局限流、反向代理信任跳数(`TRUSTED_PROXY_HOPS`)均有安全默认,生产按 `.env.example` 注释调整
- 全部可用变量及语义以 `.env.example` 内注释为准(每个变量都有说明与默认值)

## 目录

- `apps/api` NestJS 后端(`main.ts` API / `worker.ts` 队列 Worker)
- `apps/web` Next.js 前端
- `packages/shared` 前后端共享类型与 zod schema
- `docker/` 开发 Compose + 生产镜像 Dockerfile
- `k8s/` 生产 K8s 清单(kustomize,含 `secret.example.yaml`)
- `docs/` 架构、实施计划、生产运维

## 文档导航

- 架构与里程碑基线:`docs/architecture/`(`m12-m13-final-baseline.md` 为最新)
- 生产运维:`docs/operations/`(生产就绪清单、灾备、备份加密、PITR 演练)
- 安全:`docs/security/`
- 实施计划:`docs/plans/`

## 常见问题

- **5433 端口冲突 / 5432 被占**:仓库故意用 5433 映射,避开本机默认 Postgres;改 `docker/compose.yml` 的 ports 时同步改 `.env` 的 `DATABASE_URL`
- **Docker Desktop 未启动**:三个中间件都依赖它,先启动再 `docker compose up -d`
- **Postgres 数据卷损坏/迁移失败**:⚠️ 镜像锁定 Debian/glibc 系(`pgvector/pgvector:pg16`),禁止切回 alpine 复用同一数据卷(musl/glibc collation 不一致会损坏索引),详见 `docker/compose.yml` 内注释与 `docs/operations/`
- **Redis 不要改成默认 databases**:`databases=64` 是并行 e2e 按库隔离的铁律,改动会破坏测试隔离
- **Worker 没起来**:聊天无响应、任务卡队列,检查 `pnpm --filter api dev:worker` 进程
