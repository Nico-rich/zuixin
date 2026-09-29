# M12–M13 Final Roadmap（2026-09-29）

> 最终阶段路线图：从 M11 冻结（`9d30cdf`）一次执行到底完成 M12（自优化闭环）→ M13（最终产品化）→ 产品真实启动与最终验收。
> 审计基线：四维并行审计（M12 能力盘点 / Web 缺口 / Deferred 归属 / 启动面）——全部以仓库代码为唯一事实来源。
> 仓库**无 M12/M13 设计文档**；本阶段 scope 由 M10/M11 基线 Deferred 清单 + 用户规格推导。

## 1. M12 scope（自优化/数据反馈闭环）

审计结论：**Learning 层整体缺失**。全仓仅两处"事实→系统状态"闭环（CreativePerformance→verdict；provider 健康→路由排序）。M12 = 补上 Result→Next Decision 的桥，手段限定 Memory/Feedback/Evaluation/Performance/Experiment/Strategy。

**M12-P1 CreativeLoop 学习桥（最高优先）**：
- verdict→下一次决策：validated/rejected 结论进入新假设/洞察构建输入（现 insightId 单向引用）
- **先行修边界风险（审计 R1 最高项）**：loop 判定窗口加来源判别（external-only 谓词）——Agent 可经 performance.capture 伪造绩效自证假设，必须堵死

**M12-P2 Agent 表现回流**：
- analytics 组织级聚合加 agentId 维度；AgentRun 按 agent 聚合成功率/时长
- agent 候选排序（agent-registry/delegation 静态映射→表现排序）消费该数据

**M12-P3 记忆生命周期**：
- outcome 驱动提升/降级（现仅人工 PATCH）；MemoryCandidateService.decide() 死代码接线 HTTP 面
- **先行加来源可信度闸门**（审计风险 2）：LLM 反馈打分→自动提升将成提示注入持久化通道——feedback 派生记忆需来源标注+受控提升

**M12-P4 策略与实验**：
- 策略阈值外部化：SystemSetting 受限写入口（管理员 API+键白名单+审计；绝不开放 quota/RBAC 面——红线 14）
- 实验变体受控晋级：trafficPercent/configSnapshot 零运行时读者——建"实验结论→人工确认→策略生效"受控通道（评测与流量选路严格分离不变量保持）
- 评测执行补工具能力（runner 现不传 tools——无法评测带工具 Agent）

**M12-P5 数据面与杂项**：
- Analytics 聚合 cron 化（RecurringJobProvisioner 既有范式）；PerformanceSnapshot 死端接线（或明确废弃）
- 孤儿附件清扫器（storage 加 list + sweeper——纯代码增量）
- backup --upload 明文显式确认口径；mc 凭据 SIGINT 清理；PITR×逻辑备份交叉验证脚本
- event 触发器类型裁决：**下线**（无生产发布端且接线违反 G10 冻结）——登记并保留文档说明

**明确不做（M12）**：模型训练/权重修改（永久不做）；变体自动下发线上流量（必须人工确认）；LLM 决定任何治理判定。

## 2. M13 scope（最终产品化）

审计结论：后端 33 模块/30 controller，Web 只消费 6 个；20 个后端面零入口；无全局导航壳；两处闭环断裂（审批事件未进 SSE 白名单、Artifacts 无 REST 端点）。

**M13-F1 全局框架（真实前置，先行）**：
- Sidebar 提升为全局 AppShell（layout.tsx）+ 全局导航（对话/工作流/评测/扩展市场/Agents/知识/记忆/连接/用量/设置/创意/分析/账单/组织）
- middleware 服务端鉴权（替换客户端门）；UI 组件库补 Table/Dialog/Select/Card/Badge/Tabs/Toast/Skeleton；useApiQuery/service 层；login 渲染期 redirect 修复

**M13-W2~W9 页面补齐（F1 组件库就绪后并行）**：
- W2 Agents 管理+Agent Runs（含 timeline 复用+usage 渲染）
- W3 Knowledge+Memory
- W4 Creative Workspace（16 端点闭环零前端——完成度最高可见度为零）
- W5 Connections+Billing+Organization/Team
- W6 Analytics+Feedback+Usage（后端补 usage 聚合端点）
- W7 Extensions 管理
- W8 Dashboard 首页（/ 替换 redirect）
- W9 闭环断裂修复：审批 SSE 转发（chat.service 白名单）+Approvals 页；Artifacts REST 端点+页；Settings（sessions 起步）；Ecommerce 只读展示面（"工具即接口"标注）
- W10 复用完善（单 agent 串行，集中文件）：chat 消息编辑/删除、agent 事件呈现、timeline usage、sidebar 重命名/删除、workflows 新建/编辑/删除/cancel/retry/rotate、evaluation 写面最小集

**明确不做（M13）**：视觉设计终稿；placeholder 必须明确标记；Ecommerce 人机写面（产品口径）；预签名直传（Deferred）。

## 3. Dependency DAG

```
Wave 1（并行）：
  M12-P1  M12-P2  M12-P3  M12-P4  M12-P5   （后端闭环，5 worktree agents）
  M13-F1（AppShell/nav/组件库/service 层/middleware）  ← 真实前置（页面 agents 依赖组件库）
Wave 2（依赖 F1 组件库，页面间零依赖并行）：
  W2  W3  W4  W5  W6  W7  W8  W9  W10
Wave 3：Integration（merge→迁移链验证→全栈启动 smoke→定向验证）
Wave 4：唯一一次完整 pnpm test+typecheck+build → 核心用户流程 Smoke Test
Wave 5：Final Audit（七维+Product+Scope）→ 修复→重验
最终：全栈 RUNNING → 输出 WEB/API URL → PROJECT COMPLETE
```

真实依赖仅两条：页面 agents → F1 组件库；W9 的后端补面自包含。其余全部并行。

## 4. 边界红线（M12/M13 全程约束，审计 R3 第 25 条清单）

单向分层 Agent→Tool→Service→Provider；ContextAssembler 唯一注入；AgentRun→Step→ToolCall→Task→Artifact 血缘；Timeline=projection；无第二 Event Store；不持久化 CoT；UsageRecord 唯一计费事实源；无汇总表；Redis 非事实源；禁第三套 Scheduler；禁重实现 Routing/Workflow/Memory/Runtime；EventEnvelope 冻结；**LLM 不得决定 quota/RBAC/approval/provider/策略阈值**；org 归属+server-side scope；身份只从 JWT+DB；审批绑定 action；外部副作用幂等；外部数据 UNTRUSTED；凭证红线；CAS+version；不新增基础设施；迁移纪律（历史不改写/create-only 后必查 DROP INDEX）；e2e Redis DB 隔离铁律；扩展链禁止。架构变更需「偏离登记」制度（仓库无 ADR 先例——本 roadmap 即登记载体）。

## 5. Deferred / Future（本阶段不做）

终局 Deferred：真实厂商端到端（无凭据）、生产量级 PITR/主从/多机、k8s 实机、Vault/KMS、真浏览器生产域、e2e 并行化、托管 PG 受限角色、Prometheus 部署、备份桶生命周期、k8s HPA 起手值（P17 取消连带）。
永久不做：Temporal、EventEnvelope 物理删除、模型训练、无限自治 Agent、未授权金融交易、独立向量库。
M13 项（本阶段内做）：OCR、Thinking、Commerce 真适配器、毛利定价、embedding 快分类器、用户级模型指定、预签名直传——**除本 roadmap 明确纳入外均不做**。

## 6. 最终产品定义

用户打开浏览器（http://localhost:3000）→ 登录 → Dashboard → 全局导航进入：对话（SSE 流式+工具+图片/视频任务卡+时间线）、Agents 管理、Agent Runs、知识库、记忆、创意工作台、工作流（含新建）、评测（含写面最小集）、反馈/性能、分析、用量/账单、连接、组织/团队、设置、扩展市场、扩展管理。核心链路全部真实调用后端；无假数据；placeholder 明确标记。

## 7. 不属于 M12/M13 的内容

M14 不存在（项目终点=M13）；一切本表 Deferred 之外的 Future；视觉设计终稿；真实厂商凭据接入；生产集群部署。

## 8. 验证策略（必要验证，非重复全量）

Agent 层：定向测试+必要 typecheck/build+真实 E2E（其领域）。Wave 层：受影响集成测试。最终一次：完整 pnpm test+typecheck+build+全栈 Smoke Test。失败→定位→修复→只重跑受影响→最后完整验证一次。
