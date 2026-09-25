# M9-P1/P2/P3 设计（Evaluation / Advanced Memory / Provider Routing 接线）

> Pre-M9 全绿冻结后才实施。本文档是设计基线：Coordinator 在 M9 轮开始时按此预整合 schema（单点迁移），三个 worktree 并行实现业务。

## M9-P1 Evaluation / Experimentation

### 原则
- AgentVersion 不可变（已有 AgentVersion 表，publish 语义冻结）；evaluation 锁定 (agentVersionId, config 快照)。
- Dataset 版本化：`EvaluationCase.version` 列——dataset 编辑 bump 版本（copy-on-write 语义）；Run 锁定 (datasetId, datasetVersion)。
- 可复现：Run 存 configSnapshot JSON（model/provider/temperature/tools 全量快照）+ 每条 CaseRun 存 input/output/latency/tokens/cost/toolCalls 事实。
- LLM-as-judge 抽象 provider-independent（Evaluator 表 type=llm_judge + prompt 模板 + judgeModelId）；**LLM judge 绝不决定系统权限/quota/RBAC**（judge 输出只进 Score/Evidence）。
- 不做政治/社会类预测系统。

### Schema（新表，Coordinator 预整合）
```prisma
model EvaluationDataset {
  id String @id @default(uuid())
  organizationId String
  organization Organization @relation(...)
  userId String
  name String
  description String?
  version Int @default(1)
  createdAt/updatedAt
  cases EvaluationCase[]
  runs EvaluationRun[]
  @@index([organizationId])
}

model EvaluationCase {
  id String @id @default(uuid())
  datasetId String; dataset EvaluationDataset @relation(... onDelete: Cascade)
  version Int  // 所属 dataset 版本（编辑 bump 后旧版本行保留）
  input Json   // 标准输入（消息串）
  expected Json? // 期望输出（exact/schema 评测用）
  tags String[]?  // 分类标签（JSON 数组）
  createdAt
  @@index([datasetId, version])
}

model EvaluationRun {
  id String @id @default(uuid())
  organizationId String
  userId String
  datasetId String; datasetVersion Int  // 锁定版本
  agentId String; agentVersionId String  // 锁定 Agent 版本
  configSnapshot Json // model/provider/temperature/tools 快照（可复现）
  status String @default("pending") // pending|running|completed|failed|cancelled
  totalCases Int; completedCases Int @default(0)
  baselineRunId String? // 对比：baseline vs candidate（regression comparison）
  createdAt; completedAt?
  caseRuns EvaluationCaseRun[]
  @@index([organizationId, createdAt])
}

model EvaluationCaseRun {
  id String @id @default(uuid())
  runId String; run EvaluationRun @relation(onDelete: Cascade)
  caseId String
  status String // pending|running|completed|failed|skipped
  input Json; output Json?
  latencyMs Int?
  promptTokens Int @default(0); completionTokens Int @default(0)
  cost Float @default(0)
  toolCalls Json? // [{name, arguments, output}] 事实
  errorCode String?
  createdAt; completedAt?
  results EvaluationResult[]
  @@unique([runId, caseId])
  @@index([runId])
}

model Evaluator {
  id String @id @default(uuid())
  organizationId String
  name String
  type String // exact_match | json_schema | rule | llm_judge
  config Json // schema/rules/judge prompt 模板 + judgeModelId
  createdAt
  @@index([organizationId])
}

model EvaluationResult {
  id String @id @default(uuid())
  caseRunId String; caseRun EvaluationCaseRun @relation(onDelete: Cascade)
  evaluatorId String
  score Float // 0~1
  passed Boolean
  evidence Json? // judge 引用/规则命中——只读事实
  createdAt
  @@unique([caseRunId, evaluatorId])
}

model Experiment {
  id String @id @default(uuid())
  organizationId String
  name String
  status String @default("draft") // draft|running|completed|archived
  hypothesis Json? // 实验假设文本（业务记录，非判定依据）
  createdAt; updatedAt
  variants ExperimentVariant[]
  @@index([organizationId])
}

model ExperimentVariant {
  id String @id @default(uuid())
  experimentId String; experiment Experiment @relation(onDelete: Cascade)
  name String
  agentId String?; agentVersionId String?; configSnapshot Json
  isBaseline Boolean @default(false)
  trafficPercent Int @default(0)
  metrics Json? // 由 evaluation run 聚合的对照事实
  createdAt
}
```

### 模块
`apps/api/src/modules/evaluation/`：service（dataset/case/run 生命周期）+ runner（evaluation-run.processor，BullMQ 新队列 `evaluation`）+ evaluators/（exact-match、json-schema、rule、llm-judge——judge 走现有 LLM provider 抽象）+ controller（RBAC：evaluation.read/write 权限位由 Coordinator 在 M9 schema 迁移时同时加授权矩阵条目）+ experiments 服务。
文件边界：evaluation 模块全部新文件，与其他模块零重叠（app.module/worker.module 各加一行注册——Coordinator 合并）。

## M9-P2 Advanced Memory

### 原则
- 复用 ConversationSummary（已有表）+ Memory + ContextAssembler——绝不新建第二套记忆系统。
- 增量摘要：ConversationSummary 增加 sourceStartSeq/sourceEndSeq/tokenCount（列，Coordinator 预整合）——每段摘要记录覆盖的消息序列区间与版本；新消息追加 → 增量摘要（覆盖新区间，引用前一版摘要），版本链可回滚。
- summary → memory 候选（MemoryCandidate 新表：candidate/active/rejected 三态 + 来源 summaryId + 置信度）→ 提取器定期提炼 → active 进 ContextAssembler（受 token 预算）。
- **防循环污染**：memory 提取绝不把 summary 文本当 conversation 输入再生成 summary；MemoryCandidate 只从真实对话行提炼。
- 陈旧检测：消息被编辑/删除 → 覆盖区间重叠的 summary 标 stale → 重算。
- 隐私删除传播：会话删除级联 summary；用户删除级联 memory（既有 onDelete 语义沿用）。
- Memory ≠ Knowledge 严格分离（不动 knowledge 模块）。

### Schema 增量
- ConversationSummary 加列：`sourceStartSeq Int?`、`sourceEndSeq Int?`、`tokenCount Int @default(0)`、`parentSummaryId String?`（版本链）、`stale Boolean @default(false)`。
- 新表 MemoryCandidate：
```prisma
model MemoryCandidate {
  id String @id @default(uuid())
  userId String
  projectId String?
  sourceSummaryId String?
  content String @db.Text
  category MemoryCategory
  importance Int @default(50)
  confidence Float @default(0.5)
  status String @default("candidate") // candidate|active|rejected
  createdAt; promotedAt?
  @@index([userId, status])
}
```

### 模块
`apps/api/src/core/memory/` 扩展（summary-refiner.service、memory-candidate.service）+ context/sources 扩展。与 memory-extractor 同域但新文件。

## M9-P3 Provider Routing 生产接线

### 原则
- 使用已有 RoutingService/RoutingDecision（P7 零漂移面），**不重造 Router**。
- Pre-M9 已接熔断自愈（G1/G2）——本 Phase 接完整 RoutingService：LLM/Image/Video/Embedding 四条生产调用链经 RoutingService.route()。
- 输入：capability/provider health/latency/cost/quota/org policy/model 需求/circuit state；输出：provider/model/reason/policy/fallback 链（RoutingDecision 落库审计）。
- fallback：primary → secondary → tertiary，与 circuit breaker 联动。
- 新增：health scoring（Provider.healthStatus + 最近失败率）、latency scoring（最近调用延迟采样）、deterministic tie-break（hash 稳定序）、org provider allowlist（ProviderPolicy 已有表复用）。
- **LLM 绝不决定 provider**。

### 模块
改 `apps/api/src/modules/provider-routing/`（激活现有 pipeline）+ llm-manager/model-resolver 调用点替换为 routing 入口（Pre-M9 G2 的熔断接线升级为 routing 接线）。涉及文件与安全/性能/可靠性包不重叠（它们已完成合并）。

## 并行文件边界（Coordinator 合并策略）
- P1/P2/P3 全部新模块或独立文件；公共冲突点仅 app.module.ts / worker.module.ts / queue.module.ts（新队列 `evaluation`）——Coordinator 预整合 queue 常量与模块注册行，agent 只写业务文件。
- Schema 由 Coordinator 单点迁移 `m9_p1_p3_platform`（含 evaluation 全表 + summary 列 + MemoryCandidate + 授权矩阵新权限位 evaluation.read/write）。
