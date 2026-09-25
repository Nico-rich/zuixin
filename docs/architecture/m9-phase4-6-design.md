# M9-P4/P5/P6 设计（Advanced Workflow / Creative Performance Loop / Marketplace 公开层）

> 依赖：P4 ← Approval Binding（Pre-M9 安全包）+ P1 Evaluation + Pre-M9 可靠性；P5 ← M7 Feedback + P1 + P4；P6 ← M8 Extension Foundation + P1。
> P4 → P5 → P6 串行；每 Phase 完成后 Coordinator 全量回归。

## M9-P4 Advanced Workflow（durable execution 补全）

- 复用 M7-P6 WorkflowExecutor 状态机 + 既有 UNIQUE(runId,stepIndex) 幂等锚点——**不重写编排器**，增量：
  1. **Approval binding**（Pre-M9 已落 payloadHash/actionType 绑定）→ workflow approval 步骤执行前重算 hash 校验。
  2. **Human approval node**：approval 步骤支持人工表单（reason 模板 + payload 展示 + 决策 API 复用 M7-P1）。
  3. **Wait node**：等待条件（时间窗/子 run 终态/事件）——复用 waiting 语义 + wake（M6 模式）。
  4. **Timeout/retry per-step**：WorkflowStepDef 扩展 timeoutMs/retryPolicy（校验层 + 执行层）；deadline 受 run 总时限约束。
  5. **Compensation**：WorkflowStepDef.compensate（补偿步骤 id）——步骤失败/rollback 时执行补偿链（补偿步骤也是幂等锚点行）；compensation 执行记录进 WorkflowStepRun（type=compensation）。
  6. **Version locking**：run 已锁 versionId（既有）——补版本定义快照（run.definitionSnapshot JSON，版本后续发布不影响已运行 run）。
- Schema 增量：WorkflowRun.definitionSnapshot Json?；WorkflowStepRun.type 增 'compensation'（若现为 String 无需迁移）；definition JSON 内联 timeoutMs/retryPolicy/compensate 字段（不新增表）。
- 边界：workflows 模块（M7-P6 文件扩展），新文件 workflow-compensation.service.ts / workflow-wait.service.ts。

## M9-P5 Creative Performance Loop

- 闭环：Campaign/Data（M7-P4 Commerce 已备）→ Performance（M7-P8 Feedback + P1 Evaluation）→ Insight（规则+LLM 解读分层，解读绝不改写事实）→ Creative Hypothesis → 生成（M5 Image/Video）→ Evaluation（P1）→ Experiment（P1）→ Feedback → Learning。
- 新模块 `apps/api/src/modules/creative-loop/`：hypothesis 服务（假设 CRUD + 状态机 draft/ready/running/validated/rejected）+ loop 编排（复用 workflow：loop 定义成 workflow definition——P4 的 compensation/wait/approval 供其用）。
- **写操作安全**：涉及真实广告平台写操作 → Approval + ExternalAction + Audit + Idempotency 全链（既有 M7-P3 能力，绝不绕过）。
- 不做：自动化真实投放（无人工审批的批量外部操作被禁止——M8 冻结边界延续）。

## M9-P6 Marketplace 公开层

- 复用 M8-P6 Extension Foundation（manifest/签名/版本锁定/物化执行）——绝不任意代码执行。
- 新表：ExtensionPublication（publisher 组织/用户、extensionId、status draft/published/rejected、category、description、changelog、兼容性声明）+ Review（rating/body/moderation 状态）+ InstallCount 计数（聚合投影）。
- Marketplace 评分绝不提升权限（权限仍 = manifest ∩ 平台白名单 ∩ 组织策略——Pre-M9 F4 语义）。
- search/categories/publisher/version/rating/install count/changelog/permission disclosure/review moderation API + 最小 Web UI（列表/详情/安装）。
- 边界：`apps/api/src/modules/marketplace/` 新模块 + web 页面。

## 验收（每 Phase）
单测 + e2e + typecheck + build + 全量回归；无重复事实系统/重复 Router/重复 Scheduler/重复记忆系统；无 CoT 持久化；无租户逃逸；无凭证日志；外部调用有界；重试副作用幂等。
