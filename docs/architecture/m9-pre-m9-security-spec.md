# Pre-M9 安全包规格（F1/F2/F3-A/F3-B/F4/Scheduler IDOR/Workflow RBAC/Webhook 签名/Approval 绑定）

> 基于 M0-M8 Final Architecture Audit 的真实发现。实施 Agent 只许改业务代码；**禁止修改 schema.prisma、禁止创建/执行 migration、禁止 prisma generate**（Coordinator 已预整合）。测试运行于共享开发库（migration 已由 Coordinator 应用），e2e 沿用既有模式（专用用户 + afterAll 清理自建行）。

## F1 HTTP 日志 JWT 泄漏 [HIGH]

现状：`set-cookie` 未脱敏——每次登录/刷新把 access+refresh JWT 明文写入 pino 日志。pino redact 仅覆盖约 3 个 headers。

要求：
- HTTP logger 与错误日志全链路脱敏：`set-cookie`、`authorization`、`cookie`、`bearer` 及任何 JWT 形态的值绝不进日志。
- 查找并修复点：`apps/api/src/main.ts`（或 pino 配置处）的 redact 列表；若 HTTP 请求日志在拦截器/中间件中自组装对象，也必须脱敏。
- 测试：login → 捕获日志 → 断言无 token；refresh → 同；401/403 → 同。可复用现有日志捕获手法（若 e2e 已有 pino 输出捕获）或用单测直接测 serializer/redact 配置。

## F2 Worker 日志脱敏 [HIGH]

现状：worker 进程无 pino——ConsoleLogger 原样打印，脱敏层完全不存在。

要求：
- `apps/api/src/worker.ts` 接入与 API 一致的 pino 体系（含同一 redact/serializer）。
- error 对象不得泄漏 credential；queue payload 日志只记录安全 ID（runId/taskId 等）。
- 增加 worker logging e2e（或单测验证 worker 入口的 pino 配置包含与 API 相同的 redact 键）。

## F3-A 媒体 URL SSRF [P0]

现状：`apps/api/src/modules/generations/media-generation.service.ts`（storeFiles/下载 provider 结果 URL 处）直接 fetch provider 返回的 URL，无任何 SSRF 守卫且跟随 redirects。`apps/api/src/modules/security/ssrf-guard.ts` 只用于 extension config 路径。

要求：建立统一 `SafeRemoteFetcher`（建议 `apps/api/src/modules/security/safe-remote-fetcher.ts`）：
- scheme 仅 http/https；DNS/IP 检查：禁止 loopback（127.0.0.0/8、::1）、private IPv4（10/8、172.16/12、192.168/16）、link-local（169.254/16、fe80::/10）、metadata 端点（169.254.169.254 已在 link-local 内，另加显式拒绝）、IPv4-mapped/IPv6 形式全归一化后再判定（复用 ssrf-guard 的 IP 分类逻辑或抽取共用）。
- redirect 每一跳重新校验（follow 手写循环，每跳解析 DNS→校验→再 fetch）；最终连接地址重新校验。
- connect timeout + total timeout + response size limit（超出即 abort）。
- 仅允许明确 allowlist（provider 域名）或安全 provider policy；SSRF 失败形成明确错误码。
- 所有媒体下载路径只经 SafeRemoteFetcher；绝不把任意 URL 写成可信 Attachment。
- 测试：localhost / 127.0.0.1 / 0.0.0.0 / private IPv4 / IPv6 localhost / link-local / metadata IP / redirect→private IP / DNS rebinding 场景 / oversized response / timeout / valid provider URL。

注意：现有 `ssrf-guard.ts` 已实现完整 IP 分类 + DNS resolver + fail-closed（M8-P8 修复过 IPv6 方括号/内嵌 IPv4 形式）——优先**复用其 IP/DNS 判定函数**，在其上包装 fetch 循环，不要重写一份判定。

## F3-B Provider baseUrl 调用期校验

现状：Provider 表直配 baseUrl，仅启动时校验一次；调用期无重校验；SDK 默认 follow redirects。

要求：
- 每次 LLM/媒体 provider 调用前对 baseUrl 重新校验（scheme/hostname/resolved IP/redirect policy——复用 ssrf-guard）。
- 校验失败 fail-closed（拒绝调用，明确错误码）。
- 校验点放在 adapter 构造或 manager resolve 处（单一出口，避免每个 adapter 重复）。

## F4 Extension Agent 工具白名单 [P0]

现状：`apps/api/src/modules/extensions/extensions.service.ts` materializeProvider 的 kind=agent 物化不校验工具清单——组织 member（agent.write）可物化 `tools=['external_action.execute',...]` 的 Agent，绕过平台管理员工具分配控制面。

要求：effective tools = 请求清单 ∩ 平台允许清单 ∩ extension permission ∩ 组织策略（交集，绝不 union）。尤其 external_action/destructive/financial/credential/workflow mutation 类工具绝不因 manifest 自声明而获得——必须平台白名单放行。
- 增加 IDOR/privilege escalation e2e：member 物化含 external_action.execute 的 agent → 工具被剔除或物化被拒。

## Scheduler IDOR [HIGH]

现状：`apps/api/src/modules/scheduler/scheduler.service.ts` 幂等键查找 `findUnique({where:{idempotencyKey}})` 全局且未加 scope——任意登录用户猜键可读他人作业（含 payload）。

要求：
- job 查询必须 organization/user scoped（idempotencyKey 全局唯一约束保留，但读取/操作全部带 scope 条件——先查归属再操作，findFirst + organizationId 条件）。
- 跨组织访问返回 404 anti-enumeration（与既有 404 语义一致）。
- payload 绝不泄露给非归属者。
- e2e：org A create → org B 猜键 → 404。

## Workflow RBAC [HIGH]

现状：`apps/api/src/modules/workflows/workflows.controller.ts` 写操作（update/publish/archive/remove）只查 requireOwned（成员即可），viewer 可写。审计确认：workflow create 用 requireMembership 而 project 用 requirePermission。

要求：
- 统一矩阵：create/update/publish/archive/remove 全部要求 workflow.write（与 Project RBAC 语义一致）；viewer/member 只读。
- 403/404 anti-enumeration 策略与项目/组织一致。
- e2e：viewer publish/delete → 403。

## Webhook 签名覆盖 [HIGH]

现状：`apps/api/src/modules/workflows/workflow-triggers.service.ts` HMAC 只覆盖 rawBody（timestamp/eventId 未签名 → 可无限重放建 run）。

要求：
- 签名覆盖 `timestamp + eventId + body`（签名输入串含全部三者，顺序稳定并文档化）。
- timestamp tolerance（如 ±5min）；eventId replay protection（已消费 eventId 拒收）；idempotency。
- 兼容性：新签名串改变后，旧签名拒绝（安全优先，不兼容旧格式；若有既有 e2e fixture 需同步更新——这是修复的一部分，不是放宽）。
- e2e：duplicate webhook / invalid signature / stale timestamp / replay。

## Approval Binding [P0]

现状：审批只绑定 run 整体，不绑定 action payload；执行时实际内容由外部数据渲染。

要求：
- Approval 增加绑定：runId + actionType + payloadHash（payload 稳定序列化后 sha256）。schema 改动由 Coordinator 处理（agent 不得动 schema）——**本规格依赖 Coordinator 已为 Approval 表新增 actionType/payloadHash 列？否：本包不加列**，改为：payloadHash 存入 Approval.payload JSON 内（`{ __binding: { actionType, payloadHash, boundAt } }`），不改表结构。
- 执行时重算 hash：`approved payloadHash != actual payloadHash` → 拒绝执行。
- financial/destructive/external_action 全部进入统一 approval predicate（审批复核谓词按 permission 分类，不只是 external_action）。
- 触发点：engine 审批门（agent-runtime-engine.ts 的 approval gate）与 workflow approval 步骤（workflow-executor）与 external-actions verifyApproval——三处统一走一个绑定校验 helper（可放 approvals 模块，避免三份实现）。

## 交付与自验

- 分支工作目录内自测：`npx vitest run <相关模块>` + 全量 e2e 相关文件；typecheck（`npx tsc --noEmit -p apps/api/tsconfig.json`）。
- 禁止：schema.prisma / migrations / prisma generate / migrate 命令；禁止改共享包 packages/shared（如必须新增错误码——先与 Coordinator 沟通）。
- 提交：在 worktree 分支上 commit（中文规范 message，注明修复的审计编号 F1/F2/…）。
- 完成后返回：修复清单（每项：文件、机制、测试数、自验结果）+ 未覆盖/NOT VERIFIED 项。
