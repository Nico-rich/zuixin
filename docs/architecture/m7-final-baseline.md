# M7 Final Baseline（2026-09-25）

> M7（Approval / Connection / External Action / Commerce / Workflow / Multi-Agent / Feedback / Security）**最终冻结基线**。
> 设计：`docs/architecture/m7-architecture-design.md`（§1~§10，含各 Phase 实测修复与实施差异）。

## 1. M7 已实现能力（全部经真实代码核对 + 测试覆盖）

| # | 能力 | 实现位置 | 测试覆盖 |
|---|---|---|---|
| 1 | Approval / Human-in-the-loop | Approval 模型 + ToolCall waiting_approval + waitingOnApprovalId；Engine 审批门（resume 三裁决）；ApprovalsService 条件更新 + 懒过期 + recoverStale 兜底；API 5 端点 | 单测 8 + engine 8 + e2e 8（m7-p1） |
| 2 | Connection / OAuth / Credential | Connection/Credential/OAuthState；AES-256-GCM at rest；OAuthState 单次消费；MockOAuthProvider 全生命周期；refresh 竞态折叠；reconnect 复活；API 6 端点零凭证出网 | 单测 15 + e2e 8（m7-p2） |
| 3 | External Action Framework | ExternalAction + UNIQUE(userId,provider,idempotencyKey)；执行链审批复核→幂等→连接校验→Adapter（accessToken 服务端注入）；ToolPermission 扩展 financial/destructive；审计 API | 单测 9 + e2e 8（m7-p3） |
| 4 | E-commerce DataSource + Commerce Tools | 规范化 11 表；CommerceProvider 接口 + MockAdapter（种子数据，不伪造第三方）；9 个只读 tools；facts/derived 严格分层；时间窗校验 | 单测 8 + e2e 7（m7-p4） |
| 5 | Commerce Analysis + Creative Decision Loop | CommerceAnalysis（facts/derived/anomalies 服务端 + LLM 推测独立标注）/CreativeBrief（evidence 自动挂最新分析 + Artifact 镜像）；规则异常双源阈值；闭环复用既有 Image Agent 管线 | 单测 4 + e2e 3（m7-p5） |
| 6 | Workflow Engine | Workflow/Version（不可变）/Run（锁定快照）/StepRun；executor 6 步骤类型（condition/tool/agent/approval/external_action/output）；4 触发器（manual/webhook HMAC+timestamp+eventId 防重放/schedule/event）；复用 M6 lease-waiting-wake-cancel 原语集；部分唯一索引幂等；最小 UI 4 页 | 单测 4 + e2e 11（m7-p6） |
| 7 | Multi-Agent / Delegation | AgentDelegation + parentRunId/delegatedByRunId/depth；agent.delegate 工具；深度/子数上限 + 血缘链环检测 + 权限子集快照（metadata.delegationTools）；级联取消；子终态双通道唤醒 + 结构化结果回喂 | 单测 7 + engine 3 + e2e 5（m7-p7） |
| 8 | Feedback / Performance Learning | Feedback/CreativePerformance/PerformanceSnapshot；评分与绩效阈值记忆（Memory 闭环，不改模型权重）；insights 分层；创意简报 evidence 附带绩效记忆底座 | e2e 6（m7-p8） |
| 9 | Security Hardening | Prompt Injection 运行时护栏 + untrusted 标注；Rate Limit（Redis，8 端点）；AuditLog 全链路；旁路矩阵复核；凭证零泄漏；IDOR 全矩阵 | e2e 5（m7-p9） |
| 10 | 全量回归 | M0~M6 冻结回归零漂移；P1~P9 e2e 全链路 | 73 文件 / 460 测试 |

## 2. 最终全量验证（fresh，零 turbo 缓存，2026-09-25）

- **Tests**：`pnpm run test --force` → api **73 文件 / 460 测试全绿**；web、shared 全绿；
- **Typecheck**：`pnpm run typecheck --force` → 4/4（api/web/shared）零缓存；
- **Build**：`pnpm run build --force` → 3/3（api nest build / web next build / shared tsup）零缓存；
- **真实基础设施 E2E**：PostgreSQL(pgvector) + Redis/BullMQ（agent-run/workflow/image/video/media-cleanup 队列）+ Worker 上下文——全程真实执行，无 mock DB/队列；
- **M0-M6 Regression**：全部冻结 spec 在套件内（chat/M2/M3/M4/M5/M6 P1~P7），零行为漂移；
- **数据库安全**：零 `prisma migrate reset`；11 个纯增量迁移（m7_p1→m7_p9 + p6b/p6c）；
- **Git**：9 个 Phase 提交 `64acc51 → 32e74ff → eae996c → ba88172 → a9b339e → e7a67dc(wip) → 43e3233 → 6ffb4ce → 78ebaca → 3b11d5e`；工作树干净。

## 3. 关键故障修复（M7 实施过程中实测发现并修复）

| 故障 | Phase | 修复 |
|---|---|---|
| MockLLM 启发式命中 tool 结果回显的触发词（payload.title 含"发布到"）→ 无限再触发同一工具 → run 永久 waiting | P3 | 启发式仅 role=user 消息触发 |
| ToolCall 行首次执行即 completed（输出=waiting 标记）→ resume 复用行原样回喂标记 → 委派分支无限重入 waiting | P7 | refreshDelegationOutput（复用行刷新为结构化子结果；与 P4 refreshGenerationOutput 同构） |
| modules↔worker 循环导入（WORKFLOW_CANCEL_CHANNEL）→ Nest DI 解析失败 | P6 | 通道常量下沉 core/events/workflow-channels.ts |
| webhook secret 纯摘要不可用于 HMAC 校验 | P6 | AES-GCM 密文 at rest + 校验时服务端解密 + timingSafeEqual |
| 方法级 @UsePipes 作用于 @Param 字符串 → 全端点 400 | P2 | 参数级 pipe |
| worker 进程无 AuthModule（@Global 仅 API 进程）→ JwtAuthGuard 依赖解析失败 | P8 | 服务层/API 面模块分层（与既有模块同构） |
| cancel 与「审批已建但 waiting 未落库」竞态 → 审批残留 requested | P9 | 附带清理按 runId 兜底（agentRunId/workflowRunId） |
| 全量串行 e2e 击穿 60/min 创建限额 → 429 误伤 | P10 | 创建类端点 300/min（保护语义保留）+ 限流测试独立用户隔离 |
| m6-p3 transcript 断言依赖无 orderBy 的物理顺序 → 偶发 flake | P10 | messages 按 sequence 排序（测试确定性修复） |
| 指标 dimension=all 与 source 行父子重复计数（impressions 翻倍） | P4 | 总量只取 all 行；source 仅用于分布 |

## 4. 技术债（如实记录，不修）

1. 委派/工作流的 child-run 观察订阅进程内常驻（每委派一条，不随唤醒清理；recoverStale 兜底正确性不受影响）；
2. Workflow schedule repeatable 注册于 Redis（BullMQ），改 cron 需重新发布；重启自愈由 onModuleInit 重放；
3. e2e 串行（fileParallelism:false）——全量墙钟 ~3min（M6 已记录）；
4. Commerce 真实平台适配器（shopify/amazon/meta/google/tiktok）留接口位（无真实凭据不伪造——符合 P4 约束）；
5. RateLimit 为进程内 Redis 客户端 + 固定窗口近似；
6. M6 既有债延续：AgentRunProcessor active 单值字段、LLM 单回合 watchdog 未实现。

## 5. M8 边界（M7 冻结，以下全部未实现、未触碰）

模型训练 / Fine-tuning / RL / 修改模型权重 / 复杂企业组织架构 / 复杂 Billing-Subscription / Marketplace / Agent Store / 第三方开发者平台 / 完整 BI / 复杂数据仓库 / 复杂实时流计算。

## 6. 冻结声明

M7 全部代码（P1~P10，commits `64acc51`→`3b11d5e`）自本基线起冻结；
全程未修改任何 M0~M6 冻结行为（M6 文件的触碰均为增量扩展或测试确定性修复，已逐条记录）；
未使用 `prisma migrate reset`，未删除现有数据；本文件为基线快照。
