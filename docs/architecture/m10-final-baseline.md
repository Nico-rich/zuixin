# M10 Final Baseline（2026-09-28）

> M10（四维审计 → 17 Phase / 14+1+2 Agent 并行 DAG → 集成 → Final Audit → 修复回归）**最终冻结基线**。
> 计划：`m10-implementation-plan.md`；执行基线：M9 Final Baseline（`1d7673e`）；审计来源：M9/Pre-M9 文档 66 项 + 代码遗留 33 项 + M8 运维安全残余 55 项 + 全景快照。

## 1. 提交序列（M9 冻结后）

```
2e5daba  docs(architecture): M10 Implementation Plan（四维审计→17 Phase/DAG/14+3 Agent 分配）
4c29378  feat(api): M10 W0 schema+contract 预整合（CreativeHypothesis/CreativeInsight/ExtensionOrgAllowlist 表、Organization.status/WorkflowRun.definitionSnapshot/Message.editedAt/Credential.keyVersion/MemoryCandidate contentHash UNIQUE、pgcrypto 自声明、12 错误码、attachment_upload quota kind；fresh 33/33）
7e4dbe2  fix(infra): Redis databases=64（默认 16 → DB21+ 越界静默落 db0，A6 实抓）
9b13599  docs: 计划细化（AccessGuard 独占/org.status 分拆/session-events 契约）
c2fc6c5  Merge M10-P6 Marketplace Moderation 显式化（A6，09eaf60）
44b5868  Merge M10-P3 消息编辑/删除+游标分页（A3，ca9ec06）
71a3f07  Merge M10-P11 Memory 去重与降级标注（A11，cfa6444）
f08988a  Merge M10-P4 CreativeLoop 专表+P5 补偿真实触发（A4，7cc21f2）
b20e65a  Merge M10-P8 全局 per-IP 限流（A8，121f250）
acc2c64  Merge M10-P13 Web 修复+TaskCard SSE（A13，0b24ac7+66e6d4e）
c8cbf9c  Merge M10-P5 Workflow 快照+调度+webhook（A5，ef2b60f）
b9607e7  Merge M10-P14 Extension 白名单+组织禁用（A14，2deef38）
68757ea  Merge M10-P12 测试补强（A12，722348e，1 诚实 skip→A1 合并后 5/5 激活）
77fdfa3  Merge M10-P10 Runtime 可靠性+事件归档（A10，fe75d8d）
b36216f  Merge M10-P9 运维脚本+Runbook+Manifests（A9，53608f8+2）
c44633d  Merge M10-P1 生产守卫+会话治理+DNS pin+密钥轮换（A1，7768e56+58aea9d）
1592236  Merge M10-P2 Provider HTTP Contract（A2，aa2910c）
753e789  fix(api): 集成准备（httpStatusOf 10 专码/health 别名/start 脚本/forRootAsync 惰性 REDIS_URL/m8-p2-billing 排空等待+**实抓 C1 concurrent 预留泄漏**）
0ab8790  perf(api): M10-P16 EXPLAIN 索引落地（10 索引；HNSW DROP 剔除第 5 次）
2d7440d  perf(api): M10-P17 soak 脚本
217c06e  Merge M10-P15 全端点 IDOR/RBAC 枚举矩阵（P15，7c2831c：182 端点、16 越权 bug 修复）
3428b5d  fix(api): M10 Final Audit 修复批次（7 HIGH 全闭环 + MEDIUM 快速项；HNSW DROP 陷阱第 6 次实抓+恢复迁移）
```

## 2. 各 Phase 核心机制（详见各 commit 报告）

- **P1 生产安全守卫与密钥治理**：production-guards fail-fast（占位密钥/开发替身/seed 弱口令）；session-events pub/sub 跨实例撤销（3ms 级，A12 真多进程 5/5 验证）+ 会话并发上限（默认 5，evict-oldest）+ jti 黑名单；DNS rebinding 连接固定（pinned-transport）；密钥版本化 v{n}.{iv}.{tag}.{data} + 多密钥 ENCRYPTION_KEYS；helmet 显式配置。
- **P2 Provider HTTP Contract**：本地脚本化 OpenAI-compatible 假服务器（17 场景）；真实 TCP/HTTP/SSE 契约 e2e 32 测；实抓 SDK abort 静默截断流被当"完成"、SDK 超时误归类不可重试双缺陷；provider-degraded 启动校验。
- **P3 消息编辑/删除 + 游标分页**：PATCH/DELETE（仅本人 user 消息、404 反枚举、403 专码）；摘要 stale 自愈链首个生产调用方；(createdAt,id) 复合游标，向后兼容。
- **P4 CreativeLoop 专表**：CreativeHypothesis/CreativeInsight 两表（org 直列/version CAS/factsHash 不变量保持）；Artifact JSONB 容器迁移 + 幂等回填；P5 补偿链真实触发断言（回滚被审批绑定闭锁拒绝 = 零第二写操作，安全属性得证）。
- **P5 Workflow 快照+调度+webhook**：definitionSnapshot 真实现（快照优先/version 行兜底）；syncSchedules 幂等 + **实抓 BullMQ key≠id 双缺陷**（归档从未注销调度器/cron 变更叠加重复调度）；webhook 全局闸 + 双 secret 过渡窗。
- **P6 Marketplace Moderation 显式化**：治理权显式枚举（MODERATION_ROLES）+ 矩阵 tripwire 变异实测；评分绝不参与授权保持。
- **P7 附件安全 + S3 e2e**：zip 炸弹防护（EOCD/zip64 声明体积校验）；JPEG APP1 段剔除（纯二进制，畸形即 400）；每用户附件配额（attachment_upload C1）；真实 MinIO S3 全链路 e2e + 密钥不进日志断言。
- **P8 全局 per-IP 限流**：有界路由模板键/XFF 可信跳解析/四桶决策矩阵/豁免面零 Redis；app.module 唯一改权。
- **P9 运维脚本+Runbook**：backup/restore/minio-mirror 脚本（恢复演练 3 轮 88/88 表逐行一致）；runbook 10 节；k8s manifests（grace 45s/readiness /ready/worker 独立）；Prometheus 告警模板（[可用]/[待导出] 诚实标注）。
- **P10 Runtime 可靠性+事件归档**：active 单值→集合；LLM 单回合 watchdog（PROVIDER_TIMEOUT 可重试）；tool.retryPolicy 默认消费瞬态码；委派订阅回收；paused 背压口径；EventEnvelope 归档消费者（G10 冻结唯一豁免：不新增队列/不改表）。
- **P11 Memory 去重与降级标注**：contentHash UNIQUE + P2002 并发兜底；降级摘要段显式标记 → 上下文置尾降权；lastUsedAt 排序。
- **P12 测试补强**：5 队列 confused-deputy 行为级 e2e；真多进程 2API+2Worker（pid 级证据 + C1 精确准入 + 会话跨进程撤销 ④ 契约门控）；NODE_ENV=production cookie 三进程判别。
- **P13 Web 修复+TaskCard SSE**：CRLF 分帧/401 死条件/图标；task 通道 relay（fail-closed 归属路由）；SSE 降级信号。
- **P14 Extension 白名单+组织禁用**：ExtensionOrgAllowlist 两态模型 + 收窄级联停用；OrgStatusGuard（无角色豁免 + 邀请 token 烧毁缺陷修复）；全局挂载属契约裁决（偏离登记见 §5）。
- **P15 全端点 IDOR/RBAC 矩阵**：182 JWT 端点全枚举（匿名横扫 182/182 + 矩阵 180/182）；**16 个越权 bug 修复**（projects 写路径/跨租户 projectId 污染配额/评测 oracle/禁用组织治理/事件重投/feedback 落库/评审 oracle 等）。
- **P16 EXPLAIN 索引审计**：10 索引落地（游标分页 3 列/路由评分 providerId/表达式与部分索引）；HNSW 10k scratch 实测（可用但默认规划器仍选 Seq+Sort——规模交叉点 NOT VERIFIED）。
- **P17 压测/soak**：/live 1283.9 req/s（p99 61.4ms）、/ready 1348 req/s；20 并发 agent run 全 completed；30min soak（RSS 222→242MB 慢漂、150 run 全收敛、会话驱逐 401 属安全特性生效）。

## 3. 实施中实抓并修复的真 bug（12 个，测试体系价值再证）

1. **Redis databases=16 越界静默落 db0**（A6 抓）——compose 升 64 并参数化。
2. **Pub/Sub 通道实例全局、DB 段不隔离**（A13 抓）——断言纪律改为唯一 id 收敛。
3. **C1 concurrent 超限预留泄漏**（try 外抛错不回滚，refId 指向未建成 run；集成期 Coordinator 抓）——移入 try 同享回滚。
4. **BullMQ getJobSchedulers 条目只有 key 无 id**（A5 抓）——归档/删除从未注销调度器。
5. **cron 变更叠加重复调度器**（A5 抓，同源修复）。
6. **SDK abort 静默结束迭代**（A2 抓）——截断流被当"生成完成"。
7. **SDK 超时错误误归类不可重试**（A2 抓）——归一 PROVIDER_TIMEOUT。
8. **邀请 token 被冻结期烧毁**（A14 抓）——组织检查前置于条件更新。
9. **HNSW DROP INDEX 孤儿判定**（第 5、6 次出现——P16 剔除 + Final Audit 批次 Coordinator 失守直接 deploy → 恢复迁移补救，纪律再固化：**diff 后必查 DROP INDEX 再 deploy**）。
10. **P15 的 16 个越权 bug**（跨租户 projectId 污染配额/账单/分析、治理面 oracle 等）。
11. **C1 预留三泄漏路径 + 附件账本被吞 + 跨 hop usage 错配 + webhook 烧 eventId**（Final Audit 抓，全部修复）。
12. **start 脚本 dist/main.js 与实际产物不符**（A9/A12 双报）。

## 4. 最终验收数字（2026-09-28，全部实测）

- **api 测试**：226 文件 / **2220 测试连续三轮全绿**（410s/411s/389s；第 1、2 轮为审计前、第 3 轮为审计修复后）
- **web 测试**：10 文件 / 103 用例全绿；**typecheck 4/4**；**build 3/3**（含 Next 构建）
- **fresh-DB 迁移重放**：37/37 全链成功（含 HNSW 恢复迁移后索引完好、pgcrypto 自声明）
- **基础设施**：PostgreSQL(pgvector)/Redis(64 DB)/BullMQ/MinIO 全程真实
- **多进程**：2 API + 2 Worker 真 OS 进程（C1 精确准入/会话跨进程撤销 3ms/pid 级归属证据）
- **对账**：UsageRecord↔UsageLedgerEntry↔Analytics 既有三方 + 对账端点（ledger-only kind 独立校验段属 Deferred）
- **故障注入**：5 队列 confused-deputy + provider 17 场景契约 e2e
- **压测/soak**：1283.9 req/s（p99 61.4ms）；30min soak 无爆裂泄漏（+20MB 慢漂，登记观察）
- **Git**：CLEAN @ `3428b5d`

## 5. 偏离登记与 Deferred（如实记录，不伪造）

**偏离登记（M10 已接受，附理由）**：
- OrgStatusGuard 未全局 APP_GUARD 挂载（需与全局 JwtAuthGuard 成对，属契约裁决）；P15 已补服务层漏网面（marketplace 审核/workflows 读），资源守卫在 organizations/extensions 双控制器。
- session-events 为独立 pub/sub 命名空间（未复用 EventBus 前缀 `agent:events:`）；§8 契约已定名，未来消费者复用需注意。
- webhook 全局闸单键跨租户（噪声邻居取舍）；Message 删除对 GenerationTask.messageId SET NULL（有意语义，已注册）。
- 摘要/记忆类 LLM 计量已接（H4），**是否纳入 llm_tokens 配额裁决属产品决策**（未裁决前只计量不裁决）。
- 回滚 external_action 被审批绑定闭锁拒绝（引擎级，零越权写——安全属性；生产可达补偿需产品决策）。
- soak 脚本无重登逻辑（401 来自会话并发驱逐安全特性，非平台缺陷）。

**Deferred（→ M11+）**：设备级下线（需 Session.deviceId 列）；dedicated marketplace 治理位（A6 设计已备）；DB 级 CHECK 不变量集；UsageRecord (runId,turnIndex,kind) 唯一键；evaluation-runner 配额预扣；watchdog 超时回合 token 计费口径；MetricSample/EventEnvelope 保留策略；ledger-only kind 对账独立段；rewrap 脚本与 keyVersion 落库；jti ZSET 逐条过期 + pipeline；jtiOkCache 容量上限；S3 put 超时（NodeHttpHandler）；backup gzip 静态加密；OCR/Temporal/Thinking 策略/Commerce 真适配器/毛利定价/embedding 快分类器/用户级模型指定/预签名直传；PITR/主从/生产量级 DR 验证；小时级 soak；HNSW 生产规模选择行为（10k 默认规划器仍 Seq+Sort——需 random_page_cost/规模交叉点评估）；真实厂商端到端（六家 provider 行为 NOT VERIFIED，契约层已闭环）。

## 6. 冻结声明

M10 全部代码（W0 预整合 + P1~P17 + 集成修复 + Final Audit 修复）自本基线冻结；M11 未开始。**本文件为基线快照。**
