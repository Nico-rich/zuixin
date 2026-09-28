# M10-P9 运维 Runbook（脚本化备份/恢复 + 季度演练 + 告警响应）

> **上游文档**：`docs/operations/m8-disaster-recovery.md`（RPO/RTO 目标、真相源分层、失败场景矩阵）、
> `docs/operations/m8-production-readiness.md`（健康检查分级、优雅停机、背压、熔断）。
> 本文件不重复它们的原理与手工命令，只做一件事：**把手册里的手工命令固化成可重复执行的脚本**，
> 并给出**真实跑出来的数字**与**退出码契约**，让"备份是否可用"从"看起来有文件"变成"有校验、有退出码"。
>
> **配套交付**：编排对象 `k8s/`（api/worker 独立 Deployment、SSE Ingress）、告警规则 `monitoring/alerts.yml`。

## 0. 可信度声明（先读这一节）

| 内容 | 状态 |
| --- | --- |
| `backup.ts` 对**本机 dev 库**真实执行（只读，未写入源库）| ✅ 真实执行（§2.4：13.58MB / 88 表 / 44,072 行 / 1.11s） |
| `restore.ts` 回灌到**新建临时库** + 指纹/逐表行数/关键表/**抽样内容**校验 | ✅ 真实执行（§4.4：88/88 表行数一致 + 3 张表逐行一致，临时库已销毁） |
| `restore.ts` 安全闸门（拒绝恢复到源库/系统库/非法标识符）| ✅ 真实执行（退出码 4，§4.2） |
| `minio-mirror.ts` 三条链路（目录→桶、桶→目录、桶→桶）+ 内容 md5 抽样 | ✅ 真实执行（§5.3，临时桶已删除） |
| 脚本单测 | ✅ 50 用例 / 4 文件全绿（`apps/api/scripts/vitest.config.ts`） |
| **生产量级**（TB 级库、百万对象桶）的耗时/内存 | ❌ **未验证**——本机库 13.58MB、桶 3 个对象，数字**不可外推**（§9） |
| **PITR**（WAL 归档 → `recovery_target_time`）| ❌ **未演练**——本脚本只做逻辑备份，RPO = 备份时刻（§2.1、§9） |
| K8s 清单在**真实集群**中的行为（探针、HPA、Ingress SSE）| ❌ **未验证**——本机无可用集群；且仓库**尚无 Dockerfile**（§6.1、§9） |
| 密钥管理系统（Vault/KMS）取回流程 | ❌ **未验证**——本机为 `.env` 直读；流程见 §3 |

**绝对不要把本机数字当成生产承诺。** 与 m8 手册相比，本文件的增量是"可重复 + 有退出码 + 有机器可读产物"，
不是"数字更可信"。

## 1. 脚本总览与调用方式

### 1.1 为什么是 `npx tsx scripts/xxx.ts`

三个脚本位于 `apps/api/scripts/`，**没有**在 `package.json` 里加别名（`scripts` 目录由本 Phase 独占，
但 `package.json` 是他人所有且并行 Agent 正在改动——加别名会引入合并冲突）。因此调用方式永远是：

```bash
cd apps/api
npx tsx scripts/backup.ts --help          # 先看帮助：每个脚本都有 --help，且 --help 不执行任何动作
```

`tsx` 已在 `apps/api` 的 devDependencies 里，无需额外安装。脚本零第三方依赖（只用 Node 内置 + `fetch`/`spawn`）。

### 1.2 三个脚本

| 脚本 | 作用 | 危险面 |
| --- | --- | --- |
| `scripts/backup.ts` | `pg_dump` 一致性快照 → 内容校验 → gzip → manifest → 可选上传 MinIO | **只读**（不对源库写入） |
| `scripts/restore.ts` | 回灌到**新建临时库** → 指纹 + 逐表行数 + 关键表 + **抽样内容逐行**校验 → 报告 | **默认 dry-run**；需 `--confirm` 才写库；硬闸门拒绝源库 |
| `scripts/minio-mirror.ts` | 桶/目录 mirror（mc）+ 对象数/体积核对 + 可选内容 md5 抽样 | 默认不删目标（`--delete` 才删） |

### 1.3 退出码契约（所有脚本统一，便于 CI/告警判定）

| 码 | 含义 | 运维含义 |
| --- | --- | --- |
| 0 | 成功 | 校验全绿（不是"命令没报错"） |
| 1 | 执行失败 | 子进程非 0 / IO 错误——**看 stderr** |
| 2 | 参数错误 | 未知参数、取值非法、缺必填——修正调用 |
| 3 | **校验失败** | 备份/恢复结果与期望不一致（空文件、表数缩水、行数不符）——**备份不可用** |
| 4 | 前置条件不满足 | 依赖缺失、目标库不安全、文件不存在 |

> 关键设计：**"文件存在且非空"永远不等于"备份可用"**。`--expect-tables` / `--min-rows` 让"备份到空库"
> 这类事故以退出码 3 暴露，而不是以"备份成功"的记录留在日志里（m8 手册 §3.1 的第 63 行就是这个教训）。

### 1.4 env 来源与凭证纪律

- 配置从**进程环境**或 `.env` 读（`--env-file` 可指定；不传则按 `cwd/.env` → `<仓库根>/.env` 搜索）。
- **绝不硬编码密钥**；**绝不把密钥放进命令行参数**（argv 在 `ps`/审计日志里可见）。
  PG 口令经 `PGPASSWORD` 环境变量传给子进程；MinIO 凭证经临时 env 文件（0600、用完即删）传给一次性 `mc` 容器。
- 回显与错误信息统一过脱敏（连接串变 `postgresql://agent:***@host/db`）。

### 1.5 输出目录纪律（容易踩）

三个脚本的 `-o/--out-dir` **默认是 `<仓库根>/backup`**，而 `.gitignore` **没有** `backup/` 条目
（该文件归他人所有，本 Phase 不改既有文件）。因此在开发机上裸跑会在工作区留下未跟踪文件：

```bash
# 推荐：显式指到仓库外（CI/生产同理：备份不该落在应用工作目录里）
npx tsx scripts/backup.ts -o /var/backups/agent-platform --label daily
# 或设环境变量（等价）
BACKUP_DIR=D:/backups npx tsx scripts/backup.ts --label daily
```

## 2. 备份（`scripts/backup.ts`）

### 2.1 语义边界（先明确它**不是**什么）

- **是**：全库逻辑备份（`pg_dump --format=plain`），单事务一致性快照；`--no-owner --no-privileges`
  让 dump 能在**不同角色的库**上回灌；`--clean --if-exists` 让 dump 自带"先删后建"，可重复回灌。
- **不是**：物理备份 / PITR。**RPO = 备份时刻**（两次备份之间写入的数据在灾难中会丢）。
  要 PITR 必须开 WAL 归档 + 定期基础备份——**本 Phase 不做**（见 §9，属明确 Deferred）。
- 只读性：`pg_dump` 不开写事务，不碰源库数据（`--lock-wait-timeout=15s` 保证它宁可失败也不长时间锁表）。

### 2.2 常用命令

```bash
cd apps/api

# ① 先看计划（不执行 pg_dump）：确认库、输出路径、磁盘余量、密钥存在性
npx tsx scripts/backup.ts --dry-run

# ② 日常备份（带表数下限校验——这是把"备份到空库"变成失败的关键）
npx tsx scripts/backup.ts -o /var/backups/agent-platform --label daily --expect-tables 88 --min-rows 30000

# ③ 迁移前备份（标签进文件名，便于回滚时定位）
npx tsx scripts/backup.ts -o /var/backups/agent-platform --label pre-migration --expect-tables 88

# ④ 上传异地桶（**不要**用业务桶：备份桶应单独授权 + 单独生命周期）
npx tsx scripts/backup.ts -o /var/backups/agent-platform --label offsite --upload --bucket db-backups --prefix postgres/

# ⑤ 保留策略（默认只提示不删；--prune 才真删，且只删本脚本命名规则的产物）
npx tsx scripts/backup.ts -o /var/backups/agent-platform --prune --prune-keep 30
```

`--keep-plain` 保留未压缩 `.sql`（默认压缩后删明文）；`--no-compress` 只留 `.sql`（大库慎用）；
`--force` 允许覆盖同名备份（默认拒绝，防手滑覆盖当日备份）。

### 2.3 产物

| 产物 | 内容 |
| --- | --- |
| `agent_platform-<label>-<stamp>.sql.gz` | 备份本体（自描述、可 `psql -f -` 流式回灌） |
| `agent_platform-<label>-<stamp>.manifest.json` | **机器可读的"备份证明"**：大小/sha256、逐表行数、校验结论、耗时、密钥存在性 |

manifest 是整个流程的关键：**恢复前后不必再去翻日志**，"这份备份当时是什么状态"以它为准。
`restore.ts` 也会把自己那一侧的校验结果写成 `restore-<库>-<stamp>.report.json`。

### 2.4 实测（2026-09-28，本机 dev 库，只读）

命令：`npx tsx scripts/backup.ts --env-file <仓库根>/.env -o <temp> --label m10p9-drill --expect-tables 88`

| 指标 | 数值 |
| --- | --- |
| `pg_dump` 版本 | PostgreSQL 16.15（Debian），经 `docker exec docker-postgres-1` |
| 明文 dump | **13,584,317 字节（12.96 MB）**，50,836 行 |
| 耗时：dump / 统计 / gzip-6 | **729ms / 52ms / 141ms**（合计 **1,115ms**） |
| 结构统计 | 88 张表、88 个 COPY 段、44,072 行数据、192 条索引语句、33 行 `_prisma_migrations` |
| 扩展 | `pgcrypto`、`vector` |
| 关键表行数 | User=611、Organization=551、AgentRun=884、UsageRecord=1264、Credential=2、`_prisma_migrations`=33 |
| gz 产物 | 2,356,235 字节（压缩比 **5.77×**），sha256 `560fa815d560a1df44fcfd232b28fccd18c804eaad822e9d7d569870487cdf34` |
| 校验结论 | 4/4 通过：file-non-empty / has-tables / copy-segments-match-tables / row-count-floor |

**顺带暴露的真实问题**：manifest 的 `secrets` 段落报 `STORAGE_ACCESS_KEY_ID` / `STORAGE_SECRET_ACCESS_KEY`
来源是 `default-placeholder`（值为 `minioadmin`）。这正是这一步的意义——**开发库的占位符凭证会在备份阶段
就被标记出来**，而不是等到生产上线后才发现。

### 2.5 生产改写

- `--pg-mode direct`：在**有 pg 客户端的主机/Job** 里直连（`PGHOST/PGPORT/PGUSER/PGPASSWORD`），
  不依赖"能 docker exec 进数据库容器"这种特权（托管 PG 上根本不存在）。
- 库大时把 `-o` 指到大容量卷；`--expect-tables` 用**当前真实表数**（迁移后会变，把它写进巡检任务里自动更新）。
- 上传异地用专用桶 + 专用最小权限凭证（只允许 `PutObject`/`ListBucket` 到该前缀）。
- **定时备份（推荐形态）**：`nest build` 会把 `scripts/**` 一起编译进 `dist/scripts/`，
  所以**同一个镜像**就能跑备份 Job（无需在镜像里装 tsx）：

  ```bash
  node dist/scripts/backup.js --out-dir /var/backups/agent-platform --label daily --expect-tables <n>
  ```

  已实测：`node dist/scripts/backup.js --help` 退出码 0、`node dist/scripts/restore.js`（缺 `DATABASE_URL`）
  退出码 4——与 tsx 版本行为一致。K8s 里用 CronJob + 只挂备份卷（或 `--upload` 直传备份桶），
  把 `DATABASE_URL` 等从 Secret 注入（进程环境优先于 `.env`，见 §1.4）。

  > ⚠️ 顺带发现（**既有不一致**，本 Phase 未改）：`apps/api/package.json` 的 `start` 写的是
  > `node dist/main.js`，但 `tsconfig.json` 的 `include` 含 `src/scripts/prisma`，rootDir 被提升到 `apps/api`，
  > 实际产物是 **`dist/src/main.js`**（实测）。因此 `k8s/*-deployment.yaml` 的入口用的是
  > `node dist/src/main.js` / `dist/src/worker.js`；顺手修 `start` 脚本前，本地 `pnpm start` 会 MODULE_NOT_FOUND。

## 3. 密钥备份与取回（RPO=0 清单）

### 3.1 为什么单列一节

**数据库备份救不了丢了 `ENCRYPTION_KEY` 的系统。** 备份文件里只有密文；密钥丢了，`Connection`/`Credential`
里的 provider 凭证、webhook secret 全部永久不可解，只能让用户重新授权（m8 手册失败矩阵最后一列）。
这类数据的 RPO **不是**"上次备份"，而是 **0**：密钥必须与数据同等或更高频地备份。

### 3.2 RPO=0 清单（`backup.ts` 会在每次运行时检查存在性并写进 manifest）

| 键 | 丢了会怎样 | 备注 |
| --- | --- | --- |
| `ENCRYPTION_KEY` | **不可恢复**：已存凭证/密钥全部作废 | 与数据库备份**分开存放**、同等加密、多副本 |
| `JWT_SECRET` | 全部会话失效（用户重登即可） | 可与 ENCRYPTION_KEY 同等对待，但**绝不复用同一个值** |
| `DATABASE_URL` | 不知道往哪恢复 | 含口令；属于"恢复所需元数据" |
| `REDIS_URL` | 队列/总线要重建（可重建，见 m8 §5） | 含口令；低风险但仍属凭证 |
| `STORAGE_ACCESS_KEY_ID` / `STORAGE_SECRET_ACCESS_KEY` | 对象存储写不进去 | 生产用 IAM/STS 时改为角色，不要长期静态密钥 |

### 3.3 备份流程（4 步）

1. **导出**：把 `.env`（或密钥管理系统的导出）复制到**仓库之外**的加密位置。**不要**放进 `backup/`——
   备份目录常在 CI 产物/共享卷里流转，密钥必须走另一条通道。
2. **加密**：用运维侧的加密工具（age/gpg/SOPS/KMS）加密后再落盘；**不要**明文 `.env` 进对象存储。
3. **异地**：至少两处（如对象存储的密钥桶 + 离线介质），与数据库备份**不同凭证、不同生命周期**。
4. **记录指纹**：记录 `ENCRYPTION_KEY` 的**长度与 sha256 前 8 位**（不要记录值本身），
   用于日后核对"我手里这把是不是当时那把"——`backup.ts` 的 manifest 已记录长度与来源。

`backup.ts --env-backup-dir <dir>` 会对"人工存放的 .env 副本"做**存在性提醒**（默认 `<out-dir>/env`）：
它不替代上面 4 步，只是把"你有没有把密钥副本放在该放的地方"变成每次都看得见的一行输出。

### 3.4 取回流程（3 步）

1. 从异地取回**加密副本**，先在**隔离环境**解密（不要在生产主机上解密后再传输）。
2. 与 §3.3 第 4 步记录的指纹核对（长度/sha256 前 8 位）。
3. **用备份的密钥 + 备份的库做一次解密抽查**（§4.5）——这是唯一能证明"密钥与数据配套"的方法。

## 4. 恢复演练（`scripts/restore.ts`）

### 4.1 三步法

```bash
cd apps/api

# ① 计划（默认行为就是 dry-run：不建库、不写任何数据）
npx tsx scripts/restore.ts --dump /var/backups/agent-platform/agent_platform-daily-20260928-030000.sql.gz \
    --target-db drill_20260928

# ② 真恢复（临时库；校验完自动 DROP）
npx tsx scripts/restore.ts -f <上面同一个文件> -t drill_20260928 --confirm

# ③ 让临时库留下来做人工取证（默认会删）
npx tsx scripts/restore.ts -f <...> -t drill_20260928 --confirm --keep

# ④ 拧抽样内容核对的表数（默认 3 张；0=关闭；超大库想只跑行数就加 --skip-rowcount-all）
npx tsx scripts/restore.ts -f <...> -t drill_20260928 --confirm --verify-sample 5
```

**为什么必须是"新建临时库"**：`--clean --if-exists` 的 dump 回灌到已有库会**先 DROP 再建**。
脚本因此设了硬闸门，拒绝以下目标（退出码 4，实测见 §4.2）：
目标库名 == `DATABASE_URL` 的库名（即"就地覆盖源库"）、`postgres`/`template0`/`template1`、
非 `^[a-z_][a-z0-9_]{0,62}$` 的名字（`CREATE DATABASE` 拼接的注入面）。

> **生产就地恢复 / 切主**不在这条路径上，仍走 m8 手册 §4.2 的人工流程（摘流量 → 停 Worker →
> 先备份"损坏前现状" → 恢复 → 校验 → 起 API → 起 Worker）。脚本**故意不提供**"就地覆盖生产库"的捷径。

### 4.2 安全闸门实测

```bash
# 例 1：目标 = 系统库（可随时复跑的安全示例）
npx tsx scripts/restore.ts -f <backup> -t postgres --confirm --env-file <env>
# → 安全闸门：拒绝 — 拒绝以系统库 "postgres" 作为恢复目标
# → [error] 安全闸门拒绝：...      ← 退出码 4
#   拒绝发生在**任何库操作之前**：不建库、不写入、连备份的数据段都不读
#   （计划/选表照打——它们只依赖"解析 dump 得到行数"这一步）

# 例 2：目标 = 源库（"就地覆盖"，同样拒绝；不要在生产/共享环境上试这条，除非你只是想看它被拒绝）
npx tsx scripts/restore.ts -f <backup> -t agent_platform --confirm
# → 拒绝恢复到源库 "agent_platform"：恢复脚本只在**新建的临时库**上工作（就地恢复见 §4.2，需人工执行）
# → 退出码 4
```

### 4.3 校验口径（**最容易搞错的地方**）

逐表行数**与 dump 文件自身的 COPY 段比对**，**不与源库当前行数比对**——
源库在备份之后仍在被写入，拿源库当前行数当基准只会得到假失败（m8 手册 §4.1 ⑤ 的教训）。
脚本的做法：先解析 dump 得到"备份时刻的逐表行数"，回灌后逐表 `count(*)` 比对，并额外点名关键表。

**四层校验（A→D），一层比一层硬**：

| 层 | 查什么 | 查不出什么 |
| --- | --- | --- |
| A 指纹 | 表/列/索引/枚举/外键/迁移数/扩展 七项与 dump 声明一致 | 数据对不对 |
| B 逐表行数 | 88/88 张表 count(*) 与 dump 的 COPY 段一致（含"恢复库多出的表"） | **行数相同但内容损坏**（截断、转义错误、字符集问题） |
| C 关键表 | 6 张业务表逐张点名（User/Organization/AgentRun/UsageRecord/Credential/`_prisma_migrations`） | 同上 |
| **D 抽样内容**（`--verify-sample`，默认 3） | 回灌后对抽中的表**再 `pg_dump --data-only -t` 一次**，与备份里那一段 COPY **逐行原样文本**比对 | 未被抽中的表（抽样，不是全量） |

D 层的两个关键取舍：
- **为什么"再 dump 一次"而不是自己格式化行**：两侧都来自 `pg_dump`，同一个值必然渲染成同一行文本；
  原样比较比"解码后比较"更严格（连转义写法不一致都能发现），也没有自己实现 COPY 转义（`\N`/`\t`/`\\`）
  出错而**把真实损坏误判成通过**的空间。
- **选表规则**：一半名额给关键业务表（有数据且 ≤2000 行），其余从合格表里**等距抽**（首尾都取到）；
  空表与超限表一律跳过并打印告警——**超限表"两侧同样被截断"会得出假通过**，所以宁可不比。
  同一份 dump 每次抽到同一批表（确定性），演练报告才可比。差异**只报行号不回显数据**（数据行可能含用户数据/密文）。

代价：默认抽样给本机演练加了约 1.3~1.8s（3 张表各一次 `pg_dump -t`；本机负载有噪声，量级参考即可）。
超大库可 `--verify-sample 0` 关闭，但那样 B/C 层就回到"行数对了不代表内容对"的强度——**演练时不要关**。
另外注意：**选表**（纯函数，秒级）在计划阶段就打印，**采集数据行**（第二遍读备份文件）只在真正执行恢复时才做——
所以 dry-run 不会因为"看一眼计划"就把 GB 级备份解压一遍；这也是安全闸门拒绝后不再读文件的原因。

### 4.4 实测（2026-09-28，临时库 `m10p9_drill_20260928` / `m10p9_drill2_20260928` / `m10p9_drill3_20260928`）

同一份备份（`agent_platform-m10p9-drill-20260928-132425.sql.gz`，sha256 `560fa815…cdf34`）跑了三轮：
首轮只有 A/B/C 三层校验，之后两轮都带上默认的 D 层抽样内容比对（末轮在上面的"计划阶段不读文件"调整之后）。

| 步骤 | 首轮（无内容抽样） | 复跑（默认 `--verify-sample 3`，同一份备份连跑两次） |
| --- | --- | --- |
| 建库 | `CREATE DATABASE <临时库> TEMPLATE template0`（模板库隔离，不受生产模板污染） | 同 |
| 回灌 | `psql -v ON_ERROR_STOP=1 -f -` 退出码 0，**stderr 0 字节**，耗时 **3,336ms** | 退出码 0，stderr 0 字节，耗时 **2.80s / 4.16s** |
| A 指纹（七项） | 表 88 / 列 1026 / 索引 280 / 枚举 38 / 外键 152 / 迁移行 33 / 扩展 `pgcrypto,plpgsql,vector` | 同（逐项相同） |
| B 逐表行数 | **88/88 张表全部一致**，恢复库合计 44,072 行 == dump 44,072 行 | 同 |
| C 关键表 | User 611/611、Organization 551/551、AgentRun 884/884、UsageRecord 1264/1264、Credential 2/2、`_prisma_migrations` 33/33 | 同 |
| **D 抽样内容** | —（该轮尚未实现） | 抽中 **User 611 行、Organization 551 行、Plan 36 行**：三张表**逐行原样文本全部一致** |
| 结论 | `verdict: PASS`，报告 `totalMs` **4,988ms** | `verdict: PASS`，报告 `totalMs` **4,321ms / 6,758ms**（进程总耗时 4.89s / 8.15s，含 env 加载与报告落盘） |
| 清理 | 临时库已 DROP；`pg_database` 仅剩 `agent_platform`、`agent_platform_shadow`、`postgres`、`template0/1` | 同（三次演练后再次核对，仍只剩这 5 项）——**dev 主库全程未被触碰** |

> D 层为什么抽到 `Plan` 而不是别的：一半名额被关键表 `User`/`Organization` 拿走（`n=3` ⇒ `ceil(3/2)=2`），
> 剩 1 个名额从合格表里等距抽（`n=1` 时取排序后的中位）。这是**刻意的确定性**——同一份 dump 每次抽同一批，
> 演练报告才有可比性。想覆盖更多表就用 `--verify-sample <n>`。

> 注意指纹里的 `plpgsql`：它在恢复库中作为扩展出现（template0 自带），dump 侧只记录 `pgcrypto,vector`。
> 脚本据此只比对 dump 声明过的扩展，不会把这种模板差异误报为失败——但**值得知道**，
> 否则人工比对时会以为"多了个扩展=恢复出错"。

### 4.5 恢复后必做：凭证解密抽查（脚本只打印步骤，不代做）

脚本在恢复结束时会打印这段检查清单，**必须人工执行**——因为脚本刻意不持有业务解密逻辑
（让备份工具能解开业务密文，等于把 `ENCRYPTION_KEY` 的泄露面扩大到运维脚本）：

1. 用**备份里那一份** `ENCRYPTION_KEY` 起一个临时 API 进程（指向恢复库）。
2. 查 `Connection` / `Credential` 的条数，与备份 manifest 的关键表行数核对（本次：Connection=1、Credential=2）。
3. 取出 1~2 条 `Credential` 的密文，经 `apps/api/src/core/crypto/crypto.service.ts` 的解密路径验证：
   **能解出明文 ⇒ 密钥与数据配套；抛解密错误 ⇒ 拿错密钥**（此时数据没问题，是密钥不对——别去重灌备份）。
4. 把结论写进演练记录（§8 第 4 步）。**没有做这一步的演练不构成"备份可用"的证据。**

## 5. 对象存储 mirror（`scripts/minio-mirror.ts`）

### 5.1 三条链路

```bash
cd apps/api

# ① 桶 → 异地目录（最常用：把生产桶拉到备份盘/异地挂载点）
npx tsx scripts/minio-mirror.ts -s agent-storage -t /mnt/offsite/agent-storage --mkdir-target

# ② 桶 → 异地桶（跨集群/跨账号；生产推荐）
npx tsx scripts/minio-mirror.ts -s agent-storage -t agent-storage-offsite --checksum-sample 3

# ③ 目录 → 桶（回灌）；local 驱动的数据在 ./data/storage，用「目录 → 目录」备份它
npx tsx scripts/minio-mirror.ts -s /mnt/offsite/agent-storage -t agent-storage-restore-20260928 --mkdir-target
```

- **默认不删**目标端多余对象；`--delete` 才会镜像删除（**演练永远指向临时桶/临时目录**）。
- `--checksum-sample N` 对 N 个抽样对象做**内容级 md5 比对**（端点+等距抽样，可复现）；
  默认 0 = 只比对象数与体积（GB 级桶上做全量哈希是 O(全量读取)，不适合每日执行）。
- 目标目录必须已存在，除非显式 `--mkdir-target`（"目标写错地方"是这类脚本最常见的事故）。
- 目标桶默认自动创建（`--no-make-bucket` 可关，用于生产严格管控）。

### 5.2 核对输出与退出码

无论哪条链路，最后都打印源/目标的**对象数 + 总体积**，不一致即退出码 3：

```
源  ：3 个对象 / 193 KB（197632 字节）
目标：3 个对象 / 193 KB（197632 字节）
结论：PASS —— 目标 3 个对象 / 193 KB（197632 字节），与源一致（总耗时 1.52s）
```

目录侧与桶侧用的是**同一套数据结构与同一口径**（`summarizeDir` / `parseMcListJson` → `diffMirror`），
所以"桶↔目录"核对不会出现两套标准；`mc ls` 的目录占位项被显式排除（否则对象数永远对不上）。

### 5.3 实测（2026-09-28，临时桶，用后即删）

| 链路 | 结果 | 耗时 |
| --- | --- | --- |
| 目录 → 桶 | 3 个对象 / 197,632 字节，两侧一致 | 2.56s |
| 桶 → 目录 | 3 个对象 / 197,632 字节，两侧一致 | 1.52s |
| 桶 → 桶 | 3 个对象 / 197,632 字节，两侧一致 | 1.75s |
| 内容抽样（`--checksum-sample 3`） | 3/3 `match`：`obj-a.bin` `d3d1bd2a…`、`obj-b.bin` `3d2a48d8…`、`nested/obj-c.bin` `1de92c8b…` | 3.35s |

测试对象在**仓库之外**的临时目录（避免污染 git 工作区），临时桶 `m10p9-src-*` / `m10p9-dst-*` 已用
`mc rb --force` 删除；未触碰业务桶 `agent-storage`。

## 6. K8s 编排（`k8s/`）

### 6.1 apply

```bash
kubectl apply -k k8s/        # 渲染校验：kubectl kustomize k8s/
```

**Secret 不在 `resources` 里**（`secret.example.yaml` 只是键名清单，值是 `REPLACE_ME`）：
密钥由 External Secrets / Sealed Secrets / `kubectl create secret` 单独创建。
Secret 缺席时 Pod 停在 `CreateContainerConfigError`——**这是期望行为**：宁可起不来，也不要静默空密钥启动。

**当前没有 Dockerfile**（仓库内不存在，本 Phase 只交付编排对象）。镜像名/标签是占位符，
apply 前必须替换；构建要点见 `k8s/api-deployment.yaml` 的注释（`node dist/main.js` / `dist/worker.js`、
USER 非 root、`.dockerignore` 排除 `.env`）。**特别注意**：`apps/api/src/env.ts` 加载 `.env` 时
第二次调用带 `override: true` ⇒ 镜像的工作目录里若有 `.env`，它会**覆盖** ConfigMap/Secret 注入的值。

### 6.2 关键参数（都有"为什么"，改动前先读 @k8s 内注释）

| 参数 | 值 | 理由 |
| --- | --- | --- |
| `terminationGracePeriodSeconds` | **45**（硬底线 35） | 应用侧 30s 兜底 + 缓冲；小于 35 会让 SIGKILL 绕过收尾、在途 job 被打断 |
| `preStop` | `sleep 5` | 摘 endpoints 与发 SIGTERM 是并发的，给 LB 一点时间；剩余 40s 仍 > 30s 兜底 |
| `livenessProbe` | `/api/v1/live`，10s×3 | **零 I/O**：依赖抖动绝不触发重启（重启治不好下游） |
| `readinessProbe` | `/api/v1/ready`，5s×2，timeout 3s | DB/Redis critical；对象存储故障时**不摘流量**（设计如此） |
| `startupProbe` | `/api/v1/live`，2s×30 | 给冷启动 60s（Prisma/ioredis 建连），期间 liveness 不生效 |
| API 副本 | 2（RollingUpdate `maxUnavailable: 0`） | 无本地会话状态：JWT 无状态 + Redis 承载队列/总线 |
| Worker 副本 | 2（独立 Deployment + HPA 2→12） | 负载特征与故障域都与 API 不同；`worker-hpa.yaml` 有"CPU 只是代理信号"的诚实标注 |
| Worker 探针 | **无** | Worker 用 `createApplicationContext`，**不监听端口**；进程真死会退出→重启。**盲区**：Redis 长时间抖动时进程活着但不消费，编排层看不见 ⇒ 靠 `queue_depth` 告警与 §7 的人工判据 |
| `TRUSTED_PROXY_HOPS`（全局限流） | **1**（= 客户端→Ingress→Pod 的代理层数） | 全局限流按 IP 分桶，IP 取自 XFF 链**右起第 N 跳**（抗伪造：客户端只能往左追加）。**写大了**：链长不足会回退 socket 地址（此时是 Ingress Pod IP）⇒ 全员共用一个桶、正常用户先被打爆；**写小了/0**：同上退化为共享桶。**加一层代理（CDN/mesh）必须 +1**。排查见 §7.4 |

### 6.3 SSE（最容易配错的一处）

应用侧（`apps/api/src/modules/chat/sse-writer.ts`）已设 `X-Accel-Buffering: no`，但那只是**提示**。
反向代理默认缓冲响应体 ⇒ 客户端表现为"卡住几十秒后一次性喷出"。因此 `k8s/ingress.yaml` 必须保留：

```yaml
nginx.ingress.kubernetes.io/proxy-buffering: "off"      # 决定性的一条
nginx.ingress.kubernetes.io/proxy-read-timeout: "3600"  # 默认 60s：SSE 空闲超过就断
nginx.ingress.kubernetes.io/proxy-http-version: "1.1"   # 1.0 会退化，失去流式
```

修改 Ingress 后**必须**用 `curl -N` 逐个端点验一次（命令见该文件头部）；若某层还在缓冲，
表现是"整段停顿后一次性打印"。另外 `proxy-body-size: 256m` 是因为应用侧 video 上限 200MB——
代理侧更紧会让请求在到达应用前就被 413 拒掉。

### 6.4 未验证

本机**没有可用集群**（`kubectl cluster-info` 连接被拒），清单只做了 `kubectl kustomize` 渲染校验与
YAML 解析校验，**未**做过 `kubectl apply` / 探针行为 / HPA 缩放 / Ingress SSE 的实机验证（§9）。

## 7. 告警响应表（`monitoring/alerts.yml`）

### 7.1 规则状态（**先看这列，避免误以为已覆盖**）

| 规则 | 触发条件 | 状态 |
| --- | --- | --- |
| `ApiReadyUnavailable` | `/ready` 探测失败持续 1min | ✅ **可用**（blackbox_exporter，无需应用改动） |
| `ApiPodRestartLoop` | 15min 内重启 >2 | ✅ 可用（kube-state-metrics） |
| `GracefulShutdownTimeout` | 容器以退出码 1 终止 | ⚠️ **近似**（exit 1 也可能是别的崩溃，须看日志确认） |
| `AgentRunQueueBackpressure` | `queue_depth/1000 > 0.5` 持续 5min | ⛔ **待导出**（应用已采样，但无 Prometheus 导出器） |
| `AgentRunQueueSaturated` | `queue_depth ≥ 1000` | ⛔ 待导出（同上；此时 429 已对用户可见） |
| `SchedulerJobDead` | `increase(scheduler_job_dead_total[10m]) > 0` | ⛔ 待导出（当前只有事件/日志，无计数器） |
| `StorageDependencyDegraded` | 存储依赖 down 持续 5min | ⛔ 待导出（只能从 `/health` 的 JSON 取） |

**为什么"待导出"**：应用的可观测事实在 `MetricSample` 表里（`apps/api/src/core/tracing/observability.service.ts`），
读取面是 JWT 保护的 JSON API（`GET /api/v1/metrics`）——既不是 Prometheus 文本格式，也不该给 Prometheus 直接抓。
规则里的指标名（`queue_depth` 等）**与 MetricSample 对齐**，导出器一落地即可生效；在此之前它们是缺口清单。

### 7.2 处置表（含"今天就能用"的人工判据）

| 告警 / 现象 | 含义 | 首查 | 处置 | **不要做** |
| --- | --- | --- | --- | --- |
| `ApiReadyUnavailable`（P1） | DB 或 Redis critical 依赖故障，LB 已摘流量 | `curl /api/v1/health` 看 `checks[].critical`、`status`、`db/redis.state` | DB 故障 → m8 §4.2（PITR 优先，否则最近 pg_dump）；Redis 故障 → **不恢复数据**，重启 Worker 靠 `recoverStale` 重投（m8 §5） | **不要重启 API Pod**：重启治不好下游，只丢在途请求 |
| `ApiPodRestartLoop` | 进程级问题（OOM/异常/启动失败） | `kubectl describe pod` 的 Last State | OOMKilled → 提 memory limits；Error+exit1+日志「优雅停机超时」→ 见下一行；启动失败 → 查 ConfigMap/Secret | 不要把 `restartPolicy` 当自愈手段 |
| `GracefulShutdownTimeout` | 30s 内没关完，被强退 ⇒ 在途 job 被打断、lease 靠 `recoverStale` 兜底 | 日志搜「优雅停机超时」/ `phase=timeout` | 查谁挂住了：Redis/PG 半开导致 `close()` 挂住、长任务远超窗口 | **不要靠调大 `terminationGracePeriodSeconds` 掩盖**——先找到挂住的钩子 |
| 队列积压（`queue.depth/maxDepth > 0.5`，人工判据：`curl /api/v1/health`） | 消费跟不上生产，涨到 maxDepth 即 429 | Worker 副本是否被 HPA 顶到上限；单 run 是否长尾；provider 错误率 | 扩容 Worker（`kubectl scale deploy/worker`）；修 provider/超时问题 | 抬高 `AGENT_RUN_QUEUE_MAX_DEPTH` 只是把 429 推迟，不解决吞吐 |
| 队列已满（`depth ≥ maxDepth`） | 用户侧**已在**被 429 拒绝 | 同上一行 | 先止血（扩容/抬水位）再找根因 | 不要只看队列数字——用户可见失败已经发生，别当预警处理 |
| 用户报 429 `RATE_LIMITED`（非队列满） | 命中**限流**：全局 per-IP 桶（M10-P8）或端点级 `@RateLimit` 桶 | Redis 里 `SCAN` 匹配 `ratelimit:global:*`（按桶 `ratelimit:global:write:*` 等）看是哪个 IP/路由在涨、`TTL` 还剩多久；同时看 API 日志有无「限流器异常/超时（放行）」 | 见 **§7.4**：先分清"脚本/攻击"与"自己人（共享出口 IP）"，前者交上游 WAF/Ingress，后者调阈值或修 `TRUSTED_PROXY_HOPS` | **不要** `DEL ratelimit:*` 当修复——那只是抹掉观测证据，几秒后计数照涨；也**不要**把 `GLOBAL_RATE_LIMIT_ENABLED=false` 当默认状态 |
| `SchedulerJobDead`（人工判据：`SELECT count(*) FROM "ScheduledJob" WHERE status='dead' AND "completedAt" > now() - interval '1 day'`；或查 `"EventEnvelope"` 里 `eventType='scheduler.job.dead'`） | 周期性作业**已停摆**，dead 是终态、不自动重投 | `ScheduledJob.lastError`：心跳中断（worker 失联/长任务超时）还是重试超限 | 先修 worker 侧的根因，再用人工显式路径重投 | 不要批量把 dead 改回 scheduled——那会跳过"为什么死"这个信息 |
| `StorageDependencyDegraded`（人工判据：`curl /api/v1/health` 的 `storage.state`） | 对象存储降级：上传/生成受影响，核心路径仍可用 | MinIO/S3 端点与凭证 | 修端点/凭证；若桶被误删 → 用 `minio-mirror.ts` 回灌到**新桶**再切 | **不要**因此摘 API 流量（非关键依赖，摘流量只会放大故障） |
| SSE 客户端"卡住不动" | 某层代理在缓冲（应用没出问题） | `curl -N` 直连 Pod 对比经 Ingress 的表现 | 补 `proxy-buffering: off` 等三条注解（§6.3） | 不要先怀疑应用代码——先用 `curl -N` 二分定位 |
| Redis 数据丢失 | 队列 job 消失、实时事件断、熔断状态清零 | Worker 日志 | 按 m8 §5：**不恢复**，重启 Worker + ≤7min 等 `recoverStale` 收尾 | 不要 `FLUSHALL` 或试图恢复 RDB/AOF（设计上不需要） |
| `ENCRYPTION_KEY` 丢失/错配 | 凭证**永久不可解** | 抽查解密是否抛错（§4.5） | 从 §3 的密钥备份取回正确密钥；无备份则只能让用户重新授权 | 不要反复重灌数据库备份——数据没问题，是密钥不对 |

### 7.3 告警落地前置项（谁都能做，本 Phase 不做）

1. 部署 blackbox_exporter（两处即可：`/api/v1/ready` 与 `/api/v1/health`）+ 本文件的 rule_files；
2. 应用侧导出 Prometheus 文本格式指标（把 `MetricSample` 的 `queue_depth`/`request_*` 等暴露到
   受网络策略保护的 `/metrics`，**不要**复用 JWT 面），或经 otel-collector 转换；
3. 为 `scheduler.job.dead` 与停机超时打计数器（各一次代码改动，规则表达式已写在注释里）。

### 7.4 全局限流（429）排查入口与 fail-open 语义

M10-P8（审计 SA-25）加的**全局 per-IP 限流**在 Redis 里的键空间是**可直接翻的**——
这是它按"IP×方法×路由"分桶（而非一个黑盒计数器）的运维回报。

**键格式**（`core/rate-limit/global-rate-limit.policy.ts` 生成 `global:...`，`RateLimitService` 再加前缀）：

```
ratelimit:global:{bucket}:{ip}:{method}:{route}
             ↑           ↑       ↑        ↑
             read|write|auth|upload    路由模板（如 /api/v1/conversations/:id）
```

**桶与阈值**（生产默认值，`NODE_ENV !== 'production'` 时阈值 ×100，窗口不变）：

| 桶 | 落桶条件 | 阈值（每分钟） |
| --- | --- | --- |
| `auth` | `POST /auth/login`、`POST /auth/refresh` | 30 |
| `upload` | `POST /attachments` | 30 |
| `write` | 其余 POST/PUT/PATCH/DELETE | 60 |
| `read` | 其余（含 GET） | 300 |

**豁免（绝不计数，也就绝不会出现它们的键）**：健康探针（`/health`、`/live`、`/ready`）、CORS 预检、
`hooks/*`（webhook 另有 per-token 桶）、SSE 长连接（`/:id/events`、`/stream`）。
⇒ **若探针或 SSE 报 429**，那不是全局桶干的（去查端点级 `@RateLimit` 或上游 WAF），别在 `ratelimit:global:*` 里浪费时间。

**今天就能用的三条命令**（本机 Redis 在容器里；生产把 `docker exec` 换成对 Redis 的直接 `redis-cli`）：

```bash
# ① 看有没有被限流的桶在涨（按桶过滤，先看最容易出事的 write/upload）
docker exec docker-redis-1 redis-cli --scan --pattern 'ratelimit:global:write:*'

# ② 看某个键的计数与窗口剩余时间（固定窗口：首次 INCR 时 PEXPIRE 60s）
docker exec docker-redis-1 redis-cli get 'ratelimit:global:read:<IP>:GET:/api/v1/agent-runs/:id'
docker exec docker-redis-1 redis-cli ttl 'ratelimit:global:read:<IP>:GET:/api/v1/agent-runs/:id'

# ③ 换个桶再扫一遍（auth/upload 的阈值只有 30，共享出口 IP 下最先触发）
docker exec docker-redis-1 redis-cli --scan --pattern 'ratelimit:global:auth:*'
```

> **`--scan --pattern` 是 O(整库键数)**：小库随便扫；生产库请用游标式 `SCAN`（`redis-cli --scan` 本身就是
> 游标实现，但仍会遍历全部键空间），并在 Redis 负载低时做，别在故障复盘的高峰期全量扫。
> 另外：多实例/多环境共用 Redis 时按 **DB 段**隔离 keyspace（`REDIS_URL` 尾部的 `/<db>`），
> 排查前先确认自己连的是应用的**那个 DB 段**，否则会得出"一个键都没有"的错误结论。

**fail-open 语义（必须知道，否则会误判）**：`RateLimitService.consume` 在 **Redis 不可用/命令超时**时
**返回放行**（`true`）并打一条 `限流器异常/超时（放行）` 的 warn。这是 M7-P9/Pre-M9 G4 以来的既定口径：

- **故障期间限流完全失效**，脚本洪泛不会被拦——别把"Redis 故障期间没有 429"当成"没有攻击"；
- 但此时 `/ready` 已经是 503（Redis 是 readiness 的 critical 依赖，见 k8s/api-deployment.yaml），
  LB 已把流量摘走，**用户侧可见的是"服务不可用"而不是"服务可用但没限流"**；
- 反过来说：**只要看到 `限流器异常/超时（放行）` 的日志，就必须去查 Redis**，这是一条"保护面已失效"的证据。

**阈值调错 / IP 解析错的典型症状与处置**：

| 症状 | 含义 | 处置 |
| --- | --- | --- |
| 大批用户同时 429，且 `ratelimit:global:*` 里**同一个 IP** 的键在涨（多半是 Pod CIDR 或单个代理地址） | IP 解析退化成"所有用户共用一个桶"：`TRUSTED_PROXY_HOPS` 与实际代理层数不符（写大了，XFF 链长不足 → 回退 socket 地址） | 按**实际**入口层数改 `k8s/configmap.yaml` 的 `TRUSTED_PROXY_HOPS`（客户端→Ingress→Pod = `1`），改完滚动重启 |
| 单个账号/脚本把某个端点打满（其他桶正常） | 正常限流在工作 | 攻击/爬虫 → 上游 WAF/Ingress 处置；自家压测 → 显式调大对应 `GLOBAL_RATE_LIMIT_*_PER_MIN` |
| 办公网 NAT 出口的多个用户互相"挤掉" | 一个出口 IP = 一个桶，属**已知取舍**（跨端点聚合桶未实施，见 X-08 Deferred） | 调大阈值，或推动上游按账号维度而非 IP 维度扩展限流 |
| `POST /auth/login` 偶发 429 但失败计数（5 次/5 分钟）没到 | 两条计数**口径不同**：全局 auth 桶按**请求**计（含成功），失败计数按**失败**计 | 正常现象；反代场景下 auth 失败计数用的是 `req.ip`（socket 地址）⇒ 会退化为"所有用户共用一个代理 IP"，这是 P8 已记录的跨模块风险 |

**不要做的事**：不要把 `ratelimit:*` 删掉当修复（键会在几秒内重新计数，而你丢掉了唯一的观测证据）；
不要为了"先让用户进来"把 `GLOBAL_RATE_LIMIT_ENABLED` 改成 `false` 并留在配置里——那是把防护永久关掉，
要用就把阈值调到一个**能挡住脚本**的数。

## 8. 季度演练清单（5 步，不可省步）

在**隔离环境**（预发/临时命名空间）执行，全程只操作新建的临时库/临时桶，**绝不触碰生产库**。

1. **备份 + 自校验**：`backup.ts --expect-tables <当前真实值> --min-rows <实际值的 90%>`；
   要求退出码 0 且 manifest 的 `checks` 全绿；记录大小/耗时/sha256/表数/行数。
2. **密钥备份 + 指纹**：按 §3.3 导出 `.env`（或密钥管理系统快照）→ 加密 → 异地；
   记录 `ENCRYPTION_KEY` 的长度与 sha256 前 8 位（**不记值**）。
3. **临时库恢复 + 比对**：`restore.ts --confirm --verify-sample 5`（加大抽样表数）；
   要求 `verdict: PASS`、逐表行数 100% 一致、关键表逐张点名一致、**抽样表逐行内容一致**；
   记录指纹七项与耗时。
4. **凭证解密抽查**（§4.5）：用**备份的密钥**解 1~2 条 `Credential`；
   这是**唯一能证明"密钥与数据配套"**的一步——跳过它，前 3 步只证明了"字节被搬过来了"。
5. **对象存储 mirror 往返**：临时桶 `--checksum-sample 3`；要求对象数/体积全等且抽样 md5 全 match；
   再验证一次**回灌路径**（桶 → 目录 → 新桶）。

**收尾（不算步骤，但不可跳过）**：销毁临时库/临时桶（`restore.ts` 默认自动 DROP；桶用 `mc rb --force`）；
核对 `pg_database` 里只剩预期条目；把日期、真实数字、踩到的坑**更新回本文档**（发现的新坑写成注释进脚本，
不要只留在某人的聊天记录里）。

> 与本清单互补的**运行时**演练（真实 `kill -TERM` Worker、真实重启 Redis）在 m8 手册 §9，仍应照做——
> 那两项验证的是"崩溃恢复"，本清单验证的是"备份可恢复"，两者都做才算闭环。

## 9. 未验证项（诚实清单，勿当成已验证）

| 项 | 状态 | 补齐方式 |
| --- | --- | --- |
| **生产量级**的备份/恢复（TB 级库） | ❌ 未验证 | 本机 13.58MB / 44,072 行 / 1.11s 不能外推；需在预发用脱敏副本实测并记录 |
| **PITR**（WAL 归档 → `recovery_target_time`） | ❌ 未演练（本脚本**不做** PITR） | 生产开通归档后必须完整走一次并记录 RTO；在此之前 RPO = 备份时刻 |
| 备份到**对象存储的上传链路** | ⚠️ 代码路径已实现并测过 `mc` 一次性容器（§5.3 用临时桶验证了 mc 通路），但 `backup.ts --upload` 到真实备份桶**未跑过端到端** | 预发建 `db-backups` 桶后执行一次，核对远端大小与 manifest 一致 |
| K8s 清单实机验证（探针/HPA/Ingress SSE/K8s 的 SIGKILL 边界） | ❌ 未验证（本机无集群；仓库**无 Dockerfile**） | 预发集群按 §6 部署并逐项验；`terminationGracePeriodSeconds` 必须用真实 pod 删除验证 |
| 备份加密（静态加密） | ❌ 未实现 | 本脚本产出的是 **gzip 明文 dump**——落盘/上云前必须由运维侧加密（age/gpg/存储侧 SSE-KMS），否则等于把全库数据裸放在备份目录 |
| `.env` 备份的加密与取回（§3.3/§3.4） | ❌ 纯流程项，未演练 | 与运维确认工具链后走一次完整"导出→加密→异地→取回→核对指纹" |
| 告警规则里的 `[待导出]` 项 | ⛔ 未生效 | 见 §7.3；生效前用 §7.2 的人工判据 |
| 多副本下的 /ready 与滚动更新行为 | ❌ 未验证 | 需在集群里做一次滚动更新，观察摘流顺序与 SSE 断线重连（客户端依赖 `last-event-id` 续传） |
| 全局限流在**真实代理层数**下的分桶（`TRUSTED_PROXY_HOPS=1`） | ❌ 未验证 | 本机没有 Ingress，且 `NODE_ENV≠production` 时阈值 ×100；需在预发用真实 Ingress 抓一次 `X-Forwarded-For` 链长，并核对 `ratelimit:global:*` 的键里出现的是客户端 IP 而不是 Ingress Pod IP。`k8s/ingress.yaml` 的 `use-forwarded-headers` 等注解也需实机确认（§6.4） |

## 10. 边界与依赖

**本 Phase 的边界（有意为之）**：
- 不改 `schema.prisma` / `migrations/**` / `packages/shared/**`；不改任何既有文件（其他 Agent 并行中），
  因此 `package.json` 没有脚本别名（用 `npx tsx` 调用）、`.gitignore` 没有 `backup/`（用 `-o` 规避）。
- 不新增基础设施：`monitoring/` 只有**规则文件**，不含 Prometheus/Alertmanager 自身部署；`k8s/` 只有 API/Worker，
  不含 PG/Redis/对象存储（生产用托管服务）。

**对其他 Agent / 后续工作的依赖**：
| 依赖 | 影响 | 现状 |
| --- | --- | --- |
| **M10-P8 全局限流**（审计 SA-25） | 本 Phase 只**消费**它的两个事实：① `k8s/configmap.yaml` 的 `TRUSTED_PROXY_HOPS` 必须等于实际代理层数（否则全站共用一个桶，§7.4）；② §7.4 的键空间 `ratelimit:global:*` 与 fail-open 语义（Redis 故障期间限流失效）写进排查口径。**代码侧一行未改**（键名/阈值/豁免均只读确认：`core/rate-limit/global-rate-limit.policy.ts`、`rate-limit.service.ts`） | **已合并**（本 Runbook 与 manifests 已按它写的口径对齐） |
| `ENCRYPTION_KEY` 版本化 + rewrap 工具（M10-P1） | 密钥轮换落地后，§3 的清单要加"旧版本密钥保留到全部凭证 rewrap 完成"一条；`Credential.keyVersion` 列会让 §4.5 的抽查多一步"确认 keyVersion 与密钥匹配" | 并行进行中 |
| 真多进程 e2e（M10-P12） | 本 Runbook 的停机/探针结论仍来自单进程；多进程的 SIGTERM 行为需交叉验证 | 并行进行中 |
| 压测/Soak 基线（M10-P17） | `k8s/*` 的 `resources.requests/limits` 目前是**起手值**，需按压测结果调整；HPA 的 CPU 目标同理 | 未开始 |
| Dockerfile / CI 构建 | `k8s/` 的镜像名是占位符，没有镜像就无法实机验证（§9 最大的一格空白） | 不存在 |
| 备份桶与生命周期策略 | `backup.ts --upload` 的目标桶、异地复制、保留期（建议 30 份 + 异地）需运维侧创建 | 未创建 |
| Prometheus / blackbox / kube-state-metrics | §7 的"可用"类规则需要它；"待导出"类需要应用侧导出器 | 未部署 |
