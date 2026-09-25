# Pre-M9 测试补强规格（Web 测试 / 多实例 / Provider 故障注入 / SSE / 计费对账 / 性能验收）

> 可靠性包完成后串行实施（依赖其 G3/G4/G7 等修复落地后才能测）。本阶段是 Pre-M9 验收门前的最后一环：
> 只补测试与验收，不引入新业务功能。

## 1. Web 测试体系（apps/web，当前零测试）

- 建立 vitest + @testing-library/react 基础配置（web 是 Next.js 15 App Router——组件测试 + 少量集成即可，不追求全 e2e）。
- 覆盖：关键组件（消息流渲染/SSE 解析、任务时间线、审批 UI 状态、错误状态展示）。
- auth state 单元：token 存储/过期处理逻辑（若有独立 hook）。
- 前端类型漂移防线：**不重复手写后端类型**——最小方案：对 `apps/web` 里复制后端类型的文件加 vitest 快照 + 与 `packages/shared` 导出的类型比对测试（结构对比，不是运行时）；若 shared 未含这些类型，先记录漂移清单。
- 数量目标：初始 ≥15 个有意义用例（诚实数字，不凑数）。

## 2. 多实例（2 API + 2 Worker 真实验证）

- 测试 harness：同一 DB/Redis 上启动两个 API 实例 + 两个 Worker 实例（不同端口/workerId）。
- 覆盖：refresh 折叠（C5——两实例并发 refresh 只一次 provider 调用）、事件双执行（两 worker 不重复执行同一 job——claim fencing）、scheduler（同键幂等+scope）、ExternalAction（CAS claim 跨进程单执行——可直接复用 m7-p3 e2e 场景双 worker 跑）、lease/fencing（旧 worker 迟写被拒）、cancellation/wake/retry。
- 交付为独立 e2e 文件（test/pre-m9-multi-instance.e2e-spec.ts），断言必须真跑两个 worker 上下文。

## 3. Provider 故障注入

- 在 mock LLM/媒体 adapter 层加故障注入开关（env：MOCK_LLM_FAILURE=timeout|500|stall|unavailable，MOCK_LLM_STALL_MS 等——沿用 MOCK_DELAY_MS 模式，不改共享包）。
- 覆盖：timeout、500、慢响应、流停摆（stall 不发 EOF）、provider unavailable、**熔断恢复**（连续失败→open→冷却→probe→复位——G1 修复后的行为 e2e）。
- 既有 provider fault e2e（m8-p9 可靠性 e2e 有 23 个故障注入用例）沿用其 harness 扩展，不重造。

## 4. SSE 行为

- reconnect/Last-Event-ID（若协议支持）、慢客户端（背压不阻塞 worker）、饱和连接（上限+优雅拒绝）、**shutdown 时活动连接关闭**（G3 后行为）、terminal event 收流。
- 复用 m6-p6-sse-events e2e harness。

## 5. 计费对账 cross-check

- UsageRecord ↔ UsageLedgerEntry ↔ Analytics 三方 cross-check e2e：跑一个真实 run → 断言三方数字一致（对账端点 consistent=true + analytics 聚合行 = 事实汇总）。
- U1 回归：单条事实 → 单一成本（已有 pre-m9-billing e2e 覆盖，补三方版本）。

## 6. 性能验收（数字如实，绝不伪造）

- 基准断言用宽松阈值（防 CI 抖动），核心是"结构正确"：overview 查询数上限、createAsync 往返数上限、向量检索 EXPLAIN 走 HNSW（已有 pre-m9-p4 e2e）、EventBus 批处理单测（已有）。
- 记录 load 数字（如可行跑 /live 简要压测——M8-P9 模式）。

## 7. 验收门（全部通过才进 M9）

```
P0 = 0（F1/F3-A/F4/IDOR/U1/S1/C2/T1+R3/workflow viewer 写——各修复的 e2e 全绿）
P1 critical = 0（R2/G1-G11/C1/C5/D1/D5/D8/F2/F7/A2/A3——各修复的测试全绿）
全量测试 / typecheck / build / fresh-DB 迁移重放 / 现有库迁移 / 2 API + 2 Worker / SSE / 对账 / 熔断恢复
Git CLEAN
```

完成后 Coordinator 打 Pre-M9 冻结 commit + 更新基线文档 docs/architecture/m9-pre-m9-baseline.md。
