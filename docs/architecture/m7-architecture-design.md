# M7 Architecture Design — Approval / Connection / External Action / Commerce / Workflow / Multi-Agent / Feedback / Security

> 状态：随 Phase 增量维护。M7 在 M6（已冻结）之上新增能力；所有新运行时原语（waiting/lease/resume/cancel/retry）**复用 M6 实现**，禁止第二套 Runtime。
> 基线参考：`docs/architecture/m6-final-baseline.md`、`docs/architecture/m6-architecture-design.md`（§29 实施差异）。

## 0. 架构总览与职责边界

```
User ─ Chat ─ Agent ─┬─ Memory（长期上下文）
                     ├─ Knowledge（可检索信息）
                     ├─ Tool（能力；含 external_action / commerce 只读）
                     ├─ Approval（人工授权）─ ExternalAction（副作用执行）─ Connection/Credential（外部账号/密钥）
                     └─ Workflow（确定性编排）─ 步骤=Agent/Tool/Approval/ExternalAction/Condition
Feedback（绩效学习，经 Memory 闭环）
```

| 组件 | 职责 | 禁止 |
|---|---|---|
| Agent | reasoning | 不直连外部 API、不持有密钥 |
| Tool | capability | 不得自定身份/权限 |
| Approval | human authorization | 不执行副作用 |
| ExternalAction | side effect | 不推理；必须幂等键 |
| DataSource(Commerce) | external data（规范化） | 只读（P4 工具集全部 read-only） |
| Connection | external account | — |
| Credential | secret（AES-256-GCM at rest） | 绝不进 LLM/prompt/log/API |
| Workflow | deterministic orchestration | 不替代 Agent 动态推理 |
| Memory/Knowledge/Feedback | 长期/可检索/绩效上下文 | 不修改模型权重 |

**核心不变量（贯穿 P1~P10）**：
1. 所有 Approval/ExternalAction/Workflow 状态迁移 = DB 条件更新（count=0 即竞态输家），唯一赢家语义；
2. Agent 等待机制只有一种：M6 `waiting` 状态（P1 扩展 waitingOnApprovalId；P6 扩展 workflow waiting）；
3. 身份只从 JWT + DB 行继承，Worker 不信任 queue payload（M6 红线延续）；
4. 外部数据（Commerce/Webhook/外部 API 结果）一律 UNTRUSTED，不得成为 system instruction（P9 加固）；
5. 凭证只在 CredentialService 服务端解密，Tool 只拿引用。

## 1. M7-P1 Approval / Human-in-the-loop

### 1.1 数据模型

- `Approval`：id/userId/projectId/agentRunId/toolCallId/status(requested|approved|rejected|expired|cancelled)/riskLevel/reason/payload/expiresAt/approvedAt/rejectedAt/cancelledAt；
- `ToolCallStatus` 增加 `waiting_approval`（M4 预留的审批语义落地）；
- `AgentRun` 增加 `waitingOnApprovalId`（waiting 的第二种等待目标；与 waitingOnTaskId 互斥）。

### 1.2 生命周期与状态机

```
requested ──approve──▶ approved（+approvedAt）
requested ──reject──▶ rejected
requested ──expire──▶ expired（expiresAt 已过；懒检查 + recoverStale 兜底）
requested ──cancel──▶ cancelled（用户撤销 / run 被 cancel 附带清理）
```

- 终态绝不复活：所有 decide = `updateMany({status:'requested', expiresAt 未过})`；
- `approve + expire` 竞态：approve 条件更新含 `OR: [{expiresAt: null}, {expiresAt: {gt: now}}]`，输家判 expired → 409 APPROVAL_EXPIRED；
- `approve + reject + cancel + worker resume` 竞态：只有第一个条件更新 count=1；wake 由 `waiting→queued` 条件更新去重（M6 三重幂等复用）。

### 1.3 与 AgentRuntime 的接线（复用 M6 waiting，零第二套机制）

```
Engine.executeToolCall
 ├─ tool.requiresApproval || tool.permission==='external_action'
 ├─ async run：ToolCall 行(status=waiting_approval) → Approval(requested, toolCallId) → enterWaitingApproval
 │   （running+workerId → waiting + waitingOnApprovalId + 释放 lease，条件更新）
 ├─ resume（M6 'tools' 模式重放 pendingCalls）：
 │   ├─ approved → 同一 ToolCall 行继续执行（waiting_approval→running→completed/failed）
 │   ├─ rejected/expired/cancelled → ToolCall 行 failed(APPROVAL_REJECTED/EXPIRED/CANCELLED) + 结果回喂 LLM
 │   └─ requested（崩溃窗口残留）→ 重新 enterWaitingApproval（幂等收敛）
 └─ sync（chat）路径：维持 M4 冻结行为（直接 TOOL_DENIED，同步路径无 resume 通道）
```

- 用户 decide → 条件更新 Approval → `AgentRunResumeTrigger.wakeWaitingRunByApproval`（waiting+waitingOnApprovalId → queued，deadline 已过 → timeout；jobId 唯一键 `run-{id}-wake-{ts}`）；
- deadline-while-waiting：recoverStale 对 waiting+waitingOnApprovalId 同样执行 deadline 判定（timeout），绝不复活；
- run cancel：waiting + waitingOnApprovalId → 附带 Approval requested→cancelled（best-effort）；
- recoverStale 兜底：waiting+waitingOnApprovalId 且 Approval 已终态（hook 丢失）→ 唤醒；requested 且 expiresAt 已过 → 先 expire 再唤醒。

### 1.4 API（JWT + ownership + 404 防枚举）

```
GET  /approvals?projectId=&status=
GET  /approvals/:id
POST /approvals/:id/approve
POST /approvals/:id/reject
POST /approvals/:id/cancel
```

- 全部 `findFirst({id, userId})` 首条件；decide 是条件更新，409 APPROVAL_NOT_PENDING / APPROVAL_EXPIRED；
- 绑定完整性：approve 前校验 approval.userId 归属（404）；agentRunId/toolCallId 绑定在创建时由服务端写入，客户端不可指定；
- 幂等：重复 approve 第二个 count=0 → 409（不产生第二个 Tool execution——执行权只有 resume 一次，且 ToolCall 行幂等键收敛）。

### 1.5 Timeline / SSE

- Timeline 增加 approval item（id=`approval-{id}`，requested→approved/rejected/expired/cancelled 按 id 幂等演进）；
- waiting_approval 的 ToolCall 不产出 tool.completed（终态才产出）；
- SSE：approval.requested / approval.decided 经 agent-run:{runId} 通道转发。

### 1.6 测试

- 单测：ApprovalService 状态机（4 种 decide × 竞态赢家 × 过期 × 越权）；engine approval gate（async waiting / resume approved / rejected / sync deny）。
- e2e（真实 DB/Redis/Worker）：P1 全链路（waiting → approve → resume → tool 执行 → completed）、reject 回喂、expire 阻断、重复 decide 幂等、越权矩阵。

## 2. M7-P2 Connection / OAuth / Credential

### 2.1 数据模型

- `Connection`：id/userId/projectId?/provider/providerAccountId/scope/status(active|expired|revoked)/expiresAt/revokedAt/lastSyncedAt/metadata；
- `Credential`：id/connectionId/type(access_token|refresh_token)/encryptedValue（AES-256-GCM，复用 CryptoService）/expiresAt/createdAt——**绝不返回明文，绝不经 API/DTO 出网**；
- `OAuthState`：id/userId/projectId?/provider/state(single-use token)/expiresAt/usedAt——single-use、short-lived（10min）、user+project+provider 绑定。

### 2.2 凭证安全（六不原则）

LLM 不可见 / prompt 不包含 / log 不包含（pino redact + 自定义 redact 路径）/ error 不包含 / API Response 不包含（DTO 层无凭证字段）/ DB 加密（e2e 断言密文 ≠ 明文）。
Tool 只拿 `connectionId` 引用；真实凭证由 CredentialService 服务端解密后直接交给 Provider Adapter，不经过 Tool 返回值。

### 2.3 OAuth 生命周期

```
start（建 OAuthState + 返回 authorizeUrl）
→ callback（state 单次消费 + 交换 token + 加密入库）
→ refresh（token 刷新竞态：条件更新 + 单次执行；过期/吊销 → 状态回写）
→ revoke（用户主动吊销；本地标记 + best-effort 远端 revoke）
→ reconnect（revoked/expired 后重新 start，复用同一 providerAccountId）
```

- OAuthState 消费 = 条件更新（usedAt null → now），count=0 即重复 callback → 401/409；
- callback 幂等：同 state 只成功一次；重复 callback 不重复建 Connection。

### 2.4 Provider 抽象与 Mock

- `OAuthProvider` 接口：authorizeUrl/state 生成/exchange/refresh/revoke；实现 `MockOAuthProvider`（完整生命周期、确定性 token、可注入 failure/expiry 向量）+ 预留真实 provider 适配器骨架（无真实凭据时**不伪造成功**）。

### 2.5 API

```
GET  /connections（list；无凭证字段）
GET  /connections/:id（无凭证字段）
POST /connections/:provider/start        → { authorizeUrl }
GET  /connections/:provider/callback    → 302/JSON 完成态
POST /connections/:id/refresh
POST /connections/:id/revoke
DELETE /connections/:id
```
全部 JWT + ownership（404 防枚举）。

### 2.6 测试

- 单测：CredentialService 加解密/密文格式；OAuthState 单次消费/过期；refresh 竞态（并发只执行一次远端调用）。
- e2e：mock provider 全生命周期（start→callback→refresh→revoke→reconnect）、invalid state、expired state、重复 callback、越权矩阵、DB 密文断言。

## 3. M7-P3 External Action Framework

### 3.1 数据模型

- `ExternalAction`：id/userId/projectId?/agentRunId?/toolCallId?/approvalId?/connectionId?/provider/actionType/permission(快照)/riskLevel(快照)/input(Json，绝不含凭证)/status(pending_approval|executing|completed|failed|cancelled)/externalRequestId/result/errorCode/error/idempotencyKey/startedAt/completedAt；
- `UNIQUE(userId, provider, idempotencyKey)`：同一业务键绝不重复执行外部动作；
- `ToolPermission` 扩展 `financial`/`destructive`（向后兼容，原有值语义不变）。

### 3.2 执行链（职责固定，绝不短路）

```
Agent → Tool(external_action.execute) → Engine P1 审批门（waiting → 人工 decide → resume）
     → ExternalActionService.execute：
        ① 审批复核（toolCallId/approvalId → Approval 必须 approved——绝不只信 LLM）
        ② 幂等裁决（completed 复用结果；executing/failed 残留行复用同一 externalRequestId）
        ③ 连接校验（active；revoked/expired → 409）——校验失败不落孤儿行
        ④ 行 pending_approval → executing（approval/connection/externalRequestId 绑定）
        ⑤ Provider Adapter 执行（accessToken 服务端解密注入，绝不落库/回传/进 Tool 结果）
        ⑥ completed/failed/cancelled 终态落库
```

### 3.3 幂等与 exactly-once 边界

- 同一 ToolCall resume 重放 → Engine 幂等键 + ExternalAction 唯一键双重去重；
- 崩溃残留 executing 行 → 复用行 + 同一 externalRequestId 续跑（Provider 侧幂等键）；
- 语义：ExternalAction = at-least-once + Provider 层 requestId 去重（文档化为边界，不做分布式事务）。

### 3.4 Provider Adapter

- `ExternalActionProvider` 接口 + 注册表；`MockExternalActionProvider` 测试向量（success/failure/timeout/retry/duplicate/forbidden + AbortSignal）；
- 真实平台适配器（shopify/amazon/meta/google/tiktok）留接口位，无真实凭据不实现、不伪造。

### 3.5 API

```
GET /external-actions?agentRunId=   （审计读取面，userId 首条件）
GET /external-actions/:id
```

### 3.6 测试

- 单测 9：审批复核/幂等复用/残留行续跑/连接三类失败无孤儿行/失败落库/取消落库/不支持 provider/风险分级。
- e2e 8：全链路审批执行+审计绑定、reject 零副作用、failure/retry/timeout 向量、崩溃残留幂等、连接吊销、越权。
- **实测修复**：MockLLM 启发式只在 role=user 消息触发——tool 结果 JSON 回显触发词（payload.title 含"发布到"）会无限再触发同一工具 → run 永久 waiting。

## 4. M7-P4 E-commerce DataSource + Commerce Tools

### 4.1 规范化电商模型（11 表，全部 read-only）

Product / Order / OrderItem / TrafficMetric / ConversionMetric / Campaign / AdGroup / Ad / AdMetric / InventoryMetric / RevenueMetric。
指标表 = 周期快照 + 维度（dimension/dimensionValue）；`UNIQUE(userId, provider, externalId)` 幂等同步；服务层按 (period, dimension) 幂等更新（不强唯一约束）。

### 4.2 数据管线（LLM 绝不直连外部 API）

```
External API → Provider Adapter → Normalize → CommerceService → Commerce Tool → Agent
```
- `CommerceProvider` 接口 + `MockCommerceAdapter`（读规范化种子数据，明确标注 mock，不伪造第三方数据）；
- 真实平台适配器（Amazon/Shopify/MetaAds/GoogleAds/TikTokAds）留接口位，无真实凭据不注册。

### 4.3 数据真实性分层（LLM 不得编造数据）

- 工具结果严格分层：`facts`（原始聚合事实）/ `derived`（服务端计算：ctr/cvr/roas/cpc/aov/conversionRate/changePct）；
- LLM 解读/建议只出现在对话层（P5 Analysis 承接），绝不进入 facts/derived；
- **重复计数防线**：指标快照的 dimension=all 行与 source 行是父子关系——总量只取 all 行，source 仅用于分布（实测修复：初次实现把 source 子集累加进总量，impressions 翻倍）。

### 4.4 工具（第一批 9 个，permission=read，零写路径）

```
commerce.products.list / products.get
commerce.orders.list / orders.summary
commerce.traffic.summary
commerce.ads.campaigns.list / ads.performance
commerce.analytics.summary / analytics.compare
```
统一参数：timeRange{start,end,days(≤92)}/filters/page/pageSize/sort/groupBy/limit；
连接解析与 P3 同构（显式 connectionId 或默认 active 连接；无连接 → 明确提示）。

### 4.5 测试

- 单测 8：时间窗校验/连接解析/facts-derived 分层/aov-roas-ctr 计算/两期变化率零基数不伪造/来源分布不重复计数。
- e2e 7：6 个工具经真实 Agent 链路断言 facts/derived 数值；只读保证（数据零变更）；无连接失败回喂。
