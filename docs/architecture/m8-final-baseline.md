# M8 Final Baseline（2026-09-25）

> M8（Multi-tenancy / Billing / Observability / Analytics / Events / Extensions / Routing / Security / Reliability）**最终冻结基线**。
> 设计：`docs/architecture/m8-architecture-design.md`（§0~§10）；并行执行实录：`docs/architecture/m8-p3-p7-parallel-development.md`；
> 安全审计：`docs/security/m8-security-audit.md`；运维：`docs/operations/m8-production-readiness.md` / `m8-disaster-recovery.md`。

## 1. M8 已实现能力

| Phase | 能力 | Commit | 测试 |
|---|---|---|---|
| P1 | Multi-tenancy / Organization / RBAC（backfill 个人组织 + RBAC 14 权限位 + 跨组织 404） | f706689 | 单测 12 + e2e 7 |
| P2 | Billing / Subscription / Quota（ledger 复用 UsageRecord 归因 + 配额三态 429 + mock 计费） | 9f1c9da | 单测 11 + e2e 5 |
| P3 | Observability / Audit（TraceContext 全链路 + MetricSample 采样 + AuditLog 增强 6 字段 + 强制脱敏 + login 审计） | d685fc0 | 单测 22 + e2e 6 |
| P4 | Analytics / BI（5 维度确定性投影幂等刷新 + overview/breakdown/sources） | 23a0801 | 单测 15 + e2e 6 |
| P5 | Scheduler / Event Platform（ScheduledJob 全状态机 + EventEnvelope 幂等-重试-死信） | 9c8092b | 单测 21 + e2e 7 |
| P6 | Extension SDK（声明式 manifest + 签名 + 版本锁定 + 物化执行，绝不执行任意代码） | 94b1e6c | 单测 30 + e2e 7 |
| P7 | Intelligent Provider Routing（能力/策略/成本/健康/熔断 → 决策审计 + fallback 链） | 7659243 | 单测 35 + e2e 9 |
| P8 | Enterprise Security（19 项真实缺口修复含 3 项可利用 + 安全 E2E 29） | 87041f1 | 单测 154 + e2e 29 |
| P9 | Reliability / DR（/live /ready /health + graceful shutdown + 背压 + 2 真实 bug 修复 + DR drill） | 0e89638 | 单测 40 + e2e 23 |

## 2. 最终全量验证（2026-09-25，fresh 两轮）

- **Tests**：api **110 文件 / 899 测试全绿**（两轮 fresh 复跑一致；含 M0~M7 冻结回归 + M8-P1~P9 全部 E2E + 安全/可靠性 E2E）；
- **Typecheck**：workspace 4/4 零缓存；**Build**：3/3 零缓存；
- **真实基础设施 E2E**：PostgreSQL(pgvector)/Redis/BullMQ（agent-run/workflow/scheduler/image/video/media-cleanup）/Worker——全程真实；
- **数据库**：fresh-DB 迁移重放验证（临时库 prisma migrate deploy 全部成功）；零 `migrate reset`；M0-M7 迁移历史未动；
- **DR drill**：pg_dump→回灌独立容器 schema 指纹全等 + 行数全等；MinIO mirror md5 全 MATCH；生产库只读；
- **Load**：/live 1502 req/s（p99 54.93ms 零错误）；20 并发 agent run 全完成；50 job 队列 32.72 job/s；
- **Git**：工作树干净。

## 3. 关键故障修复（P8/P9 实测发现）

| 故障 | 严重度 | 修复 |
|---|---|---|
| 登出后 access token 在 TTL 内继续有效（会话撤销不覆盖 access） | 可利用 | access token 加 sid + JwtAuthGuard 会话/用户状态校验 |
| 禁用账号旧 token 仍可全量读写 | 可利用 | 全受保护端点用户状态校验（肯定结论缓存） |
| SSRF 守卫 IPv6 方括号/内嵌 IPv4 永不命中 + 无 DNS 层 | 可利用 | 全新 ssrf-guard（完整 IP 分类 + DNS resolver + fail-closed） |
| WorkflowLeaseService.recoverStale 无周期任务接线（生产 workflow 丢 job 无人重投） | 高 | 接线 MediaCleanupProcessor 5min 清扫周期 |
| Redis 健康探针冷启动假 503 | 中 | 专用探针客户端（enableOfflineQueue） |
| P6 extension e2e fixture 用 RFC2606 域名被新 DNS 层拒绝 | 测试 | fixture 改公网字面量（校验未放宽） |

## 4. 技术债 / NOT VERIFIED（如实记录，详见各文档）

- P7 invoke 句柄无生产调用方（接入 chat/media 会触碰冻结模块，留待解冻决策）；
- 多实例会话撤销传播窗口 ≤5s；生产 NODE_ENV 下 Secure cookie 属性；DNS rebinding/TOCTOU；
- Provider 表直配 baseUrl 未接 SSRF；非 workflow 队列 confused-deputy 行为级验证；
- DB/Redis 真宕机 /ready 503（探针注入验证，共享库禁止停服）；多副本/PITR/生产量级 DR 耗时；
- 小时级 soak、K8s SIGKILL 边界、真实 LLM provider 行为、附件 AV/解压炸弹。

## 5. M9 边界（以下全部未实现、未触碰）

模型训练 / Fine-tuning / RL / 模型权重修改 / 无限自治 Agent / Agent 自我复制 / 未经批准的金融交易 / 未经人工授权的高风险批量外部操作 / 不受控第三方代码执行 / 复杂 ERP / 实时流计算平台 / 完整支付生产系统 / Agent Marketplace 公共开放平台。

## 6. 冻结声明

M8 全部代码（P1~P10，commits f706689 → 2cacf06 及之后基线提交）自本基线起冻结；
M0-M7 冻结基线零漂移（P8/P9 的越界修复均有明确记录与回归验证）；未使用 `prisma migrate reset`；
本文件为基线快照。
