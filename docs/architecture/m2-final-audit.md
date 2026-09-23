# M2 Final Architecture Audit

| 项 | 内容 |
|---|---|
| 日期 | 2026-09-23 |
| 基线 | M2 全部提交（159 测试全绿），零代码修改 |
| 方法 | 逐项读代码核验（schema/服务/控制器/SSE/Worker），所有结论附文件级依据 |
| 状态 | 未提交（按审计指令，本报告不入库） |

---

## M2 Audit Result

### 1. Architecture Status

🟢 **Safe**

M2 的结构性基础足以支撑 Video / Agent / Tool / Workflow / Ecommerce 的后续演进。没有发现需要推倒或返工的设计；所有发现的问题都是增量式修补（见 §11）。

### 2. Database

**核验通过的项：**
- `User → Project`：userId FK + Cascade，反向关系已建 ✓（schema.prisma:382 前）
- `Project → Conversation`：**onDelete: SetNull** ✓——删除 Project 不会删除 Conversation/Message（软删除 + 关系置空，schema:167）
- `Project → Memory/Artifact`：Cascade ✓——项目级记忆/制品随项目消失，语义正确
- Memory 全字段：scope/category/status/source/sourceMessageId/confidence/importance/**lastUsedAt** 齐全 ✓
- 索引齐备：conversations[userId,updatedAt]+[projectId]、messages[conversationId,createdAt]、attachments[userId,createdAt]+[messageId]、generation_tasks[userId,createdAt]+[status]、memories[userId,scope,status]+[projectId,scope,status]、artifacts[userId,createdAt]+[projectId]+[conversationId] ✓

**发现的问题（均为 🟡）：**
- **D1** `artifacts` 缺 `messageId` 索引（制品按消息查询是未来高频路径，M6 建 API 时补）。
- **D2** `conversation_summaries` 仅结构 ✓（全库 grep 0 处使用），未污染 M2 上下文 ✓。
- **D3** Memory 无任何唯一性约束——**候选可无限重复**（详见 §3）。

### 3. Memory

**核验通过的项：**
- user/project scope 清晰：单表 + scope 字段 + 服务层一致性校验（user 禁 projectId、project 必填且验归属）✓
- candidate → active/rejected 状态机 ✓；**ContextAssembler 只读 status=active**（memory.sources.ts），candidate 不会进入上下文 ✓
- confidence（提取置信度 0~1）与 importance（任务重要度 0~100）**完全分离**，注释与 prompt 双处明确 ✓
- sourceMessageId/source 追溯齐全 ✓；lastUsedAt 存在且 markUsed 刷新 ✓
- 权限：list 双条件（userId+projectId）、create 验项目归属、update/remove requireOwned ✓
- **删除语义**：硬删除 + 每次组装实时查询（无缓存）→ 删除后不可能再被注入 ✓
- 注入有界：每源 top-10 by importance（memory.sources.ts）✓
- 增长有闸：extractor 每日 20 候选上限 + 置信度 0.7 ✓（LIMITS 与系统设置双保险）

**发现的问题（🟡）：**
- **M1 无去重**：同一事实被反复提取 → 重复 candidate 累积；人工确认后同一内容可能以多条 active 注入上下文。M4 做确认 UI 时建议加「内容相似度/精确前缀去重」+「同 sourceMessageId 幂等」。
- **M2 `markUsed` 无 userId 条件**（memory.service.ts）：当前仅内部调用（ids 来自已 scoped 的 list），无 API 暴露，无实际风险；未来若开放公共刷新接口需补归属校验。
- **M3 active 总量无上限**：存储增长由人工确认把关（可接受），注入已 top-10 截断；M6 引入淘汰策略时用 lastUsedAt 即可，无结构障碍。
- **M4 每日限额存在并发竞态**（count 与 create 非原子）：单用户场景影响可忽略；多实例上线前改 Redis 计数。

**结论**：MemoryExtractor 是"记忆候选生成器"（提取→candidate→人工确认），不是模型训练系统 ✓——无训练语义、无自动激活路径。

### 4. ContextAssembler

**核验通过的项：**
- 六层顺序已锁定（CONTEXT_ORDER：system=0→project=10→user=20→summary=30→knowledge=40→recent=100）✓
- M2 已注册 ProjectMemorySource/UserMemorySource/RecentMessageSource；**未实现源零注册、零数据** ✓
- **无记忆时行为与 M1 逐字一致**（集成测试覆盖）✓
- **ChatService 零直查 Memory**：唯一 memory 触点是 MEMORY_EXTRACTOR（fire-and-forget 提取），上下文组装全走 assembler ✓
- 复用性：ContextAssembler 仅依赖 Prisma/MemoryService，无 chat 依赖 → 未来 Agent/Workflow 直接注入即用 ✓
- 无 N+1：每会话 2~4 条查询（conversation + 两源 + markUsed 批更新）✓

**发现的问题（🟡）：**
- **C1** Router 输入复用组装结果需手动过滤 conversation scope（chat.service.ts prepareChat 内的过滤逻辑）——正确但属于"约定"。未来 Router 升级或新调用方接入时建议把「对话-only 视图」收进 assembler 提供独立方法（如 `assembleConversationOnly()`），避免再次复制过滤逻辑。

### 5. Image Generation

**核验通过的项：**
- **完全独立**：ImageGenerationService（modules/generations）零 ChatService import；Chat/ImageAgent 只是调用入口之一 ✓（grep 核验）
- 未来 Agent 调用 = 注入服务；Workflow 调用 = 循环 prepareImageTask；批量 = count 1~4 + 多任务 ✓
- Provider 可替换：ImageManager 注册表 + DB 配置 ✓；Mock 支持 ✓（mock-image 1×1 PNG）
- 失败/retry/超时：ModelRouter 可重试回退 + 熔断记录 ✓；万相异步轮询内部 8 段退避上限 ~155s ✓；下载 3 次重试 ✓
- 结果 → Attachment（generated_image, taskId 关联）✓；SSE task.* 只携带 taskId/progress/kind，**零 Provider 细节** ✓
- 幂等：非 pending 任务跳过 ✓；取消：pending 置 cancelled，worker 跳过 ✓

**发现的问题（🟡，均非阻塞）：**
- **G1 无全局任务超时护栏**：worker 崩溃/进程重启后，processing 任务永久卡死（无清扫机制）。万相轮询有内部上限，但同步型 provider 挂起或 worker 中途死亡没有兜底。—— **见 §11 唯一 Must Fix**。
- **G2 usage 失败行归因缺失**：失败时 providerId/modelId 记录为空串（任务成功才写 provider 字段），M5 健康度统计需要失败归因。
- **G3 写死检查**：mock-router 启发式仅存在于 dev 替身 adapter（文档明确），mock-image 同理；核心链路无任何为 M2 生图写死的代码 ✓。

### 6. Video Compatibility

**结论：无结构性阻碍，M3 可直接开建。**

- `GenerationTask.type` 枚举已含 `video` ✓；`input` Json 可放 duration/resolution ✓
- `VIDEO_QUEUE` 已定义（queue.module.ts）✓；Worker 处理器注册模式可直接复用（ImageWorkerModule 为模板）✓
- `ImageProvider` 的异步形态（submit/getStatus）与 VideoProvider 同构——**新增接口文件即可，无需改 ImageProvider**；差异仅在 video 需 `cancel` 与 progress 字段
- SSE task.* 事件与 kind 字段类型无关 ✓；前端 TaskCard 已按 kind 泛化 ✓
- Attachment：type video + kind generated_video 枚举已就位 ✓
- 需要新增（M3 内）：VideoProvider 接口 + 2 adapter、seed 视频模型、video 队列处理器 + 轮询器（复用 delayed-job 模式）、任务取消（进行中）、30min 超时护栏（与 §11 一并做）

### 7. Agent / Workflow Compatibility

**结论：无结构性阻碍。**

1. ContextAssembler 可被 Agent 复用 ✓（§4）
2. ImageGenerationService 就是未来 Tool/Workflow 的执行能力 ✓（§5）
3. Artifact 可承载 Agent 输出：类型枚举（creative_brief/report/analysis 等）+ content Json + storageKey + 关联 user/project/conversation/message/task ✓
4. Attachment 可作 Tool 输入/输出 ✓（上传路径 + generated_* 路径并存）
5. SSE：agent.*/tool.*/run.*/artifact.created 事件名已在 ChatStreamEventNames 锁定 ✓；wire schema 增量追加即可，无破坏
6. AgentRun/AgentRunStep：**M6 需要**（长任务持久化/步骤追溯），当前无表、无阻碍——按审查报告 §8 设计增量落地
7. ChatService 与未来 AgentService **无强耦合**：意图→Agent 的选择逻辑单点隔离在 streamChat（chat.service.ts:105 一处 switch），M4 换成 Agent 注册表只动这一点

### 8. Ecommerce Compatibility

**结论：可承载，两处小补强（M6 时做，不阻塞）。**

链路映射核验：
- Ecommerce DataSource → 未来 integrations 模块（M6，与现架构无冲突）
- Data Analysis → Artifact(kind=analysis/report) + content Json ✓
- Creative Brief → Artifact(kind=creative_brief) ✓（枚举已含）
- Image/Video Generation → ImageGenerationService + 未来 Video 同构服务 ✓
- Campaign/Ad Analysis → Artifact + metrics 数据（M6 宽表，属新增域）✓

Artifact 关联能力核验：Project ✓ / Conversation ✓ / User ✓ / 输入数据（messageId/taskId 溯源 ✓）/ 分析结果（content Json）✓ / Creative Brief ✓ / 生成素材（taskId→attachments）✓。

**不足（🟡，M6 补）：** Artifact 无独立 metadata Json 字段（目前用 content 承载附加信息，可用但语义混）；无「数据快照/来源数据引用」的规范字段（如 sourceRef）——M6 定义 DataSource 时一并定契约。

### 9. Security

**逐面核验（全部通过）：**

| 面 | 校验点 | 结论 |
|---|---|---|
| Project 越权 | list(userId)/requireOwned(userId,id)（projects.service） | ✅ |
| Conversation 越权 | requireOwned（conversations.service，全部 CUD + messages 读取） | ✅ |
| Memory 越权 | list 双条件 / create 验项目 / update/remove requireOwned | ✅ |
| Attachment 越权 | getById(userId)；上传绑定 userId；chat 引用路径 resolveAttachments(userId, ids) 逐条校验 | ✅ |
| Artifact | **当前无任何 API** → 零暴露面；M6 建 API 时需按同模式加归属校验（**记入未来检查单**） | ✅（无面） |
| GenerationTask 越权 | get(userId)/listByConversation 验会话归属/cancel(userId) | ✅ |
| 跨用户任务读取 | 无全局任务列表（list 强制 conversationId + 归属） | ✅ |
| SSE 订阅他人任务 | M2 任务走 REST 轮询 + 归属校验；**无任务 SSE 通道**（M5 建通道时订阅必须鉴权，记入检查单） | ✅ |
| 会话锁 | Redis SETNX（chat:lock:{conversationId}） | ✅ |
| 认证/CSRF/CORS/限流 | M1 已审计，M2 未触碰 | ✅ |

**发现的问题：** 无 🔴。两条 🟡 记入未来检查单（Artifact API 归属校验、M5 SSE 通道订阅鉴权）。

### 10. Performance

| 项 | 结论 |
|---|---|
| ContextAssembler N+1 | 无——每会话 2~4 条查询；markUsed 为单条批量 UPDATE ✓ |
| Memory 查询增长 | list take 100 + 注入 top-10；ILIKE 走 [userId,scope,status] 前缀过滤后扫描（万级以内无压力）✓ |
| 最近消息查询 | 命中 [conversationId, createdAt] 复合索引 ✓ |
| Project/Conversation/GenerationTask/Attachment/Artifact 索引 | §2 核验齐备 ✓ |
| SSE 连接泄漏 | ChatController：heartbeat clearInterval + req.off('close') + writer.end() 全部在 finally ✓；AbortController 传播到 Provider 流 ✓ |
| MemoryExtractor fire-and-forget | 双重兜底（extractor 内部 try/catch + 调用点 .catch）→ 异常不丢失、不阻塞响应 ✓ |
| 写放大（🟡 备注） | 有记忆时每次对话都会 markUsed（单条批量 UPDATE）——当前可忽略；高并发时改为异步/合并（M6 与淘汰策略一起） |

### 11. Must Fix Before M3

**仅 1 项：**

1. **任务超时护栏 + 孤儿任务清扫**（G1）
   - 现状：`LIMITS.IMAGE_TASK_TIMEOUT_MS`（5min）在 shared 定义但**未消费**；worker 崩溃/重启后 processing 任务永久卡死；同步型 provider 挂起无兜底。
   - 修复形态（M3 第一项任务，与视频轮询器共用）：① processor 内按任务类型设绝对截止时间（image 5min / video 30min），超时强制 failed；② BullMQ repeatable job 每 5min 扫 `processing` 且 `startedAt` 超限的任务标记 failed；③ 视频轮询器天然复用它。
   - 规模：worker 侧 ~30 行 + 一个 repeatable job，不触碰 API 与协议。

### 12. Can Enter M3?

**YES。**

条件：§11 的唯一 Must Fix（任务超时护栏）作为 M3 第一项任务落地，与视频轮询器一并实现。除此之外，M2 的结构性基础全部达标——无任何需要返工的数据库、接口或协议。

---

*审计基线：`5041756`→`fa6cd68` 共 12 个提交；159 测试全绿。本报告未提交 git（按审计指令）。*
