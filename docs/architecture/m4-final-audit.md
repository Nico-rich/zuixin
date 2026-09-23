# M4 Final Architecture Audit

| 项 | 内容 |
|---|---|
| 日期 | 2026-09-23 |
| 方法 | 代码级审计：对 11 个怀疑点做了 grep/读码实证（终态路径/清扫范围/分层方向/usage 关联/越界扫描），非报告形式确认 |
| 状态 | 未提交 git（按审计指令） |

---

## 1. 总体结论

🟡 **PASS WITH FIXES**

测试全绿（205）不是 PASS 的理由——审计发现 3 个真实缺陷（§3）和 8 个改进项（§4）。缺陷均不推翻 M4 架构方向，但按"代码级"标准不允许直接 PASS。

---

## 2. 架构检查

| 模块 | 状态 | 问题 | 严重程度 |
|---|---|---|---|
| Agent | 🟢 | Agent 接口/事件流边界干净；GeneralAssistant/Image/Video 三实现分层正确（grep 实证：agents 目录零 Provider 引用） | — |
| AgentRegistry | 🟢 | DB 驱动确认；硬编码仅剩 DEFAULT_AGENT_MAPPING 常量（服务端配置，可接受）；无任何 Agent 写 API → 普通用户无法改 systemPrompt/enabled/tools（M5 后台才有）；disabled Agent 不加载，映射失效回退 general-assistant ✓；`buildFallback()` 抛错路径 = 注册表为空时聊天显式失败（不会静默错误行为） | — |
| AgentLoop | 🟡 | **MUST-1** maxSteps 耗尽但最后一轮为 tool_calls 时以 completed 终态（AGENT_MAX_STEPS 定义了却从未触发）；**MUST-2** 进程崩溃/硬中断时 run 永久 running（无清扫兜底）；deadline 只在步首检查（provider timeout 兜底，可接受）；循环检测/取消/错误回喂/不存 CoT 全部实证 ✓ | 高/高/低 |
| ToolRegistry | 🟢 | register/get/list/has/listForAgent 完整；重名注册报错；允许清单过滤 = 服务端权限边界 ✓ | — |
| ToolContext | 🟢 | 服务端注入实证（loop 构造，非 LLM/用户输入）；4 个 Tool 均 strictObject → `{"userId":"other-user"}` 直接被拒（单测覆盖）；Tool 无法自定身份调用 Service（身份只经 ctx 继承） | — |
| LLM Tool Calling | 🟡 | Provider 格式（OpenAI delta 分片聚合）完全隔离在 adapter 实证；Loop 零 provider 分支 ✓；Case A/B/C/D/E 覆盖（多工具**顺序执行**，与设计一致）；**MUST-3** Case F 降级未实现——`capabilities.functionCalling` 从未被读取，不支持工具的模型收到 tools 参数可能 400 导致聊天失败 | 中 |
| AgentRun | 🟡 | 状态机六态、条件更新终态、DB WHERE 双重防复活 ✓；cancel/timeout 竞争条件安全（条件更新一方 count=0）；queued 预留未使用 ✓；孤儿风险见 MUST-2 | 高 |
| AgentRunStep | 🟢 | UNIQUE(runId, stepIndex)；类型含 reasoning/tool_call/final；无 LLM 推理内容落库（reasoning 未使用，符合"不存 CoT"）✓；stepIndex=999 魔数（仅美观问题） | 低 |
| ToolCall | 🟢 | UNIQUE(runStepId, idempotencyKey) 与代码幂等键生成匹配；复用输出路径实证；单请求单线程下无真实并发窗口（chat 会话锁 + 同步 run），约束在 M6 异步 run 时成为真正防线——当前为防御性正确 | — |
| Memory | 🟢 | memory.create_candidate → MemoryService.create（不直写 DB）实证；candidate 不绕过状态机（e2e 断言 status=candidate）；重复候选问题（M2 审计遗留）未变化 | 低 |
| ContextAssembler | 🟢 | Loop 未绕过（GeneralAssistant 经 assemble 取上下文）；**发现**：每会话 assemble 执行两次（ChatService 路由 + Agent 各一次）→ 记忆查询与 markUsed 双写（低效非错误）；Tool Result 经本地 messages 数组进入下一轮（工具协议，非上下文组装，边界合理）；无重复注入（单次组装 + 本地累积） | 低 |
| Generation | 🟢 | Tool → MediaGenerationService → Provider 分层实证（core/tools/builtin/tools.ts 只 import 服务）；M3 兼容（原子 claim/条件终态/清扫全回归绿） | — |
| SSE | 🟢 | 三类事件边界清晰；run.created→agent.start→…→agent.end→run.completed 单次发射（finally 保证）；无重复终态路径（e2e 事件序列断言）；**发现**：task 失败无独立 `task.failed` 事件（经 task.progress{message:'失败'}+轮询呈现）——命名已预留，非阻塞 | 低 |
| Usage | 🟡 | Loop 每回合记录 LLM 用量（实证在循环体内，全部回合都记）+ runId 关联 ✓；**发现**：LLM 流抛错时该回合用量记录被跳过（可能已计费但无记录）；**发现**：工具产生的媒体任务（image/video）无法关联 run——generation_tasks 无 runId，usage_records.runId 只覆盖 LLM 回合 → "一次 Run 四类成本"不可完整回答 | 低/中 |
| Security | 🟢 | 九个资源面逐一核验：AgentRun/Step/ToolCall（经 run 内联，userId 首条件）、Artifact（service 层归属，无 API 面）、Task/Attachment/Memory/Conversation/Project（M2/M3 审计结论保持）；agent-runs 越权 404 e2e ✓；Tool 权限服务端双校验实证 | — |
| Database | 🟢 | FK 完整（AgentRun.agent Restrict 防删行、steps/toolCalls Cascade）；三 UNIQUE 与代码逻辑匹配；nullable unique（idempotencyKey 多 NULL 合法）；无孤儿路径（M5 后台删 Agent 时 Restrict 会阻止——需确认后台 UX） | 低 |

**架构边界专项（§16 对应）**：Agent→Provider ✗ 无、Tool→DB ✗ 无（全经 Service）、Controller→Provider ✗ 无、Adapter→Service ✗ 无、Provider→Agent ✗ 无、Memory→Agent ✗ 无、GenerationTask→Agent ✗ 无（grep 实证）。
**唯一反向依赖**：`core/tools` → `modules/generations` + `modules/artifacts`（core 层依赖 modules 层，与 core→providers 的单向约定相反）——见 §4.3。

**越界扫描（§17）**：Ecommerce/Amazon/Shopify/Meta/Google/TikTok/Workflow/审批系统/多 Agent/RAG/data.query/web.search/Billing **均无实现**（grep 命中的 "workflow"/"approval" 均为意图枚举与 requiresApproval 预留位，属设计内）。✓

---

## 3. 必须修复

1. **MUST-1 AgentRun 无孤儿清扫**：`MediaCleanupService` 只扫 `generation_tasks`（media-cleanup.service.ts:25 实证）；AgentRun 在进程崩溃/异常中断后永久 `running`。修复方向：清扫 job 扩展 agent_runs（status=running 且 startedAt 超过 deadline → timeout，条件更新 + usage 归因，复用现有 sweep 模式）。约 30 行。
2. **MUST-2 maxSteps 耗尽误标 completed**：循环耗尽且最后一轮产出 tool_calls 时，`finalStatus` 保持初始值 completed（loop:87-143 实证），AGENT_MAX_STEPS 定义了但从未触发。修复方向：循环后检测 `step === maxSteps && 仍有工具调用` → 终态 timeout/errorCode=AGENT_MAX_STEPS。约 5 行 + 测试修正。
3. **MUST-3 functionCalling 降级缺失**：`models.capabilities.functionCalling` 从未读取；不支持工具的模型收到 tools 参数可能 400 → 普通聊天也会失败（general-assistant 默认携带工具）。修复方向：Loop 第一回合若工具定义非空但模型不支持（capabilities 声明或捕获 PROVIDER_BAD_REQUEST 关于 tools 的错误）→ 无工具重试一次。

---

## 4. 建议修复（不阻塞 M5，尽快处理）

1. **失败回合用量缺失**：LLM 流抛错时该回合 recordChatUsage 被跳过（可能已计费）→ try/finally 包裹或失败状态记录。
2. **媒体任务与 run 关联缺失**：generation_tasks 无 runId → Tool 产生的图/视频无法并入"一次 Run 的成本"。M5 补 `generation_tasks.runId?`（或经 ToolCall→task 二级关联），usage 聚合即可完整。
3. **core/tools 分层反向**：core 层 import modules/generations+artifacts。两选一：M5 将 Tool 实现上移到集成层（如 `modules/tools/`，core/tools 只留接口），或正式声明 core/tools 为"集成边界层"并文档化。当前无功能危害。
4. `agents.version` 无操作语义（仅写入不读取）——M5 后台做 diff/回滚时赋予语义。
5. stepIndex=999 魔数 → 常量化（FINAL_STEP_INDEX）。
6. `prepareMediaTask` 幂等键冲突（P2002）时抛错——真幂等语义应为返回已有任务（fetch by idempotencyKey）。
7. 每会话 assemble 双执行（路由 + Agent）→ 路由复用 Agent 组装结果或增加短 TTL 缓存，消除 markUsed 双写。
8. `task.failed` 事件 schema 缺失（失败经 task.progress 呈现）——补名入 ChatStreamEventNames 预留即可（命名已有一致性风险：task.completed 存在而 failed 不存在）。

---

## 5. Future

- **M5**：管理后台（Agent CRUD——注意 Agent 删除受 Run FK Restrict 保护，后台需"禁用"而非删除语义；Provider/Model 管理；usage/run 统计报表；Provider 健康页；任务 SSE 通道订阅鉴权）；agent-runs 的 queued 语义与异步化不在此列
- **M6**：Human Approval（pending_approvals + requiresApproval 状态机接入，ToolCall.waiting_approval）、异步 AgentRun（POST /agent-runs + retryOfRunId）、data.query/web.search/knowledge.search 等新 Tool、Workflow 引擎（独立表/模块）、Ecommerce DataSource 族、多 Agent 协作、记忆去重与确认策略、pgvector/RAG
- **更后续**：Agent Marketplace、Billing、多租户

---

## 6. 最终判断

### M4 是否真正可以冻结？

**不可以无条件冻结。** 架构方向与分层边界可以冻结；§3 的三个缺陷需在冻结前修复（规模合计 <100 行 + 测试），否则"Agent Runtime 长期能力"的可靠性声明不成立。

### 是否允许进入 M5？

**允许（有条件）。** 条件：§3 三项作为 M5 第一批任务落地（其中 MUST-1/2 属核心运行时正确性，MUST-3 属聊天可用性），随 M5 首周交付。

### 如果不允许，阻塞原因是什么？

非硬阻塞（三项均不推翻任何架构决策，无 schema 破坏性变更）。

### 如果允许，进入 M5 前必须保留哪些技术债？

1. §4.1/4.2（usage 完整性：失败回合 + 媒体任务 run 关联）——M5 做统计报表时必然要补，建议 M5 内完成；
2. §4.3（core/tools 分层）——M5 新增后台模块前定案，避免继续加深反向依赖；
3. §4.4（version 语义）——M5 后台 Agent 编辑时赋予；
4. M6 前：ToolCall 幂等键在异步 run 场景下的并发语义需以 §2 评估结论为准（当前防御性正确，M6 引入重试时补并发测试）。

---

*审计基线：`060e9b1`→`0ff2670`（M4 全部提交）+ 执行记录提交；205 测试全绿。本报告未提交 git。*
