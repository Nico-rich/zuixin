# M12-P5 数据面与杂项（Analytics 聚合 / 孤儿清扫 / 上传闸门 / mc 凭据清理）

> 本文件登记 M12-P5 里**面向上线运维**的四项增量（另两项在独立文档：
> PITR × 逻辑备份交叉验证见 `m12-pitr-backup-crosscheck.md`，
> event 触发器下线见 `m12-workflow-event-trigger-retirement.md`）。
> 四项都遵守同一条纪律：**默认安全侧（只读/干跑/拒绝），要"真动手"必须显式开**。

| # | 增量 | 默认态 | 打开方式 |
| --- | --- | --- | --- |
| 1 | Analytics 周期聚合（cron）+ `PerformanceSnapshot` 读面接线 | 周期作业**开通即生效**（自动建作业） | 无需动作；窗口/预算用 env 调 |
| 2 | 孤儿存储对象清扫 | 周期任务**干跑**（只统计不删） | payload `{"apply":true}` 或 env `STORAGE_ORPHAN_SWEEP_APPLY=true` |
| 3 | `backup --upload` 明文外发闸门 | 未加密 + 非本机端点 ⇒ **拒绝**（退出码 4） | `--allow-plaintext-upload`（显式承认风险）或 `--encrypt gpg` |
| 4 | `mc` 临时凭据文件的信号清理 | 进程被 `Ctrl+C`/`SIGTERM` 也会删除临时文件 | 无需动作（自动接管信号） |

---

## 1. Analytics 周期聚合（cron）+ `PerformanceSnapshot` 读面接线

### 1.1 问题（M12 审计项）

- **Analytics 没有 cron 聚合**：日/周/月数字只由"读路径按需算"产出（`refreshToday` 等），
  迟到事实（跨零点归因、后到的 usage）没有**后台**兜底；一旦没人打开页面，昨日数字就永远停在首次计算的样子。
- **`PerformanceSnapshot` 是死端**：创意反馈链路一直在**写**该表（`feedback.capturePerformance`），
  但没有任何读面消费它——写进去的数据从未被看过一眼。

### 1.2 做法

**（a）周期聚合**：新增 `AnalyticsAggregationService`（`modules/scheduler/`），走平台既有的
`RecurringJobProvisioner` 范式（**不新增队列**，与 metric-retention 同一条路）：

| 项 | 值 | 说明 |
| --- | --- | --- |
| handler | `analytics.aggregation` | 平台作业名 |
| 幂等键 | `platform:analytics-aggregation:v1` | **版本化**：语义变更才换 `v2`（绝不无声换键产生第二个作业） |
| cron | `*/5 * * * *`（UTC，每 5 分钟） | 单轮有界 ⇒ 代价恒定；够频繁 ⇒ 当日数字与读路径无肉眼可见分歧 |
| 超时 / 重试 | `300_000ms` / `maxAttempts 3` / `backoff 5s` | 失败退避重投；仍失败 → dead（运维面可见） |
| 执行方 | worker（调度器只登记与投递） | 与既有平台作业一致 |

聚合本体**不重复实现**：服务只做"周期触发 + 观测"，真正的刷新委托
`AnalyticsService.refreshStaleOrganizations`，其语义为：

- **窗口**：`days = ANALYTICS_AGGREGATION_DAYS`（默认 **2** = 今日 + 昨日；非法/非正回落默认，
  上限 31 —— 误配成 366 会让单轮变成全历史重算）。即"**一天只在其后一天内可被周期任务修，再往后冻结**"。
- **有界轮转**：单轮最多 `DEFAULT_ANALYTICS_AGGREGATION_MAX_ORGS = 50` 个组织，按**组织 id 游标**轮转
  （`nextCursor`，进程重启即从头 —— 重启不该跳过任何组织）；到预算即停并把 `truncated` 如实回显，余量下轮继续。
- **失败隔离**：单个组织出错**不打断**整轮（`failed` 计数 + warn）；失败组织下轮自然重试。
- **幂等**：刷新本身幂等，多进程游标重叠只浪费一点算力，不产生错误数据。

**（b）`PerformanceSnapshot` 读面接线**：`GET /analytics/overview` 新增 `snapshots` 字段
（`AnalyticsService.snapshotSummary`），口径：

- 回看窗 `PERFORMANCE_SNAPSHOT_WINDOW_DAYS = 30` 天；读路径**有界**（最多取 `SNAPSHOT_SUMMARY_LIMIT = 200` 行，
  超限 `truncated=true` —— 如实标注，绝不当成全量）。
- `facts` 只对**白名单里的六个可加标量**求和（`impressions/clicks/spend/conversions/revenue/orders`）；
  `metrics` 里的嵌套对象（`derived`/`subject`）**不合并**——把多期派生值相加只会造出一个假对象。
- `derived` 由合计值**重算**比率（体量加权；分母 0 → 0），不是"把各期比率加起来"。
- `latest` 给最近一条的 metrics 原文（要看未被合计的键走这里）；`layering` 明写三层口径
  （facts / derived / interpretation），避免下游把"我算的"当成"库里存的"。
- `empty` 分支与有数据分支**同形**（`entries: 0`），前端不必写两套渲染。

### 1.3 运维面

```bash
# 看本期聚合是否在跑：指标 analytics_aggregation_refreshed（value = 成功刷新的 (org, period) 组合数）
#   0 也是信号（跑了但没得刷），不是"没跑"；平台级事实 ⇒ organizationId 显式 null
# labels: organizations / periods / failed / truncated / from / to

# 调整窗口（默认 2 天；非法值回落默认，不会静默变成"全历史重算"）
ANALYTICS_AGGREGATION_DAYS=3

# 停用/恢复：作业由 provisioner 自动开通；停用后需运维显式 resume（inactiveHint 已写明）
```

- `truncated=true` 持续出现 ⇒ 组织数超过单轮预算（50），属预期行为（轮转会覆盖），不是故障。
- `failed>0` 的 warn 表示部分组织本轮未刷新，下轮重试；只有**连续**失败才需要人介入（dead 作业可见）。

### 1.4 未做（明确）

- **不新增汇总表**（红线：UsageRecord 是唯一计费事实源）；聚合只**刷新既有的** `AnalyticsAggregate`
  行（按 `organizationId + kind + period + source` upsert，无新表、无新副本、无 schema 变更），
  且刷新窗口天然有界（默认今日+昨日）。
- **不改读路径语义**：`overview` 的既有权重与口径未动，只**新增** `snapshots` 字段。

---

## 2. 孤儿存储对象清扫（StorageOrphanSweepService）

### 2.1 问题（M12 审计项："孤儿附件清扫器缺 storage list 能力"）

对象字节在对象存储（local 驱动即磁盘目录），元数据在 DB（`Attachment` / `Document` / `Artifact` 的
`storageKey`）。两条链路错位时（上传成功但事务回滚、任务失败只剩半截对象、历史清理只删了 DB 行），
字节就成了**无主孤儿的净增量**——没有任何既有机制回收（媒体清扫只动任务状态，不动物件）。

### 2.2 前置：`StorageAdapter.list`（**可选能力**）

```ts
interface StorageAdapter {
  list?(options?: { prefix?: string; limit?: number; cursor?: string | null }): Promise<{
    objects: { key: string; sizeBytes: number; lastModified: Date | null }[];
    nextCursor: string | null;
  }>;
}
```

- **可选**：未实现的驱动就是 `undefined`。调用方必须把"**驱动不支持枚举**"与"**枚举到 0 个对象**"
  当成两件事——清扫器遇前者记 `supported:false` 并告警，**绝不**把"没扫"报告成"干净"。
- `lastModified` 允许 `null`（驱动拿不到时间就如实给 null，**不是 1970 年**）；消费方一律按"年龄未知"保守处理。
- `local` 驱动用 `readdirSync + lstatSync` 递归枚举（遍历中的竞态删除 ⇒ 跳过该项，不炸整轮）；
  `s3` 驱动用分页 ListObjectsV2（继承既有的 abort/超时兜底）。

### 2.3 清扫判定（**保守到近乎保守过头**：对象删除不可逆）

| 规则 | 值 | 为什么 |
| --- | --- | --- |
| 只支持枚举的驱动才扫 | `supported:false` ⇒ 什么都不做 + 告警 | 不能把"能力缺失"说成"干净" |
| **超龄**才可能删 | `STORAGE_ORPHAN_MIN_AGE_DAYS`（默认 **7** 天） | 上传-落库的窗口、排队中的任务、刚生成还没登记的文件都在保护期 |
| **年龄未知永不删** | `lastModified === null` ⇒ 跳过（计入 `unknownAgeSkipped`） | 拿不到年龄就不猜 |
| 只删**三表并集都查不到**的 key | Attachment ∪ Document ∪ Artifact | 引用判定每轮**重算**，绝不缓存 |
| **保护前缀永不删** | `backups/ backup/ db-backups/ manifests/`（`STORAGE_ORPHAN_SWEEP_PROTECTED_PREFIXES` 只能**追加**） | 备份归档等非业务对象即便落在同一桶里也不动；只增不减，绝不因配置放开保护 |
| **默认干跑** | `apply=false` | 只统计不删除 |
| 有界 | 单页 200 / 单次最多 25 页 / 单次最多删 200；到顶即停并 `truncated` | 绝不长时间占用 worker |

**失败语义**：枚举失败（S3 超时等）**向上抛**（作业按失败重试），但抛出前会把本轮**部分统计**打成一条 warn
——"扫了一半炸了"必须与"扫完没发现孤儿"可区分。

**绝不做**：不动 DB 行、不动非超龄对象、不动年龄未知对象、不删保护前缀。

### 2.4 接线与运维

| 项 | 值 |
| --- | --- |
| handler | `storage.orphan-sweep` |
| 幂等键 | `platform:storage-orphan-sweep:v1` |
| cron | `41 4 * * *`（UTC，每日 04:41 —— 避开整点、UTC 日界与保留策略 03:23 时段） |
| 超时 / 重试 | `600_000ms` / `maxAttempts 3` / `backoff 5s` |
| 指标 | `storage_orphan_sweep_deleted`（value = 实际删除数；labels 见源码） |

```bash
# ① 先看一段时间（默认就是干跑）：读日志与指标 storage_orphan_sweep_deleted=0 / candidates>0 的差距
# ② 确认 candidates 都是真孤儿后再开启删除（二选一）：
#    - 单次：手动作业 payload {"apply":true}
#    - 常态：STORAGE_ORPHAN_SWEEP_APPLY=true
# ③ 放宽/收紧超龄门槛（默认 7 天；非法/非正回落默认）
STORAGE_ORPHAN_MIN_AGE_DAYS=14
# ④ 追加保护前缀（只会更保守）
STORAGE_ORPHAN_SWEEP_PROTECTED_PREFIXES=legal/,exports/
```

**观测口径**：`candidates>0 && deleted=0` 持续出现 = 清扫器在正常工作（干跑）；`supported=false` 是
**告警**信号（驱动不支持枚举 ⇒ 该环境根本没有孤儿回收，需换驱动或接受"无回收"）。**`scanned=0` 且
`supported=true`** 才算"桶是空的/没有超龄对象"。

**已知不足（诚实登记）**：`supported:false` 这条分支**当前不记指标**（只告警 + 报告文字），
因此"清扫器在这个环境里根本没工作"只出现在日志里，**不会进指标告警**。后续若要让它对告警可见，
需要在新指标（例如 `storage_orphan_sweep_supported`）上补一条，属**未做**项。

---

## 3. `backup --upload` 明文外发闸门

### 3.1 问题（M12 审计项）

`backup.ts --upload` 会把备份推到 `STORAGE_ENDPOINT` 指向的 MinIO/S3。若**未加密**（默认 `--encrypt none`）
且端点**不是本机**，那么"数据库全量明文"就离开了这台机器——而脚本此前不会为此要求任何确认。

### 3.2 判定（`scripts/lib/upload-gate.ts`，纯函数 + 单测）

| 上传 | 加密 | 端点 | 结果 |
| --- | --- | --- | --- |
| 否 | 任意 | 任意 | 放行（与本闸门无关） |
| 是 | `gpg` | 任意 | 放行（推荐形态，**不需要**任何确认） |
| 是 | `none` | **本机**（`localhost` / `127.0.0.0/8` / `::1` / `0.0.0.0` / `*.localhost`） | 放行 + **提醒**"仅限开发环境"（不要求确认） |
| 是 | `none` | **非本机**（含 `minio:9000` 这类 docker service name） | **拒绝**：退出码 `4`，除非给 `--allow-plaintext-upload` |
| 是 | `none` | 非本机 + `--allow-plaintext-upload` | 放行，但**留痕** `acknowledgementRequired=true` |

- **拒绝文案必须可照抄**：同时给出两条正路（`--encrypt gpg` / `--allow-plaintext-upload`）与"要发到哪个端点"。
- **`--dry-run` 也做这项检查**：dry-run 的价值正是"在没有任何副作用前暴露问题"，只在真实上传前拦截等于给假绿灯。
- **manifest 留痕**：`--upload` + 未加密时，校验清单里固定追加一条 `plaintext-upload-acknowledged`
  （`ok:true` —— 它记录的是"已按闸门口径放行"这个**事实**，不是"校验通过"），使"这次上传是明文"可被机器读取。
- 端点未配置（空串）按**非本机**处理（保守方向：宁可多要一次许可）。
- 边界（**有意**的诚实）：IPv4-mapped 形态（`::ffff:127.0.0.1`）**不**判为本机（URL 会把它规范化为
  `::ffff:7f00:1`），宁可多要一次 `--allow-plaintext-upload`，也不猜地址族语义。

```bash
# 开发链路（本机 MinIO）：自动放行，只打一行提醒
npx tsx scripts/backup.ts --label dev --upload

# 生产/远端：要么加密，要么显式承认风险（推荐前者）
npx tsx scripts/backup.ts --label daily --encrypt gpg --upload
npx tsx scripts/backup.ts --label offsite --upload --allow-plaintext-upload   # 不推荐：明文出机
```

### 3.3 实测（2026-09-29 本机，`--dry-run`，出口码为真实退出码）

| 命令（`DATABASE_URL` 指向本机 5433） | 上传闸门一行 | 退出码 |
| --- | --- | --- |
| `STORAGE_ENDPOINT=minio.example.com … --upload --dry-run` | `**未加密外发被拒绝**（原因见下）` + 两条正路 | **4** |
| `STORAGE_ENDPOINT=minio.example.com … --upload --allow-plaintext-upload --dry-run` | `明文备份上传到**非本机**端点 … 已由 --allow-plaintext-upload 显式确认（manifest 记录未加密事实）` | 0 |
| `STORAGE_ENDPOINT=http://localhost:9000 … --upload --dry-run` | `明文备份上传到**本机**端点 …（开发链路，未强制确认；生产请用 --encrypt gpg）` | 0 |

这三条也顺带证明：闸门**在 `--dry-run` 阶段就会触发**（不是等真正上传时才拦），且拒绝时打印的那一行
明确写"被拒绝"，不会与"无需确认"混淆。

---

## 4. `mc` 临时凭据文件的 SIGINT 清理

### 4.1 问题（M12 审计项："mc 凭据 SIGINT 残留"）

`docker` 形态的 `mc` 需要把凭证（`MC_HOST_*`）写进一个**临时 env 文件**再挂进容器。此前该文件只在
**正常返回路径**（`finally`）里删除——`Ctrl+C`（SIGINT）/`SIGTERM` 直接终止进程时，
**含密钥的文件会留在临时目录里**。

### 4.2 做法（`scripts/lib/mc.ts`）

- 只要有临时文件在场，模块就**临时接管** `SIGINT`/`SIGTERM`：先删除全部临时文件，再按 shell 惯例退出
  （`SIGINT → 130`、`SIGTERM → 143`）。
- 临时文件清零后**立刻卸载处理器**——不在空转时改变进程的信号语义（不吞掉其它代码的默认行为）。
- 清理**幂等**且**逐个兜底**（一个删不掉不影响其余），清理失败**绝不**卡住退出。
- 信号源可注入（`__setSignalSourceForTest`，仅供测试）：单测用假信号源验证"清理 + 退出码"，
  **绝不真的杀测试进程**。
- `native` 形态的凭证只经环境变量传递、**不落盘**，因此不涉及本机制。

---

## 5. 验证与未验证

**已验证（本轮）**：

- `apps/api/src/modules/scheduler`（含上述两个周期服务）与 `src/modules/analytics` 单测全绿
  （含幂等键版本化、cron 字段口径、预算/游标/失败隔离/`truncated`、停机不留定时器、`supported:false` 不误报"干净"）。
- `scripts/lib/upload-gate.spec.ts`（13 例）与 `scripts/lib/mc.spec.ts`（19 例，含 6 例信号清理）全绿；
  `scripts` 套件整体 7 文件 / 103 例全绿。
- `backup.ts` 的闸门接入以**真实 `--dry-run`** 验证（§3.3 三条命令：拒绝 4 / 放行 0 / 本机 0）——
  注意这是人工验证，**没有** backup.ts 级别的自动化用例（纯函数层才是被单测锁住的部分）。
- 存储 `list` 能力：`local` / `s3` 两个适配器各有单测（分页、`lastModified` 缺省、前缀、游标、竞态跳过）。
- **定向 e2e（真实 PG/Redis/BullMQ，2026-09-29）**：`test/m8-p4-analytics`（8 例）、
  `test/attachments`、`test/m11-p8-metric-retention`、`test/m8-p5-scheduler-events`（三文件 17 例）、
  `test/m10-p15-idor-workflows`、`test/m7-p9-security`（15 例）全部通过——
  说明两个新平台周期作业在应用引导期开通常规、`snapshots` 字段为纯增量、storage `list` 未改变既有读写路径。
  （**完整** e2e 套件不属本 Phase 范围，见 Wave 3 集成。）

**未验证 / 待运维确认**：

- 周期作业在本机**真实 worker** 上的首轮执行时间与是否与其它平台作业（保留策略 03:23）错峰符合预期
  （cron 已避开，但没有跑满 24h 观察）。
- 孤儿清扫的 `candidates` 在**真实生产桶**上的量级（本机 e2e 只有少量对象）——开启 `apply` 前请先干跑观察。
- S3 兼容端（非 MinIO）的 `list` 分页/`lastModified` 精度（只有 MinIO 环境可本机验证）。
- 明文闸门只覆盖 `backup.ts --upload`；`minio-mirror.ts` 等其它出网路径**不在**本闸门内（各有其角色）。
