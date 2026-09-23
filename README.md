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
