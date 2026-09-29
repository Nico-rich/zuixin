# M12-P5 裁决记录：工作流的 `event` 触发器**已下线**

> 结论一句话：**平台没有生产事件发布端，`event` 触发器从未被真实事件驱动过**——因此从
> M12-P5 起，新建/更新工作流时提交 `type: 'event'` 会被**明确拒绝**（而不是静默接受一个永不生效的配置）；
> **既有**含 event 触发器的工作流原样保留，读/列表/运行/发布全部照常。

## 0. 裁决与出处

- 出处：`docs/architecture/m12-m13-final-roadmap.md` §1（M12-P5 数据面与杂项）——
  "event 触发器类型裁决：**下线**（无生产发布端且接线违反 G10 冻结）——登记并保留文档说明"。
- 本文即该"登记"，实现落在 `apps/api/src/modules/workflows/workflows.dto.ts`
  （`EVENT_TRIGGER_RETIRED_MESSAGE` + `superRefine`），契约锁定在 `workflows.dto.spec.ts`。

## 1. 为什么下线（三条，按可验证性从强到弱）

1. **没有生产发布端（可验证）**。event 触发器的运行时是"向 `EventBusService` 订阅一个 channel
   字符串"（`workflow-triggers.service.ts` 的 `registerEvent` → `events.subscribe(channel, handler)`），
   channel 完全来自用户输入。而平台上真实存在的发布者只有两类：
   - Agent 运行链路的**私域** channel（`agentRunChannel(runId)`，如 `run.cancelled` / `approval.decided`）；
   - 事件平台的 **`m8:event:<eventType>`** channel（`event-platform.service.ts` 的 `eventChannel`）。

   两者与"工作流订阅的字符串"之间**没有任何桥接代码**：没有任何模块把某类事件转发到工作流的订阅集合。
   换句话说，只有"测试/脚本自己 publish 到那个 channel"才能让它跑起来——现有 e2e 正是这么做的
   （`test/m7-p6-workflow.e2e-spec.ts` 直接 `bus.publish('wf-e2e-events', …)`），这正是"没有生产发布端"的证据。
2. **接线违反 G10（EventEnvelope 冻结）**。要让 event 触发器真在生产被驱动，就必须定义"哪些事件、
   以什么信封、按什么语义投递给工作流"——这是**新增事件投递语义**，与 M9 冻结的 EventEnvelope 契约冲突。
   冻结不是"暂时不动"，而是"不得为某个调用方再加一层投递语义"。
3. **留着它只会误导使用者**。一个能配、能发布、能出现在列表里、但**永远不会被真实事件触发**的触发器类型，
   比"没有这个类型"危险得多：使用者会以为自己的自动化已经上线了。

## 2. 下线方式（**只收写入面，不动存量**）

| 面 | 行为 | 位置 |
| --- | --- | --- |
| 新建（POST `/workflows`） | 含 `event` 触发器 ⇒ **400** `VALIDATION_ERROR`，文案见 §2.1 | `WorkflowDefinitionSchema`（`CreateWorkflowSchema` 内嵌复用） |
| 更新（PATCH/PUT `/workflows/:id`） | 同上（更新走同一份定义 schema） | 同上 |
| **既有**含 event 的工作流：读 / 列表 / 详情 | **不受影响**（读路径不经过写 DTO） | — |
| **既有**含 event 的工作流：运行（手工/API 触发） | **不受影响**（`POST /workflows/:id/runs` 不校验触发器类型） | — |
| **既有**含 event 的工作流：发布 / 重新发布 | **不受影响**：发布走 `validateDefinition`（`workflow-types.ts`）——**该处故意未改** | `workflow-types.ts` |
| `manual` / `webhook` / `schedule` | 三条真实链路**完全不受影响** | — |

设计原则：**存量工作流绝不因"某个触发器类型下线"而变成不可用**。下线只发生在"用户此刻提交一份新定义"这个动作上，
并且给出可照抄的替代方案（改 `manual` / `webhook` / `schedule`）。

### 2.1 错误形态（可直接照抄的契约）

```
HTTP 400
{
  "code": "VALIDATION_ERROR",
  "message": "参数校验失败：definition.triggers.1.type: event 触发器已下线（M12-P5）：平台无生产事件发布端，该类型从未被真实事件驱动过；请改用 manual / webhook / schedule（既有含 event 触发器的工作流仍可读取与运行）"
}
```

- 文案常量：`EVENT_TRIGGER_RETIRED_MESSAGE`（`workflows.dto.ts`）——**测试与文档都引用同一个常量**，改文案只需改一处。
- `path` 指到**具体数组元素**（`...triggers.1.type`）：多个触发器时能直接看出是第几个，不必逐个猜。
- 同一次提交里有多个 `event` ⇒ 每个都报一条（不会被"第一条就返回"掩盖）。
- 拒绝发生在 **DTO 层**（`ZodValidationPipe`），因此在任何业务副作用之前——不会出现"工作流建了一半"。

### 2.2 用户该怎么做

| 原意图 | 替代 |
| --- | --- |
| "某个业务事件发生后跑工作流" | 用 `webhook`：由事件源方（或你的事件平台消费者）签名调用工作流的 hook（签名 + 时间戳 + 重放防护已在既有实现里） |
| "定时跑" | 用 `schedule`（cron） |
| "人/系统手工触发" | 用 `manual`（`POST /workflows/:id/runs`） |

## 3. 存量数据处理

- **无需迁移**：数据库里的 `WorkflowVersion.definition` JSON **不做任何改写**（迁移纪律：历史不改写）。
- 含 `event` 的存量工作流仍然可以被读取、被运行、被重新发布；只有"再次提交定义（即新建/更新）"时才必须去掉它。
- 若某工作流确实依赖 event 触发，请在**决定替代方案之后**再更新它的定义（更新是覆盖式的：提交的新定义里不能再有 `event`）。

## 4. 验证（本裁决的测试证据）

`apps/api/src/modules/workflows/workflows.dto.spec.ts`（9 个用例，全绿）锁定：

- `validateDefinition`（存量读取/发布路径）**仍接受** event 触发器 —— 保证"存量不受影响"不是口号；
- `manual` / `webhook` / `schedule` 三种定义照常通过；`triggers` 缺省（可选）照常通过；
- 单个 `event` ⇒ 拒绝，且文案**逐字**等于 `EVENT_TRIGGER_RETIRED_MESSAGE`；
- `path` 断言两处：经 `CreateWorkflowSchema` 提交时是 `definition.triggers.1.type`，
  单独用 `WorkflowDefinitionSchema` 时是 `triggers.0.type`；
- 多个 `event` ⇒ 全部被标记；
- 更新 schema（`UpdateWorkflowSchema`）同样拒绝；
- 经 `ZodValidationPipe` 走一遍 ⇒ `code === 'VALIDATION_ERROR'` 且 message 含该文案；
- 未知字段（`z.strictObject`）照旧被拒——下线没有放松其它任何校验。

## 5. 已知影响（**跨模块**）

- `test/m7-p6-workflow.e2e-spec.ts` 的 `DEFINITION`（第 43~49 行）含 `{ type: 'event', event: 'wf-e2e-events' }`，
  并经 **HTTP 创建**（第 122 行 `.send({ name, definition: DEFINITION }).expect(201)`）——该用例会因本裁决
  得到 400 而失败。**已实测确认**（2026-09-29，真实 PG/Redis）：
  `Error: expected 201 "Created", got 400 "Bad Request"`，该套件 11 例全部 skip。
  **这属于 e2e 侧需要跟进的改动，不在 M12-P5 的所有权范围内**（见本 Phase 的最终报告"对其他 Agent 的依赖"）。
  同批次实测**不受影响**的 e2e：`m10-p15-idor-workflows`、`m7-p9-security`（共 15 例全绿）。
  建议的最小改法（二选一）：
  1. 从 `DEFINITION` 删除 event 触发器，并删掉依赖它的 `P6 event 触发` 用例（该用例同时失去前置条件）；
  2. 保留 P6 的**存量语义**验证：用 `prisma.workflowVersion` 直接落库一个含 event 触发器的定义（绕过写 DTO），
     再 `bus.publish(...)` 驱动它 —— 这恰好把"存量仍可运行"变成可回归的证据。
- 运行时接线（`workflow-triggers.service.ts` 的 `registerEvent`/`unregisterEvent`/`handleEvent`）
  **本次未改**：它仍是存量工作流的执行路径。若将来平台真的有了生产发布端，`registerEvent` 已具备
  "订阅失败绝不留下半成品"、"最后一个订阅者注销时精确解绑"等既有保障（D2-03）。
