# M11 Implementation Plan（2026-09-28）

> 唯一基线：M10 Final Baseline（HEAD `2a907d6`，226 文件/2220 测试三轮全绿、37 迁移）。
> 本计划由四维并行审计合成（Deferred 25 项逐项核实 + 代码增量 19 项 + NOT VERIFIED/生产就绪 36 项 + 全景快照 v2），去重收敛为 17 Phase / 16 并行 Agent + 1 个集成后任务。
> 审计关键结论：① M10 基线 Deferred 清单可信但**不是未闭环全集**——18/20 审计 MEDIUM/LOW 未登记（UTC 日界、4 处无界载入、media 预检计费为活跃缺陷）；② 3 处"半成品空转"（DEVICE_REVOKED 无抛出点、rewrap 无调用方、keyVersion 恒 1）必须收口；③ 架构 v1 剩余 5 项仅有延期记录无产品裁决——M11 显式登记裁决状态。

## 1. M11 总目标

**M10 未闭环项收口 + 生产就绪残余闭环**，不引入新架构、不新增基础设施：

- 收口 3 处半成品空转（设备下线、密钥轮换落地、市场治理位）
- 修复审计未登记活跃缺陷（UTC 日界、对账历史月失真、预检计费、CAS lost-update、订阅泄漏、无界载入）
- 闭环本地可验证的生产就绪项（浏览器验证、PITR、备份加密、HNSW 规模交叉点、真宕机 /ready、k8s 清单/Dockerfile、小时级 soak）
- 文档/配置错误批量修正（alerts 交叉引用、过期数字、死配置）
- **明确不做**的项登记裁决状态（§13）

## 2. 全部工作项（17 Phase）

| Phase | 内容 | 来源 | schema |
|---|---|---|---|
| **P1** 密钥轮换收尾 | credentials 写路径落 keyVersion；rewrap 脚本（游标批量+事务+审计）；CREDENTIAL_REWRAP_REQUIRED 接线 | D1-09/NV-11 | — |
| **P2** 会话治理补全 | Session.deviceId 写入点 + 会话管理端点（list/按设备下线）+ DEVICE_REVOKED 接线（现空转）；token 轮换端点；jti ZSET zremrangebyscore 清理；jtiOkCache 容量上限 | D1-01/D1-10/D1-11 | S1 |
| **P3** 计费正确性 | ledger-only kind 对账独立段（补齐基线 §4 对外声称）；ledger 侧无界查询+历史月上界修复（结论失真）；UTC 日界统一（本地午夜→UTC）；storageMb/seats 死配置摘除 | D1-08/D2-15/维度2#13/#14 | — |
| **P4** Runtime 计费口径 | watchdog 超时回合至少写一条"已占用 provider"ledger 行（绝不漏计）；media 预检失败（未触达 provider）不虚计 1 单位；路由延迟聚合 30-60s TTL 缓存；可选凭据门控真实厂商 e2e（有 key 才跑/无 key 显式 skip） | D1-05/D1-06 保守子集/维度2#8/#12/NV-01 | — |
| **P5** CreativeLoop 正确性 | 状态 CAS 加 version 谓词（lost update 修复）；存量回填分页+批量 createMany+失败退避（请求路径去 N+1） | D2-01/D2-02 | — |
| **P6** Workflow 订阅治理 | unregisterEvent 真解绑（空 Set 删 Map 键+unsubscribe）；workflow-wake watchChildRun 订阅回收（对称 D2-04） | D2-03/D2-04 | — |
| **P7** 无界载入治理 | recoverStale/media-cleanup/scheduler.processor/workflow-lease 4 处分页（照抄 external-actions take 范式）；agent-run timeline 子行 take 上限；delegation 幂等重入重建订阅 | D2-11/12/13/14/维度2#4/#19 | — |
| **P8** MetricSample 保留策略 + 归档活性 | MetricSample 周期删除（保留天数 env，默认 30d）；event-archive 归档计数指标 + 0 行时日志 + 开通失败重试 | D1-07/D2-18/维度2#10 | — |
| **P9** 运维脚本收尾 | backup gzip 静态加密（gpg）；backup --upload 真实桶 e2e；expect-tables 73→88（+pg.ts 注释）；restore 三处解压共用 helper | D1-13/NV-25/D2-19 | — |
| **P10** 生产就绪配置收尾 | alerts.yml 6 处 §4→§7.2+错引 §3.3→§5+补 Provider 故障行+行名对齐；configmap APP_URL 删除/SCHEDULER_SHUTDOWN_WAIT_MS 8000；secret.example 补 SEED_ADMIN_PASSWORD 说明；worker.ts 生产守卫接线（E-08）；runbook pgcrypto 生产角色说明+键空间补 ratelimit:webhook:global+迁移数 33→37 | E-01..E-08 | — |
| **P11** 存储可靠性 | S3Client NodeHttpHandler 超时；attachments/media 调用点 withDeadline | D1-12/NV-13 | — |
| **P12** Marketplace 专用治理位 | `marketplace.moderate` 权限位（M10-P6 预留钩子唯一改动点）；矩阵与测试锁定 | D1-02 | — |
| **P13** Playwright 浏览器验证 | @playwright/test + channel:chrome（本机已装，零下载）；覆盖 7 个 jsdom-only 组件面 + chat SSE 真流式 + CORS/CSRF 浏览器行为 + run-timeline/task-card | NV-03/NV-35 | — |
| **P14** HNSW 交叉点实验 + DNS 投毒 | scratch 库 10^5~10^6 行 × random_page_cost 扫描找交叉点；结论驱动的检索路径事务+ef_search；翻转解析器真实投毒 spec（pinned 断言） | NV-10/NV-05 | — |
| **P15** PITR 演练 | 一次性 PG 容器（archive_mode=on）→ pg_basebackup → 造 WAL → recovery_target_time 恢复 → 四层校验；新脚本+新文档（不碰共享 dev 容器） | NV-06 | — |
| **P16** Dockerfile + k8s 实机验证尝试 | docker/Dockerfile.api+web（修正 dist/src/main.js 口径）；构建验证；Docker Desktop k8s/kind 实机（可用则验证 probes/滚动/SSE；环境不可用则 NOT VERIFIED 如实登记） | E-06/NV-22/NV-23 | — |
| **P17** 小时级 soak（集成后） | SOAK_MS=7200000（2h）长跑 + RSS/队列/活跃 run 曲线——把 M10"+20MB 慢漂"变成收敛结论 | NV-09 | — |

## 3. Dependency DAG

```
W0 Coordinator：schema 预整合（S1 Session.deviceId + S2 CHECK 约束）──┐
                                                       ↓
Wave 1（16 个并行 worktree，无相互真实依赖）：
  P1  P2  P3  P4  P5  P6  P7  P8  P9  P10  P11  P12  P13  P14  P15  P16
                                                       ↓
Wave 2（仅真实依赖）：P17 小时级 soak（环境独占，集成回归后）
                                                       ↓
Integration：按完成序 merge → fresh+现有 DB 迁移验证 → 连续两轮全量回归
                                                       ↓
Final Audit（七维 + M11 scope creep 检查）→ 自动修复 → 回归 → 冻结
```

## 4. 可立即并行（Wave 1 = P1~P16，唯一共同上游是 W0）

## 5. 存在真实依赖、必须等待

- **P17** 依赖集成完成且无并行 agent（环境独占）
- 每个 Phase 内部：schema 先行（W0）→ 业务代码 → 测试

## 6. Worktree / Agent 分配

| Agent | Phase | 文件所有权 | Redis DB |
|---|---|---|---|
| A1 | P1 | core/crypto/**、modules/connections/**、scripts/rewrap.ts（新）、相关 spec | /21 |
| A2 | P2 | modules/auth/**、modules/security/**（session-events/access-guard）、新 test/pre-m11-*.e2e-spec.ts | /22 |
| A3 | P3 | modules/billing/**、modules/usage/**、test/pre-m9-billing 相关断言 | /23 |
| A4 | P4 | core/agent-loop/engine（仅 watchdog ledger 行）、modules/generations/**（仅计费路径）、modules/provider-routing/**、新 env-gated spec | /24 |
| A5 | P5 | modules/creative-loop/**（唯一 owner） | /25 |
| A6 | P6 | modules/workflows/**、worker/workflow/**（唯一 owner） | /26 |
| A7 | P7 | worker/agent-run/**、worker/scheduler/**、worker/media-cleanup/**、core/agent-run-lease/**、modules/agent-delegation/**、modules/agent-runs/**（timeline） | /27 |
| A8 | P8 | modules/events/**、modules/scheduler/**、core/tracing/observability.service.ts（仅 retention/归档指标） | /28 |
| A9 | P9 | scripts/**（backup/restore/minio-mirror/lib）、新 e2e/演练记录 | /29 |
| A10 | P10 | monitoring/**、k8s/**、docs/operations/m10-runbook.md、apps/api/src/worker.ts（仅守卫接线一行） | /30 |
| A11 | P11 | core/storage/**、modules/attachments/** | /31 |
| A12 | P12 | modules/marketplace/**、modules/organizations/authorization.service.ts（唯一改权） | /32 |
| A13 | P13 | apps/web/**（e2e 新目录+config+package.json devDep）、相关 spec | /33 |
| A14 | P14 | core/knowledge/**（仅结论驱动改动）、新 test/pre-m11-dns-rebind.e2e-spec.ts、scratch 实验脚本（不入库或入 scripts/lib） | /34 |
| A15 | P15 | scripts/pitr-drill.ts（新）、docs/operations/m11-pitr-drill.md（新） | — |
| A16 | P16 | docker/Dockerfile.api、docker/Dockerfile.web（新文件）、实机验证记录 | /35 |

**单点所有权（R4 fan-in 结论，全 Agent 禁碰）**：prisma.service.ts、common/errors/app-error.ts、auth/jwt-auth.guard.ts、core/queue/queue.module.ts、organizations.module.ts、core/events/event-bus.service.ts、packages/shared/**（W0 预置后只读）、app.module.ts、schema.prisma+migrations（仅 Coordinator）。
**worker.ts 唯一改权 = A10（一行守卫接线）**；engine 唯一改权 = A4；authorization.service 唯一改权 = A12。

## 7. Schema / migration 依赖（Coordinator 单点预整合 W0）

- **S1** Session.deviceId String? + @@index([userId, deviceId])
- **S2** DB 级 CHECK 收窄版（财务/安全后果项）：QuotaReservation.quantity >= 0、UsageLedgerEntry.quantity >= 0、UsageRecord.inputTokens/outputTokens >= 0——手写 raw SQL（Prisma 无 @check），DO $$ 守卫幂等；先查存量脏行（若有则报告不强制）
- 验证：fresh-DB 全链重放 + **diff 后必查 DROP INDEX（M10 第 6 次教训）** + deploy 现有库 + generate + seed

## 8. API contract

- 无新错误码（DEVICE_REVOKED/CREDENTIAL_REWRAP_REQUIRED 已预置）；新端点（P2 会话管理/P12 治理位）沿用既有 zod/RBAC/org 隔离/IDOR 测试纪律
- 跨 Agent 契约：无新固定名通道；P2 的 deviceId 来源（登录时客户端传 header 或字段——P2 自行定夺并在报告登记）

## 9. 安全边界（M0–M10 冻结原则，全文适用）

不得重建 UsageRecord/第二套 Billing Fact；不得扩展 EventEnvelope 平台（P8 只加保留策略的**删除面决策**——EventEnvelope 仍只归档不物理删除，登记）；不得新增第三套 Scheduler；不得重实现 Provider Routing；所有组织级数据有 organizationId 归属；跨租户查询 server-side scope；状态转换条件 CAS（P5 修复后含 version）；外部副作用幂等；新 API 全带鉴权/RBAC/org 隔离/IDOR 测试；敏感数据脱敏；LLM 不得决定 quota/RBAC/approval/provider；不持久化 CoT；不新增基础设施（Dockerfile 属交付物非新基础设施；k8s 实机验证用既有 Docker Desktop）。

## 10. 测试策略

- 每个 Agent：实现+单测+必要 e2e+typecheck+build+安全边界自查+commit（报告格式同 M10）
- e2e 真实基础设施；**并行 worktree 铁律：独立 REDIS_URL DB 号；Pub/Sub 通道实例全局——断言按唯一 id 收敛，禁全局负向断言**（A13 M10 纠正）
- 瞬态断言→持久事实；最终一致轮询；P15/P17 特殊（P15 纯演练文档+脚本实测；P17 长跑）

## 11. Integration 顺序（Coordinator）

1. 每个 worktree：tests/typecheck/build/schema consistency/契约检查
2. 按完成序自动 merge（机械冲突自动解；架构冲突保留双方能力）
3. fresh-DB 全链重放 + 现有 DB deploy + generate + seed
4. Redis 全 DB flush → 连续两轮全量回归（api+web+typecheck+build）
5. P17 小时级 soak
6. Final Audit 七维 + scope creep → 发现即修复 → 回归 → 冻结

## 12. 最终验收矩阵

```
Dependency DAG/Parallel Agents/Git Worktrees/Automatic Merge/Conflict Resolution: PASS
P1~P17: PASS
PostgreSQL/pgvector/Redis/BullMQ/Workers: PASS
Security E2E/Concurrency E2E/Billing/Reliability/Performance: PASS
M0-M10 Regression: PASS
Tests/Typecheck/Build: PASS
Git Working Tree: CLEAN
```
+ 输出格式按规格：`M11 COMPLETE` + `M12 NOT STARTED`。

## 13. M11 明确不做（Deferred/裁决登记，不伪装）

| 项 | 裁决 | 理由 |
|---|---|---|
| LLM 用量裁决口径完整包（评测配额预扣/摘要配额裁决/超时 token 计费政策） | 再延（只做 P4 保守子集） | 产品决策悬空 |
| event 触发器类型（无生产发布端，D2-05） | 再延（文档登记半成品状态） | 接线需重审 G10 冻结；下线需产品裁决 |
| run SSE 端点 web 消费者（D2-06） | 再延（端点保留，外部 API 面） | web 功能开发属产品项 |
| UsageRecord 唯一键（turnIndex） | 再延 | 无重复计费实证；触发条件=出现证据 |
| OCR/PDF 解析 | 再延 | 外部能力依赖；现状"接受不处理"已登记 |
| Thinking 全量策略 | 再延 | 产品决策（模式设计未定） |
| Commerce 真适配器/毛利定价 | 再延 | 供应商账号/产品定价 |
| embedding 快分类器 | 再延 | HNSW 规划器问题未解（P14 是前置） |
| 用户级模型指定/预签名直传 | 再延 | §9 边界需谨慎设计；预签名绕过四道闸不划算 |
| Temporal | 永久不做 | v1 决策+双审计确认 |
| AV 扫描 | 再延 | 外部引擎（ClamAV 可 M12 评估） |
| PITR 生产量级/主从真切换/多可用区 | 再延 | 需生产基建（P15 只做一次性容器演练） |
| 真多机/多副本 | 再延 | 需第二台机器（P16 尝试单机 k8s） |
| 真实厂商端到端 | 再延（P4 只补凭据门控骨架） | 无 API key |
| 孤儿附件清扫器 | 再延 | 需先给 storage 加 list 能力 |
| Vault/KMS 取回 | 再延 | 组织流程不可本机闭环 |
| 备份上传真实桶端到端 | P9 纳入（本机 MinIO 桶） | — |
| EventEnvelope 物理删除 | 不做（仍只归档） | M9 冻结条件 |
