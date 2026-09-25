# Pre-M9 可靠性包规格（G1~G11 + C5 + D5）

> 基于 M0-M8 Final Architecture Audit 的真实发现。**依赖**：计费正确性包（已落地）与安全/性能包（合并后）先行——本包在其后串行实施。
> 实施 Agent 只许改业务代码；禁止修改 schema.prisma/migrations（如需 schema 变更先反馈 Coordinator）；禁止 prisma generate/migrate。

## G1/G2 熔断自愈 + 生产 LLM 路径接线 [HIGH]

现状：`apps/api/src/core/circuit-breaker/circuit-breaker.service.ts` openedAt 无 TTL（触发后永久排除）；唯一调用方是 media 的 ModelRouter 且从不传 isProbe → 跳闸即永久打开。生产 LLM 调用链（llm-manager / model-resolver）零熔断引用。

要求（最小正确接线，不重造 Router）：
- CircuitBreaker：closed/open/half-open 三态 + TTL 自动半开（openedAt + cooldown 到期 → 半开）+ probe 成功复位/失败重新打开；canCall 支持 probe 语义。
- 接线：Agent 回合 LLM 调用（engine resolveLLM 路径）失败进熔断计数；熔断 open 时模型选择跳过该 provider（model-resolver 已有候选 fallback 语义可复用）。**完整 RoutingService 接入（策略/成本/评分）是 M9-P3 的事——本包只做熔断自愈 + 计数/跳过接线。**
- 测试：单测（三态转移、TTL、probe）+ 故障注入 e2e（provider 连续失败 → open → 冷却后半开 probe → 成功复位）。

## G3 Graceful Shutdown 顺序 [HIGH]

现状：`apps/api/src/main.ts`（或 shutdown 钩子）先断 DB/Redis 再关 HTTP/worker；SSE 未纳管 → 30s 强退 exit(1)。

要求顺序：停止接受 HTTP → 停新队列 job → 停新 SSE 订阅 → drain 活动 HTTP/SSE → worker 停 claim → lease finalization → drain 活动 worker job → 关 BullMQ → 关 Redis → 关 DB。SSE 连接纳入管理（连接集合 + 关闭/超时）。增加真实 shutdown e2e（发请求后 SIGTERM 模拟，断言无 exit(1)、lease 已释放）。

## G4 Redis 超时 [HIGH]

现状：Redis 不可用时 login 锁/chat 锁/queue.add 无限挂起（maxRetriesPerRequest null 无 commandTimeout）。

要求：所有关键 Redis 路径（login lock、chat lock、queue.add、scheduler、EventBus、rate limit）设置 command timeout + 有界重试 + 显式失败；关键路径 catch 降级（fail-open 放行或 fail-closed 拒绝——按路径语义选择并注明理由）。禁止无限 hang。

## G5 DashScope 超时/取消 [HIGH]

现状：`apps/api/src/providers/image/adapters/dashscope-image.adapter.ts`、video 同理——timeoutMs 被丢弃，executor AbortSignal 死代码。

要求：image/video 真实传递 connect timeout / request timeout / polling timeout / overall deadline / abort；signal 真正传入底层 fetch/SDK。

## G6 LLM 流式总时限 [HIGH]

现状：openai-compatible 流式只有 SDK 连接超时（响应头到达即清除）——卡流可占 worker 至 40min deadline。

要求：connection timeout / first-byte timeout / idle timeout / total stream deadline 四层；总时长受 AgentRun deadline 约束（engine 已有 deadline 检查，补流级 idle 超时——相邻 chunk 间隔超限即中断）。中断映射 PROVIDER_TIMEOUT。

## G7 remoteTaskId 回读 [HIGH]

现状：GenerationTask.remoteTaskId 只写不读——provider 成功后崩溃只能等清扫判失败。

要求：`recoverRemoteGenerationTask()`：pending/processing 且有 remoteTaskId 的任务 → 查询 provider 状态（adapter 需支持 remoteStatus 查询接口——mock/dashscope 实现）→ 恢复终态。接线到 media-cleanup 清扫周期（替换"一律判失败"）。ExternalAction 同理（executing + externalRequestId → provider 状态查询恢复；与计费包的 claim 语义衔接）。

## G8 Payment 事务一致性 [HIGH]

现状：`billing.service.ts` applyPayment 事件+发票非事务化；P2002 分支不补更新 → 发票永久 unpaid。

要求：事件幂等 claim（P2002 后重查）→ 发票状态转换补做；或事件与发票更新用同一事务（Prisma $transaction）。crash/retry e2e。

## G9 Scheduler dead resume [HIGH]

现状：`scheduler.service.ts` resume 只接受 paused，与文案"dead 可恢复"矛盾。

要求：dead → resumeable 语义（选择与现有状态机一致的一套：resume 接受 paused+dead，状态定义文档化）；不新增状态值（除非 Coordinator 同意 schema 变更）。

## G10 EventEnvelope 冻结或接消费者 [HIGH]

现状：EventEnvelope 只写无消费者（无 relay；redeliver 只收 dead）；published 永久滞留。

要求（选 B：冻结）——当前产品无真实消费者，**冻结**：删除/停用无意义运行路径（保留表结构与幂等写入 API，明确标注 frozen；不新增订阅/relay 功能）。若审计后发现真实消费者需求另报 Coordinator。

## G11 非幂等写工具 [HIGH]

现状：resume 会重复执行的非幂等写工具（feedback/performance/analysis）无幂等键。

要求：所有写副作用工具补幂等键（ToolCall 层已有幂等键——检查工具内部是否二次写其他表无幂等保护：feedback.create、performance.insights（若写）、commerce analysis 写）。补 UNIQUE 幂等键或复用既有键（schema 变更需求先报 Coordinator）。

## C5 refresh 折叠多实例 [HIGH]

现状：`connections/credentials` refresh 折叠仅进程内；store 无条件 update 无 CAS。

要求：多实例安全——DB 条件更新兜底（version/updatedAt CAS 或状态条件 updateMany）；进程内折叠保留。e2e：并发 refresh（模拟两实例并行调用）→ 仅一次 provider 刷新。

## D5 Workflow lease 心跳 abort 对齐 [HIGH]

现状：workflow processor 心跳 renew=0 只 warn 不 abort → 分叉 worker 双写风险。

要求：renew=0 → 立即 abort 当前执行（与 agent run lease 语义对齐）。验收：单测 + 既有 workflow e2e。

## 交付与自验

- 自测：单测 + 相关 e2e（m6/m7-p3/m8-p5/m8-p2 等受影响文件）+ `npx tsc --noEmit`。
- 提交：中文规范 message（注明 G1-G11/C5/D5 与测试数）。
- 返回：每项文件/机制/测试数/自验结果；NOT VERIFIED 项；与真实代码的差异报告。
