# M5 Architecture Design

| 项 | 内容 |
|---|---|
| 日期 | 2026-09-23 |
| 基线 | M0~M4 实际代码（M4 = 🟢 FROZEN，207 测试全绿），全部现状经代码核验 |
| 状态 | **待确认**（纯设计：不写代码/不改 schema/不迁移/不实现/不提交） |
| 主题 | Agent Management + Versioning + Run Observability + Knowledge/RAG + Usage 完整性 + Context Budget + Timeline + 长任务预留 |

---

## 1. M0~M4 当前架构核验（代码实证）

| 结构 | 现状（核验） | 对 M5 的约束/机会 |
|---|---|---|
| agents 表 | 单表承载定义 + `version Int @default(1)`（**无快照语义**，version 只写不读） | 拆表设计见 §4 |
| AgentRun | `agentId FK → Agent onDelete: Restrict`（**无 version 引用**）；currentStep/maxSteps/status/条件终态；metadata Json | 历史 run 无法还原当时配置 → 必须补 version 快照关联 |
| ToolCall | UNIQUE(runStepId, idempotencyKey)；无 taskId 关联 | §6 关联设计 |
| usage_records | **runId 已存在**（M4 补）+ 索引 ✓；llm/image/video 三类 kind | 聚合投影即可，不建新表 |
| generation_tasks | idempotencyKey UNIQUE ✓；**无 runId/toolCallId**（M4 审计债） | §6 补双关联 |
| artifacts | userId/projectId/conversationId/messageId/taskId；**无 runId/toolCallId** | §16 补关联 |
| ContextAssembler | MemorySource 注册制；**CONTEXT_ORDER.knowledge=40 已预留**；M4 实际每 Run 组装一次 | KnowledgeSource 直接注册即接入 ✓ |
| ToolContext | userId/projectId/conversationId/messageId/agentRunId/agentRunStepId/idempotencyKey（**无 toolCallId**） | §6 需要补 toolCallId |
| Worker | image/video/media-cleanup 三队列 + repeatable 清扫（GenerationTask + AgentRun 双域） | document 处理队列复用同模式 |
| ConversationSummary | 表已备（M2），零写入方 | M6 自动摘要直接落地 |
| 技术栈 | PG16（docker）、Prisma、BullMQ、S3 兼容存储、StorageAdapter.getStream | §11 向量存储选型依据 |

**M4 冻结边界（M5 不得破坏）**：`Agent→Tool→Service→Provider`；`Agent→ContextAssembler→Memory/Knowledge`；`AgentRun→Step→ToolCall→GenerationTask→Attachment`。以下设计全部在这些边界内做增量，无一处要求推翻 M4。

---

## 2. M5 总体架构

```
┌─────────────── 管理面（Admin 后台，M5 新增） ───────────────┐
│  Agent 管理（版本发布/回滚/启停）│ Model/Provider 管理      │
│  Knowledge Base 管理 │ 文档上传/索引状态 │ 用量与成本报表    │
│  Provider 健康页 │ Run 浏览（Timeline）                      │
└───────────────────────────────────────────────────────────┘
                            │ 写
┌─────────────── 运行面（M4 冻结核心，M5 增量） ─────────────┐
│ AgentRegistry（读 activeVersion）→ Agent → AgentLoop       │
│   │ 工具: image/video/artifact/memory + M5: knowledge.search│
│   │ 上下文: ContextAssembler + M5: KnowledgeSource         │
│   │ 关联: AgentRun→Version / ToolCall→Task / Artifact→Run  │
│   ▼                                                       │
│ 执行记录 → Timeline 投影 / Usage 聚合                       │
└───────────────────────────────────────────────────────────┘
                            │
┌─────────────── 知识管线（M5 新增，Worker 侧） ─────────────┐
│ document 队列: 抽取 → 分块 → EmbeddingProvider → pgvector   │
└───────────────────────────────────────────────────────────┘
```

---

## 3. Agent Management

| 问题 | 设计决策 | 理由 |
|---|---|---|
| 谁创建/修改？ | **仅 Admin**（平台级 Agent；沿用"仅管理员"产品模型） | 成本/安全面可控 |
| 普通用户能否创建自己的 Agent？ | **M5 不开放**。表结构预留 `scope: 'system' \| 'user'` 字段（M6+ 再议） | 用户自定义 Agent 涉及权限/计费/隔离，属独立特性 |
| System/User Agent 区分？ | 预留 scope 字段，M5 全部 system | 同上 |
| Agent 属于 Project？ | **不**。Agent 是平台级能力，任何用户/项目可用 | 避免 Agent 与数据域耦合 |
| Agent 被多 Project 使用？ | 天然支持（无 projectId） | — |
| Version 管理 / active / Run 快照 | §4 拆表设计 | — |
| 修改 Agent 后旧 Run 可还原？ | **是**——run → 不可变 AgentVersion（§4） | 审计要求 |

---

## 4. Agent Versioning（拆表设计）

**结论：拆表。** 当前单表 `version` 字段只写不读（核验实证），无法满足"Run 还原当时配置"。

```prisma
model Agent {
  id              String   @id @default(uuid())
  slug            String   @unique
  name            String
  description     String?
  kind            String            // builtin | custom（代码类映射）
  scope           String   @default("system")  // M5 新增预留：system | user
  enabled         Boolean  @default(true)
  activeVersionId String?            // M5 新增：当前生效版本
  activeVersion   AgentVersion? @relation("ActiveVersion", fields: [activeVersionId], references: [id], onDelete: SetNull)
  priority        Int      @default(100)
  createdAt       DateTime @default(now())
  updatedAt       DateTime @updatedAt
  versions        AgentVersion[]
  runs            AgentRun[]
}

model AgentVersion {
  id           String   @id @default(uuid())
  agentId      String
  agent        Agent    @relation(fields: [agentId], references: [id], onDelete: Cascade)
  version      Int                            // 单调递增
  status       AgentVersionStatus             // draft | published | archived
  systemPrompt String   @db.Text
  modelId      String?
  tools        Json     @default("[]")
  temperature  Float    @default(0.7)
  maxTokens    Int?
  config       Json?                          // maxSteps/requiresTools 等
  createdAt    DateTime @default(now())
  createdBy    String?
  runs         AgentRun[]
  @@unique([agentId, version])
}

model AgentRun {
  // ...现有字段不动
  agentVersionId String?                      // M5 新增
  agentVersion   AgentVersion? @relation(fields: [agentVersionId], references: [id], onDelete: Restrict)
  // agentId 保留（去规范化，查询友好；agent 行 Restrict 继续保证身份存在）
}
```

**语义（写死）：**
- **Version 不可变**：published/archived 版本任何字段不可改；只有 draft 可编辑。
- **发布流**：编辑 draft → `publish` → 生成新 version 行（version=n+1, status=published）→ `Agent.activeVersionId` 指向它；旧 published → archived。
- **回滚**：后台操作 = 新建 version 复制目标旧版本内容（或直接把 activeVersionId 指回旧版本——设计选择**指回**，零复制；若要"回滚后再编辑"则基于旧版本开 draft）。两种都支持，后台语义为"以 vX 为基础新建草稿"。
- **Run 快照**：`AgentRegistry.resolveForIntent` 读 activeVersion → run 落 `agentVersionId`；**run 不复制配置**（version 行即快照，Restrict 保证不删）。查询"当时配置" = run.agentVersion 一行。
- **Registry 改造**：加载 enabled Agent + activeVersion 构建 Agent 实例（loop 配置来自 version 行）；agentId/agentVersionId 都传给 run。
- **迁移路径（M5 实施时）**：① 建 AgentVersion 表；② 现有 agent 行字段快照为 v1 published 并置 activeVersionId；③ registry/loop 切到 version 行；④ 原 agents 上的定义字段退役（保留只读或删除）。

---

## 5. Agent Run Observability（执行追踪系统）

**原则：不新增事件流水表——Timeline 是投影，不是副本。**（用户要求："不要为了 Timeline 重复存储大量数据"）

| 问题 | 决策 |
|---|---|
| 一个 Run 如何完整还原执行过程？ | `run(状态/版本) + steps(顺序) + toolCalls(明细) + usage_records(runId, LLM 回合) + generation_tasks(runId) + artifacts(runId)` ——全为现有/§6 关联表，零重复存储 |
| ToolCall 如何关联 GenerationTask？ | §6：generation_tasks.toolCallId + runId |
| ToolCall 如何关联 Artifact？ | §16：artifacts.toolCallId + runId |
| LLM Round 是否独立表？ | **不建 llm_rounds 表**。每轮 LLM = usage_records 一行（runId+llm_chat，latency/tokens 已存）；回合顺序按 createdAt。Prompt 快照不存（隐私与成本，且非可观测性必需） |
| Tool Result 进 Step？ | 不复制——结果在 toolCall.output（JSON 全量）＋ tool.end 事件的 outputSummary（摘要） |
| 统一 RunEvent？ | 不建。投影层在 service 内合并各表按时间排序 |

**Timeline 投影（§14）**：LLM 回合（usage）→ tool 调用（toolCall）→ 任务事件（task）→ 制品（artifact）→ final（step），按 startedAt/createdAt 合并。

---

## 6. GenerationTask → AgentRun（M4 审计技术债）

**决策：generation_tasks 加 `runId String?` + `toolCallId String?`（双关联，都可空）。**

| 问题 | 决策 | 理由 |
|---|---|---|
| 关联 AgentRun 还是 ToolCall？ | **两者都加**（可空） | 查询方向全覆盖：run→tasks、task→run、toolCall→task、task→attachment（既有 taskId 链路）。单关联 toolCall 需 join 才能答"run 生成哪些图"；单关联 run 无法精确答"哪个工具调用创建" |
| 冗余？ | 最小——两个外键列，无复制数据 | 满足"最小冗余"要求 |
| M3 兼容 | 可空 + 写入方仅在 Tool 路径传值；ImageAgent/VideoAgent 直连路径留空 | 不触碰 retry/idempotency/cleanup/attachment/生命周期（全为只读关联） |
| 写入方 | `ToolContext` 补 `toolCallId`（Loop 注入）；image.generate/video.generate Tool 透传给 prepareMediaTask | Tool 层单向 → Service，无越层 |

**未来查询**：`这个 Run 生成了哪些图片/视频`（tasks where runId+type）、`这个 ToolCall 创建了哪个任务`（tasks where toolCallId）、`这张图来自哪个 Run`（attachment→task→runId）。

---

## 7. Usage 完整性

| 项 | 设计 |
|---|---|
| 失败回合（M4 债） | AgentLoop 每回合记录改 try/finally：成功 status=success、失败 status=failed+errorCode——**每轮必记**（修复 M4 审计 §4.1）。实现点收敛在 loop 单处 |
| retry usage | 每 attempt 独立行（现设计）；聚合 sum |
| 媒体任务归因（M4 债） | §6 runId 落地后，媒体 usage 行（MediaGenerationService 写入时带 task.runId）自动并入 run |
| 聚合 API | `GET /usage/agent-runs/:id`：按 runId 投影聚合（totalTokens/inputTokens/outputTokens/llmCost/imageCost/videoCost/totalCost/duration=completedAt-startedAt）。**纯查询聚合，不建 usage 汇总表**（usage_records 已有 runId 索引） |
| 不做 Billing | 只做执行成本可观测（估算成本字段已有） |

---

## 8. Knowledge Architecture

```
User/Project → KnowledgeBase(scope: user|project)
  → Document(upload, contentHash 去重)
    → DocumentChunk(text, tokenCount, embedding)
      → pgvector(cosine, topK, scoreThreshold)
        → KnowledgeSource（ContextAssembler 自动注入，每 Run 一次）
        → knowledge.search Tool（Agent 主动检索）
          → Agent
```

- **Scope**：user KB / project KB（project KB 归属项目，权限 §19）。Organization/Agent KB 仅文档预留（M6+）。
- **两路径并存**（§12）：自动注入（少量 top chunks，降低"应该查没查"）+ 工具查询（显式语义检索）。

---

## 9. Knowledge 数据模型

```prisma
model KnowledgeBase {
  id               String   @id @default(uuid())
  userId           String
  scope            KnowledgeScope    // user | project
  projectId        String?           // scope=project 必填（服务层校验）
  name             String
  description      String?
  embeddingModelId String?           // 空 = 平台默认 embedding 模型
  topK             Int      @default(5)
  scoreThreshold   Float    @default(0.3)
  status           KnowledgeBaseStatus @default(active)
  createdAt        DateTime @default(now())
  documents        Document[]
  @@index([userId, scope])
  @@index([projectId])
}

model Document {
  id          String   @id @default(uuid())
  kbId        String
  kb          KnowledgeBase @relation(fields: [kbId], references: [id], onDelete: Cascade)
  userId      String          // 冗余：权限快路径
  title       String
  sourceType  DocumentSourceType  // upload（M6+: url）
  sourceUri   String?        // 预留：外部 URL
  storageKey  String         // 原始文件（StorageAdapter）
  mimeType    String
  sizeBytes   Int
  contentHash String         // sha256，去重
  status      DocumentStatus // uploaded | processing | ready | failed
  errorCode   String?
  chunkCount  Int      @default(0)
  version     Int      @default(1)   // re-index 计数
  metadata    Json?
  createdAt   DateTime @default(now())
  updatedAt   DateTime @updatedAt
  chunks      DocumentChunk[]
  @@unique([kbId, contentHash])     // 去重：同文件重复上传幂等返回已有
  @@index([kbId, status])
}

model DocumentChunk {
  id           String  @id @default(uuid())
  documentId   String
  document     Document @relation(fields: [documentId], references: [id], onDelete: Cascade)
  chunkIndex   Int
  content      String  @db.Text
  tokenCount   Int
  embedding    Unsupported("vector")?   // pgvector；Prisma Unsupported 列 + $queryRaw 检索
  embeddingModel String
  createdAt    DateTime @default(now())
  @@unique([documentId, chunkIndex])
}
```

**去重策略（写死）**：`UNIQUE(kbId, contentHash)`——同一文件重复上传返回已有 document（幂等）；同名不同内容 = 不同 hash → 新文档（标题可重复）。

---

## 10. Document 生命周期

```
uploaded → processing（抽取 → 分块 → embedding）→ ready
processing → failed（errorCode；可 retry = 重新入队）
ready →（re-index：换 embedding 模型/改分块参数）→ processing → ready（version+1，旧 chunks 清空重建）
删除（任意态）：级联 chunks + 清理存储文件（storageKey）
```

- **处理管线**：新增 `document` 队列（复用 BullMQ 模式）+ Worker processor：文本抽取（pdf/docx/txt，实现期选型 pdf-parse/mammoth）→ 固定大小分块（约 800 字符 + 15% overlap，首版不分层）→ EmbeddingProvider → 批量 upsert chunks → ready。
- **不实现**：完整 Document Processing Worker 的可观测面板（仅状态字段）、OCR、图片/视频索引。

---

## 11. Vector Store（选型：PostgreSQL + pgvector）

| 候选 | 结论 | 理由 |
|---|---|---|
| **PostgreSQL + pgvector** | ✅ **选定** | 当前唯一 OLTP 库（docker PG16）；单租户/文档级数据量（万级 chunks）远低于独立向量库阈值；零新基础设施；事务与业务数据同库（chunk 与 document 强一致）；镜像换 `pgvector/pgvector:pg16` 数据卷兼容（`CREATE EXTENSION vector`），无迁移风险 |
| Redis（向量） | ❌ | 引入 Redis 栈新组件；持久化语义弱；无必要性 |
| 独立 Vector DB（Qdrant/Milvus 等） | ❌ | 新运维面；当前规模纯属过度设计；未来量级增长时再评估（数据模型已隔离 chunks，可平移） |

**参数设计**：dimensions 由 embedding 模型决定（embeddingModel 字段记录）；相似度 = cosine（pgvector `<=>`）；索引 = IVFFlat（chunks 数 <10 万时足够，避免 HNSW 构建成本；实现期按量级定）；topK 默认 5 / scoreThreshold 默认 0.3（per KB 可配）；metadata filter = kbId/documentId SQL 下推。Prisma `Unsupported("vector")` + `$queryRaw` 检索，写路径经原生 SQL upsert。

**EmbeddingProvider**（providers/embedding/，与 LLM/Image/Video 同族注册表模式）：`embed(texts: string[]) → number[][]`；models.type 加 `embedding`（M2 审计建议项）；真实 adapter：dashscope text-embedding-v3 / openai text-embedding-3-small（实现期按 key 可用性）；**mock-embedding dev 替身**（确定性 hash 投影向量，无 Key 全链路可跑——延续替身哲学）。

---

## 12. KnowledgeSource（接入 ContextAssembler）

| 问题 | 决策 |
|---|---|
| 查询发生在哪？ | 两条路径：① **自动注入**——KnowledgeSource（MemorySource 接口实现，注册进 ContextAssembler，order=CONTEXT_ORDER.knowledge=40）；② **主动检索**——`knowledge.search` Tool（read 权限，M5 首批新工具） |
| 谁决定 query？ | 自动路径：当前 userMessage 原文（单查询点；M4 现状每 Run 只 assemble 一次 → **每 Run 只检索一次**，天然避免每轮重复 RAG）；工具路径：Agent 显式给 query |
| Agent 可否绕过 ContextAssembler？ | **不可**——knowledge.search Tool 走 KnowledgeService（服务层），Tool/Agent 均不直查 chunks 表；自动注入唯一入口是 ContextAssembler |
| 如何避免无意义 RAG？ | scoreThreshold 过滤（低于阈值 → 零注入）；KB 为空 → 零查询；M6 可选"查询改写"（不进 M5） |
| topK / threshold / budget | per KB topK+threshold；注入 token 预算见 §14（chunks 按 tokenCount 累计截断） |
| 注入格式 | role=user 前缀：`【知识库】《{doc.title}》：{chunk.content}`（与 memory 前缀同风格）；MemoryBlock 扩展 `source?: {kind:'knowledge', documentId, title, chunkIndex}` 供前端未来渲染引用 |
| citation | 注入块携带 source 元数据（不实现 UI 渲染，字段先行） |

---

## 13. Memory vs Knowledge（写死边界）

| | Memory | Knowledge |
|---|---|---|
| 语义 | **结构化事实/偏好**（"用户喜欢黑金配色"） | **原始语料**（产品说明书/Listing 文档/品牌规范/广告报告/SOP） |
| 来源 | LLM 提取（candidate→active 状态机）或人工 | 用户上传文档 |
| 存储 | memories 表（内容即结构化值） | documents + chunks + 向量 |
| 注入 | active 记忆 → 前缀块（M2 机制） | 检索 top chunks → 前缀块（M5） |
| 生命周期 | 确认/拒绝/编辑/淘汰 | 上传/索引/re-index/删除 |

**两系统不合并、不互相存储**（Knowledge 不写入 memories，Memory 不进向量库）。

---

## 14. Context Budget（设计层，M5 不实现压缩）

```
ContextAssembler.assemble()
  → blocks（各源产出，带 order + tokenCount 估算）
  → BudgetApplier（M5 新增，纯截断无压缩）：
     总预算（默认 8k tokens，per agent 可配，估算 chars/2≈1 token）
     按 order 升序优先分配：system → project memory → user memory → summary → knowledge → recent
     recent messages 从最旧开始截断（保留最新完整轮次）
     knowledge 块按 chunk.tokenCount 累计截断（保证 topK 内预算内）
  → messages
```

- **不实现**：摘要压缩（conversation_summaries 表 M2 已备，M6 自动摘要 + 压缩）、工具结果压缩（M4 现状回喂全量 JSON，M6 再议）。
- Tool results 不纳入 BudgetApplier（Loop 局部 messages，非 assembler 输出）。

---

## 15. Agent Run Timeline（投影设计）

`GET /agent-runs/:id/timeline` 服务端合并以下源（无新表）：

```
agent.start / agent.end      ← agent_runs（status/startedAt/completedAt/agentVersion）
LLM turn（thinking/executing）← usage_records(runId, kind=llm_chat)：latencyMs/tokens/status
tool.start / tool.end        ← tool_calls：toolName/durationMs/status/error/outputSummary（无 CoT）
task.created / progress / completed ← generation_tasks(runId)：status/progress/statusMessage
artifact.created             ← artifacts(runId)：type/title/summary
final response               ← agent_run_steps(type=final)
```

按时间合并排序输出 `{at, kind, label, durationMs?, status?, refs?}`。**绝对不含模型隐藏推理**；`reasoning` 类 step 只存公开状态文案（M4 约定维持）。

---

## 16. Artifact

**决策：artifacts 加 `runId String?` + `toolCallId String?`**（与 §6 同策略，可空）。追溯闭环：分析报告/Creative Brief/生成结果 → 所属 Run → 触发工具调用。
`version`/`references` 字段**预留 M6**（内容制品版本策略与 Creative Brief 工作流一起定，不在 M5 猜）。写入方：artifact.create Tool 透传（ToolContext.runId/toolCallId）。

---

## 17. Long-running Agent Preparation（只设计）

| 问题 | 设计 |
|---|---|
| checkpoint？ | **不建 checkpoint 表**。M6 resume 的三重锚点已存在：`runId + stepIndex（UNIQUE）+ ToolCall.idempotencyKey（UNIQUE）`——恢复 = 读取 run 的 currentStep、跳过已完成 ToolCall（幂等复用，M4 已备） |
| currentStep 是否足够？ | 足够（顺序执行模型下即断点） |
| ToolCall 可恢复？ | 是——幂等键复用输出（M4 语义） |
| LLM context 恢复？ | M6 需重放 messages（= system+记忆+历史+已存 tool 消息）。缺口：**tool 消息未落库**（loop 内存态）——M6 需把 tool 回合消息写 run 级存储（设计预留：届时加 `agent_run_messages` 表或 step.output 存 tool 消息）。**M5 不做** |
| heartbeat | `agent_runs.heartbeatAt` 字段（M6 加）；M5 清扫阈值机制（M4 MUST-1）已为长任务留了超时语义 |
| Worker 崩溃恢复 | M6：异步 run worker + 清扫/恢复策略；M5 只确保 M4 的条件终态 + 清扫兜底不被破坏 |

---

## 18. API Design

| API | M5 | 说明 |
|---|---|---|
| GET /agents、GET /agents/:id、GET /agents/:id/versions | ✅ 必须 | Admin 读 |
| POST /agents、PATCH /agents/:id | ✅ 必须 | Admin 创建/编辑（编辑只作用于 draft） |
| POST /agents/:id/versions（publish/rollback/开 draft） | ✅ 必须 | 版本发布流 §4 |
| GET /agent-runs/:id/timeline | ✅ 必须 | §15 投影 |
| GET /usage/agent-runs/:id | ✅ 必须 | §7 聚合 |
| GET/POST/PATCH/DELETE /knowledge-bases（user 自有 / admin） | ✅ 必须 | KB 管理（project KB 验归属） |
| POST /knowledge-bases/:id/documents（multipart） | ✅ 必须 | 上传 → 处理队列 |
| GET /documents/:id、GET /knowledge-bases/:id/documents | ✅ 必须 | 状态/列表 |
| POST /documents/:id/retry、DELETE /documents/:id | ✅ 必须 | 生命周期操作 |
| knowledge.search 调试端点 | 🔵 暂不 | M6 或后台内置 |
| POST /agent-runs（异步）、cancel、approvals | 🔵 M6 | 长任务/审批 |

---

## 19. Security

- **全资源 userId 首条件**：KnowledgeBase/Document/Chunk/Artifact/AgentRun/GenerationTask/Attachment/Usage——延续 M2~M4 审计模式；Timeline/Usage 聚合走 run 归属。
- **Project 域**：project KB 与 project run 双重校验——Project A 的 AgentRun 不可访问 Project B 的 KB（KnowledgeSource 按 run.projectId 定位 KB；projectId 不一致 → 不检索）；chunk 查询带 kbId+userId 下推。
- Agent 管理全 admin（§3）；AgentVersion 只有 admin 可 publish/rollback。
- 文档下载经 storageKey + 归属（复用附件同源机制，不暴露存储凭据）。
- knowledge.search Tool：read 权限、ToolContext 身份继承（M4 机制不变）。

---

## 20. Performance

| 面 | 设计 |
|---|---|
| RAG 频率 | **每 Run 一次**（M4 单次 assemble 现状维持）；scoreThreshold 早停；KB 空/未配置 → 零检索 |
| 向量检索 | topK 截断 + IVFFlat 索引 + SQL 元数据过滤；检索与注入预算双限制 |
| Context 爆炸 | BudgetApplier（§14）：总额 8k tokens + 分级截断；tool 结果 M4 现状单回合回喂，M6 压缩 |
| DB | 索引：documents[kbId,status]、chunks UNIQUE(documentId,chunkIndex)+vector 索引、usage[runId]（已有）、tasks[runId]（§6 加）；文档列表游标分页；timeline 单 run 范围查询（无全表扫） |

---

## 21. Ecommerce Compatibility（只检查）

目标链路映射（全部兼容，无阻碍）：

```
Amazon/Shopify/Meta/Google/TikTok → DataSource（M6，独立 provider 族）
  → data.query Tool（M6）→ Agent（M4 Loop）
  → Analysis Artifact（M4 表 + M5 runId 追溯）→ Creative Brief（同）
  → image.generate/video.generate（M4 工具）→ GenerationTask（M5 runId 追溯）
  → Attachment（既有链路）
```

M5 新增的 KB 可承载品牌规范/历史报告（品牌知识 → 自动注入），与 M6 DataSource 无冲突。**不实现任何 Ecommerce 组件。**

---

## 22. M5 Scope（实施序，确认后执行）

1. **Agent Versioning**（§4）：AgentVersion 表 + agents.scope/activeVersionId + registry 读版本 + 迁移现有行 → v1 + 后台发布/回滚 API + Run 快照关联
2. **关联补全**（§6/§16）：generation_tasks.runId/toolCallId、artifacts.runId/toolCallId、ToolContext.toolCallId、Tool 透传
3. **Usage 完整性**（§7）：Loop 失败回合 try/finally + 媒体归因 + `GET /usage/agent-runs/:id` 聚合
4. **Timeline**（§5/§15）：`GET /agent-runs/:id/timeline` 投影服务
5. **Knowledge**（§8~12）：pgvector 镜像切换 + EmbeddingProvider 族（含 mock）+ KB/Document/Chunk 表 + document 队列/Worker + KnowledgeSource + knowledge.search Tool
6. **Context Budget**（§14）：BudgetApplier 截断 + 常数化预算
7. **后台**：Agent/版本管理页、KB 管理页、Run 浏览（Timeline）、用量/成本报表、Provider/Model 管理、Provider 健康页（M3 已有数据）
8. 全量回归（M1~M4 冻结测试全绿）

## 23. M6 Scope（衔接）

长任务（异步 run/heartbeat/resume/retry orchestration）、Approval 系统、external_action 工具、Ecommerce DataSource + metrics 宽表、摘要自动生成（conversation_summaries 表已备）、Context 压缩、organization KB/用户自建 Agent（scope=user）、Run Timeline UI 增强。

---

## 三清单

### Must Fix Before M5

**无阻塞项**（M4 FROZEN 状态干净）。以下 M4 技术债**并入 M5 实施**（非前置）：① failed LLM round usage（§7.1）；② GenerationTask→AgentRun 关联（§6）；③ core/tools 分层方向（M5 后台模块搭建时定案：Tool 实现上移至 `modules/tools/`，core/tools 只留接口）；④ version 语义（§4 本体）。

### Recommended（M5 内）

1. artifacts.version/references 字段**不建**——M6 与 Creative Brief 工作流同定（避免猜结构）；
2. document sourceType=url 抓取源留 M6；
3. mock-embedding 替身随 EmbeddingProvider 一并落地（延续无 Key 全链路可验原则）；
4. TaskCard 与 Timeline 复用同一 run 数据投影（前端组件不重复请求）。

### Future（M6+）

自动摘要与 Context 压缩、长任务五件套（heartbeat/resume/重试编排/分布式锁/恢复）、审批与 external_action、Ecommerce 全链路、用户自建 Agent（scope=user）、多租户。

### 绝对不能提前做（M5 内禁止）

Workflow 引擎、审批系统、Ecommerce DataSource、异步长任务、多 Agent 协作、Billing、OCR/音视频索引、独立向量数据库。
