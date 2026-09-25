# M8 Architecture Design — Multi-tenancy / Billing / Observability / Analytics / Events / Extensions / Routing / Security / Reliability

> 状态：随 Phase 增量维护。M8 在 M7（已冻结，73 文件/460 测试）之上新增能力。
> 基线：`docs/architecture/m7-final-baseline.md`。核心原则（§0 职责表）延续。

## 0. 架构原则（M8 强化）

| 职责 | 组件 | 禁止 |
|---|---|---|
| 多租户边界 | Organization + Membership | 查询只依赖客户端 organizationId |
| 计费 | Billing（Plan/Subscription/Quota/Ledger） | LLM 决定是否超额 |
| 计量 | Usage（复用 UsageRecord，不建第二套） | 重复计费/不可追溯 |
| 审计 | Audit（actor/org/before/after/脱敏） | 记录 password/token/credential |
| 分析 | Analytics（聚合/物化视图，不破坏事务库） | LLM 修改事实数据 |
| 事件 | EventEnvelope（幂等/防重放/死信） | 与 M6 Timeline/EventBus 冲突 |
| 扩展 | Extension（manifest/权限/签名） | 执行任意第三方代码（无法 sandbox 时不执行） |
| 路由 | Provider Router（能力/健康/价格/策略/审计决策） | 敏感数据流向禁止的 Provider |
| 安全 | deny-by-default + UNTRUSTED DATA | 外部数据改变 system policy/approval |
| 可靠 | health/readiness/liveness/backpressure | prisma migrate reset |

## 1. M8-P1 Production Multi-tenancy / Organization / RBAC

### 1.1 数据模型

- `Organization`：name/slug(unique)/isPersonal/ownerUserId/deletedAt(soft delete)；
- `OrganizationMember`：UNIQUE(organizationId, userId)，role owner|admin|member|viewer；
- `OrganizationInvitation`：email/role/token(unique)/status(pending|accepted|revoked|expired)/expiresAt；
- 资源归属：Project.organizationId（服务层新建必挂组织；存量 backfill）、Agent.organizationId + scope='organization'、Workflow.organizationId、Connection.organizationId、ExternalAction.organizationId（后续 Phase 扩展）。

### 1.2 兼容策略（旧数据自动兼容）

- 迁移时 backfill：每个存量 user 建 Personal Organization（isPersonal=true，ownerUserId=user，member=owner），存量 projects 挂入；
- 运行期 lazily ensure：登录成功时确保 personal org 存在（幂等 upsert 语义）；
- Project.organizationId 列 nullable（历史数据兜底），服务层创建时必填（默认 = 用户指定组织或 personal org）。

### 1.3 RBAC 矩阵（服务端最终决定；deny-by-default）

| 权限 | owner | admin | member | viewer |
|---|---|---|---|---|
| organization.read | ✓ | ✓ | ✓ | ✓ |
| organization.write（改名/删除/转移） | ✓ | — | — | — |
| member.read | ✓ | ✓ | ✓ | — |
| member.write（邀请/移除/角色） | ✓ | ✓ | — | — |
| project.read | ✓ | ✓ | ✓ | ✓ |
| project.write | ✓ | ✓ | ✓ | — |
| agent.read | ✓ | ✓ | ✓ | ✓ |
| agent.write | ✓ | ✓ | ✓ | — |
| workflow.read | ✓ | ✓ | ✓ | ✓ |
| workflow.write | ✓ | ✓ | ✓ | — |
| connection.read | ✓ | ✓ | ✓ | ✓ |
| connection.write | ✓ | ✓ | ✓ | — |
| billing.read | ✓ | ✓ | ✓ | — |
| billing.write | ✓ | — | — | — |

- `AuthorizationService.authorize(userId, { organizationId, resource, action })` → 403 FORBIDDEN；
- 资源读路径：客户端只传资源 id；服务端从资源行取 organizationId → membership 校验（跨组织 → 404 防枚举）；
- 禁止任何查询只依赖客户端传入 organizationId（M6 红线延续）。

### 1.4 API

```
GET/POST /organizations；GET/PATCH/DELETE /organizations/:id（soft delete）
GET/POST /organizations/:id/members；DELETE /organizations/:id/members/:userId
GET/POST /organizations/:id/invitations；POST /invitations/:token/accept；POST /invitations/:token/revoke
```
邀请：token 单次使用（accept 条件更新 pending+未过期 → accepted + member；重复 409）；懒过期 + 列表过滤。

### 1.5 多租户 E2E

A→A / B→B PASS；A→B / B→A 404（跨组织不可见）——覆盖 project/workflow/connection/agent 核心资源面。

## 2. M8-P2 Billing / Subscription / Quota（✅ 2026-09-25 完成）

### 2.1 数据模型

Plan（code free/pro/team/enterprise + entitlements）/ Subscription（每组织一条，UNIQUE）/ UsageLedgerEntry（append-only + idempotencyKey UNIQUE + period 月度归集 + usageRecordId 关联）/ Invoice / PaymentEvent（provider+eventId UNIQUE 幂等）/ QuotaAlert（预留）。

### 2.2 计量（复用 UsageRecord，绝不建第二套 Agent Usage）

- 计量入口统一 `BillingService.recordUsage`：agent run 终态（driver）→ agent_run + llm_tokens + llm_cost（从 UsageRecord 聚合，幂等键 = `run:{runId}:*`）；媒体任务终态 → image/video（键 = taskId）；external action 完成 → external_api_call（键 = actionId）；workflow run 创建 → workflow_run（键 = runId）；
- 组织归属：项目组织 > 个人组织（organizationFor 兜底）；
- **幂等**：idempotencyKey UNIQUE——崩溃重放/重复触发绝不重复计量（P2002 静默去重）。

### 2.3 配额三态（服务端裁决，LLM 绝不决定是否超额）

- monthly（ledger 当月聚合）/ daily（当日聚合）/ concurrent（org 活跃 run 计数）；
- 裁决点：agent-run 创建、workflow-run 创建、external_action 执行前；超额 → 429 QUOTA_EXCEEDED；
- 计划未定义配额（entitlement 缺失）→ 不限；free 默认宽限额（存量行为零漂移）；
- e2e 用 tiny 计划（月度 2/并发 1）与并发专用计划（月度宽/并发 1）做确定性验证。

### 2.4 订阅/发票/支付（MockBillingProvider，不接真实支付）

- subscribe（billing.write = owner）：upsert 订阅 + 开票 + mock 支付事件；
- PaymentEvent (provider, providerEventId) UNIQUE——重复支付事件幂等返回，绝不重复入账；
- API：GET plans/subscription/usage/invoices + POST subscribe（组织 RBAC：billing.read 成员可读；billing.write 仅 owner）。

### 2.5 实测修复

- 组织 id 含 `personal-{uuid}` 前缀——billing schema 的 organizationId 不能用 `z.string().uuid()`（personal 组织订阅 400）；
- 全量套件历史 run 都归集到 admin 个人组织 ledger——配额 e2e 需先清空该组织 ledger 建立确定性基线；
- mock LLM 环境 tokens=0（引擎不计量 token）——llm_tokens 断言改为条目存在性。

## 3. M8-P3 Observability / Audit（✅ 2026-09-25 完成，并行 Agent）

### 3.1 全链路 TraceContext（AsyncLocalStorage）

- `core/tracing/trace-context.ts`：requestId/traceId/organizationId/userId/projectId/runId/toolCallId/taskId/workflowRunId/provider；`runWithContext` + `current()`；
- HTTP 传播中间件（main.ts 在 init 前注册）：req.id 复用、X-Trace-Id 继承+回写、res.on('finish') 采 request_count/request_latency_ms/error_count；
- Worker：agent-run processor 置 runId、workflow processor 只置 workflowRunId（绝不冒充 agentRunId）；时长采样 agent_run_duration_ms/workflow_duration_ms；queue_depth 60s 周期四队列采样（timer.unref + onModuleDestroy 关探针）；
- 已知限制：HTTP 上下文不含 userId/orgId（不改 JwtAuthGuard）；队列 payload 不跨进程传 traceId（身份红线延续）。

### 3.2 AuditLog 增强

- AuditInput +6 字段：organizationId/actorId/requestId/traceId/result/reason；write() 从 TraceContext 自动注入；agentRunId/toolCallId/workflowRunId 亦从上下文补（显式优先）；
- **强制脱敏**：maskSensitive 递归（子串+大小写不敏感命中 password/token/secret/apiKey/credential/encrypted 等即整棵子树 '***'——宁可多脱）；maskEmail 前缀保留；metadata 落库前必过脱敏；
- login 成功/失败审计（auth.login / auth.login_failed；metadata 只含掩码 email）；未知邮箱失败不伪造归属（结构化 warn）。

### 3.3 Metrics

- MetricSample 表 + ObservabilityService.recordMetric（best-effort）；采样点：HTTP 三类、agent/workflow 时长、队列深度；
- GET /metrics（userId 首条件 + organizationId 过滤经 requireMembership）。

### 3.4 实测修复

- **Nest app.use 必须在 app.init 之前**（init 才注册路由，之后追加的中间件不进请求链）——e2e 用 moduleRef.get(TracingMiddleware).handler 在 init 前注册；
- AuthService 用 @Optional() @Inject(AuditService)（不改既有 auth.service.spec 的 4 参构造）。

## 4. M8-P4 Analytics / BI（✅ 2026-09-25 完成，并行 Agent）

### 4.1 聚合投影（不破坏事务库）

- `AnalyticsAggregate`（UNIQUE(organizationId,userId,kind,period,source)）+ AnalyticsService 确定性投影：
  - kind=usage source=usage_ledger（复用 P2 ledger，绝不建第二套事实）；
  - kind=agent source=agent_run；kind=generation source=generation_task；kind=provider source=usage_record；kind=workflow source=workflow_run；
- 归因：project.organizationId = org 或（个人组织且 userId=owner 且 projectId null）+ 历史 NULL 组织行兜底（与 BillingService.organizationFor 同源）；
- 幂等刷新：findFirst→create/update + P2002 兜底；刷新是稠密写入（无数据为 0）；时长均值存 totals+samples，跨天读路径重算（绝不做平均的平均）；
- provider/generation 维度单行 metrics 内 byProvider（唯一键不含 dimension 的取舍）；
- **facts 只含事实**：metrics 只有原始聚合 + 服务端 derived（overview 的 derived 标注 service-computed），LLM 解读绝不入表。

### 4.2 API（RBAC：requireMembership）

- GET /analytics/overview（先幂等 refresh 后读）/ breakdown（自刷新窗口）/ sources（source 追溯）。

### 4.3 实测修复

- generation/provider 的 run 归因用 7 天回看窗（跨零点 run 的兜底）；e2e 用专用用户+专用个人组织隔离，断言用独立 DB 查询核对而非硬编码总量（防其他套件残留 flaky）；
- worktree 首次 pnpm install 后 packages/shared/dist 缺失需 tsup 重建（合并时 Coordinator 已重建）。

## 5. M8-P5 Scheduler / Event Platform

（施工时补全）

## 6. M8-P6 Extension SDK / Marketplace Foundation（✅ 2026-09-25 完成）

### 6.1 声明式扩展（绝不执行任意代码）

- manifest 是**纯 JSON 数据**（zod strictObject 按 kind 校验：tool / agent / provider / workflow_step）；任何函数、类实例、宿主路径、数据库连接串、密钥字面量（`sk-…`）在解析期一律拒绝（`findNonJsonPath` / `findSecretPath`）；
- **绝不使用 eval / Function / vm / child_process / 动态 import**——扩展的全部能力 = 组合平台既有 tool / Agent / Provider，越权能力无从表达；
- 权限白名单 `tool.execute / agent.run / provider.call / workflow.step / config.read / config.write`，并按 kind 限定能力域（agent 类不得声明 tool.execute）；块内 `permissions` 归一化折叠到顶层（顶层与块内不一致 → 拒绝），checksum 只覆盖归一化后的 manifest（键序无关的稳定序列化）。

### 6.2 版本状态机与签名（draft → published → deprecated → archived，绝不逆向）

- 扩展级与版本级双层状态：`update` 只产出 draft 版本（published 版本行永不被修改）；`publish` = draft → published + HMAC-SHA256 签名（`signChecksum(manifest.checksum, ENCRYPTION_KEY)`），旧 published 版本自动 archived；
- **安装完整性校验**：install 时复算 manifest checksum 并与版本行比对（防篡改）+ timingSafeEqual 验签（防伪造）；`ENCRYPTION_KEY` 缺失 → 拒绝发布（绝不产生无签名发布）；
- **安装版本锁定**：installation 只指向某一版本，后续 publish 绝不使已安装实例漂移；升级必须显式 install 指定 versionId。

### 6.3 物化执行（tool / agent / provider / workflow_step）

- tool：ExtensionsService 注入 ToolRegistry，将「已启用安装 × 扩展 published × 锁定版本 published」的期望集合与已注册集合求差 → 运行期 `register` 包装工具 `ext.<slug>.<name>`（paramConstraints 执行前校验 + 输入原样透传；inputSchema/permission/requiresApproval/retryPolicy 全部继承 baseTool，**权限绝不提升**）；disable/uninstall/deprecate 立即回收；`onModuleInit` 全量 reconcile（重启自愈）；
  - 只允许包装 read/write/generate 类平台工具；destructive / financial / external_action 一律拒绝；baseTool / agent.tools / step.toolName 均不得指向 `ext.*`（**禁止扩展链**）；
- agent：物化为组织私有 Agent（scope=organization、kind=custom）+ 已发布 AgentVersion（systemPrompt 由白名单模板变量渲染，tools = 声明的平台工具子集），复用既有 Agent 运行时（AgentRun 锁定 AgentVersion）；
- provider：物化 Provider（adapter 仅 `openai-compatible`）+ Model 行；**apiKey 只能由安装时组织 config 提供**并 AES-256-GCM 加密落库（manifest 绝不携带）；baseUrl 强制 https 公网（拒绝 userinfo / localhost / 私网 / 链路本地 → 防 SSRF）；installation.config 落库前键名脱敏；
- workflow_step：仅登记可查询的步骤模板（`GET /extensions/steps`），本 Phase 不改执行器。

### 6.4 多租户与生命周期

- 可见性：平台级（organizationId=null）+ 本组织私有；跨组织访问一律 404（防枚举）；管理语义 = 组织 `agent.write`（平台级扩展需平台管理员），marketplace 目录 = `organization.read`；
- 安装/卸载/启停 = `agent.write`；非组织成员安装 → 403；
- **卸载标记而非删除**物化资源（Agent/Provider enabled=false、Model 禁用）：AgentRun / GenerationTask 有 FK 引用，保留审计与血缘；
- Provider 表无 organization 列（平台级资源）→ 以确定性命名 `[ext:<slug>:<orgHash>]` 隔离各组织安装实例（已知限制：命名隔离而非行级隔离）。

### 6.5 实测修复（诚实记录）

- **Nest 管道位置**：`@UsePipes(ZodValidationPipe)` 是方法级管道，会一并校验 `@Param('id')` 字符串 → 所有带 `:id` 的子路由恒定 400；改为参数级 `@Body(new ZodValidationPipe(Schema))`（与 organizations.controller 约定一致）。单测（直调 service）无法暴露此类缺陷，e2e 拦下；
- **enable 复用密钥**：provider 类扩展重新启用时不会再索取明文 apiKey，改为复用已加密落库的密文（否则启用即 400）；
- **组织私有 Agent 无法创建 run**：既有创建路径硬编码 `scope='system'` → agent-runs.service 的 Agent 解析改为「系统 Agent 或本人所属组织的私有 Agent」（越权/跨组织返回 404），系统 Agent 行为零漂移；


## 7. M8-P7 Intelligent Provider Routing（✅ 2026-09-25 完成，并行 Agent）

### 7.1 路由管道（服务端 deterministic；LLM 只表达能力需求）

```
候选收集（Provider.type 收窄 + ProviderCapability ∪ Model.capabilities 兜底）
→ 模型选优 + 成本估算（token ÷1e6 × 价格；budget 可覆盖；非法值回退默认）
→ disabled → policy_deny → costCeilingPerRequest → unhealthy → 熔断 open 逐级剔除
→ 排序（allow 优先组 → policy.priority → provider.priority → 成本 → providerId 确定性兜底）
→ 写 RoutingDecision（candidates 含拒绝原因 / reasonCode / estimatedCost / policyId）
→ 返回 invoke 句柄（首选失败自动切下一候选，最多 2 次 fallback；回退成功改写决策行 reasonCode=fallback）
```

- 无可用候选：先落审计（providerId=null）再抛 PROVIDER_UNAVAILABLE（503）；
- 熔断只剔除 open（half_open 作探测放行）；阈值/冷却读 Provider.retryConfig（缺省 5/60）；
- **未暴露 route 端点**：客户端无法指定 provider——选择权 100% 服务端。

### 7.2 策略/能力

- ProviderPolicy（组织级：allow/deny、priority、costCeilingPerRequest/Monthly、dataPolicy）；写 = member.write 及以上、读 = organization.read；平台级策略（org=null）仅 admin；
- ProviderCapability.syncFromProviders()：从真实 Provider/Model 派生（与 route 匹配规则同源），幂等 upsert + 失效清理。

### 7.3 审计

- GET /routing/decisions?runId=&organizationId=（org 收窄；平台级无组织决策不返回——防越权）。

### 7.4 遗留（如实记录）

- invoke 句柄尚无生产调用方（接入 chat/media/agent 会触碰冻结模块，超出 P7 边界）——P7 交付路由决策层 + 审计；接入点留待 M8 后续或显式解冻决策。

## 8. M8-P8 Enterprise Security（✅ 2026-09-25 完成，并行 Agent）

- 完整审计见 `docs/security/m8-security-audit.md`（11 节 + 19 项真实缺口 + NOT VERIFIED 清单）；
- **修复 3 项可利用缺口**：① 登出只撤 refresh、access token 在 TTL 内继续有效 → access token 加 sid 会话标识 + JwtAuthGuard 校验会话未撤销/用户 active（只缓存肯定结论）；② 禁用账号旧 token 仍可读写 → 全端点用户状态校验；③ SSRF 守卫对 IPv6 方括号形式/内嵌 IPv4 永不命中且无 DNS 层 → 全新 `modules/security/ssrf-guard.ts`（协议 allowlist + 完整 IP 分类 + IPv6 展开 + 可注入 DNS resolver + fail-closed），接入扩展 provider 物化；
- 上传加固（服务端权威大小/MIME 白名单/文件名 sanitize/魔术字节嗅探）、webhook 加固（统一错误文案/载荷复杂度+体积二次校验）、API 加固（显式 body limit 413 映射/CORS 解析策略）；
- 安全 E2E 29 项（真实基础设施）；M0-M7 认证行为零漂移。

## 9. M8-P9 Reliability / Disaster Recovery（✅ 2026-09-25 完成，并行 Agent）

- 详见 `docs/operations/m8-production-readiness.md` 与 `docs/operations/m8-disaster-recovery.md`；
- **修复 2 个真实 bug**：① WorkflowLeaseService.recoverStale 只有测试直调、无周期任务接线（生产里 workflow 丢 job 无人重投/worker 崩溃永久 running/超时无人判）→ 接线进 MediaCleanupProcessor 5min 清扫周期；② Redis 健康探针 enableOfflineQueue=false 导致冷启动首个 ping 假 503 → 专用探针客户端；
- /live（进程存活恒定 200）/ /ready（DB+Redis 分级探测，非关键依赖不整体 503）/ /health（兼容扩展明细）；
- graceful shutdown（SIGTERM/SIGINT → app.close → worker 等当前 job → 30s 兜底强制退出）；
- 背压：全局 agent-run 队列深度水位 429（与 per-org 并发配额互补；fail-open 绝不误拒）；
- scheduler processor stalled 判定（running 心跳 + 超时归 failed，一致性优先）；
- **真实 load 数字**：/live 50 并发×200 请求 p50 27.65ms / p95 52.32ms / p99 54.93ms / 0 错误 / 1502 req/s；20 并发 agent run 全部完成（端到端 p50 529ms）；50 job 队列 32.72 job/s；
- **真实 DR drill**：pg_dump 5.3MB（0.72s）→ 回灌独立临时容器（schema 指纹全等 73 表/862 列/238 索引 + 逐表行数全等）→ 清理；MinIO mc mirror 往返 md5 全 MATCH；生产库全程只读。

## 10. M8-P10 Final Hardening / Release（✅ 2026-09-25 完成，串行）

- 全量 fresh 回归两轮：api **110 文件 / 899 测试全绿**（含 M0-M7 + M8-P1~P9 全部 E2E）；
- workspace typecheck 4/4、build 3/3（零缓存）；
- fresh-DB migration 重放验证：临时数据库（预装 pgvector）`prisma migrate deploy` 全部迁移成功（生产库零触碰）；
- 基础设施真实健康（PostgreSQL/pgvector/Redis/BullMQ/Worker/MinIO）；
- 工作树干净；基线：`docs/architecture/m8-final-baseline.md`。
