# M12–M13 Final Baseline（2026-09-29）

> M12（自优化/数据反馈闭环）→ M13（最终产品化）→ 产品真实启动与最终验收，一次执行到底。
> 起点 M11 冻结 `9d30cdf`；计划载体 `docs/architecture/m12-m13-final-roadmap.md`（含 DAG、25 条红线、Deferred 裁决）。
> **项目终点 = M13；M14 不存在。**

## 1. 交付内容

- **M12-P1 CreativeLoop 学习桥**（d42c678）：verdict→下一决策闭环 + 判定窗口来源判别（external-only 谓词，堵死 performance.capture 伪造自证）。
- **M12-P2 Agent 表现回流**（1417c76）：analytics byAgent 维度 + AgentRun 聚合 + 候选表现排序消费。
- **M12-P3 记忆生命周期**（a84ad45）：outcome 驱动提升/降级 + 来源可信度闸门（origin=agent 只进候选，剔除 LLM 自由文本——堵死提示注入持久化通道）。
- **M12-P4 策略与实验**（90c6741）：SystemSettings 白名单写入口 + 阈值 SystemSetting 优先/常量兜底 + 实验受控晋级（CAS）。
- **M12-P5 数据面**（e843d4e）：孤儿附件清扫器 + analytics 聚合 cron + event 触发器**下线登记**（无生产发布端）。
- **M13-F1 全局框架**（961c38a）：AppShell 全局导航 + middleware 服务端鉴权 + UI 组件库 + useApiQuery/service 层。
- **M13-W2~W10**（133e3e3→f2e80d5）：Agents/Runs、Knowledge/Memory、Creative Workspace、Connections/Billing/Organization、Analytics/Feedback/Usage、Extensions、Dashboard、闭环断裂修复（审批 SSE 转发/Approvals、Artifacts REST+页、Settings、Ecommerce 只读标注）、复用完善（消息编辑删除、workflows 全写面、evaluation 最小写面）。

## 2. 最终验证（唯一一次完整验证 ×2 轮 + 定向修复）

- **api**：254 文件 / **2720 通过** + 3 跳过（第二轮全绿 exit 0）
- **web**：43 文件 / **463 通过**
- **typecheck** 4/4、**build** 3/3
- **Playwright 真浏览器**：**17 通过 / 0 失败 / 1 跳过**（登录/对话流 SSE/时间线/task 卡/只读页/浏览器安全/XSS）
- Final Audit：**0 CRITICAL / 0 HIGH**；2 MEDIUM（collectFacts 无界→已修 N+1 触顶 fail-closed；routingPolicy 写面范围→登记）+ 9 LOW 全部修复或登记

## 3. 冒烟实抓真 bug（修复后复跑）

1. feedback 幂等修复漏同步单元 spec（`memories_call` 仍锚 findFirst）→ d2c3b42
2. M13-W10 用户气泡外层 `flex.justify-end`→`group/user`，markdown-xss e2e 定位锚漂移 → 36c0506（testid 定位）
3. M11 遗留 chat-workspace history 查询键为路由 prop（新会话附件永不刷新）→ afe6bda 前修复

## 4. 产品启动状态（RUNNING）

| 组件 | 地址/端口 | 状态 |
| --- | --- | --- |
| PostgreSQL 16 + pgvector | localhost:5433 | healthy |
| Redis（64 DB） | localhost:6379 | healthy |
| MinIO | localhost:9000 | healthy |
| API（生产 dist） | **http://localhost:3001** | ready（db/redis/storage/queue 全 up） |
| Worker（BullMQ 6 队列 + 触发器恢复 165 + session-events） | 同 API 进程族 | 消费端已启动 |
| Web（Next 生产构建） | **http://localhost:3000** | /login 200；/ → 307 登录（服务端鉴权中间件）；同源代理 200 |

真实端到端：admin 登录（CSRF 守卫 + Cookie 会话）→ auth/me、conversations、system-settings、analytics/overview（102 条 usage 事实）、billing/usage（真实计费数据）全部 200。

## 5. 边界与记录保留

- M11-P17 小时级 soak **用户决定不做** 记录保留于 `m11-final-baseline.md`（Final Audit 第 4 项确认完好）。
- M13 结算项裁决保留于 roadmap §5：OCR/Thinking/Commerce 真适配器/毛利定价/embedding 快分类器/用户级模型指定/预签名直传一律不做。
- 25 条红线全程无违反（偏离登记制沿用）；迁移纪律：无 DROP INDEX 混入；LLM 零治理判定。
- Deferred/Future 不实现；无 M14 能力落地。

## 6. 上线后事故与修复（用户实机触发）

**事故**：用户浏览产品时打开 e2e 残留会话 → 附件行在库、字节不在盘（Playwright 临时存储与共享库错配）→ `createReadStream` 的 `error` 事件无消费者 → **整个 API 进程被打崩**（node unhandled 'error'）。

**修复（三层）**：
1. `storage-local.adapter.getStream`：字节缺失 → 确定性 `NOT_FOUND`（绝不返回裸 error 流）；
2. attachments / artifacts 两控制器：读流 error → 未发头 404、已发头断连（S3 等驱动 TOCTOU 兜底）；
3. e2e 自清理：task-card spec 结束删除测试会话（软删除语义，产品视图零残留）+ 新增回归测试
   （adapter 缺失文件/目录 NOT_FOUND ×2；attachments e2e「行在字节失 → 404 进程不崩」）。

**残留清理**：删除共享库中当日测试残留（131 会话/37 运行/14 任务/33 附件/2 制品，单事务 FK 安全序）+ 31 个对应磁盘文件。

## 7. 关键 commit

`d42c678` `1417c76` `a84ad45` `90c6741` `e843d4e`（M12 五并行）→ `961c38a`（F1）→ `133e3e3`~`f2e80d5`（W2~W10）→ `afe6bda`（Final Audit 修复）→ `d2c3b42` `36c0506`（最终验证实抓修复）
