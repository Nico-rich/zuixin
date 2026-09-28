# M10 Implementation Plan（2026-09-28）

> 唯一基线：M9 Final Baseline（HEAD `1d7673e`，180 文件/1614 测试两轮全绿）。
> 本计划由四维并行审计合成（M9/Pre-M9 八份文档 66 项 + 代码遗留扫描 33 项 + M8 运维/安全残余 55 项 + 实现全景快照），去重收敛为 17 个 Phase / 14 个并行 Agent + 3 个 Wave 2 任务。
> **本文件只确定执行计划；开发按 DAG 最大化并行，不人为串行。**

---

## 1. M10 总目标

**欠债闭环 + 明确延期项兑现**，不引入新架构、不新增基础设施：

- 闭环 M9 基线 §5 全部 NOT VERIFIED 中**本地可诚实验证**的项（真实 provider HTTP 层、真多进程、浏览器、NODE_ENV、DNS rebinding、补偿链断言）
- 闭环 M9 基线声明的 3 项已知降级（definitionSnapshot、marketplace moderation 语义借用、CreativeLoop 三表缺失——审计发现后者是唯一架构级欠债）
- 闭环 M8 安全/运维审计中**代码或本地脚本可闭环**的 open 项（生产密钥守卫、附件安全、限流、会话治理、密钥轮换、S3 驱动 e2e、备份脚本入仓、confused-deputy 行为级验证、IDOR 全端点枚举）
- 闭环跨里程碑可靠性与性能小修（X-01~X-06、游标分页、EventEnvelope 归档、paused 背压口径、EXPLAIN 索引审计）
- **明确不做**的项如实记录 Deferred（见 §13）

## 2. 全部工作项（17 Phase）

| Phase | 内容 | 来源 | schema |
|---|---|---|---|
| **P1** 生产安全守卫与密钥治理 | NODE_ENV=production 下 JWT_SECRET/ENCRYPTION_KEY 默认值 fail-fast；mock adapter/SEED 默认口令/MOCK_DELAY_MS 生产禁用；mock* SSRF 白名单收紧为精确枚举；audit 写失败 warn；memory-extractor 非法 JSON warn；helmet 逐项审计固化；会话撤销 Redis pub/sub 跨实例传播 + 会话并发上限/按设备下线/token 轮换黑名单；DNS rebinding 连接固定（socket pin）；ENCRYPTION_KEY 版本化 + rewrap 工具 | D2/D8/D13/D23/D24/D30/PR-8/SA-24/SA-1/X-10/SA-4/X-20/M9-07/SA-13/SA-12 | S9 Credential.keyVersion |
| **P2** Provider HTTP Contract 验证层 | 本地脚本化 OpenAI-compatible HTTP 假服务器（真实 HTTP/fetch/流式/错误/超时，非 mock adapter）；e2e 让 openai-compatible adapter 全链路（流式、四层超时、重试退避、usage 块、SSRF 逐跳校验、manualRedirectFetch）走真实网络；provider 启动配置校验告警（buildAdapter 失败标记 degraded 而非静默跳过）；queryRemoteStatus 契约补全 | D3/M9-03/M9-14/G5/G6/X-28/D12/D18 | — |
| **P3** 消息编辑/删除端点 + 游标分页 | chat PATCH/DELETE 端点（仅本人消息、org 隔离、IDOR 测试）；接线 summary-refiner stale 自愈链（detectStale/recomputeStale 生产调用方）；conversations/messages 游标分页替代 take 固定值 | D5/D6/M9-08/ARCH-11 | S4 Message.editedAt |
| **P4** CreativeLoop 专表 | CreativeHypothesis/CreativeInsight 两表（organizationId 直列 + 版本列 + DB CHECK/FK；loop 执行记录由既有 WorkflowRun 承载，不建冗余表）；store 层从 Artifact JSONB 容器迁移；存量数据回填；P5 补偿链 e2e 补真实触发断言 | D1/M9-21/D14/M9-09 | S1 |
| **P5** Workflow 快照与调度补强 | WorkflowRun.definitionSnapshot 列 + run 创建快照 + 执行器读快照（替代 version 行只读降级）；schedule repeatable 更新 cron 时重新注册；webhook 速率上限 + secret 轮换（双 secret）+ 429 e2e 断言 | D4/M9-01/X-06/SA-16/SA-17/SA-18 | S2 |
| **P6** Marketplace Moderation 显式权限 | moderation 判定显式化（专用判定函数 + 测试锁定权限矩阵变更不得静默放宽治理权） | D7/M9-02 | — |
| **P7** 附件内容安全 + S3 驱动 e2e | zip 解压炸弹防护（解压前后体积比校验）；EXIF 元数据清洗；每用户附件配额（C1 预留，quota kind `attachment_upload` 已由 W0 预置）；attachments e2e 用 STORAGE_DRIVER=s3 指向真实 MinIO 跑全量 | SA-19/X-18/SA-20 | W0 预置 quota kind |
| **P8** 全局 per-IP 限流 | RateLimitGuard 全局挂载 + per-IP 维度（登录失败计数之外的面）；app.module 唯一改动权归本 Phase | SA-25 | — |
| **P9** 运维脚本与 Runbook | scripts/backup.ts、scripts/restore.ts、MinIO mirror 脚本、.env（含 ENCRYPTION_KEY）备份清单、季度演练 runbook、k8s manifests（terminationGracePeriodSeconds≥35）、Prometheus 告警规则模板（/ready 503、queue depth、scheduler dead、phase timeout） | DR-13/PR-6/PR-7/PR-10/DR-6 | — |
| **P10** Runtime 可靠性补强 + 事件归档 | AgentRunProcessor active 单值→集合（cancel/shutdown 作用于全部 in-flight）；LLM 单回合 watchdog（agentRunLlmTurnMs）；tool.retryPolicy 默认消费瞬态码；委派 child-run 观察订阅随唤醒清理；quota 背压口径计入 paused；EventEnvelope 归档消费者（scheduler 周期任务，published→consumed） | X-01/X-02/X-04/X-05/X-27/PR-3/M9-11 | — |
| **P11** Memory 去重与标注 | MemoryCandidate UNIQUE 去重约束（先清重再建）；摘要降级文本标记为低优先级不进正常上下文排序；lastUsedAt 参与排序；陈旧注释修复 | X-29/D29/D15/D17 | S3 |
| **P12** 测试补强（confused-deputy/多进程/NODE_ENV） | image/video/agent-run/scheduler/media-cleanup 5 队列 confused-deputy 行为级 e2e（job payload 越权篡改重放被拒）；真多进程 e2e（child_process spawn 独立 API×2 + Worker×2 进程，非 in-process）；NODE_ENV=production 下 Secure cookie 断言 | SA-9/X-11/M9-04/PR-2/M9-06/SA-3 | — |
| **P13** Web 前端修复 + TaskCard SSE | lib/sse.ts CRLF 分帧；lib/api.ts 401 守卫死条件；run-timeline waiting/approval 图标；TaskCard 接入 task 通道 SSE（api 侧 sse-registry 订阅 Redis task 通道转发；SSE 降级信号 degraded 标记） | M9-17/M9-18/M9-20/ARCH-07/D10/D11 | — |
| **P14** Extension 白名单 + 组织禁用 | ExtensionOrgAllowlist 表 + resolveEffectiveAgentTools 贯通；Organization.status 禁用态 + 全入口守卫（登录/访问/创建）+ e2e | D16/X-21 | S6/S7 |
| **P15** 全端点 IDOR 枚举矩阵（Wave 2） | 系统化 IDOR/RBAC 测试矩阵覆盖全部控制器端点（组织/角色/跨租户维度）；发现即修 | SA-5/X-17 | — |
| **P16** EXPLAIN 索引审计（Wave 2） | 关键查询 EXPLAIN 审计 → 缺索引报告；索引变更由 Coordinator 以幂等迁移应用 | M9-22 | 报告→Coordinator |
| **P17** 压测/Soak 基线（Wave 2/集成后） | load-test 基线记录（诚实口径）；30min soak + 内存观测 | M9-23/PR-5/PR-12 | — |

## 3. Dependency DAG

```
W0 Coordinator：schema+contract 预整合（S1~S9 + shared 错误码/事件预置）──┐
                                                        │
Wave 1（全部并行，各自 worktree）                          ↓
  ┌────┬────┬────┬────┬────┬────┬────┬────┬────┬────┬────┬────┬────┬────┐
  P1   P2   P3   P4   P5   P6   P7   P8   P9  P10  P11  P12  P13  P14
  └────┴────┴────┴────┴────┴────┴────┴────┴────┴────┴────┴────┴────┴────┘
                                     │
Wave 2（仅真实依赖）                   ↓
  P15（依赖 P1~P14 端点终态，避免与全部 owner 冲突）
  P16（依赖全量 schema/索引稳定）
                                     │
Wave 3 Integration（Coordinator）     ↓
  按 DAG 自动 merge → 冲突机械自动解/架构冲突保留双方能力 → fresh+现有 DB 迁移验证
  → 全量回归 → P17 压测/soak
                                     ↓
Final Audit（七维） → 自动修复循环 → 最终验收
```

## 4. 可立即并行（Wave 1 = P1~P14，无相互真实依赖）

唯一共同上游是 W0（schema+contract）。P2/P6/P8/P9/P12 无 schema 变更，但依赖 shared 错误码/事件预置，故统一从 W0 HEAD 分支。

## 5. 存在真实依赖、必须等待

- **P15** 依赖各模块端点实现终态（其发现可能触发各 owner 修复；Wave 2 避免与 14 个 owner 冲突）
- **P16** 依赖全量表/索引稳定（审计后索引由 Coordinator 追加迁移，不能在 14 个 worktree 浮动时做）
- **P17** 依赖集成完成（压测/soak 在合并后环境跑）
- 每个 Phase 内部：schema 先行（W0 已解决）→ 业务代码 → 测试

## 6. Worktree / Agent 分配

| Agent | Phase | Worktree 文件所有权 | Redis DB（e2e 隔离铁律） |
|---|---|---|---|
| A1 | P1 | auth/、security/（**含 AccessGuard**：jti 黑名单/跨实例缓存失效/登录路径 org.status 检查）、audit/、core/crypto/、main.ts、seed.ts、.env.example、新 session 逻辑 | /21 |
| A2 | P2 | providers/**、core/tracing/observability.service.ts（仅 provider-degraded 计数）、scripts/fake-openai-server/、新 test/pre-m10-provider-contract.e2e-spec.ts | /22 |
| A3 | P3 | modules/chat/、modules/conversations/ | /23 |
| A4 | P4 | modules/creative-loop/、test/m9-p5-creative-loop.e2e-spec.ts | /24 |
| A5 | P5 | modules/workflows/（唯一 owner）、test/m9-p4-workflow.e2e-spec.ts、webhook e2e | /25 |
| A6 | P6 | modules/marketplace/ | /26 |
| A7 | P7 | modules/attachments/、core/storage/、新 S3 e2e | /27 |
| A8 | P8 | core/rate-limit/、app.module.ts（唯一改权） | /28 |
| A9 | P9 | scripts/、docs/operations/、k8s/、monitoring/（纯新文件） | — |
| A10 | P10 | worker/agent-run/、core/agent-loop/engine、modules/agent-delegation/、modules/billing/quota.service.ts、modules/events/、modules/scheduler/ | /29 |
| A11 | P11 | core/memory/、core/context/（降级摘要处理+types.ts 注释修复） | /30 |
| A12 | P12 | test/ 新文件（pre-m10-confused-deputy、pre-m10-multiprocess、pre-m10-production-cookie） | /31 |
| A13 | P13 | apps/web/**、core/sse/、core/events/event-bus.service.ts（降级信号）、modules/agent-runs/agent-runs.controller.ts（SSE 降级信号） | /32 |
| A14 | P14 | modules/extensions/、modules/organizations/、common/guards/org-status.guard.ts（**新文件**；全局挂载由集成阶段统一） | /33 |

**热点文件纪律**（R4 快照结论）：`schema.prisma`=W0 独占；`queue.module.ts`/`worker.module.ts`=本 M10 不新增队列、全不碰；`app.module.ts`=A8 唯一；`shared/errors.ts`、`shared/events.ts`=W0 预置后只读；`health.service.ts`=不碰。workflows 模块 18 文件由 A5 独享（P5 内部两项合并避免同模块并行冲突）。主工作树仅 Coordinator 操作 merge，Agent 永不直接写主树。

## 7. Schema / migration 依赖

Coordinator 单点预整合（W0，一个 commit，含全部 M10 schema）：

- **S1** CreativeHypothesis/CreativeInsight 两表（org 归属、版本列、DB CHECK；loop 引用留 hypothesis.loop JSON，执行记录由 WorkflowRun 承载——不建冗余表）
- **S2** WorkflowRun.definitionSnapshot JSONB（可空，存量 run 保持读 version 行兜底）
- **S3** MemoryCandidate 去重 UNIQUE（先清重数据再建约束；幂等迁移模式）
- **S4** Message.editedAt
- **S6** ExtensionOrgAllowlist
- **S7** Organization.status（active/disabled）
- **S9** Credential.keyVersion
- 若 P7 附件配额需 quota kind 枚举迁移，一并纳入

验证：fresh-DB 32+N 迁移全链重放 + **create-only 后必查 DROP INDEX（Prisma HNSW 孤儿判定，第三次出现）** + deploy 到现有 dev DB + prisma generate + seed。历史迁移绝不改写。

## 8. API contract

- W0 在 shared 预置 M10 全部新错误码/事件（一次加齐，Wave 内只读）：
  errors：`ORG_DISABLED`、`SESSION_CONCURRENCY_EXCEEDED`、`DEVICE_REVOKED`、`WEBHOOK_SECRET_ROTATION_REQUIRED`、`ATTACHMENT_UNZIP_REJECTED`、`ATTACHMENT_QUOTA_EXCEEDED`、`CREDENTIAL_REWRAP_REQUIRED`、`KEY_VERSION_INVALID`、`MESSAGE_EDIT_FORBIDDEN`、`MESSAGE_DELETE_FORBIDDEN`、`PROVIDER_CONFIG_INVALID` 等（P 期定稿）
- 新端点必须：zod 校验、JWT 守卫、RBAC、org 隔离、IDOR 测试（既有纪律）
- Web 契约：P13 的 SSE 分帧/事件沿用 shared/events.ts 现有 schema，不新造
- **跨 Agent 契约（A1↔A12）**：会话撤销跨实例传播用 Redis pub/sub channel **`session-events`**（A1 发布、A12 多进程 e2e 断言复用同一通道名）；org.status 登录检查在 A1（AccessGuard/auth 路径），资源守卫在 A14（新文件 OrgStatusGuard），全局挂载由集成阶段统一

## 9. 安全边界（M0–M9 冻结原则，全文适用）

不得重建 UsageRecord/第二套 Billing Fact；不得扩展 EventEnvelope 平台（P10 只加消费者）；不得新增第三套 Scheduler；不得重实现 Provider Routing；不为修问题大规模重构；所有组织级数据有 organizationId 归属或可靠归属链；跨租户查询 server-side scope；状态转换条件 CAS/worker fencing；外部副作用幂等/并发/崩溃恢复；新 API 全带鉴权/RBAC/org 隔离/IDOR 测试；敏感数据脱敏；raw JWT/secret/provider credential 不进日志；provider 返回 URL 不作可信 URL fetch；LLM 不得决定 quota/RBAC/approval/provider；不持久化 CoT；审批绑定具体 action；不新增基础设施/数据库/消息系统/向量库。

## 10. 测试策略

- 每个 Agent：实现 + 单测 + 必要 e2e + typecheck + build + 安全边界自查 + 隔离/幂等/错误处理检查 + commit（报告：内容/文件/commit/测试结果/风险/依赖）
- e2e 全部真实基础设施（PG/pgvector/Redis/BullMQ/MinIO/Worker）；**并行 worktree 铁律：`REDIS_URL=redis://localhost:6379/{本 Agent DB 号}`**，禁止 DB0
- 瞬态状态断言→持久事实断言（M7-P7 委派教训）；最终一致写入轮询等待
- A12 真多进程：child_process spawn 独立进程（先 build 再 spawn）
- P17：压测数字诚实口径（本机回环，不冒充生产容量）

## 11. Integration 顺序（Wave 3，Coordinator）

1. 每个 worktree 检查：tests/typecheck/build/migration/schema consistency/API contract/架构边界
2. 按 DAG 顺序自动 merge（无冲突直接 merge；机械冲突自动解；架构冲突按 §9 contract 保留双方有效能力，绝不简单覆盖）
3. merge 后验证：fresh-DB 全链重放 + 现有 DB migrate deploy + prisma generate + seed
4. 全量回归：api 全量测试 + web 测试 + typecheck 4/4 + build 3/3（连续两轮全绿）
5. P17 压测/soak
6. Final Audit（§12 七维）→ 发现即自动修复→测试→回归，不停下逐项请示

## 12. 最终验收矩阵

```
M0-M9 Regression     PASS     M10 Tests           PASS
Real Infrastructure  PASS     Security E2E        PASS
Concurrency E2E      PASS     Migration           PASS
Billing              PASS     Worker              PASS
SSE                  PASS     Performance         PASS
Typecheck            PASS     Build               PASS
Git Working Tree     CLEAN
```
+ 输出格式按 M10 规格第十三节 block（Dependency DAG/Parallel Agents/Git Worktrees/Automatic Merge/Conflict Resolution/P1~P17/基础设施/Security/Concurrency/Billing/Reliability/Performance/M0-M9 Regression/Tests/Typecheck/Build/Git）。

## 13. M10 明确不做（Deferred → M11+，记录不伪装）

| 项 | 理由 |
|---|---|
| OCR/PDF 解析（ARCH-03） | 外部能力依赖（tesseract/paddle 或云 OCR），非欠债 |
| Temporal 迁移（ARCH-06） | v1 已决策 BullMQ+自研 workflow；审计确认无必要 |
| Thinking 执行策略（ARCH-01） | 产品决策项（模式设计未定），非欠债 |
| Commerce 真实平台适配器（X-07） | 需供应商账号与真实投放环境 |
| 毛利核算/订阅定价体系（ARCH-10） | 产品定价决策未定 |
| embedding 快分类器（ARCH-05） | 性能优化特性；生产规模数据未验证（M9-12）时做属提前优化 |
| 用户级模型指定（ARCH-02） | Phase 6 feature 非欠债 |
| 预签名直传（ARCH-04） | Phase 6 feature 非欠债 |
| PITR/主从切换/生产量级 DR 验证（DR-2/4/10/11） | 需真实生产基建；本 M10 只交付脚本+runbook，验证项 Deferred |
| 真浏览器对生产域（HTTPS 证书链）验证 | 本地无生产域 |
| 小时级 soak（PR-5） | 降级为 30min soak（P17）；小时级 Deferred |
| e2e 并行化（X-09） | 共享 DB 约束下收益低风险高，维持 fileParallelism:false |
| 组织邀请/角色变更端点 IDOR 之外的抽样外端点 | P15 全覆盖后剩余风险 Deferred 并记录 |
| 会话 token 主动轮换黑名单中"轮换接口" | 若与现有登录流冲突则只做黑名单+文档，接口 Deferred |
```
