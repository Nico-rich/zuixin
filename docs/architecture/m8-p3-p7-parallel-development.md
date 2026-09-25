# M8-P3~P7 并行开发记录（DAG / Worktree / 合并 / Migration 策略）

> 执行模式：依赖分析 + Git Worktree 并行 Agent + Coordinator 自动合并 + 全量回归（2026-09-25）。

## 1. 依赖 DAG（基于真实代码分析，非臆造）

```
P1/P2（已完成，f706689/9f1c9da）──→ P3/P4/P5/P6/P7 全部
P3 ─┐
P4 ─┤
P5 ─┼── 零强依赖，完全并行（交叉点仅可选弱集成，经稳定接口消费）
P6 ─┤
P7 ─┘
```

- P3 依赖：既有 AuditLog（M7-P9）+ Pino + P1 org RBAC；
- P4 依赖：UsageRecord（M0-M5）/UsageLedgerEntry（P2）/AgentRun/WorkflowRun/GenerationTask；
- P5 依赖：BullMQ/QueueModule（M6）+ P1 org；
- P6 依赖：ToolRegistry（M4）/Agent 体系（scope=organization 已备，P1）/CryptoService；
- P7 依赖：Provider/Model（M0-M5）/CircuitBreaker（既有）/P1 org；
- **P3~P7 相互之间无强依赖**——并行安全。唯一公共资源是 schema，由 Coordinator 预整合。

## 2. Worktree / 分支

| Phase | 分支 | Worktree |
|---|---|---|
| P3 | m8-p3-observability | ../agent-m8-p3-observability |
| P4 | m8-p4-analytics | ../agent-m8-p4-analytics |
| P5 | m8-p5-scheduler | ../agent-m8-p5-scheduler |
| P6 | m8-p6-extension | ../agent-m8-p6-extension |
| P7 | m8-p7-provider-routing | ../agent-m8-p7-provider-routing |

## 3. Migration 策略（并行核心约束）

- **Coordinator 预整合 schema**（commit 8a3fc45）：P3~P7 全部新表 + AuditLog 增强列 + 一个迁移 `m8_p3_p7_platform` 单点应用；
- 子 Agent **只写业务代码**：禁止修改 schema.prisma / 创建 migration / 执行 prisma migrate；
- 合并后 Coordinator 验证：fresh DB 重放全部迁移 + 现有真实库零漂移；
- M0-M7 迁移历史绝不修改。

## 4. 合并策略（Coordinator）

1. 按 DAG 顺序（无依赖 → 任意序）逐个 `git merge` 到 main；
2. 冲突分析（ours/theirs 皆不直接取——按意图整合）：公共文件（app.module/worker.module/main.ts/auth.service）为预期冲突点，人工整合（每 Phase 只允许一行 import + 数组一项的追加模式）；
3. Migration 冲突：不存在（schema 单点已冻结）；
4. 合并后立即：`prisma generate` → `tsc --noEmit` → 全量 vitest → pnpm typecheck/build；
5. 失败定位到具体 Phase → 回对应 worktree 修复（SendMessage 续接 Agent）或 Coordinator 直接修复（记录归属）。

## 5. 测试策略

- 子 Agent：单测 + 服务测试 + 各自 e2e（真实 PG/Redis/Worker，worktree 内自验）；
- Coordinator：M0-M7 + M8-P1/P2 回归 + P3~P7 全部 e2e + 跨阶段全量；
- 共享 DB 测试行隔离（每个 e2e spec 清理自己创建的行——沿用既有模式）。

## 6. 实际偏差记录（合并完成，2026-09-25）

### Agent 报告汇总

| Phase | Commit | 单测 | e2e | 自验 |
|---|---|---|---|---|
| P3 | d685fc0 | 22 | 6 | 28/28 |
| P4 | 23a0801 | 15 | 6 | 21/21 |
| P5 | 9c8092b | 21 | 7 | 28/28 |
| P6 | 94b1e6c | 30 | 7 | 37/37 |
| P7 | 7659243 | 35 | 9 | 44/44 |

### 合并冲突与解决（Coordinator）

- app.module.ts：P3/P4/P6/P5 四方追加模块注册——全部按意图整合保留（import + 数组各一次冲突）；
- worker.module.ts：同型冲突两次（import 行）——整合保留；
- 无 schema/migration 冲突（Coordinator 预整合策略生效）；无共享包冲突（P7 的 shared errors 追加与主线无重叠）；
- 合并后立即 tsc + 定向复验（P3+P4+P6 65/65、P5 28/28、P7 44/44）→ 全量 96 文件/653 测试全绿。

### 关键实测教训（来自 Agent 报告，值得沉淀）

1. Nest `app.use()` 必须在 `app.init()` 之前（init 才注册路由）；
2. `@UsePipes` 方法级管道会连 @Param 一起校验 → 带 :id 子路由恒定 400（必须参数级 @Body pipe）；
3. BullMQ 5 jobId 禁用冒号（validateOptions 硬拒）；
4. 重投必须换 jobId（active job 同 id 被判重丢弃）；
5. 组织私有 Agent 建 run 需扩展 agent-runs.service 的 scope 解析（原硬编码 system）——系统路径零漂移（m6-p3 复验 5/5）。

## 7. 完成状态

- 全部 5 Phase 合并于 main（85aa2db/6d54179/112d48d 三个整合 commit）；
- 全量验证：api 96 文件/653 测试全绿（fresh）；typecheck 4/4、build 3/3 零缓存；
- 基础设施真实（PG/pgvector/Redis/BullMQ/Worker）；工作树干净；
- M0-M7 + M8-P1/P2 回归全绿。
