# M9 Final Baseline（2026-09-28）

> M9（Pre-M9 修复包 + P1 Evaluation / P2 Advanced Memory / P3 Provider Routing 接线 / P4 Advanced Workflow / P5 Creative Performance Loop / P6 Marketplace）**最终冻结基线**。
> 设计：`m9-phase1-3-design.md` / `m9-phase4-6-design.md`；Pre-M9 基线：`m9-pre-m9-baseline.md`；审计基线：M0-M8 Final Architecture Audit。

## 1. 提交序列（Pre-M9 冻结后）

```
c3a4788  wip(api): M9-P1/P2/P3 schema 预整合（Evaluation 8 表/Summary 版本链列/MemoryCandidate/evaluation 权限位/队列常量）
b24a3d4  feat(api): M9-P6 Marketplace schema 预整合（+ HNSW 守卫；fresh 重放 32/32）
09b0445  feat(api): M9-P1 Evaluation / Experimentation（39 文件）
769b938  feat(api): M9-P2 Advanced Memory（18 文件）
dc7dd44  feat(api): M9-P3 Provider Routing 生产接线（19 文件）
f206131  Merge P1/P2/P3（161 文件/1432 测试全绿）
edc8694  fix(api): 恢复 HNSW 索引（m9_p1_p3_platform 的 DROP INDEX 孤儿判定——P3 自验实抓）
afc6dd9  feat(api): M9-P4 Advanced Workflow（16 文件）
c5d2df8  feat(api): M9-P5 Creative Performance Loop（20 文件）
c070dfd  feat(api): M9-P6 Marketplace 公开层（24 文件）
7987855  test(api): M7-P7 委派 e2e 去瞬态断言（M9-P3 接线后链速变化暴露的测试设计缺陷）
```

## 2. 各 Phase 核心机制（详见各 commit 报告）

- **P1 Evaluation**：dataset copy-on-write 版本锁（bump 后历史 run 逐行不变）；run 冻结 agentVersionId+configSnapshot；CAS 状态机；exact_match/json_schema/rule/llm_judge 四类评测器（LLM judge 输出只进 score/evidence，零越权断言）；baseline/candidate 对比；RBAC evaluation.read/write；Web 三页只读。
- **P2 Advanced Memory**：增量摘要版本链（消息 id 锚点 + parentSummaryId + 乐观 CAS 防重复建段）；MemoryCandidate 三态（candidate/active/rejected，只从真实对话提炼——防循环污染）；ConversationSummarySource 进上下文（ContextBudgetService 裁剪最早版本段）；软删除显式清理 + 用户删除级联。
- **P3 Provider Routing**：四条调用链（LLM/Image/Video/Embedding）激活既有 RoutingService；能力/策略/健康评分（失败率+延迟罚分+stableHash tie-break）/成本/熔断事实排序；fallback 链（同 provider 重试耗尽后才换候选——fallback≠retry）；RoutingDecision 全量审计；LLM 绝不决定 provider。
- **P4 Advanced Workflow**：wait 节点（时间窗落库期限绝不重计时 + wakeByWaitDue 条件唤醒 + recoverStale 兜底）；步骤级 timeoutMs（受 run 总时限裁剪）/retryPolicy（与 maxAttempts 并集）；逆序补偿链（复用 UNIQUE(runId,stepIndex) 锚点幂等，补偿失败只记录）；审批表单（formFields 不参与 payloadHash）+ binding 三处校验；版本锁定 lockedDefinition（definitionSnapshot 因 schema 冻结降级为"version 行只读"——如实记录）。
- **P5 Creative Performance Loop**：洞察 facts/derived/interpretation 三层隔离（factsHash CAS 双保险）；假设状态机（无 running→ready 边）；loop 编排 = M9-P4 workflow 模板（approval/external_action/wait/compensation 全用上）；并发启动收敛（实抓两 run bug 修复）；写操作全走 M7-P3 全链。
- **P6 Marketplace**：发布状态机（rejected 无直达 published）；上架门禁 = M8-P6 平台校验；审核 pending→approved/rejected（pending 永不可为终点）；评分聚合 + 安装量投影（不新建事实表）；权限披露 = F4 交集现算（readOnly 投影）；**评分绝不参与授权**（5 星/1 星审核后 AgentVersion 逐项不变断言）；RBAC 复用既有权限位（member 可管理条目——真实矩阵，如实记录）。

## 3. 最终验收数字（2026-09-28，全部实测）

- **api 测试**：180 文件 / **1614 测试全绿**（M0-M8 回归 + Pre-M9 修复包 + M9-P1~P6 全部；连续两轮一致）
- **web 测试**：10 文件 / 86 用例全绿；web typecheck/build 通过
- **typecheck**：4/4 零缓存；**build**：3/3 零缓存
- **fresh-DB 迁移重放**：32 迁移全链成功（Evaluation/Summary 列/MemoryCandidate/Marketplace 表 + HNSW 索引齐）
- **基础设施**：PostgreSQL(pgvector)/Redis/BullMQ/MinIO/Worker 全程真实
- **多实例**：2 API + 2 Worker e2e（C1 跨实例精确准入——绝不超量）
- **对账**：UsageRecord↔UsageLedgerEntry↔Analytics 三方一致 + 对账端点
- **故障注入**：stall→idle 超时/熔断 open→跳过→fallback 归因/unavailable 不重试
- **SSE/停机**：pre-m9-shutdown 九阶段 + SSE 纳管
- **Git**：CLEAN

## 4. 实施中实抓并修复的真 bug（测试体系价值证明）

1. ensureSubscription 懒创建 P2002 竞态 → 500（多实例 e2e 抓）。
2. C1 预留顺序竞态 → 同瞬并发超量准入（改"先预留后计数超限回滚"）。
3. M9-P5 loop 并发启动双 workflow 双 run（编排器自验抓）。
4. m9_p1_p3_platform 迁移生成 DROP INDEX（Prisma 对 Unsupported 列索引的孤儿判定——第三次出现，已固化为 create-only 后必查项）。
5. M7-P7 委派 e2e 瞬态断言（waiting 可被轮询错过）——链速随 P3 接线变化暴露。

## 5. NOT VERIFIED（如实延续，不伪造）

- 全部 LLM 行为用 mock adapter 验证——无真实供应商端到端（路由/评测/摘要/生成质量待真实 provider）。
- 多实例验证为同进程双实例 + 独立 Redis DB 隔离（非真多进程/多机）。
- Web 无真实浏览器验证（jsdom 组件测试）；生产 NODE_ENV Secure cookie；DNS rebinding TOCTOU——延续 M8 清单。
- P2 无消息编辑/删除端点（stale 钩子仅 e2e 直调）；P5 补偿链真实触发未 e2e（归 P4 自身覆盖）。
- marketplace moderation 复用 member.write 是语义借用（已记录）；definitionSnapshot 因 schema 冻结降级（已记录）。

## 6. 冻结声明

M9 全部代码（Pre-M9 修复包 + P1~P6）自本基线冻结；M10 未开始。**本文件为基线快照。**
