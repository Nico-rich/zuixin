# M8-P9 生产可用性基线（健康检查 / 优雅停机 / 背压 / 熔断 / 性能实测）

> 状态：M8-P9 已落地并**实测**。本文件里的所有数字都是本机真实跑出来的（脚本、命令、环境、时间戳均可复现），
> 不是估算值。凡未在本环境验证的项，一律在文末「未验证项」明列——不猜测、不粉饰。

- 实测日期：2026-09-25
- 环境：Windows 11 + Node v24.14.0；本机 Docker `docker-postgres-1`（pgvector/pgvector:pg16，5433）、
  `docker-redis-1`（redis:7-alpine，6379）、`docker-minio-1`（9000/9001）
- 被测进程：API `AppModule`（随机端口、本机回环）+ Worker `WorkerModule`（同进程，`AGENT_RUN_WORKER_CONCURRENCY` 默认 2）

---

## 1. 健康检查：三端点与依赖分级

| 端点 | 语义 | 探测依赖 | 状态码 |
| --- | --- | --- | --- |
| `GET /api/v1/live`（别名 `GET /api/v1/health/live`） | **进程存活**（liveness） | **零 I/O**（不碰 DB/Redis/存储，连日志都不打） | 恒 `200` |
| `GET /api/v1/ready`（别名 `GET /api/v1/health/ready`） | **可接流量**（readiness） | DB + Redis（critical） | 全 up → `200`；任一 down → `503`（body 仍带完整报告） |
| `GET /api/v1/health` | 聚合报告（兼容保留） | DB + Redis + 对象存储 + 队列计数 | **恒 `200`**（故障体现在报告字段里，见下） |

`/health` 报告新增字段（旧字段 `status` 语义与取值不变，既有探针/告警规则零改动可用）：

```jsonc
{
  "status": "ok | degraded | unavailable",   // ok=全绿；degraded=仅非关键依赖故障；unavailable=关键依赖故障
  "ready": true,                             // 与 /ready 的 200/503 同一判定（DB && Redis）
  "db":      { "state": "up", "latencyMs": 2.1 },
  "redis":   { "state": "up", "latencyMs": 0.8, "detail": "失败原因(截断200字符,绝不含凭证)" },
  "storage": { "state": "up", "latencyMs": 1.2, "driver": "local" },
  "queue":   { "state": "up", "waiting": 0, "active": 0, "delayed": 0, "failed": 0, "depth": 0, "maxDepth": 1000 },
  "checks":  [ { "name": "db", "critical": true, ... }, { "name": "storage", "critical": false, ... } ],
  "uptimeMs": 123456, "timestamp": "2026-09-25T05:27:51.807Z"
}
```

**分级规则**（`checks[].critical` 显式暴露给运维，写告警规则依赖它）：

- `critical: true`（DB / Redis）任一 down ⇒ `status='unavailable'`、`ready=false`、`/ready` **503** ⇒ 负载均衡必须摘流量；
- `critical: false`（对象存储 MinIO/本地盘）down ⇒ `status='degraded'`、`ready=true`、`/ready` **仍 200** ⇒
  **绝不因非关键依赖摘掉整个实例**（生成类能力受损，但对话/查询等核心路径可用；摘流量只会放大故障）；
- `/live` 与依赖完全解耦 ⇒ 依赖抖动**绝不触发编排层重启**（重启治不好下游故障，只会雪崩）。

**探测硬超时**：每个探测都有 1s 硬超时（`HEALTH_PROBE_TIMEOUT_MS` 覆盖），三项探测**并行**，
所以 `/health`、`/ready` 的耗时上界 ≈ 1×timeout（Redis 冷启动等建连时最坏 ≈ 2×timeout）。
依赖挂起时探针**一定**会返回结论，绝不被拖死。已实测：注入一个 1.2s 挂起的探测替身后，`/live` 仍在 **< 500ms** 内返回（`test/m8-p9-reliability.e2e-spec.ts`）。

**队列计数复用 Redis 结论**：Redis down 时不再打第二次网络，直接返回 `queue.detail='Redis 不可达'`。

**探针连接的两个坑（已修，勿回退）**：

1. 探针用**独立** ioredis 连接（`createRedisProbeClient`），不复用 BullMQ 主连接——主连接
   `maxRetriesPerRequest: null` 会无限重试，探针必须能快速失败；
2. 该连接必须 `enableOfflineQueue: true`：`lazyConnect` + 冷启动/重连窗口里 stream 还没 writable，
   关掉离线队列会让**首个 ping 立即 reject ⇒ 实例刚起来就误报 Redis down ⇒ /ready 503 ⇒ 健康实例被摘掉**
   （假故障比慢 200ms 危害大得多）。失败仍然有界：`maxRetriesPerRequest: 1` + 调用方 1s 硬超时。
   回归测试见 e2e「冷启动不误报」用例。

**编排接入（建议值）**：

```yaml
livenessProbe:  { httpGet: { path: /api/v1/live,  port: 3001 }, periodSeconds: 10, failureThreshold: 3 }
readinessProbe: { httpGet: { path: /api/v1/ready, port: 3001 }, periodSeconds: 5,  failureThreshold: 2, timeoutSeconds: 3 }
startupProbe:   { httpGet: { path: /api/v1/live,  port: 3001 }, failureThreshold: 30, periodSeconds: 2 }
```

**告警建议**：`status=='unavailable'` 持续 1min → P1；`status=='degraded'` 持续 5min → P2；
`queue.depth / queue.maxDepth > 0.5` 持续 5min → P2（提前于 429 触发前介入）。

---

## 2. 优雅停机（SIGTERM → 收尾 → 有界强退）

模块：`apps/api/src/lifecycle/graceful-shutdown.ts`（单文件，API 与 Worker 共用同一实现）。
接线：`main.ts` 末行 `registerGracefulShutdown(app)`；`worker.ts` `registerGracefulShutdown(app, { worker: true })`
（两处均有源码级 e2e 断言，防止「写了模块没挂上」）。

**顺序（已从 Nest 源码 + 真实 BullMQ 实测确认）**：

```
SIGTERM/SIGINT → phase:start
  → app.close()
      ├─ onModuleDestroy（Prisma $disconnect 等）
      ├─ onBeforeShutdown
      ├─ HTTP adapter 关闭（**先停止接受新请求**，在途请求继续跑完）
      └─ onApplicationShutdown（**按模块注册逆序**）
            └─ BullExplorer: Promise.all(worker.close()) —— 非 force 的 close() **等当前 job 跑完**
  → phase:closed → exit(0)
```

- 实测不变式：停机过程中**在途 job 不被中断**（合成 Nest 应用 + 真实 BullMQ job，`probeJobFinished === true`
  且 `processor:onApplicationShutdown` 早于 `job:end`）；处理器自己的 `onApplicationShutdown` 确实被调用
  （`AgentRunProcessor` 的 lease 释放钩子，真实 `WorkerModule` 上验证 `toHaveBeenCalledTimes(1)`）。
- **30s 兜底**：`GRACEFUL_SHUTDOWN_TIMEOUT_MS`（默认 `30000`）内没关完 ⇒ 记录 `phase:timeout` 并以退出码 1 强退，
  绝不无限等待（已用 200ms 短窗口实测）。
- 重复信号幂等：第二次 SIGTERM/SIGINT 复用同一序列结果，`app.close()` 只调用一次。
- Scheduler：`onApplicationShutdown` 先停巡检定时器、置 `shuttingDown`（不再认领新作业），再**有界等待在途作业收尾**
  （`SCHEDULER_SHUTDOWN_WAIT_MS`，默认 25s），窗口到期记录告警后放行。

**K8s 参数**：`terminationGracePeriodSeconds` 必须 **≥ 35**（30s 兜底 + 缓冲），否则 SIGKILL 会绕过收尾。

---

## 3. 队列可靠性

### 3.1 崩溃恢复（已有原语，P9 回归验证）

| 场景 | 机制 | 兜底事实源 |
| --- | --- | --- |
| Worker 崩溃（AgentRun） | lease 过期/已释放 ⇒ `AgentRunLeaseService.recoverStale()` 重新入队（由 media-cleanup 5min 清扫调用，**已接线**） | DB 条件更新（`claim`）——重复入队/重复 job 幂等 |
| Worker 崩溃（WorkflowRun） | `WorkflowLeaseService.recoverStale()` 同构（**P9 接线到 media-cleanup 清扫周期**，见下） | 同上 |
| job 因优雅停机被放弃 | processor 抛错 → BullMQ `attempts: 2` + 指数退避重试 | 重试耗尽仍由 `recoverStale` 兜底 |

**P9 发现的真实缺口（已修复，非仅测试问题）**：`WorkflowLeaseService.recoverStale()`（M7-P6 原语）
此前**只被测试直接调用，没有任何周期任务调用它** ⇒ 生产环境里 workflow run 的丢失 job 无人重投、
worker 崩溃后 lease 过期无人接管（run 永久停在 `running`）、超过 1h `workflowDeadlineMs` 无人判超时。
M8-P9 将它接线进 `MediaCleanupProcessor.process()`（同一 5min 清扫周期，条件更新 + 唯一 jobId，幂等且多 Worker 安全），
并把 e2e 从「直接调 service」改为**走生产清扫入口**断言 —— 直接调 service 的测试正是掩盖该缺口的写法。

**实测（真实 DB + 真实 Redis + 真实 Worker，不 mock）**：
把 run 置为 `running` + `leaseUntil` 过期（模拟崩溃）→ `recoverStale()` → 真实 worker 接管 → `completed`，
且 LLM 计量行数 **恰好 1**（不重复执行）；并发触发 3 次 `recoverStale()` 仍然只执行一次；
终态 run 再次 `claim` 返回 `acquired: false`（**永不二次执行**）。
WorkflowRun 走 `MediaCleanupProcessor.process()` 生产路径验证通过（`workflowRecovered.reEnqueued ≥ 1` → `completed`）。

**恢复时延（诚实口径）**：清扫周期 5min + 判定阈值 ⇒ 崩溃 run 的最坏恢复时延 ≈ 6~7min
（`running` 需等 lease 过期 60s，`queued` 丢 job 需 `queuedFor > 2×leaseTtl = 2min`，再等最近一次清扫 tick）。

### 3.2 Scheduler stalled 巡检（P9 新增）

- **心跳**：作业执行期间按 `timeoutMs/3`（钳制 500ms~5s）刷新 `updatedAt`（`where status='running'` 条件写；
  作业被取消/重投后绝不再续写），`finally` 里清除定时器。
- **判定**：`lag = now - updatedAt > max(timeoutMs × 3, 心跳间隔 × 3)` ⇒ 条件更新 `status: 'dead'` + `lastError`
  留痕 + 发 `scheduler.job.dead` 事件；**绝不自动重投**（一致性优先：无法区分「慢」与「死」时，宁可人工介入，
  也不制造重复副作用）。阈值下限保证长作业不被误杀（60s 作业 30s 无心跳仍不判死）。
- 巡检间隔 `SCHEDULER_RECONCILE_INTERVAL_MS`（默认 60s），定时器 `unref()` 不阻止进程退出。

### 3.3 BullMQ 重试/backoff 语义（只测不改，回归）

`attempts: 2` + `backoff: exponential(2000)` + `removeOnComplete: true` + `removeOnFail: {count: 500}`
与既有 lease 语义**不冲突**：BullMQ 只决定「谁来跑下一次」，**终态永远由 DB 条件更新裁决**；
job 重试耗尽后 `recoverStale` 仍能兜底（e2e 已断言）。

---

## 4. 背压：两层闸门

| 层 | 位置 | 口径 | 触发 |
| --- | --- | --- | --- |
| 单租户 | `QuotaService.assertQuota`（P2 已有） | org 活跃 run 数 vs `concurrentAgentRuns` | 429 `QUOTA_EXCEEDED` |
| 全局 | `QuotaService.assertQueueDepth`（P9 新增，`agent_run` 创建入口**最先**执行） | `queue.getJobCounts('waiting','active')` 之和 ≥ `AGENT_RUN_QUEUE_MAX_DEPTH`（默认 1000） | 429 `QUOTA_EXCEEDED`，报文含真实 `X/Y` |

- 分工：并发配额管「单个租户别占满 worker」，队列深度管「**所有租户合计**别再收了」——积压越深恢复越久，
  且 BullMQ 的 job 保留/重试会放大内存占用。
- **绝不误拒（fail-open）**：队列未装配 / Redis 不可达 / 探测超时（1s 硬超时）⇒ 放行并 warn。
  理由：Redis 故障时该熔断的是 Redis 依赖方，而不是在入口新造一次全站 429。
- 实测：真实投递占位 job 造出真实积压（observed depth ≥ 5）后，`POST /agent-runs` 返回 **429** 且
  `error.message` 含真实 `积压 N/1`；撤压并恢复水位后同一请求 **201**（`test/m8-p9-reliability.e2e-spec.ts`）。
- **口径注意**：水位只统计 `waiting + active`。BullMQ **暂停队列**时 job 会落到 `paused` 列表，此时计数为 0
  ——运维在「暂停队列排障」期间不要指望背压闸门生效（这也是把队列长期置 paused 视为非常规操作的原因）。

---

## 5. 熔断（`CircuitBreakerService`，Redis/KV 事实源）

- 状态机：`healthy → open → half_open → healthy`；`canCall()` 判定，`recordSuccess()/recordFailure()` 记录；
- 与路由集成：`ModelRouterService.order(candidates)` 过滤掉 `canCall()===false` 的候选，
  `execute()` 统一记录成功/失败 ⇒ **故障 provider 被自动跳过，请求走下一个候选**；
- **per-provider 隔离**：一个 provider 熔断不牵连其他候选（e2e 已断言）；
- 实测（真实 Redis + 真实 ModelRouter）：连续 5 次可重试 `PROVIDER_TIMEOUT` → `open` → `order()` **返回空**
  （后续请求不再打到故障 provider）→ 冷却期（`cooldownSec: 0`）后进入 `half_open` → `recordSuccess()` 恢复 `healthy`。
- 运维含义：`order()` 返回空 = 所有候选都在熔断中 ⇒ 上游应返回明确的「服务暂不可用」而非无限重试。

---

## 6. 性能实测（真实执行，非模拟）

脚本：`apps/api/scripts/load-test.ts`（**自实现，零外部压测框架**：`node:perf_hooks` + `fetch` + 真实
DB/Redis/Worker）。复现：

```bash
cd apps/api
MOCK_DELAY_MS=0 npx tsx scripts/load-test.ts   # A：纯系统吞吐（排除模拟模型延迟）
npx tsx scripts/load-test.ts                   # B：含 mock 流式延迟（20ms/分块，模拟真实模型流式）
```

脚本自清理：跑完删除自己创建的全部 run + 观测采样，**不往开发库留压测数据**。

### 6.1 运行 A — `MOCK_DELAY_MS=0`（系统能力，`ranAt=2026-09-25T05:38:06Z`）

| 指标 | 结果 |
| --- | --- |
| `GET /api/v1/live` 50 并发 × 200 请求 | **0 错误**，吞吐 **1502 req/s**，p50 **27.65ms**，p95 **52.32ms**，p99 **54.93ms**（max 55.72） |
| `GET /api/v1/ready`（含 DB+Redis+存储探测）50 并发 × 200 | **0 错误**，吞吐 **1328 req/s**，p50 **32.66ms**，p95 **36.33ms**，p99 **49.04ms** |
| 20 并发 `POST /agent-runs`（message=你好） | 20/20 accepted，**20/20 completed**（0 失败）；端到端 p50 **529ms**、p95 **879ms**（max 890） |
| 单个 run 真实执行时长（Worker 自采 `agent_run_duration_ms`） | p50 **63ms**、p95 **77ms** |
| 50 个 job 直投 agent-run 队列 | 入队 2.81ms，排空 **1528ms** ⇒ **32.72 job/s**；端到端 p50 683ms / p95 1366ms；单片执行 p50 **48ms** / p95 58ms |

### 6.2 运行 B — `MOCK_DELAY_MS` 未设置（含模拟模型延迟，`ranAt=2026-09-25T05:39:24Z`）

| 指标 | 结果 |
| --- | --- |
| `GET /api/v1/live` | 0 错误，**1471 req/s**，p50 28.77ms，p95 51.59ms，p99 54.85ms |
| `GET /api/v1/ready` | 0 错误，**1314 req/s**，p50 33.89ms，p95 36.69ms，p99 51.84ms |
| 20 并发 `POST /agent-runs` | 20/20 completed；端到端 p50 **9498ms**、p95 **18847ms** |
| 单个 run 真实执行时长 | p50 **1862ms**（≈93 个流式分块 × 20ms，**由 mock 的模拟延迟主导，不是系统开销**） |
| 50 个 job | 排空 **42943ms** ⇒ **1.16 job/s** |

**怎么读这些数字（诚实解读）**：

1. **HTTP 路径本身不是瓶颈**：`/live`（零 I/O）与 `/ready`（真探 DB+Redis+存储）吞吐都在 1300~1500 req/s、
   p99 < 56ms，且 200 请求 0 错误。该量级由「本机回环 + 50 条连接」决定，**不代表生产网关后的容量**。
2. 本机样本只有 200 次请求，p99 是第 2 差的样本（最近邻百分位，不插值）⇒ p99 数字**噪声大**，
   只用于「有没有秒级/超时级异常」的判断。
3. **队列吞吐 ≈ 32.7 job/s（concurrency=2，单 run 执行 ≈ 48ms）**：这是本机单进程 Worker 的消费能力上界，
   与 `AGENT_RUN_WORKER_CONCURRENCY` 近似线性。真实 LLM 调用（数秒级）下吞吐由模型延迟决定，**worker 应扩副本而不是调大并发**。
4. 运行 B 的 1.16 job/s 与执行 p50 1862ms 说明：**当模型流式延迟 ~2s/次时，吞吐从 33 job/s 掉到 1.2 job/s**——
   这正好量化了「模型延迟而非平台」才是吞吐的主导项。
5. 两种配置下 `errors` 全为 0：**压测期间无 5xx、无 429、无超时**（背压水位 1000 远高于 50 的压测负载）。

---

## 7. 上线前检查清单（Ops Checklist）

**配置**
- [ ] `ENCRYPTION_KEY` 已备份到密钥管理系统（**丢失 = 所有已加密凭证不可恢复**，见 DR 手册）
- [ ] `DATABASE_URL` / `REDIS_URL` 指向高可用实例；连接池上限与会话数匹配
- [ ] `AGENT_RUN_QUEUE_MAX_DEPTH`（默认 1000）按 worker 消费能力 × 可接受恢复时间设定
- [ ] `GRACEFUL_SHUTDOWN_TIMEOUT_MS`（默认 30s）与 K8s `terminationGracePeriodSeconds` ≥ 35 对齐
- [ ] `HEALTH_PROBE_TIMEOUT_MS`（默认 1s）小于 LB/探针超时
- [ ] `MOCK_DELAY_MS` 等开发替身配置在**生产必须不存在**（否则跑的是替身 provider）

**部署**
- [ ] liveness → `/api/v1/live`；readiness → `/api/v1/ready`（**不要**把 readiness 指到 `/health`：它恒 200）
- [ ] 滚动更新时确认 `ready` 摘流先于进程退出；观察日志出现 `phase:closing → phase:closed`
- [ ] Worker 与 API **分开部署**（Worker 故障不摘 API 流量；API 扩容不重复消费队列）

**告警**
- [ ] `/ready` 503 持续 1min；`/health.status=='unavailable'`
- [ ] `queue.depth / queue.maxDepth > 0.5` 持续 5min；`queue.failed` 增长
- [ ] 出现 `scheduler.job.dead` 事件（需人工确认作业语义后再决定是否重投）
- [ ] 出现 `phase:timeout`（停机超时 = 有 job 卡住，需排查）

**故障演练**
- [ ] 按 `docs/operations/m8-disaster-recovery.md` 每季度做一次「备份 → 临时库恢复 → 校验」演练
- [ ] 演练 `kill -TERM` 一个 Worker：确认在途 run 由 `recoverStale` 接管并只执行一次

---

## 8. 未验证项（诚实清单，勿当成已验证）

| 项 | 状态 | 原因 / 如何补 |
| --- | --- | --- |
| DB / Redis **真实宕机**下的 `/ready` 503 | ⚠️ 用**探针注入**验证（HTTP 全链路真实，探针结果替身） | 共享 PG/Redis 被其他 Phase 与并行任务使用，**禁止停服**。生产演练里应真停从库/单节点验证 |
| 多副本 / 多节点下的行为（LB、Redis 主从、PG 主备） | ❌ 未验证 | 本机为单实例单容器；需在预发集群按生产拓扑重跑 |
| 队列「暂停」状态下背压计数 | ⚠️ 已知口径缺口（见 §4 注意） | 需在演练中确认运维流程不会长期 pause 队列 |
| 真实 LLM provider（非 mock）的延迟/限流/熔断行为 | ❌ 未验证 | 需真实 API Key；压测数字会完全由模型决定 |
| 长稳压（小时级）/ 内存泄漏 | ❌ 未验证 | 本机脚本为分钟级基准；需在预发做 soak test |
| 30s 停机兜底在真实 K8s SIGKILL 边界下的表现 | ❌ 未验证 | 单测/短窗口已覆盖逻辑；需集群验证 `terminationGracePeriodSeconds` |
