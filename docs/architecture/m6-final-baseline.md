# M6 Final Baseline（2026-09-24）

> M6（Long-running Agent Runtime）**最终冻结基线**。本文件为 P1~P7 全部落地的验收快照：
> 能力清单、验收结果、关键故障修复、实施差异、技术债与 M7 边界。代码冻结后不随后续 Phase 更新。

## 1. M6 已实现能力（全部经真实代码核对 + 测试覆盖）

| # | 能力 | 实现位置（证据） | 测试覆盖 |
|---|---|---|---|
| 1 | Durable AgentRunMessage transcript | `prisma/schema.prisma`（AgentRunMessage 模型，UNIQUE(runId,sequence)）+ `agent-run-messages.service.ts`（append-only，userId 首条件） | P1 e2e（CRUD+UNIQUE+IDOR）、P4 e2e（transcript 断言）、engine 单测（seed/快照顺序） |
| 2 | Waiting / Resume | `resume-planner.ts`（llm/tools/final 三模式）+ engine `enterWaiting`（running+workerId→waiting+waitingOnTaskId+清 lease）+ driver 重放 | planner 单测 9、engine 异步 8+、P4 e2e 5（真实等待→唤醒→续跑） |
| 3 | ToolCall crash recovery | engine `retryingExistingRow`（P2002 running 残留行同行重试 attempts+1）+ completed 行复用/刷新 | engine 单测、P4 e2e（运行中崩溃现场恢复 attempts=2） |
| 4 | GenerationTask wake/resume | `agent-run-resume-trigger.service.ts`（onTaskTerminal 单点 hook + wakeWaitingRun）+ recoverStale waiting 兜底双通道 | P4 e2e（hook 唤醒、兜底唤醒、重复唤醒幂等、deadline 阻断） |
| 5 | Lease / Heartbeat / fencing | `agent-run-lease.service.ts`（claim 原子条件更新/renew owner fencing/release/recoverStale） | lease 单测 10、P3 e2e（claim 竞争/takeover/renew=0 fencing） |
| 6 | Cancellation / AbortSignal | `POST /agent-runs/:id/cancel`（三态条件取消）+ Redis 快速通道（AGENT_RUN_CANCEL_CHANNEL）+ 心跳 DB 兜底 + engine 取消识别（AGENT_CANCELLED 绝不伪装 provider failure） | P2 e2e（同步取消冻结）、P5 e2e 8（queued/running/waiting/409/404）、engine 单测 |
| 7 | Retry / retryOfRunId / attempt | `POST /agent-runs/:id/retry`（新 run + 血缘 + attempt+1 + 同会话新 assistant 消息 + 上下文重组装） | P5 e2e（血缘/attempt/usage 分离/retry 链） |
| 8 | Retry idempotency | migration `m6_p5_retry_idempotency`：部分唯一索引 `AgentRun_retryOfRunId_key` + service 查重 + P2002 兜底 | P5 e2e（重复 POST → 同一 runId，DB count=1） |
| 9 | SSE reconnect / Last-Event-ID | `GET /agent-runs/:id/events`（timeline.snapshot + filterAfter 断点过滤 + EventBus agent-run:{runId} 实时转发 + 终态事件收流） | P6 e2e 4（全生命周期/断线补段/完成后重连/越权） |
| 10 | Timeline projection | `agent-run-timeline.service.ts`（只读投影，无 Event 表；含 run.waiting 项；usage.summary 终态限定） | timeline 单测 7、P4/P6 e2e 断言 |
| 11 | Usage attribution | usage.service runId 归因（LLM 回合粒度 + 媒体成败路径 A9 修复）+ retry 新 run 独立计费 | P3/P4/P5 e2e（llm 回合数、AGENT_CANCELLED、usage 分离） |
| 12 | user/project scope isolation | 全部 HTTP 面 `findFirst({id, userId})` 首条件（404 防枚举）；worker 不信任 payload（仅 {runId}，DB 行即身份事实） | P3/P5/P6 e2e 越权矩阵 + P7 安全审计全表核查 |
| 13 | PostgreSQL + pgvector + Redis/BullMQ + Worker E2E | 6 个 m6-*.e2e-spec 全部使用真实 DB/Redis/Worker 上下文（NestFactory.createApplicationContext(WorkerModule)） | P1~P6 e2e 全链路 |
| 14 | Engine 抽取 / 同步路径冻结 | AgentRuntimeEngine + AgentRuntimePersistence 边界；Sync Driver（chat）行为逐字节冻结 | engine 单测 40（含 M6-P2 冻结集）、P2 e2e、M1~M5 全量回归 |

## 2. P4/P5/P6/P7 验收结果

- **P4（Waiting + Durable Resume）**：PASS — planner 9 单测 + engine 8 异步单测 + e2e 5（全链路 waiting→唤醒→resume、崩溃残留行恢复、任务失败回喂 LLM 决策、deadline-while-waiting、重复唤醒幂等）。
- **P5（Cancellation + Retry）**：PASS — engine 6 重试单测 + e2e 8（cancel queued/running/waiting、任务取消意图 TOCTOU、409/404、retry 血缘/幂等/链/usage 分离）。
- **P6（SSE Reconnect）**：PASS — EventBus 单测 4（含精确 unsubscribe）+ e2e 4（snapshot→实时→waiting→task.completed→run.completed→收流；断线重连补段；完成后重连；越权）。
- **P7（硬化）**：PASS — fencing 迟写被拒单测 3；安全审计 userId-first 全表；全量回归 56 文件 330 测试全绿；运维手册并入设计文档 §29。

## 3. 最终全量验证（本基线冻结时实测，非缓存）

- **Tests**：`pnpm run test --filter api` → **56 files / 330 tests 全绿**（Duration 108.59s，真实执行）
- **Typecheck**：api `tsc --noEmit` ✓、web `tsc --noEmit` ✓
- **Build**：api `nest build` ✓、web `next build` ✓、shared ✓
- **真实基础设施 E2E**：PostgreSQL（含 pgvector 影子库重放）+ Redis/BullMQ（agent-run/image/video/media-cleanup 队列）+ 同进程 Worker 上下文 — 全部真实执行，无 mock 队列/DB
- **M0-M5 Regression**：全量回归包含 M0~M5 全部冻结 spec（chat/M2/M3/M4/M5 知识库/用量/Timeline），零行为漂移
- **Git**：工作树干净；HEAD = `8835f73`（P7 提交 `fc1d370` + chore gitignore）

## 4. 关键故障修复（M6 实施过程中实测发现并修复）

| 故障 | 发现 Phase | 修复 |
|---|---|---|
| wake jobId 与 create 同键被 BullMQ 去重吞掉 → run 永久 stuck queued | P5 | 唤醒用唯一键 `run-{id}-wake-{ts}`；去重改由条件更新 waiting→queued + claim 承担；recoverStale 增 queued 丢失 job 兜底重入队 |
| driver `messageId = assistantMessageId ?? runId` 用 runId 冒充 Message FK → GenerationTask_messageId_fkey 违规 | P4 | messageId 仅传真实 Message 行或 undefined |
| M1 潜伏 bug：req 'close' 在请求体消费完即触发，客户端断连从未取消 run | P2 | res 'close' + writableEnded 守卫（同步取消链路） |
| 并行 e2e 套件 Worker 互抢共享队列 job（P2 全局 cancelled 查询误中他套件行；P5 时序断言失去确定性） | P5/P7 | vitest `fileParallelism: false` 串行；P2 查询按消息内容归因 |
| Timeline usage.summary 运行中时间戳漂移破坏 SSE 游标（cursor 恒落在会移动的末项） | P6 | usage.summary 限终态产出（usage 聚合字段仍全状态返回） |
| shadow DB 缺表导致 migrate dev 失败（容器重建丢失）+ 新迁移误用 `agent_runs` 表名 | P5 | 仅重建 shadow 库（主库零触碰）；修正为 `"AgentRun"` |
| cancel 退避期间的 AbortError 逃逸出重试循环 → AGENT_CANCELLED usage 缺失 | P5 | sleep 可中断并闭环（取消路径单出口） |
| EventBus subscribe 回调被 wrapRedis 丢弃 / 无退订能力 | P6 | 处理器 Map 化 + 单一分发器 + 精确 unsubscribe |

## 5. §29 实施差异（设计 vs 实际，逐条如实记录）

见 `docs/architecture/m6-architecture-design.md` §29.1，要点：

1. resume 判定 = ResumePlanner 纯函数（llm/tools/final 三模式），等价于设计 §8.4 规则 3a~3d；
2. waiting 时 tool 结果不预写占位，由 resume 补写真实任务终态；
3. 唤醒 jobId 用唯一键（设计写 `run:{runId}` 去重——BullMQ 禁冒号且同键碰撞实测吞 job）；
4. queued 丢失 job 兜底重入队（补齐「任何路径都不让 run 永久停留」）；
5. LLM 瞬时重试按设计（maxRetries=2、1s/4s+全幅 jitter、回合粒度 usage）；
6. tool.retryPolicy 仅显式声明时消费（设计的「默认 1 次」会改变 M5 冻结行为，收紧）；
7. cancel 双通道（Redis 提示 + 心跳 15s DB 兜底）；
8. SSE 游标 = 投影确定性排序 + id 定位；items 为 id 幂等 upsert；瞬态项 cursor 未命中 → 全量兜底；
9. e2e 串行执行（fileParallelism: false）。

## 6. 当前技术债（如实记录，不修）

1. **AgentRunProcessor `active` 单值字段与 concurrency=2 不匹配**：并发执行两个 job 时，cancel 快速通道与 onApplicationShutdown 只作用于最近一个 active（心跳续期/fencing 不受影响——每个 job 各自持有 interval）。建议 M7 改为 active Map。
2. **LLM 单回合 watchdog（limits.agentRunLlmTurnMs）未实现**（设计 §12 分层超时表）：provider 流若既不出错也不响应，回合无独立 120s 看门狗，只受 run deadline（40min）约束。低概率、长尾影响。
3. **恢复延迟上界**：GenerationTask 终态 hook 运行于 generation worker 进程；若该进程整体宕机，等待唤醒延迟 = recoverStale 周期（5min）。已文档化为 at-least-once + 幂等语义。
4. **e2e 串行执行**：全量回归墙钟 ~110s（原并行 ~21s）。换取共享真实基础设施下时序断言的确定性——已知取舍。
5. **设计 Recommended 未做项**：B8（文档异步 ingestion）、B5（dashscope 超时加固）——非阻塞，M7 评估。
6. **tool.retryPolicy 默认不消费**：仅显式声明生效（§29 差异 6）；如需「默认 1 次」语义，M7 逐工具显式声明后放开。

## 7. M7 待办边界（M6 冻结，以下全部未实现、未触碰）

- **Human Approval / human-in-the-loop**（waiting 状态机 + resume 机制是基座；ToolCall.waiting_approval 已留名）
- **external_action 工具**（M4 权限位已留）
- **Ecommerce DataSource / metrics 宽表**（Amazon / Shopify / Meta Ads / Google Ads / TikTok Ads）
- **Workflow 引擎**（queue/lease 模式可参考，不承诺复用）
- **多 Agent 协作**
- **Billing**
- **自动摘要 + Context 压缩**（数据源 = agent_run_messages，M6 已备）
- **Run Timeline UI 增强**（events 端点 + timeline.snapshot 已备）
- **用户自建 Agent（scope=user）**
- B2（usage tokens 真实消费）、B5（dashscope 加固）、B7（TaskStatus.timeout 枚举值）、B8（文档异步 ingestion）

## 8. 冻结声明

M6 全部代码（P1~P7，commits `864357c`→`74e3789`→`fa2a758`→`5519dc3`→`21d1fee`→`f8a3bdd`→`fc1d370`→`8835f73`）自本基线起冻结；
审计期间未修改任何数据库、未新增 migration、未重构、未新增功能、未进入 M7。
本文件为唯一新增物。
