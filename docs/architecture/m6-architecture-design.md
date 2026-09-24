# M6 Architecture Design — Long-running Agent Runtime

| 项 | 内容 |
|---|---|
| 日期 | 2026-09-24 |
| 基线 | M0~M5 实际代码（256 测试全绿）+ 4 路只读代码探查（执行核心 / 持久化 / Chat-SSE-Context / 知识-生成-基础设施），所有"现状"均经代码核验并附 file:line |
| 状态 | **待确认**（纯设计：不写代码/不改 schema/不迁移/不实现/不提交） |
| 主题 | Long-running Agent Runtime：异步 AgentRun、Worker、Lease、Heartbeat、Checkpoint/Resume、Retry、Cancellation、Timeout 分层、GenerationTask 等待集成 |

---

## 1. M0~M5 当前架构审计（代码实证）

### 1.1 文档 vs 代码一致性核验

| 文档声称 | 代码实证 | 一致性 |
|---|---|---|
| M4 §19「每步前 deadline 检查 + 条件终态」 | ✅ `agent-loop.service.ts:107` 步首检查、`:207-210` `updateMany({id,status:'running'})` 条件终态 | 🟢 一致 |
| M4 §18 三层幂等（Loop/Task/执行层） | ✅ ToolCall UNIQUE(runStepId,idempotencyKey)（schema:544）+ GenerationTask 全局唯一幂等键（schema:318）+ 原子 claim（media-generation.service.ts:114） | 🟢 一致 |
| M4 §4 状态机「queued→running 预留」 | ⚠️ `queued` 全仓**零写入**（死枚举）；`status` 默认 `running`（schema:495）；`startedAt` = create 时刻 | 🟡 预留未落地 |
| M4 §4「终态不可复活」 | ✅ 全仓仅 4 个 AgentRun 写点，终态全部条件更新；e2e 断言清扫不复活终态 | 🟢 一致 |
| M4 设计 deadlineMs「绝对截止」 | ⚠️ 实现为**相对时长**（`Date.now() + deadlineMs`，agent-loop.service.ts:80）；无调用方传值 | 🟡 语义偏差（无功能危害） |
| M5 §17「M6 resume 三重锚点已存在」 | ⚠️ 锚点存在但**不足**：① ToolCall 幂等键含 `stepId`（行 UUID），resume 必须复用原 step 行；② `running` 残留 ToolCall 行会让同一调用**永久无法重试**（`executeToolCall` 撞唯一约束后 `throw`，:269）；③ LLM messages 无任何持久化 | 🔴 M6 必须处理 |
| M5 §17「heartbeatAt 字段 M6 加」 | ✅ 确认当前无 lease/heartbeat/workerId 任何字段 | — |
| M5 §14 Context Budget | ✅ 与设计一致（8k 默认，服务端配置链 AgentVersion→limits→8000） | 🟢 一致 |
| M5 §10 Document 队列 | ⚠️ 实际为 **HTTP 请求内同步 ingestion**（knowledge.service.ts:19 注释「P5 同步；异步队列留 M6」） | 🟡 M6 决策点 |
| M1 审查「Worker = BullMQ image/video 队列」 | ✅ BullMQ 真实运行：image/video/media-cleanup 三队列 + 5min repeatable scheduler；worker.ts 独立进程（无 HTTP） | 🟢 一致 |
| M5 §19 安全「userId 首条件」 | ✅ 九个资源面全部 userId 首条件（M4 审计实证）；ToolContext 服务端注入 | 🟢 一致 |

### 1.2 AgentRun 生命周期审计

**现状**（写点全集 = 4 处，见 agent-run-timeline 探查报告 §2）：

```
create(status 默认 running, startedAt=now) ──agent-loop:81-88
  ├─ LLM 步首检查 deadline(内存值 120s) ──agent-loop:107
  ├─ signal.aborted → cancelled ──agent-loop:106,189
  ├─ 终态条件更新 updateMany(status:'running'→final) ──agent-loop:207-210
  └─ 清扫器：running 且 startedAt>120s → timeout ──media-cleanup:70-73（worker 进程，5min 周期）
```

**审计结论**：
1. **状态机六态齐全但 `queued` 未用**；条件更新杜绝终态复活（🔴 红线已守住）。
2. **terminal 不可重开**：已由 DB 条件更新保证，M6 沿用同一机制。
3. **retry 与 resume 尚未区分**：无 `retryOfRunId`、无 resume 机制。Retry（新 run）与 Resume（同 run 续跑）在 M6 是两个正交概念（§10/§11）。
4. **进程崩溃后无法恢复**：run 停留 `running` → 120s 后被清扫器误判 `timeout`。清扫阈值 = 同步 run 的 deadline，**与长任务语义根本冲突**——M6 必须分层（§13）。
5. **cancel 只能通过 SSE 断连隐式触发**：无 `POST /agent-runs/:id/cancel`（agent-runs.controller.ts 仅 3 个 GET）。
6. **无 run 级并发保护**：`agentRun.update currentStep` 无条件写（:187）；同一 message 可产生无限个 run（create 无条件）。

### 1.3 AgentLoop 审计（复用 vs 改造）

| 能力 | 现状 | M6 判定 |
|---|---|---|
| maxSteps/step 循环协议 | ✅ 完整（8 步默认、FINAL_STEP_INDEX=999） | 🟢 **直接复用** |
| 循环检测（连续同签名） | ✅ `AGENT_LOOP_DETECTED` | 🟢 复用 |
| ToolCall 先建行后执行 | ✅ running→终态，P2002 兜底复用 completed | 🟡 复用 + 修复 running 残留语义（§7） |
| 幂等键 | ✅ sha256(runId:stepId:toolIndex:name:arguments) | 🟢 复用（resume 复用原 step 行保 key 稳定） |
| ContextAssembler | ✅ 每 run 一次（GeneralAssistantAgent 内重组装，general.agent.ts:25-35） | 🟢 复用（异步 run 创建时组装一次，resume 不再组装） |
| Tool Result 截断 | ✅ 单条 4k + 累计 8k 确定性截断 | 🟢 复用（截断后的结果进 transcript） |
| LLM Tool Calling | ✅ adapter 聚合、能力降级 | 🟢 复用 + 补流级超时与 signal 接线（§1.6 缺陷） |
| **LLM messages 持久化** | ❌ **纯进程内存**（agent-loop.service.ts:93-97,175-181） | 🔴 **M6 必须新增**（§8） |
| **deadline** | ⚠️ 内存值 + 仅步首检查 + 只约束首字节 | 🔴 M6 分层重做（§13） |
| **Tool 超时强制** | ⚠️ 只有 AbortSignal.timeout，**无 Promise.race**；所有内置工具不读 signal → 可无限阻塞 | 🔴 M6 修复 |
| **等待异步任务** | ❌ 生成类工具 fire-and-forget 返回 taskId（tools.ts:28,52） | 🔴 M6 核心增量（§9） |
| **重试** | ❌ LLM 零重试（maxRetries:0）；tool.retryPolicy 声明未消费 | 🔴 M6 新增（§11） |
| GenerationTask/Artifact 关联 | ✅ runId/toolCallId 双关联（P3） | 🟢 复用 |

### 1.4 Tool 执行可靠性审计（exactly-once 边界实证）

```
AgentLoop → ToolCall → Tool → Service → Provider
```

| 场景 | 现状行为 | 保障级别 |
|---|---|---|
| Worker crash（tool 执行中） | ToolCall 行永久 `running`；同 step 同调用**永久无法重试**（:269 throw） | 🔴 无保障 |
| 网络超时 | 工具抛错 → 行 failed → 回喂模型 | 🟢 已闭环（但无重试策略消费） |
| 请求重试 | P2002 → 查 completed 复用 output | 🟢 effectively-once（completed 后） |
| Provider 成功但进程崩溃（写 DB 前） | 行 running → 重放被唯一约束阻断 | 🔴 必须改为「复用或恢复」语义 |
| GenerationTask 已创建但结果未记录 | 任务继续在 worker 执行完，run 侧半截 | 🟡 数据不丢但 run 不再感知 |
| GenerationTask 层 | 原子 claim + 全局唯一幂等键 → 单任务单结果 | 🟢 **exactly-once（现有机制已证明）** |

**M6 诚实边界声明**：
- **GenerationTask**：exactly-once（原子 claim + 全局唯一幂等键 + 条件终态，M3 已闭环）。
- **Tool 副作用**（artifact.create / memory.create_candidate / knowledge.search 只读）：effectively-once——ToolCall 行复用 + Artifact 新增幂等键（§25）；memory 候选重复为 M2 已知债（不阻塞）。
- **LLM 回合**：at-least-once（provider 侧无幂等锚点；重复回合按实际调用计费，usage 恒真实）。
- **Transcript 写入**：exactly-once（UNIQUE(runId, seq)）。
- 不声称全链路 exactly-once。

### 1.5 M0~M5 遗留问题清单（审计产出）

**A. 阻塞 M6（必须随 M6 处理，否则长任务不可行）**

| # | 问题 | 证据 | 处理 |
|---|---|---|---|
| A1 | 无 LLM 消息持久化 → resume 无据可依 | 全仓无消息表；messages 纯内存 | §8 新增 `agent_run_messages` |
| A2 | `sweepAgentRuns` 120s 会把长任务误杀 | media-cleanup.service.ts:58-80 | §13 分层：同步 run 沿用，异步 run 走 lease 恢复 |
| A3 | `running` ToolCall 残留永久阻断重试 | agent-loop.service.ts:262-269（throw 分支） | §7 resume 语义：running 行 = 可恢复执行 |
| A4 | Tool 超时无强制（无 race、工具不读 signal） | agent-loop.service.ts:279-280；tools 全不读 ctx.signal | §13 Promise.race 硬强制 |
| A5 | 无 lease/workerId/heartbeat | schema AgentRun 无相关字段 | §5/§6 新增 |
| A6 | 无 waiting 状态与任务等待语义 | 生成工具 fire-and-forget | §9 新增 waiting |
| A7 | 无 run 取消 API | agent-runs.controller.ts 无 POST | §12 新增 cancel |
| A8 | LLM 流 abort 未接到 SDK（body.signal 而非 options.signal）→ 真实取消不中止 provider 流；AbortError 被映射为 PROVIDER_TIMEOUT → 取消被记成 failed | openai-compatible.adapter.ts:80 vs SDK core.js:217-260；agent-loop.service.ts:189 兜底只救 completed | §12 修复 signal 接线与错误映射 |
| A9 | 媒体失败 usage 缺 runId 归因（M4 债剩余项） | media-generation.service.ts:185-189 未传 runId | §19 小修 |

**B. 非阻塞技术债（记录，M6 内顺带修或延后）**

| # | 问题 | 证据 | 处理 |
|---|---|---|---|
| B1 | 同一回合 N 个 tool_calls 会重复 push N 条相同 assistant 消息 | agent-loop.service.ts:175-181（push 在逐工具循环内） | 引擎抽取时顺带修复 |
| B2 | LLM usage tokens 恒为 0（usage chunk 未消费） | agent-loop.service.ts:128-131,137,145 | 延后（可观测性增强，非正确性） |
| B3 | chat:lock 无 fencing（del 不校验 owner）；TTL 120s 无续期 | redis-kv.service.ts:24；chat.service.ts:45,77,137 | 小修：compare-and-del（Lua） |
| B4 | 任务 cancel TOCTOU（读后无条件写） | tasks.service.ts:29-32 | 小修：条件更新 |
| B5 | dashscope image/video adapter 无 timeout/signal/重试 | dashscope-*.adapter.ts 原生 fetch | 延后 |
| B6 | `CONCURRENT_CHAT` 等未映射错误码 → 502 | global-exception.filter.ts:37-47 | 延后（补码表） |
| B7 | `TaskStatus` 无 `timeout` 值（超时= failed + errorCode） | schema:110-116 | 记录，不改 |
| B8 | Document ingestion 同步于 HTTP（P5 明示留 M6） | knowledge.service.ts:19 | Recommended 项，非核心 |
| B9 | 无生产 worker 启动脚本（仅 dev:worker） | package.json | 小修：加 start:worker |

### 1.6 审计总判定

- **架构方向**：🟢 M4/M5 分层（Agent→Tool→Service→Provider、注册表、条件终态、三层幂等、投影式 Timeline）全部经受住长任务推演，**零推翻项**。
- **M6 前置条件**：A1~A9 均为增量补强，无破坏性变更；**不阻塞设计定稿**，按 §28 实施序内嵌于 M6 各 Phase。
- M5 冻结行为（同步 chat SSE 事件序列、任务轮询、Timeline 投影、256 测试）**全部保持**——M6 只做增量，不做重写。

---

## 2. M6 Goals

> Agent 不再必须在一次 HTTP / SSE 请求生命周期内完成。

1. **异步 AgentRun**：`POST /agent-runs` 创建即返回；执行在独立 worker 进程，与任何 HTTP 连接解耦。
2. **Durable checkpoint**：LLM 对话消息 + step + toolCall 全量落库，worker 崩溃后可无损 resume（重放而非重来）。
3. **Worker lease/ownership**：一个 run 同一时刻只有一个 worker 执行（split-brain 防护）；worker 崩溃后 lease 过期自动恢复。
4. **等待异步任务**：Agent 调 image/video 生成后进入 `waiting`，任务完成自动唤醒继续推理——支持"先生成图→看到结果→再写文案"类长链路。
5. **重试编排**：run 级 retry（新 run 新 attempt）+ 回合级自动重试（瞬时故障退避）+ 任务级幂等（现有）。
6. **异步取消**：`POST /agent-runs/:id/cancel` 对 queued/waiting/running 全态生效，与 complete 竞争由 DB 条件更新裁决。
7. **分层超时**：run 总 deadline / lease TTL / heartbeat / LLM 回合 / tool / 生成任务六层独立，互不混淆。
8. **SSE 观察化**：新增 run 事件订阅端点（重放 + 实时）；SSE 断线不影响 Runtime；Timeline 投影仍是历史事实来源。
9. **安全不倒退**：所有新面 userId 首条件；worker 不信任队列 payload 身份。

## 3. Non-goals（M6 明确不做）

Human Approval / external_action 工具 / Ecommerce DataSource（Amazon/Shopify/Meta/Google/TikTok Ads）/ Workflow 引擎 / 多 Agent 协作 / Billing / OCR / PDF 高级抽取 / 独立向量库 / OpenTelemetry/LangSmith 等外部可观测平台 / 摘要自动生成与 Context 压缩 / 用户自建 Agent（scope=user）/ Run Timeline UI 增强（前端只做最小订阅展示）。

**接口预留但不实现**：`waiting` 状态机是 Approval 的未来基座（§32 说明预留点）；queue/lease 机制对 Workflow 引擎可复用（不承诺、不实现）。

---

## 4. Async Agent Runtime（总体架构）

```
                    ┌─────────────── API 进程（不变 + 增量） ───────────────┐
                    │  POST /agent-runs          GET /agent-runs/:id/events │
                    │  POST /agent-runs/:id/cancel / retry                  │
User ──HTTP/SSE──▶  │  Chat 同步路径（M5 冻结，行为不变）                    │
                    │  run 创建 → 组装上下文 → 落 transcript → 入队          │
                    └──────────────────────────┬────────────────────────────┘
                                               │ BullMQ 'agent-run'
                    ┌──────────────────────────▼────────────────────────────┐
                    │ Worker 进程（现有 worker.ts 扩展）                      │
                    │  AgentRunProcessor：claim(lease) → resume 重放 →      │
                    │    AgentLoop 引擎（checkpoint 每回合） → 终态/等待     │
                    │  GenerationTask 终态 hook → waiting run 唤醒入队       │
                    │  Recovery sweep（5min 兜底 + BullMQ stalled 快路径）   │
                    └───────────────┬────────────────────┬───────────────────┘
                                    │ Redis Pub/Sub      │ PostgreSQL
                    ┌───────────────▼───────────┐  ┌──────▼──────────────────┐
                    │ SSE 观察层（EventBus）     │  │ 事实来源（DB）            │
                    │ agent-run:{runId} 实时事件 │  │ agent_runs + lease/heartbeat
                    └───────────────────────────┘  │ agent_run_messages(transcript)
                                                    │ steps/toolCalls/tasks/usage
                                                    └─────────────────────────┘
```

**四条铁律**（贯穿全文）：

1. **Durable over memory**——Runtime 不依赖进程内状态；LLM 消息、step、toolCall 全落库。
2. **DB is source of truth**——run 归属、状态、租约全部以 PostgreSQL 条件更新为准；Redis/BullMQ 只是加速与执行载体。
3. **Queue is execution mechanism**——队列不承载业务状态；job payload 只含 `{runId}`。
4. **SSE is observation / Timeline is projection**——断线不影响 Runtime；Timeline 不成为 Runtime 事实来源。

**入口双轨（关键决策）**：

| 路径 | 载体 | 行为 | M5 兼容 |
|---|---|---|---|
| **同步路径（chat）** | HTTP 请求内联执行 | M5 现有行为**逐字节冻结**：SSE 事件序列、锁、任务轮询、Timeline 全部不变；新增 transcript 落库（透明增强，不改变外部行为） | ✅ e2e 回归锁定 |
| **异步路径（POST /agent-runs）** | Worker + BullMQ | 完整长任务语义：lease/checkpoint/waiting/retry/cancel | 全新面 |

**共享引擎**：两条路径共用同一 Loop 引擎（`AgentLoopService` 抽取为可挂接驱动的核心）。同步驱动 = 现有行为；异步驱动 = lease + checkpoint + waiting。设计上**不允许**出现两套循环逻辑。

**Queue Job payload**：`{ runId: string }`（仅此一个字段；attempt 由 BullMQ 自带，不信任载荷）。

---

## 5. AgentRun State Machine（扩展设计）

### 5.1 新增状态：`waiting`

```prisma
enum AgentRunStatus {
  queued      // 已创建已入队，未被任何 worker 认领（M6 起激活）
  running     // worker 持有 lease 正在执行
  waiting     // 【新增】run 存活但无 worker：等待外部异步任务完成（GenerationTask）
  completed
  failed
  cancelled
  timeout
}
```

**为什么需要 `waiting`**：等待生成任务期间（最长 30 分钟视频）没有 worker 执行、没有 lease 心跳，但 run **绝非**孤儿、也绝非终态——若复用 `running`，清扫器无法区分"正在跑"与"在等待"；若直接终态，则放弃"任务完成后继续推理"这个长任务核心能力。`waiting` 的语义 = "暂停于 durable checkpoint，等待可枚举的外部事件唤醒"。

### 5.2 状态转换矩阵

```
queued   → running     ✅ worker claim（lease 获取，条件更新）
queued   → cancelled   ✅ cancel API
running  → waiting     ✅ 生成任务 pending/processing，checkpoint 后释放 worker
running  → completed   ✅ 引擎正常终态（条件更新）
running  → failed      ✅ 引擎异常终态（条件更新）
running  → cancelled   ✅ cancel API 或 worker 检测到取消（条件更新）
running  → timeout     ✅ worker 检测 run deadline（条件更新）
waiting  → running     ✅ resume（claim：waiting→running）
waiting  → cancelled   ✅ cancel API
waiting  → timeout     ✅ recovery：等待任务终态但 run deadline 已过，或任务已终态且超期
waiting  → failed      ✅ recovery：waitingOnTaskId 任务 failed 且错误不可补救（或 resume 后引擎判定）

completed → *  ❌     失败/取消/超时 → *  ❌      （终态绝不复活，条件更新 where status=当前态）
```

- **terminal**：`completed / failed / cancelled / timeout`。恢复、重试、清扫一律条件更新，DB 层杜绝复活。
- **可恢复**：`queued / running / waiting` 均可被恢复或取消。
- **实现**：全部迁移沿用 `updateMany({where:{id, status: 当前态}})` 条件更新模式（M4 已锁定，agent-loop.service.ts:207 同款），**不引入 SELECT FOR UPDATE / advisory lock**——现有并发原语已经足够（§22 论证）。

### 5.3 Retry 与 Resume 的严格区分

| | Retry（重试） | Resume（恢复） |
|---|---|---|
| 语义 | **重新创建一次执行尝试** | **从已有 durable checkpoint 继续同一执行** |
| run 实体 | 新 AgentRun（`retryOfRunId` → 旧 run，`attempt = 旧.attempt + 1`） | 同一个 AgentRun（runId 不变） |
| 触发 | 用户显式 `POST /agent-runs/:id/retry`；或引擎内回合级自动重试（§11，不换 run） | worker claim 后发现断点（crash 后）或 waiting 唤醒 |
| LLM 历史 | 重新组装上下文，从头执行 | 从 `agent_run_messages` 重放，**绝不重新组装**（§18） |
| 幂等锚点 | 新幂等键域（新 run） | 原 step 行 + 原 ToolCall 行复用（§7） |

两者绝不混用：自动恢复只走 resume；用户可见的"再来一次"只走 retry。

---

## 6. Worker Queue

### 6.1 队列定义

```typescript
// core/queue/queue.module.ts 增量
export const AGENT_RUN_QUEUE = 'agent-run';
BullModule.registerQueue({ name: AGENT_RUN_QUEUE });
```

- **Job payload**：`{ runId: string }` —— **不含 userId/身份/参数**。worker 以 DB 的 AgentRun 行为唯一身份与事实来源（§24）。
- **jobId**：`run:{runId}` —— BullMQ jobId 天然去重：同一 run 的初始执行与任意次 resume 触发共享同一 jobId，**活跃 job 存在时重复入队被忽略** → 直接解决"resume 重复入队"（Case H）。run 每次进入可执行态（queued）前必须确保上一个 job 已终结（waiting 退出时 job 主动 return；running 崩溃由 stalled 机制回收）。
- **Job options**：`attempts: 2`（BullMQ 层重试 = **崩溃恢复的快速路径**，幂等 resume 语义），`backoff: { type: 'exponential', delay: 2000 }`，`removeOnComplete: true`，`removeOnFail: { count: 500 }`（dead-letter 可见）。**不加 BullMQ 层 timeout/delay**——时限语义全部在 DB lease 与 run deadline 层（§13），避免"队列超时"与"run 超时"概念混淆。
- **stalled 快路径**：BullMQ stalledInterval 默认 30s——worker 进程崩溃后 ~30s 内 job 被判定 stalled → 按 attempts 重试 → 走 resume 路径。5 分钟 recovery sweep 是慢速兜底。
- **Concurrency**：`AGENT_RUN_WORKER_CONCURRENCY`（env，默认 2）。每个 job 内部串行执行一个 run 的 steps（loop 顺序模型不变）。
- **Graceful shutdown**：SIGTERM/SIGINT → 停止拉新 job → 当前 run 立即 checkpoint（已完成的回合已落库）→ 释放 lease（`leaseUntil = now()`，或直接停心跳任其过期）→ 把 job **失败退回**（不写 run 终态！）→ BullMQ 会按 attempts 重试 → 新 worker resume。**绝不**在 shutdown 时把 run 写成 failed——那是数据造假。

### 6.2 Worker 生命周期（run 维度）

```
claim(queued→running, 写 workerId/leaseUntil)
  → heartbeat 启动（15s setInterval）
  → resume 判定（§7）：读 transcript + steps 决定起点
  → Loop 引擎逐回合（checkpoint 协议 §7）
      ├─ 生成任务未完成 → checkpoint → run: running→waiting(+waitingOnTaskId)
      │                    → 释放 lease → job return（正常结束）
      └─ 完成/失败 → 终态条件更新 → 写 assistant 消息 → job return
```

---

## 7. Worker Lease / Ownership（split-brain 防护）

### 7.1 字段（AgentRun 增量）

```prisma
workerId     String?    // 当前持有者（worker 实例 id = hostname:pid:random，进程启动生成）
leaseUntil   DateTime?  // 租约到期时刻（DB 时间语义，用应用时间 now() 写入即可）
heartbeatAt  DateTime?  // 最近心跳（可观测性）
```

### 7.2 Lease 协议（全部条件更新，无锁）

**获取（claim）**——一个条件 UPDATE，原子裁决：

```sql
UPDATE agent_runs
SET workerId = $worker, leaseUntil = now() + leaseTtlMs, heartbeatAt = now(), status = 'running'
WHERE id = $runId
  AND status IN ('queued', 'waiting')          -- 正常入口
  AND (leaseUntil IS NULL OR leaseUntil < now())  -- 防双 claim
```

stale `running` 接管（崩溃恢复）：

```sql
UPDATE agent_runs
SET workerId = $worker, leaseUntil = now() + leaseTtlMs, heartbeatAt = now()
WHERE id = $runId AND status = 'running' AND leaseUntil < now()
```

**续期（heartbeat，15s）**：

```sql
UPDATE agent_runs
SET leaseUntil = now() + leaseTtlMs, heartbeatAt = now()
WHERE id = $runId AND workerId = $worker AND status = 'running'
-- count=0 ⇒ 已被接管或已终态 → 本 worker 必须立即中止执行（fencing）
```

**释放**：正常退出（waiting/终态）时 `leaseUntil = null`（或过期自然释放）。

### 7.3 关键性质

- **谁拥有**：唯一权威 = AgentRun 行上的 `workerId`；DB 条件更新是唯一裁决者，Redis 不参与正确性。
- **split-brain 防护**：两 worker 同时 claim → 只有一个 UPDATE 命中 count=1；另一个 count=0 → 直接放弃 job（no-op 成功返回，不报错——幂等）。被接管的旧 worker 在**下一次心跳续期时 count=0 而强制自杀**（abort 当前 LLM/tool、不再写任何状态）。残余窗口 ≤ leaseTtlMs。
- **worker crash 释放**：无需显式释放——lease 60s 过期后任何 worker 可接管（stalled job 快路径 30s 先行）。
- **两个 worker 同时恢复 stale run**：同上，条件更新原子裁决，仅一个成功。
- **为什么不用 Redis 锁**：Redis 锁引入独立失效域与 fencing 复杂度；DB 已具备条件更新原语且 run 状态本就写在 DB（同一事务域）。Redis 只保留既有 chat:lock（同步路径，行为冻结）与 Pub/Sub 提示通道。

### 7.4 Heartbeat 与 Worker 生命周期的关系

- **载体**：worker 进程内每 job 一个 `setInterval(15s)`（heartbeatIntervalMs），job 结束即 clear。
- **Node 事件循环不被 LLM 流式阻塞**（async iterable），流式期间心跳照常触发——心跳不需要"长任务期间特殊处理"。
- **心跳失败处理**：连续失败只告警不自杀（DB 抖动不误杀）；续期 count=0 才自杀（真被接管）。
- **长时间 Tool**：tool 超时上限 30s < lease TTL 60s，即便心跳恰好错过，工具也不可能在 lease 过期后继续产生副作用超过其自身超时；恢复路径靠幂等键去重（§7.5）。
- **Provider 长请求**：LLM 流不受心跳影响（独立 async 路径）；流级超时由引擎层 watchdog 兜底（§13）。

---

## 8. Checkpoint / Resume（M6 核心）

### 8.1 Checkpoint 存什么（按持久化位置）

| 数据 | 位置 | 写入时机 |
|---|---|---|
| run 身份/版本/状态/currentStep | `agent_runs`（现有） | create + 每 step 完成 |
| **LLM 会话消息全集（transcript）** | `agent_run_messages`（**新增**） | 见 §8.3 协议 |
| 每步的 step 行 | `agent_run_steps`（现有，UNIQUE(runId,stepIndex)） | 回合开始（tool_call 步）/ 结束 |
| 每工具的调用与结果 | `tool_calls`（现有，UNIQUE(runStepId,idempotencyKey)） | 先建行后执行（现有模式） |
| 等待的任务 | `agent_runs.waitingOnTaskId`（新增） | 进入 waiting 时 |
| 重试血缘 | `agent_runs.retryOfRunId / attempt`（新增） | retry 创建时 |
| 初始上下文（system + 记忆 + 知识 + 历史 + 用户消息） | `agent_run_messages` seed（role=system/user/assistant 前缀行） | run 创建时一次 |

**不存**：模型隐藏推理（M4 红线延续）、完整 prompt 快照（预算语义在 transcript 内容内，不复制 assembler 中间态）、进程内 deadline（每 resume 重算）。

### 8.2 是否需要 `agent_run_messages`？——需要，且理由充分

M5 §17 预留的备选方案是「`agent_run_messages` 表 **或** step.output 存 tool 消息」。M6 审计后判定：**必须建表**，step.output 方案不成立，因为：

1. **user/system/history 消息无处可放**：step 行只覆盖 tool_call/final 两类，run 的初始上下文（system prompt、历史对话、记忆/知识注入块、用户消息）在 step 模型里没有载体；resume 必须精确重放这些内容，否则上下文漂移。
2. **assistant 消息（含 tool_calls 快照）无处可放**：resume 的核心判定点是"最后一轮模型决定要调哪些工具"——这必须持久化，否则 crash 后只能重打 LLM（多花一次调用且结果可能分叉）。
3. **tool 结果消息的配对语义**：`role=tool + tool_call_id` 是 provider 消息序列的硬约束，需要独立有序存储，塞进 step.output（Json）会失去顺序与配对查询能力。
4. **单一有序序列 = 重放算法唯一输入**：resume 算法只依赖"transcript 顺序重放 + 行状态补全"，逻辑可被单测穷尽验证。

```prisma
model AgentRunMessage {
  id         String   @id @default(uuid())
  runId      String
  run        AgentRun @relation(fields: [runId], references: [id], onDelete: Cascade)
  seq        Int                    // run 内单调递增
  role       String                 // system | user | assistant | tool
  content    String   @db.Text
  toolCallId String?                // role=tool 时 = LLM 生成的 call id（配对用，非 ToolCall 行 id）
  toolCalls  Json?                  // role=assistant 时 = tool_calls 数组快照（id/name/arguments）
  createdAt  DateTime @default(now())
  @@unique([runId, seq])
}
```

- **生命周期**：随 run 走（Cascade）；run 永不物理删除（现有模型），无 TTL 问题。
- **写入模式**：append-only；seq 由引擎在单执行流内自增（同一 run 任何时刻只有一个 writer——lease 保证）。

### 8.3 Checkpoint 协议（每回合的落库顺序 = crash 安全边界）

```
回合开始（步首）：
  [A] 取消/超时检查（读 DB 状态 + 本地 signal）——无写
LLM 回合：
  [B] LLM 流式调用完成 → assistant 消息（content + tool_calls 快照）append transcript  ← CP1
  [C] usage 落库（现有，含失败回合）
  [D] 无 tool_calls → final 路径（见下）
工具回合：
  [E] 创建 step 行（type=tool_call, running）                                          ← CP2
  [F] 逐工具：创建 ToolCall 行（running）
      → execute（硬超时 race，§13）
      → 更新 ToolCall 行终态（output/status/duration）                                  ← CP3
      → tool 结果消息 append transcript（role=tool, tool_call_id）                      ← CP4
  [G] step 行 → completed；run.currentStep 更新（条件更新）
等待路径（异步 run + 生成类工具）：
  [H] 任务未终态 → run: running→waiting + waitingOnTaskId → 释放 lease → job return   ← CP5
final 路径：
  [I] final step 行（stepIndex=999，现有）+ assistant final 消息 append transcript
  [J] 终态条件更新（running→completed/failed/cancelled/timeout）
```

### 8.4 Resume 算法（claim 成功后）

```
1. 读 run + transcript（orderBy seq）+ steps（orderBy stepIndex）
2. messages = transcript 顺序重放（截断语义已物化在内容里，不重算）
3. 判定起点：
   a. transcript 空 → 全新执行（正常 case）
   b. 最后一条是 assistant(tool_calls)：
      - 找到 run 当前 step 行：
        · 无 step 行 → 创建 step 行（同 stepIndex），继续 [F]
        · step 行 running → 逐个 tool_call 处理（规则 4）
        · step 行 completed → 说明 [G] 已落但 [B] 未落？不可能——[G] 在 [B] 后；
          若发生（人为改库）→ 当作新回合，从 [B] 开始
   c. 最后一条是 tool 消息 → 下一个工具或下一回合（规则 4 内循环）或 [B]
   d. 最后一条是 assistant（无 tool_calls）→ final 路径补 [I][J]
4. 对 step 内每个（assistant.tool_calls 中）调用：
   - 按 idempotencyKey 查 ToolCall 行（key 算法不变：runId:stepId:toolIndex:name:arguments，
     stepId = 原 step 行 id —— resume 复用原行，key 恒定）：
     · completed 有 output → 直接复用，补 tool 消息 append（若缺）
     · running / 不存在 → 重新 execute（同一行 update 终态，不新建行）
       —— 副作用去重由 GenerationTask 全局幂等键 / Artifact 幂等键兜底（§22）
5. 继续 Loop 引擎下一回合（[B]），循环直至终态或 waiting
```

**崩溃窗口分析**（协议顺序保证）：

| 崩溃点 | 恢复结果 |
|---|---|
| [B] 前（LLM 流中） | assistant 消息未落 → 重打 LLM 回合（at-least-once，§1.4 诚实边界） |
| [B] 后 [E] 前 | 无 step 行 → 规则 3b 重建 step，继续执行工具（**不重打 LLM**） |
| [F] 工具执行中 | ToolCall 行 running → 重新 execute（幂等键去重副作用） |
| [C]/[F] 工具成功、行更新前 | 行 running → 重新 execute → GenerationTask 幂等键命中返回已有任务/结果 |
| [F] 行已 completed、[C4] 前 | 行 completed → 复用 output 补 tool 消息（**零重复执行**） |
| [H] 后（waiting） | job 已正常返回，无恢复问题；唤醒由任务终态触发（§9） |

### 8.5 能否只依赖 AgentRunStep + ToolCall？

**不能**。缺三样 resume 必需且不可再生的数据：① 初始上下文（system/history/memory/knowledge 注入块）——重新组装会因记忆/知识库在 resume 时刻已变化而产生上下文漂移；② assistant 消息的 tool_calls 决策快照——不可重算（LLM 非确定性）；③ 有序消息序列与 tool 配对。Step/ToolCall 仍是执行事实层，transcript 是决策事实层，两者互补、职责不同。

---

## 9. Async GenerationTask Integration（waiting → resume）

### 9.1 流程

```
Agent(异步 run) → image.generate/video.generate Tool（工具本身不变，仍返回 {taskId, status}）
  → 引擎检查任务状态（按 taskId 读 GenerationTask）：
      · 已终态（同步型 provider 秒回）→ tool 结果消息直接写任务结果，继续循环（不进入 waiting）
      · pending/processing → [H] checkpoint → running→waiting + waitingOnTaskId → job return
GenerationTask 终态（worker 进程 executeTask 的 complete/fail/sweep 三处，新增单点 hook）：
  → ResumeTrigger.onTaskTerminal(taskId)：
      · 条件更新：waitingOnTaskId=taskId 且 status='waiting' → status='queued'（count=0 → no-op 幂等）
      · queue.add('agent-run', {runId}, {jobId: run:{runId}})
Resume job → claim → resume 算法 → 读任务终态 → 写 tool 结果消息（成功=任务输出摘要/失败=错误文案）
  → 继续 LLM 回合 → … → 终态
```

### 9.2 关键设计点

- **如何知道等哪个任务**：`agent_runs.waitingOnTaskId` 显式记录（单任务——loop 顺序执行工具，进入 waiting 的必然是当前正在执行的那一个）。
- **一回合多工具**（模型同时要图+视频）：顺序执行，第一个未完成即 waiting；resume 后按 [F] 循环继续第二个（transcript 里 assistant.tool_calls 快照驱动，无需重打 LLM）。
- **任务失败**：resume 后写 tool 结果消息（error 文案，`tool.failed` 语义），模型看到失败自行决策（现有回喂哲学不变）。
- **任务超时**：sweep 已把它置 failed + MEDIA_TASK_TIMEOUT，hook 照常触发 resume——任务超时 ≠ run 超时。
- **避免重复 resume**：触发面三重幂等——① hook 内条件更新 waiting→queued 原子去重；② 队列 jobId `run:{runId}` 去重；③ claim 条件更新去重。
- **避免"任务完成但 run 永远不恢复"**（触发器丢失兜底）：recovery sweep（5min，worker 进程）扫描 `status='waiting'` 且 `waitingOnTaskId` 已终态的行 → 同样走条件更新唤醒。hook 与 sweep 双通道，至少一次语义 + 幂等 = effectively-once。
- **同步路径不受影响**：sync run 不进入 waiting（M5 冻结行为，任务照旧 fire-and-forget + 前端轮询）。

---

## 10. Retry Orchestration

### 10.1 分层重试矩阵

| 失败类型 | 处理层 | 行为 | 自动？ |
|---|---|---|---|
| LLM 瞬时故障（PROVIDER_TIMEOUT/RATE_LIMITED/OVERLOADED） | 引擎回合内 | 同 run 同回合重试，maxRetries=2，backoff 1s/4s + 全幅 jitter（±30%） | ✅ 自动 |
| LLM 不可重试（AUTH/BAD_REQUEST/CONTENT_FILTERED） | 引擎 | 回合失败 → 回喂模型一次（现状语义）→ 再失败 → run failed | ❌ |
| Tool 执行瞬时失败 | 引擎工具内 | `tool.retryPolicy`（**M6 起消费**，默认 1 次，retryableCodes=RETRYABLE_CODES）同一 ToolCall 行内重试 | ✅ 按策略 |
| Tool 入参非法 / TOOL_DENIED / 需审批 | 引擎 | 回喂模型（现状，不重试执行） | ❌ |
| AGENT_MAX_STEPS / AGENT_LOOP_DETECTED / AGENT_RUN_TIMEOUT | 引擎 | 直接终态（不可自动重试——语义性失败） | ❌ |
| 用户取消 | cancel API / 引擎 | cancelled 终态 | ❌ |
| Worker 进程崩溃 / lease 过期 | BullMQ stalled + recovery | **resume**（同 run 续跑，非重试） | ✅ |
| 任务失败（GenerationTask） | 引擎回喂 | 模型决策（现状），run 不自动失败 | ❌ |
| 队列 job 重试耗尽 | BullMQ dead-letter + recovery sweep | run deadline 未过 → 重新入队；已过 → timeout | ✅ 兜底 |

**Dead-letter 策略**：job `attempts: 2` 耗尽 → BullMQ failed set 保留现场（`removeOnFail: {count: 500}`）；recovery sweep 是最终裁决者——按 run deadline 判定 timeout 或重入队。**任何路径都不会让 run 永久停留 running/waiting**。

### 10.2 Run 级 Retry（用户显式）

- `POST /agent-runs/:id/retry`：旧 run 必须已终态（否则 `RUN_NOT_CANCELLABLE` 语义 → 新错误码 `RUN_NOT_RETRYABLE`）。
- 创建**新 run**：`retryOfRunId = 旧run.id`、`attempt = 旧.attempt + 1`、同一 conversation 新 assistant 消息；用户消息从旧 run transcript 第一条 user 消息复制（**不新建 user Message**，避免用户气泡重复）；上下文重新组装（retry = 新执行，允许新上下文）。
- 血缘链：`retryOfRunId` 自引用（SetNull），Timeline/报表可按链聚合；Usage 按新 runId 归集（§19）。

---

## 11. Cancellation（异步取消）

### 11.1 协议

```
POST /agent-runs/:id/cancel（userId 首条件校验归属，404 防枚举）
  → 条件更新：UPDATE agent_runs SET status='cancelled', completedAt=now(), errorCode=NULL
      WHERE id=$id AND userId=$uid AND status IN ('queued','waiting','running')
  → count=1：✅ 200 {status:'cancelled'}
  → count=0：已终态 → 409 RUN_NOT_CANCELLABLE（新错误码）
  → 同时：Redis publish 'agent-run:cancel:{runId}'（提示通道，非事实来源）
```

### 11.2 Worker 侧检测与中止

- **协作点检查**：引擎在 [A]（步首）与每个 checkpoint 后读 DB 状态（每回合至少一次）→ 发现 cancelled → 立即走终态路径。
- **快速通道**：worker 订阅 cancel 提示通道 → abort 本地 AbortController → LLM 流/工具执行被打断（需 §1.6-A8 的 signal 接线修复，否则只对协作点生效——诚实声明：首版取消延迟上界 = 心跳周期 15s 或当前回合结束）。
- **等待中取消**：waiting→cancelled 直接生效；顺带对 waitingOnTaskId 若仍 pending 走现有任务取消（best-effort，processing 中任务不打断，其完成后 hook 发现 run 已终态 → no-op）。
- **cancel 与 complete 竞争**：双方都是条件更新，DB 串行裁决。cancel 赢 → worker 后续所有写（ToolCall 终态等）改为"尽力而治"——引擎检测到 run 已非 running 即停止写业务态、放弃 yield；complete 赢 → cancel API count=0 → 409。**无中间态**。
- **cancel 与 retry 竞争**：retry 作用于新 run（新 id），与旧 run 的 cancel 正交；旧 run 血缘只读。
- **worker crash 后 cancel**：cancel 直接写 DB（不依赖 worker），queued/running 均可置 cancelled；恢复者 claim 时条件更新对 cancelled 无效 → 不会复活。

---

## 12. Timeout 与 Long-running（分层时间语义）

| 层 | 默认值 | 配置来源 | 语义 | M6 变更 |
|---|---|---|---|---|
| **run 总 deadline** | 40 min | `limits.agentRunDeadlineMs`（**新增**，可被 AgentVersion.config.runDeadlineMs 覆盖） | 绝对截止（自 startedAt，含 queued/waiting 时间），超时 → timeout 终态 | 新增；同步路径维持 `agentRunTimeoutMs=120s` 不变 |
| **lease TTL** | 60 s | `limits.agentRunLeaseTtlMs`（新增） | 心跳间断容忍上限；**≠ run 超时** | 新增 |
| **heartbeat 间隔** | 15 s | `limits.agentRunHeartbeatMs`（新增） | 续期频率（lease/4） | 新增 |
| LLM 单回合超时 | 120 s | `limits.agentRunLlmTurnMs`（新增） | 引擎层流级 watchdog（AbortSignal.timeout race 在流消费循环上），补足 provider.timeoutMs 只约束首字节的缺陷 | 新增 + 修复 signal 接线 |
| Tool 超时 | 30 s | `tool.timeoutMs ?? 30000`（现有） | **M6 起硬强制**：`Promise.race([execute, timeout reject])`，超时必抛、行必终态 | 修复（A4） |
| GenerationTask 超时 | image 5 min / video 30 min | `LIMITS.*_TASK_TIMEOUT_MS`（现有） | 任务域超时，任务 failed；**与 run deadline 独立** | 不变 |
| 队列 job 超时 | 无 | — | 队列不设时限；stalled 由 BullMQ 判定 | 明确不设 |
| 清扫 sweep | 5 min 周期 | 现有 scheduler | recovery 兜底（慢路径） | 扩展（§14） |

**明确的语义隔离**：lease 过期 ⇒ "worker 失联，可被接管"；run deadline 过期 ⇒ "任务本身失败"。两者绝不可互换。同步路径（chat）保持 120s 语义与行为**完全冻结**；`sweepAgentRuns` 只对 `workerId IS NULL`（同步 run）生效——异步 run 的失联由 lease 恢复链路处理。

---

## 13. Concurrency

| 竞争面 | 结论 | 机制 |
|---|---|---|
| 同一 run 多 worker | **禁止**，硬保证 | lease 条件更新 claim（§7），续期 fencing 自杀 |
| 同一 user 多 run | 允许（现状延续） | 无全局锁；媒体配额现有 |
| 同一 conversation 多 run | 允许（异步 run 不持 chat:lock）；同步 chat 仍受 chat:lock 互斥（冻结行为） | 顺序性由 UI 层承担（记录为已知语义） |
| 同一 ToolCall 执行一次 | effectively-once | UNIQUE(runStepId, idempotencyKey) + 行复用/恢复语义（§8.4）+ GenerationTask 全局幂等键 + Artifact 幂等键（新增，§25） |
| GenerationTask 多 consumer | exactly-once | 现有原子 claim（media-generation.service.ts:114）不变 |
| resume 幂等 | 幂等 | claim 条件更新 + jobId 去重 + transcript seq UNIQUE + step UNIQUE |
| cancel/complete/timeout 三方竞争 | DB 串行裁决 | 全部条件更新（where status=当前态），输家 count=0 |

**数据库约束 + 队列层面双重保护**：DB 唯一约束（steps/toolCalls/transcript seq）保证重放不重复落库；队列 jobId 保证同一 run 至多一个活跃 job；lease 保证同一 run 至多一个活跃 worker。三层各自独立失效不影响其余两层。

---

## 14. Crash Recovery（故障场景全表）

| 场景 | 检测 | 最终状态 | 防护方式 |
|---|---|---|---|
| **A** Worker 执行中崩溃 | BullMQ stalled（~30s）→ attempts 重试；兜底 recovery sweep | resume 同 run 继续（或按 deadline 终态） | lease 过期 + 条件 claim + checkpoint 重放 |
| **B** Tool 已成功但 worker 写 DB 前崩溃 | resume 时 ToolCall 行 running | 重新 execute → 幂等键命中复用（GenerationTask）或副作用幂等（Artifact 键） | [F] 协议 + §8.4 规则 4 |
| **C** GenerationTask 已创建但 worker 崩溃 | 任务域独立执行（worker 存活） | 任务正常终态；run 由 lease 恢复 resume 后读取结果 | GenerationTask 与 run 生命周期解耦 |
| **D** Run 已 completed 但 job 重试 | claim 条件更新（status='running' 才可 claim） | no-op，job 幂等退出 | 终态条件更新 |
| **E** Heartbeat 停止（进程假死） | lease 过期 | 新 worker 接管（fencing：旧 worker 续期 count=0 自杀） | §7.2 续期协议 |
| **F** 两 worker 同时恢复 stale run | 同时 claim | 仅一个成功，另一个 no-op 退出 | 原子条件更新 |
| **G** cancel 与 complete 同时 | 条件更新串行 | 一方获胜；输方 count=0（API 409 / 引擎静默停止） | §11.2 |
| **H** resume job 重复入队 | jobId `run:{runId}` 去重 | 至多一个活跃 job | BullMQ jobId 唯一性 |

---

## 15. Context / Memory / Knowledge（resume 时的行为）

**原则：Durable state 与 Context reconstruction 分离——resume 只重放，不重组装。**

| 组件 | 异步 run 首次执行 | resume 时 | 理由 |
|---|---|---|---|
| 上下文组装（ContextAssembler：历史+记忆+知识注入块） | run 创建时组装一次，seed 进 transcript | **不重新组装**（transcript 重放） | 防止 resume 时刻记忆/知识库变化导致上下文漂移；预算截断语义物化在 transcript 内容里 |
| Knowledge 自动注入 | 同上（seed 内） | 不重新检索 | 同上 |
| knowledge.search 工具结果 | 每次调用结果进 transcript | 重放 | 工具结果 = 决策事实 |
| Memory | 仅注入 active 记忆（seed 内）；`memory.create_candidate` 结果进 transcript | 不重新注入 | 同上 |
| Conversation Summary | **M6 不使用**（summary 源为 transcript，自动摘要属 M7，§32） | — | 表已备，M7 消费 |
| Context Budget | M5 机制不变（组装时截断；工具结果截断后物化进 transcript） | 不重算 | 重放的是已截断内容 |
| 进程内状态（lastToolSignature 等循环检测态） | — | **不恢复**：resume 后重新以 transcript 推导（循环检测窗口从 resume 点重新计数，行为可接受并文档化） | 避免检查点膨胀 |

**不把整个 prompt 无脑存 checkpoint**：transcript 只存最终消息内容（已含截断），不存 assembler 中间块与 token 估算——检查点 = 决策事实，非过程快照。

---

## 16. SSE / Realtime（观察层设计）

- **事件体系零重造**：M5 的 `agent.*/tool.*/run.*/task.*` 事件集全量沿用（shared/events.ts 已锁）。
- **新增订阅端点**：`GET /api/v1/agent-runs/:id/events`（SSE，JWT + 归属校验）：
  1. 连接建立 → 先发一条 `timeline.snapshot`（复用 Timeline 投影 items 的 JSON，作为断点基线）；
  2. 随后实时转发 worker 经 EventBus 发布的 `agent-run:{runId}` 通道事件（worker 侧 publish 为新增，EventBus 基础设施已存在——现状"只发不收"的 task 通道一并激活）；
  3. 支持 `Last-Event-ID`：客户端记录最后收到的 item `id`，重连时发送 → 服务端按（timestamp → TYPE_ORDER → id）三元组过滤快照，只补缺失段。Timeline 投影的确定性排序（M5 P8 已实现）使 cursor 语义成立。
- **断线语义**：SSE 断线不影响 Runtime（执行在 worker）；重连 = 快照补齐 + 继续订阅。**Timeline API 仍是历史事实来源**；SSE 只是实时通知，丢失事件由快照补齐。
- **不增加 RunEvent 表**：审计结论——worker 实时事件经 Redis Pub/Sub（尽力而为），历史事实由投影（Timeline）+ 决策事实（transcript，run 详情内可读）覆盖，无需事件流水表。若未来需要强审计流水，另行评估（M7+）。
- **chat SSE 冻结**：同步路径不动；`run.created` 等事件在 chat 流中的行为与 M5 逐字节一致（e2e 锁定）。
- **前端 M6 最小集**：run 详情页订阅 events 端点（含 timeline.snapshot 渲染）；chat-workspace 不动。完整 Run Timeline UI 增强留 M7。

---

## 17. Usage

| 问题 | 设计 |
|---|---|
| resume 是否继续原 run | **是**——所有 usage 行继续带原 runId，聚合自动并账 |
| retry 是否产生新 UsageRecord | 新 run = 新 runId，usage 按新 runId 归集；血缘经 `retryOfRunId` 可聚合（`GET /usage/agent-runs/:id` 增可选 `includeRetries` 聚合，或报告层按链查询——不建汇总表） |
| failed round 是否记录 | 是（M5-P4 行为延续：每回合必记，失败带 errorCode） |
| resume 后重复 LLM 回合是否重复计费 | 每次实际调用一行——**计费恒等于真实调用次数**（at-least-once 边界如实入账） |
| GenerationTask usage | 现有（成功路径带 runId）；**修复 A9**（失败路径补 runId） |
| provider 内部重试算几次 | 引擎回合内重试（maxRetries=2）记**一个回合一行**（latencyMs 覆盖全回合含重试）——回合粒度，非尝试粒度 |
| 聚合口径 | `aggregateRunUsage` 不变（按 runId+userId 求和）；waiting/恢复不产生新口径 |

**不重复统计保证**：usage 行 append-only、按真实 provider 调用一对一产生；resume/重试不产生任何"虚拟"行。

---

## 18. Security（userId-first，M6 全新增面）

| 面 | 设计 |
|---|---|
| POST /agent-runs | JWT → userId；conversationId/projectId 归属校验（M4 已定稿规则）；agentId 只允许 `enabled` 且 `scope='system'` 的 Agent |
| cancel / retry / events / 详情 | 一律 `findFirst({id, userId})` 首条件，越权 404（防枚举，现有约定） |
| **Worker 不信任队列载荷** | job payload 只有 `{runId}`；worker 以 DB 行（含 userId）为唯一身份来源；worker 内所有写操作 where 条件带 runId + 状态，不携带载荷身份 |
| transcript 访问 | 仅经 run 详情（归属校验）；无独立 transcript API |
| waitingOnTaskId 跨用户 | 任务由同一 run 的工具调用创建（ToolContext 身份继承），task.runId 链保证同用户；hook 触发时按 taskId 查 run 并校验一致性 |
| lease 接管 | 接管不改变 userId 归属（claim 只在同 run 行上做状态迁移） |
| 队列面 | BullMQ/Redis 仅内网（现有部署形态），不暴露；cancel 提示通道消息不携带敏感数据 |
| ToolContext | M4 注入机制不变：身份字段禁止出现在工具输入 schema |

---

## 19. Database Changes（M6 全部增量，无破坏性变更）

**1. `AgentRunStatus` 枚举**：+ `waiting`（PG enum ADD VALUE，安全）。

**2. `AgentRun` 加列**（全部可空，旧行默认语义 = sync）：

```prisma
workerId        String?            // lease 持有者
leaseUntil      DateTime?          // 租约到期
heartbeatAt     DateTime?          // 最近心跳
waitingOnTaskId String?            // waiting 时等待的 GenerationTask
retryOfRunId    String?            // 重试血缘（自引用）
retryOf         AgentRun?  @relation("RetryChain", fields: [retryOfRunId], references: [id], onDelete: SetNull)
attempt         Int      @default(1)
@@index([status])                  // 补：清扫/恢复查询（现状全表扫，agent 2 报告）
@@index([retryOfRunId])
```

**3. 新表 `agent_run_messages`**（§8.2 全定义）。

**4. `ToolCall`**：+ `attempts Int @default(1)`（重试可观测）。

**5. `Artifact`**：+ `idempotencyKey String?` + **部分唯一索引**（raw SQL：`CREATE UNIQUE INDEX ... ON artifacts(idempotencyKey) WHERE idempotencyKey IS NOT NULL`，与 pgvector 同法）——artifact.create 在 resume 重放时去重。

**6. `system_settings.limits` JSON**（无迁移，seed + 代码兜底）：+ `agentRunDeadlineMs: 2400000`、`agentRunLeaseTtlMs: 60000`、`agentRunHeartbeatMs: 15000`、`agentRunLlmTurnMs: 120000`。

**不建**：run_events 表（§16 论证）、checkpoint 表（§8 论证：checkpoint = 现有行 + transcript）、usage 汇总表（聚合口径不变）。

---

## 20. Queue Changes

- 新增 `agent-run` 队列（§6 全参数）。
- `AGENT_RUN_QUEUE` 常量进 `core/queue/queue.module.ts` 注册表。
- worker 侧新增 `AgentRunWorkerModule`（processor + ResumeTrigger + heartbeat + recovery 扩展），挂 `worker.module.ts`。
- media-cleanup 的 `sweepAgentRuns` 增加 `workerId IS NULL` 过滤（只扫同步 run）；新增 `recoverAsyncRuns()`（§9.2 兜底 + lease 过期重入队/超期终态）。
- 现有 image/video/media-cleanup 三队列不动。

---

## 21. API Changes

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/agent-runs` | **新增**。body：`{agentId?, conversationId?, projectId?, message, attachmentIds?}`（agentId 缺省 general-assistant）。返回 `{runId, status:'queued'}`（201）。流程：归属校验 → 建/取会话 → 建 user+assistant Message → 组装上下文 → 建 run（queued，metadata: {agentTools, mode:'async', assistantMessageId}）→ seed transcript → 入队 |
| POST | `/agent-runs/:id/cancel` | **新增**（§11） |
| POST | `/agent-runs/:id/retry` | **新增**（§10.2），错误码 `RUN_NOT_RETRYABLE` |
| GET | `/agent-runs/:id/events` | **新增**（§16，SSE 订阅，重放+实时） |
| GET | `/agent-runs/:id` | 详情增返回 transcript（`messages`，调试用，归属校验内） |
| GET | `/agent-runs?conversationId=`、`/timeline`、`/usage/...` | 不变（自动覆盖异步 run） |
| POST | `/chat` | **冻结**（同步路径） |

新错误码（shared）：`RUN_NOT_CANCELLABLE`、`RUN_NOT_RETRYABLE`。

---

## 22. Worker Changes

- `worker.ts` / `worker.module.ts`：挂 `AgentRunWorkerModule`；生产启动脚本 `start:worker: node dist/worker.js`（补 B9）。
- 新组件：`AgentRunProcessor`（claim → resume → 引擎驱动 → 终态/等待）、`RunLeaseService`（claim/续期/释放，条件更新封装）、`RunHeartbeat`（15s 定时器，fencing 自杀语义）、`GenerationTaskResumeTrigger`（任务终态 hook）、`RecoverySweep` 扩展（lease 过期 + waiting 兜底）。
- 优雅停机：§6.1。
- worker 进程不引入 HTTP 模块（现有边界保持）；Chat/Auth 模块不进 worker。

---

## 23. Test Strategy

**单元测试**：
- `RunLeaseService`：claim 成功/竞争失败/stale 接管/续期 fencing（count=0 自杀）/终态拒绝。
- Resume 组装器：transcript 重放全部判定分支（§8.4 规则 3a~3d + 规则 4 五种行状态），崩溃窗口逐点注入（[B]/[E]/[F]/[C3]/[C4] 前后）。
- 引擎重试策略：retryable 分类、backoff/jitter 上限、不可重试直通终态。
- Cancel 竞争：cancel 赢 / complete 赢 / 双方条件更新 count=0。
- Timeout 分层：lease 过期 ≠ run 超时；tool 硬超时 race；LLM 回合 watchdog。
- 新 API 归属校验（越权 404）。

**e2e（mock 全链路，注入式故障）**：
- 异步 run 全链路：POST /agent-runs → worker 执行 → 工具调用 → waiting → 任务完成唤醒 → final → 消息/usage/Timeline 断言。
- **崩溃注入**：processor 在执行中抛错模拟 worker 死亡 → BullMQ attempts 重试 → resume 从 checkpoint 续跑（断言 LLM 回合数不重复、工具不重复执行）。
- 双 worker 竞争 claim（两个 processor 实例）→ 单执行者断言。
- cancel 于 queued/waiting/running 三态 + cancel 与 complete 竞争。
- retry 血缘与 usage 聚合（新 runId 独立计费）。
- 越权矩阵：cancel/retry/events 跨用户 404。
- **M1~M5 全量回归（256 测试冻结集）必须全绿**——同步路径零行为漂移是 M6 的硬验收线。

---

## 24. Migration Strategy

- 单一增量迁移（enum ADD VALUE + 可空列 + 新表 + 索引 + Artifact 部分唯一索引），**零破坏性变更、零数据改写**。
- 旧行默认语义：`mode` 无列（以 `workerId IS NULL` 推断 sync）、`attempt=1`、transcript 为空（旧 run 无 resume 能力，只读呈现——文档化）。
- 新 limits JSON 键由 seed 写入，代码侧全部有默认值兜底（老库不加 seed 也能跑）。
- 迁移后全量回归 + seed 重跑。

## 25. Rollback Strategy

- **代码回滚安全**：新列为可空、新枚举值无旧代码消费（旧代码不认 waiting，但也不会写它）；新表无旧代码依赖。
- **运维注意事项（写入文档）**：旧代码的清扫器不处理 waiting 行——回滚前需确认无活跃异步 run（或执行折叠 SQL：`UPDATE agent_runs SET status='timeout' WHERE status='waiting'`）。数据库不回滚（枚举 ADD VALUE 不可逆属正常，PG 允许）。
- 灰度建议：先发 DB 迁移 + API 只读增强（详情 transcript），再发 worker 异步能力，最后开 POST /agent-runs。

---

## 26. M6 Implementation Phases（确认后执行序）

1. **P1 数据库 + 配置**：§19 全部迁移 + limits 键 + seed；`AgentRun.status` 索引。
2. **P2 引擎抽取与正确性修复**（不动外部行为）：AgentLoop 抽取共享引擎 + transcript checkpoint（同步路径透明接入）+ A3/A4/A8/B1/A9/B3/B4 修复 + 同步路径 e2e 回归全绿。
3. **P3 异步运行时**：POST /agent-runs、agent-run 队列、AgentRunProcessor、lease/heartbeat、resume 重放（不含 waiting）。
4. **P4 waiting/唤醒**：waiting 状态流、GenerationTask 终态 hook、recovery sweep 扩展、任务失败/超时恢复路径。
5. **P5 取消 + 重试 API**：cancel/retry 端点、取消竞争测试。
6. **P6 SSE 订阅 + 可观测**：events 端点、EventBus worker→API 打通、Timeline 对 waiting/attempt 的呈现、run 详情 transcript。
7. **P7 全量回归与文档**：M1~M6 全绿、崩溃注入矩阵、运维手册（回滚/恢复/sweep 语义）。
- Recommended（P 后，独立小项）：Document 异步 ingestion（B8）、错误码→HTTP 状态补表（B6）。

---

## 27. M6 → M7 Boundary

| 能力 | 关系 | M7 时点 |
|---|---|---|
| Human Approval | `waiting` 状态机 + resume 机制是审批等待的基座；预留：ToolCall.waiting_approval（M4 已留名）、approvalId 等待目标 | M7 实现审批实体与 UI |
| external_action 工具 | 审批前置（M4 权限位已留） | M7 |
| Ecommerce DataSource / metrics 宽表 | 独立 provider 族 + 新表域，与 M6 无冲突 | M7 |
| 自动摘要 + Context 压缩 | 数据源 = `agent_run_messages`（M6 已备）；压缩后消息替换进 transcript | M7 |
| Run Timeline UI 增强 | events 端点（M6 已备）之上做前端 | M7 |
| 用户自建 Agent（scope=user） | 独立权限域 | M7+ |
| Workflow 引擎 | 独立表/模块（M4 定稿）；queue/lease 模式可参考但**不承诺复用** | 未定 |

---

## 28. 架构一致性检查（对照八条设计原则）

| 原则 | 设计满足点 |
|---|---|
| Durable over memory | transcript + step/toolCall 全落库；resume 只读 DB |
| DB is source of truth | lease/cancel/claim/终态全条件更新；Redis 仅提示 |
| Queue is execution mechanism | payload 仅 runId；业务状态零进队列 |
| SSE is observation | 断线不影响执行；重连靠投影快照补齐 |
| Timeline is projection | 无 run_events 表；Runtime 不读 Timeline |
| Idempotency everywhere | claim/jobId/seq UNIQUE/step UNIQUE/任务幂等键/Artifact 幂等键 |
| Terminal means terminal | 全迁移条件更新，输家 count=0 |
| User scope everywhere | §18 全表覆盖；worker 不信任载荷身份 |

**与 M0~M5 冻结边界的兼容**：同步 chat 路径行为逐字节冻结（e2e 锁定）；`Agent→Tool→Service→Provider` 分层不变；Timeline/Usage 投影口径不变；无一处要求推翻既有决策。

---

## 三清单

### Must Fix（M6 内，阻塞长任务）

A1~A9（§1.5）全部并入实施 Phase（P2~P5）。

### Recommended（M6 内）

B3（锁 fencing）、B4（任务 cancel 条件更新）、B6（错误码补表）、B8（文档异步 ingestion）、B9（生产 worker 脚本）。

### Future（M7+）

B2（usage tokens 消费）、B5（dashscope 超时加固）、B7（TaskStatus.timeout 枚举值）、摘要/压缩、审批、Ecommerce、Timeline UI 增强、多租户。

### 绝对不能提前做（M6 内禁止）

Human Approval、external_action、Ecommerce DataSource、Workflow 引擎、多 Agent 协作、Billing、OCR、独立向量库、外部可观测平台接入。
