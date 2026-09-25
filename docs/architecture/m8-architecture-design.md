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

## 2. M8-P2 Billing / Subscription / Quota

（施工时补全）

## 3. M8-P3 Observability / Audit

（施工时补全）

## 4. M8-P4 Analytics / BI

（施工时补全）

## 5. M8-P5 Scheduler / Event Platform

（施工时补全）

## 6. M8-P6 Extension SDK / Marketplace Foundation

（施工时补全）

## 7. M8-P7 Intelligent Provider Routing

（施工时补全）

## 8. M8-P8 Enterprise Security

（施工时补全）

## 9. M8-P9 Reliability / Disaster Recovery

（施工时补全）

## 10. M8-P10 Final Hardening / Release

（施工时补全）
