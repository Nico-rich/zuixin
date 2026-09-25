# Pre-M9 性能包规格（P1 createAsync/P2 Analytics/P3 resume 预算/P4 向量索引/P5 EventBus/P6 索引验证）

> 基于 M0-M8 Final Architecture Audit 的真实发现。实施 Agent 只许改业务代码；**禁止修改 schema.prisma、禁止创建/执行 migration、禁止 prisma generate**（Coordinator 已预整合：复合索引与 HNSW 向量索引已在库）。禁止为性能破坏状态机一致性（全部条件更新/CAS 语义保持不变）。

## P1 createAsync 往返合并 [HIGH]

现状：`apps/api/src/modules/agent-runs/agent-runs.service.ts` createAsync ≈14-17 次 DB 往返全串行；transcript seed（agent-run-messages append）串行循环 30-75 次往返（append 内含 requireRun + max(seq) + create ×3）。

要求：
- 可并行的查询并行化（Promise.all）；可合并的读合并（一次 include/findMany 取多实体）。
- transcript seed 批量写入（createMany；保持 UNIQUE(runId, sequence) 幂等语义——冲突时降级逐条或复用现有 append 语义）。
- 禁止破坏：配额断言顺序、归属校验、幂等键语义。
- 验收：单测断言往返数下降（可用 spy 计数）+ 既有 e2e 全绿。

## P2 Analytics 出请求路径 [HIGH]

现状：`apps/api/src/modules/analytics/analytics.service.ts` overview/breakdown 读路径内联 `refreshAll`——单请求 512~6,223 条查询（month=30×17、days=366→6.2k）；四维聚合 findMany+JS 求和。

要求：
- 读路径只读聚合表（绝不内联全量刷新）：`overview/breakdown` 去掉 `await this.refreshAll(...)`。
- 刷新改为显式/后台入口：现有 refresh API（refresh endpoint 或 controller 调用点）保留显式刷新；新增"轻量补偿刷新"策略——读路径只刷新**当日**（单日 17 查询上限）而不是 30/366 天，且当日刷新幂等（refreshOrganization 单日）。
  - 折中：overview(range=day) 刷当日；week/month 只读已有聚合 + 当日补刷（绝不 366 天内联）。文档化"历史聚合由显式刷新/后台任务维护"。
- 保留 `sources()/query()` 只读语义。
- 验收：e2e 断言 overview 查询数下降（可 spy prisma 调用计数）+ 既有 analytics e2e 更新后全绿（e2e 若依赖旧"读时自动刷新全区间"行为——按新语义更新断言并注明）。

## P3 续跑上下文预算 [HIGH]

现状：`apps/api/src/worker/agent-run/async-agent-run.driver.ts` replayHistory 全量重放 transcript 且跳过 ContextBudgetService——160KB 级进首个 LLM 调用。

要求：
- resume 重放必须经 ContextBudgetService 预算（与首跑同一裁剪语义）。
- 注意：**绝不能裁剪掉最后一条 user 消息与关键 tool 决策**——ResumePlanner 依赖 transcript 完整性做续跑计划（planResume 仍读全量 transcript；只有发给 LLM 的 messages 做预算裁剪）。
- 验收：单测（超长 transcript → 发送给 adapter 的消息量被裁剪 + planResume 行为不变）+ 既有 resume e2e 全绿。

## P4 Knowledge 向量索引 + 批量 chunk [HIGH]

现状：检索 raw SQL `(1 - (embedding <=> q))` 表达式 ORDER BY 无法走索引 → 全表扫描；`knowledge.repository.ts` createChunks 逐条 raw INSERT。

Coordinator 已预整合：`DocumentChunk_embedding_hnsw_idx`（hnsw + vector_cosine_ops，vector(1536) 固定维度）；`MOCK_EMBEDDING_DIMS` 默认 1536。

要求：
- 检索查询改写为 `ORDER BY c.embedding <=> $vector`（cosine 距离升序）+ 相似度阈值过滤 + userId/projectId scope 过滤（候选集后过滤）——走 HNSW 索引。
- `createChunks` 批量 INSERT（单条多 VALUES；一次往返）。
- 维度守卫：写入侧拒绝非 1536 维向量（明确错误，绝不静默插坏数据）。
- 验收：单测（SQL 形状断言/EXPLAIN 走索引——测试库真实 pgvector 可跑 EXPLAIN）+ 既有 knowledge e2e 全绿 + 简单 benchmark 数字（1000 行向量检索耗时对比，如实记录即可）。

## P5 EventBus 批处理 [MED-HIGH]

现状：`apps/api/src/core/events/event-bus.service.ts` 每事件一次 await Redis publish——text.delta 逐 chunk 转发（2000 chunk 回答 = 2000 次串行 Redis 往返在生成循环内）。

要求：
- 发布侧批处理/缓冲（microtask 或短窗口聚合，如 5-10ms 窗口内合并为一条 multi/pipeline 发布或直接 batched publish）。
- 不能影响：SSE 实时性（延迟预算 <~50ms）、final message 持久化、cancellation（flush 在 generator 结束/异常路径强制）。
- channel 订阅泄漏：补充 unsubscribe 机制（进程退出时关闭）。
- 验收：单测（批处理合并断言）+ 既有 SSE e2e 全绿（事件顺序与内容不变）。

## P6 索引验证（schema 已由 Coordinator 完成）

Coordinator 已在库：`UsageLedgerEntry(organizationId,kind,createdAt)`、`Project(organizationId)`、`AgentRun(status,leaseUntil)`、`UsageRecord(organizationId,createdAt)`。
- Agent 负责：验证相关查询（quota 日聚合/lease 清扫/组织 project 列表）实际走索引（EXPLAIN），如未走——报告原因（不自行加索引；确需新索引反馈 Coordinator）。

## 交付与自验

- 分支工作目录内自测：单测 + 相关 e2e + `npx tsc --noEmit -p apps/api/tsconfig.json`。
- 禁止：schema.prisma / migrations / prisma generate / migrate 命令；禁止改 packages/shared。
- 提交：worktree 分支 commit（中文规范 message，注明 P1-P6）。
- 完成后返回：每项：文件、机制、测试数、自验结果、EXPLAIN/benchmark 数字；NOT VERIFIED 项。
