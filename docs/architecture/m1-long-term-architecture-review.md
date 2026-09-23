# 《M1 → AI Agent 平台长期架构审查报告》

| 项 | 内容 |
|---|---|
| 日期 | 2026-09-23 |
| 基线 | Phase 3（M0）+ M1 实际代码（89 测试全绿），未做任何修改 |
| 目标 | 面向 20 项未来能力（Memory/RAG/多 Agent/Tool/Ecommerce 集成/Creative Brief/Human Approval 等）评估现有 Database/Conversation/Message/User/Provider/Model/Router/Task/Agent/Tool/Storage/API/SSE/Worker 的可扩展性 |
| 状态 | **待用户确认**（确认后按三个清单排期执行） |

---

## 0. 总体结论（先说结论）

**M0+M1 的基础是健康的，扩展点大部分已经预留**。20 项未来能力中没有任何一项需要"推倒重来"：

- 正确预埋的：意图枚举（含 agent_task/workflow）、Agent 事件流模型、SSE 协议（含 task.* 占位）、统一附件系统（上传与生成产物同源）、usage_records 成本字段、Redis 事件总线 + BullMQ 双队列、会话锁、错误码归一化体系。
- **唯一"必须现在动手"的代码级修改只有一个**：把 ChatService 中硬编码的上下文组装（`chat.service.ts:152` 的 `take: 8` 历史裁剪）抽成独立 ContextAssembler——它是未来 Conversation Memory / User Memory / KB 检索的**唯一接入点**，且 M4（多 Agent 路由）就要复用。
- 其余 95% 的调整是**增量式**的：加表、加枚举值、加接口实现，按里程碑自然发生。
- 最大的纪律要求不是"现在多建表"，而是**锁定几条边界约定**（消息三层内容模型、枚举只增不改、Artifact 容器、任务与运行的边界），避免后续返工。

---

## 1. 现状盘点（逐组件 verdict）

| 组件 | 现状 | 对未来的适配度 | 判定 |
|---|---|---|---|
| Database | 14 表，enums 13 个，JSONB 用于 tools/capabilities/input/output | 结构克制、扩展点充足 | ✅ 保持（详见 §3） |
| Conversation | userId 归属 + 软删除 + 标题自动截取 | 未来 Project 维度可加 projectId 列 | ✅ 保持 |
| Message | 纯文本 content + intentType/confidence + tokenUsage/errorCode | **有意为之的"文本层"**；结构化产物走附件/Artifact，不改 content | ✅ 保持（锁定约定 §7） |
| User | role/status 枚举预留 vip/enterprise | ✅ | ✅ 保持 |
| Provider | type: llm/image/video + adapter 注册表 + AES-GCM | Embedding/数据源未来加 adapter 族 | ✅ 保持 |
| Model | capabilities Json + 价格 + isDefault/priority | 能力声明已够（vision/jsonSchema…） | ✅ 保持 |
| Router | LLM 分类 + 快路径 + 置信度降级 + agent 字段 | 多 Agent 路由只需 agent→注册表映射 | ✅ 保持 |
| Task | generation_tasks 面向 image/video 生成 | 生成类任务够了；**Workflow 用独立 agent_runs**（见 §8） | ✅ 保持 |
| Agent | `Agent = execute() → 事件流` + 注册表（未接线）+ agents 表（未使用） | 模型正确；M4 接线 DB 配置 | 🟡 M4 按计划接线 |
| Tool | **代码中尚无 Tool 接口**（架构文档 §7.4 有契约） | M6 Tool Calling 时实现，勿提前 | ✅ 保持 |
| Storage | StorageAdapter（local/S3）+ 路径穿越防护 | Artifact/报告/知识库文件全走它 | ✅ 保持 |
| API | /api/v1 + 统一信封 + 拦截器 + CSRF + 归属校验 | 未来加 /integrations、/approvals 路由即可 | ✅ 保持 |
| SSE | message_start/delta/end + status + task.* + error（zod 共享） | 缺 approval/artifact/tool/run 事件——**增量追加，无破坏** | 🟡 补事件名预留（§5） |
| Worker | BullMQ image/video 队列已定义，处理器空 | M2/M3 挂处理器；长任务用 delayed job 已有 | ✅ 保持 |

---

## 2. 九个问题的回答

### 问题 1：哪些现有设计需要修改？

**代码级必须修改（1 处）：**

1. **ChatService 上下文组装硬编码**（`modules/chat/chat.service.ts:152` `take: 8` + `router.service.ts:59` `slice(-2)`）。未来 Memory/RAG 必须改这条路径，M4 多 Agent 也要复用。抽成 `core/context/ContextAssembler`：
   ```typescript
   // 目标形态（M4 前完成重构，行为与现在完全等价）
   interface MemorySource {
     readonly scope: 'conversation' | 'user' | 'project' | 'knowledge';
     collect(ctx: AssembleContext): Promise<MemoryBlock[]>;   // 有序上下文块
   }
   class ContextAssembler {
     assemble(input: { userId; conversationId; userMessage; attachments; agentConfig }): Promise<ChatMessage[]>;
     register(source: MemorySource): void;                     // 注册即生效（M6 挂 Memory/RAG）
   }
   ```

**接口/命名级修改（M4 前定稿）：** SSE 事件名与 AgentEvent 补充占位（见问题 5 与 §5 的清单）。

**其余一切保持。** Provider/Model/Router/Task/Storage/API 的抽象形状都经受住了 20 项能力的推演。

### 问题 2：哪些接口需要提前抽象？

**现在实现（M2~M4 窗口内）：**
| 接口 | 位置 | 落地时机 |
|---|---|---|
| `MemorySource` + `ContextAssembler` | core/context | M4 前（重构） |
| `Tool`（name/description/zod schema/execute） | core/tools | M6 实现，契约已入架构文档 §7.4 |
| `Artifact` 类型（kind/title/summary/content/storageKey） | shared | 建议现在定义类型（表在 M6 前建） |

**只写契约、推迟实现（M6+）：**
| 接口 | 说明 |
|---|---|
| `EmbeddingProvider`（embed(query/text)→vector） | 与 LLM/Image/Video 同族，providers.type 加 `embedding` |
| `DataSourceAdapter`（authUrl/exchangeCallback/refreshToken/sync/fetchReport） | Ecommerce 集成族（§6） |
| `ApprovalGate`（request/await/cancel） | Human Approval（§5） |
| `WorkflowEngine`（run/steps/事件） | Multi-Agent（§8） |

### 问题 3：哪些数据库实体需要调整？

**必须（M2 前）：** 无破坏性调整。Enum 管理约定：**只增不删不改名**（Prisma enum 是 PG enum，改名需重建）。

**建议现在（M2~M5 窗口，一次小迁移做完）：**
1. `AttachmentKind` 增加 `generated_file`（报告/PDF/导出物）。
2. `agents` 增加 `kind String`（`builtin`/`custom`，映射到代码类 slug）+ seed 四个内置 Agent（chat/image/video/image-analysis）。
3. 新增 `artifacts` 表（Creative Brief/报告/分析结果的容器，见 §7）。
4. `UsageKind` 增加 `embedding`/`tool`/`workflow` 三个枚举值（一次性加全，避免 M6 后 enum 追加风暴）。

**以后按需（M6+）：** `projects`、`user_memories`、`project_memories`、`conversation_summaries`、`documents`/`kb_collections`/`kb_chunks`(pgvector)、`integrations`、`analytics_metrics`（统一指标宽表）、`agent_runs`/`agent_run_steps`、`pending_approvals`。全部为增量表，不触碰现有表。

### 问题 4：未来 Memory 应该如何接入？

四层 Memory 统一走 **MemorySource → ContextAssembler** 注入：

```
ContextAssembler.assemble() 输出顺序：
[agent systemPrompt] → [project memory] → [user memory] → [conversation 摘要] → [KB 检索块] → [最近消息] → [附件上下文]
```

| 层 | 存储 | 机制 | 时机 |
|---|---|---|---|
| Conversation Memory | 现有 messages（近期）+ `conversation_summaries` 表（远期） | 滑窗 + 超过阈值触发 BullMQ 摘要任务（llm_router 类用量计费） | M4 滑窗参数化 / M6 自动摘要 |
| User Memory | `user_memories`（userId, key, value, importance, hitCount, updatedAt） | LLM 从对话中抽取事实，同 key 合并/冲突覆盖；命中率低的衰减 | M6 |
| Project Memory | `project_memories`（同构，projectId 作用域） | 品牌/店铺/受众等稳定上下文 | 随 projects 落地（M6+） |
| 长期 Memory / KB | pgvector + `kb_chunks`（embedding 列） | 文档切块 → 向量化 → 相似度检索；Docker 镜像换 `pgvector/pgvector:pg16`（数据兼容，扩展 `CREATE EXTENSION vector`），Prisma 用 `Unsupported("vector")` + `$queryRaw` 检索 | M6+，**现在不动** |

关键点：**先有 ContextAssembler 接口，Memory 才有地方挂**——这正是 §1 把它列为唯一"必须现在"的原因。

### 问题 5：未来 Agent / Tool 如何接入？

**Agent（M4 接线，模型已就绪）：**
- `agents` 表行（slug/kind/systemPrompt/modelId/tools/temperature/…）→ 启动时载入 `AgentRegistry`（已存在，`agents/agent.registry.ts`），`slug` 映射代码类。
- Router 输出已有 `agent` 字段 → 按 slug 取注册表实例执行；意图 `agent_task`/`workflow` 枚举已预留。
- 新 Agent（电商数据分析、文案、PPT、文档）= 新代码类 + 后台建行，**核心零改动**——与 Provider 同款"注册即用"。

**Tool（M6 实现，契约先行）：**
- `ToolRegistry`：name → `{ schema(zod), execute, sideEffects: 'none'|'external', requiresApproval?: boolean }`。
- agents.tools（JSONB）声明启用的 tool 名 + 参数覆盖。
- Agent Loop（core/agent-loop）：LLM function-calling ↔ tool 执行循环，M6 起供 ChatAgent 与其他 Agent 共用。
- **Human Approval**：`sideEffects: 'external'` 的工具（如广告创建/投放）自动要求批准——`pending_approvals` 表 + SSE `approval.requested` 事件（前端渲染"批准/拒绝"卡片）+ `/api/v1/approvals/:id` 决策端点。审批发生在 tool 执行层，Agent 无感知——这是最干净的接入点。

### 问题 6：未来 Ecommerce DataSource / Integration 如何接入？

与 Provider 同构的**第二组适配器族**，但隔离在独立模块（`modules/integrations` + `providers/datasource`）：

```
integrations 表：userId, provider(amazon|shopify|meta|google|tiktok), credentialsEncrypted,
                status(connected|expired|error), scopes Json, config Json, lastSyncAt
DataSourceAdapter：authorizeUrl() / exchangeCallback(code) / refreshToken() / sync(since) / fetchReport(params)
```

- OAuth 流程：`/api/v1/integrations/:provider/authorize` → 回调 `/callback`（state 存 Redis KV，防 CSRF）。
- 凭据复用 AES-256-GCM（CryptoService 已就绪）；token 过期→状态 expiring → 后台刷新。
- 数据落地两段式：**raw staging**（原始报表 Json，可回溯）→ **`analytics_metrics` 统一指标宽表**（date, platform, entity_type(account/campaign/ad/product), entity_id, measures Json{impressions,clicks,spend,sales,…}, dimensions Json）——跨平台分析（问题 12/13/17）必须统一宽表，**不要**为每家平台建独立表。
- 同步 = BullMQ repeatable job；分析 = Agent + `query_metrics`/`list_campaigns` 等只读工具；**"根据数据自动判断做什么素材"（问题 14）= 数据分析 Agent 产出 Creative Brief Artifact → 素材生成 Workflow**。
- 时机：**全部 M6+**，现在零改动。

### 问题 7：未来 Artifact（图片/视频/报告/Creative Brief）应该如何设计？

**三层内容模型（现在锁定为约定，写入架构文档）：**

| 层 | 载体 | 内容 |
|---|---|---|
| 文本层 | `messages.content` | 对话正文（Markdown）——**永不改结构** |
| 媒体层 | `attachments`（kind: upload/generated_image/generated_video/**generated_file**） | 图片/视频/文件，SSE `task.completed.artifact` 引用 |
| 制品层 | **`artifacts`（新表，建议现在建）** | Creative Brief、分析报告、数据集、方案文档等结构化产物 |

```prisma
model Artifact {
  id             String   @id @default(uuid())
  userId         String
  conversationId String?
  messageId      String?
  taskId         String?
  kind           String   // creative_brief | report | analysis | dataset | proposal
  title          String
  summary        String?  @db.Text     // 列表卡片摘要
  content        Json?                  // 结构化数据（brief 的 JSON schema 等）
  storageKey     String?               // 大体积产物（PDF/Markdown）走对象存储
  status         String   @default("ready")
  createdAt      DateTime @default(now())
}
```

- 前端渲染为**制品卡片**（消息下方插入，可展开/下载/引用）；SSE 补 `artifact.created` 事件。
- Creative Brief = `kind: creative_brief` 的 Artifact，content 为 schema 化的品牌/受众/渠道/素材清单（问题 15 的载体）。
- 图片/视频继续走 attachments（不进 artifacts）——M2/M3 零改动。

### 问题 8：未来 Agent Workflow / AgentRun / Step 如何接入？

**与 generation_tasks 严格分工，不泛化现有任务表：**

- `generation_tasks` 保持媒体生成语义（M2/M3 直接用，含轮询/取消/转存）。
- Workflow 独立：`agent_runs`（run 级：agentId?/status 含 awaiting_approval/input/output）+ `agent_run_steps`（step 级：type llm|tool|agent|approval，parentStepId 支撑嵌套，input/output Json，retry 计数）。
- 编排：`WorkflowEngine`（M6+）——计划生成（LLM）→ 逐步执行 → 事件经 EventBus 推 task SSE 通道；步骤可引用 generation_tasks（生成素材步骤）。
- 长任务 UX：chat SSE 收尾发 `run.created` → 前端轮询/订阅 run 状态（**复用 M5 的 task SSE 通道设计**）→ 会话中展示 Run 时间线卡片。现有「SSE 短连接 + 任务通道」的组合已经为它预留了位置。
- 时机：**全部 M6+**，现在不动。

### 问题 9：哪些东西现在绝对不要过度设计？

1. **不建 projects 表**——Ecommerce/品牌维度未成形前建了也是猜。
2. **不建 user_memories/project_memories/conversation_summaries**——先有 ContextAssembler，表随 M6 落地。
3. **不装 pgvector、不建 kb_***——检索层是 M6 的事；届时只换 compose 镜像即可，无锁定风险。
4. **不实现 Tool 接口/ToolRegistry/Agent Loop**——M6 前无消费者。
5. **不建 agent_runs/agent_run_steps**——Workflow 未开工。
6. **不建 integrations/analytics_metrics**——数据源未确定前，指标宽表的维度设计必错。
7. **不做审批系统（pending_approvals）**——M6 随副作用工具一起。
8. **不迁移 messages.content 为 JSONB blocks**——三层内容模型已覆盖，迁移纯属折腾。
9. **不做多租户 organization**——userId 贯穿已够，届时加成员关系表即可。
10. **不建通用"任务表"泛化**——generation_tasks 保持语义清晰，比一张大而全的 tasks 表更可维护。
11. **不在 M2 前给前端加 Zustand/复杂状态层**——react-query 已够，等 TaskCard 复杂度上来再评估。

---

## 3. 未来能力 → 架构落点映射表（20 项）

| # | 能力 | 落点 | 需要的架构件 | 时机 |
|---|---|---|---|---|
| 1 | 长期 Memory | ContextAssembler + pgvector | MemorySource(vector) | M6 |
| 2 | User Memory | ContextAssembler | user_memories + LLM 抽取任务 | M6 |
| 3 | Project Memory | ContextAssembler | projects + project_memories | M6+ |
| 4 | Conversation Memory | 滑窗参数化 → 摘要 | conversation_summaries + BullMQ 摘要 | M4/M6 |
| 5 | Knowledge Base / RAG | ContextAssembler | documents/kb_chunks + EmbeddingProvider | M6 |
| 6 | Image Agent | 现架构 | ImageProvider 实现 + image 队列处理器 | M2 |
| 7 | Video Agent | 现架构 | VideoProvider 实现 + 轮询器 | M3 |
| 8 | Tool Calling | Agent Loop | Tool 接口 + ToolRegistry | M6 |
| 9 | Multi-Agent | AgentRegistry + WorkflowEngine | agent_runs/steps | M6+ |
| 10 | Ecommerce Data Agent | DataSource 族 + Agent | integrations + metrics 宽表 + 只读工具 | M6+ |
| 11 | Amazon/Shopify/Meta/Google/TikTok 连接 | DataSourceAdapter | OAuth 路由 + staging | M6+ |
| 12/13 | 销售/广告数据分析 | metrics 宽表 + 分析 Agent | query_metrics 工具 | M6+ |
| 14 | 数据→素材决策 | 分析 Agent → Creative Brief | Artifact(creative_brief) | M6+ |
| 15 | Creative Brief | Artifact | artifacts 表（建议现在建） | M6+ |
| 16 | 自动生成素材 | Workflow + generation_tasks | run 内批量任务 | M6+ |
| 17 | 广告预算分析 | metrics 宽表 | 同 12/13 | M6+ |
| 18 | 确认后执行广告 | ApprovalGate + 副作用工具 | pending_approvals + approval.requested | M6+ |
| 19 | 长任务/Workflow | WorkflowEngine + Run 卡片 | agent_runs + task SSE 通道（M5 就绪） | M6+ |
| 20 | Human Approval | ApprovalGate | 同 18 | M6+ |

---

## 4. 三个清单（最终交付）

### ✅ 必须现在修改（M2 开工前，行为不变）

1. **抽取 `core/context/ContextAssembler`**：ChatService 的硬编码历史裁剪（`chat.service.ts:152`）与 Router 的 `slice(-2)`（`router.service.ts:59`）迁入独立服务，定义 `MemorySource` 接口（先空实现，行为与现状等价）。—— 这是四层 Memory 与 RAG 的唯一接入点，现在抽成本最低。
2. **锁定 SSE 未来事件命名**（只改 shared/events.ts 注释 + 架构文档）：`artifact.created`、`approval.requested`、`tool.start/tool.end`、`agent.start/agent.end`、`run.created/run.progress/run.completed`。命名一锁，前端 TaskCard/审批卡片的协议层零返工。

### 🟡 建议现在修改（M2~M5 窗口内，一次小迁移）

3. `AttachmentKind` + `generated_file`；`UsageKind` + `embedding/tool/workflow`（一次性 enum 补充）。
4. 新建 `artifacts` 表 + shared `Artifact` 类型（§7 设计）——Creative Brief/报告从第一天就有"家"。
5. `agents` 表 + `kind` 字段；seed 四个内置 Agent（chat/image/video/image-analysis）——M4 路由/注册表接线的前置。
6. 会话列表与消息列表的游标分页（长任务日志与历史增长，M5 做）。
7. M2 的 TaskCard 组件按「泛化任务事件」（kind 字段预留）设计，不做 image/video 专属写死。

### 🔵 可以以后修改（M6+，按里程碑自然发生）

8. projects / user_memories / project_memories / conversation_summaries
9. pgvector 镜像与 kb_collections / kb_chunks / documents + EmbeddingProvider
10. Tool 接口 + ToolRegistry + Agent Loop
11. integrations + DataSourceAdapter 族 + OAuth 路由 + staging + analytics_metrics 宽表
12. agent_runs / agent_run_steps + WorkflowEngine
13. pending_approvals + 审批 UI（approval.requested 卡片）
14. 多租户 organization
15. 广告预算/成本域（走 metrics 宽表，不进 usage_records）

---

## 5. 结语

审查结论一句话：**架构不需要"为未来重构"，只需要"为未来留门"——门已经留了 95%，剩下的 5% 是 ContextAssembler 一个重构和几张新表。** 真正要防的不是能力缺失，而是过早建表（projects/metrics/agent_runs 现在建必错）。

按此报告确认后：先执行「必须」两项（半天工作量，零行为变化），然后照常进入 M2（附件 + 图片生成），「建议」项在 M4/M5 窗口消化。
