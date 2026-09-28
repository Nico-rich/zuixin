# M11-P15 PITR 演练（`scripts/pitr-drill.ts`）

> **上游文档**：`docs/operations/m8-disaster-recovery.md`（§1 目标 RPO/RTO、§3.1 WAL 归档要求、
> §4.2 就地恢复、§7 失败矩阵（误删数据/主库损坏）、§8 未验证清单里的 PITR 行）、
> `docs/operations/m10-runbook.md`（§4 恢复演练的三步法 + **四层校验 A/B/C/D 口径**、§1.3 退出码契约）。
>
> 本文件只做一件事：把 m8 里"**PITR ❌ 未演练**"这一行变成**可重复执行、有退出码、有数字**的演练，
> 并把它**跑不动的地方**如实登记（§8/§9）。原理不重复，m8 已经写清楚了。
>
> **本文件不修改 `m10-runbook.md`**（该文件归 A10 所有）。m10 §0 的可信度声明里
> "**PITR**（WAL 归档 → `recovery_target_time`）❌ 未演练"一行，自本文件起由本节接管，
> 是否回填 m10 由 A10/集成阶段决定。

## 0. 可信度声明（先读这一节）

| 内容 | 状态 |
| --- | --- |
| PITR 全链路（`archive_mode=on` → `pg_basebackup` → 造 WAL → 事故 → `recovery_target_time` → promote） | ✅ **真实执行 8 次**（7 次 PASS + 1 次 FAIL，§4） |
| 四层校验 A/B/C/D（口径同 m10 §4.3）+ PITR 专属断言 P1~P5 | ✅ 真实执行（7 次 PASS 的轮次都是 **10/10 项 PASS**；A 指纹 / B 90 张表行数 / C 9 张点名 / D 4 张表逐行原样） |
| 恢复的**内容级**证据（不是"行数对了就算过"） | ✅ 真实执行（`_prisma_migrations` 38 行、`Plan` 3 行、`pitr_drill_event` 4 行、`pitr_drill_ledger` 500 行，逐行文本一致） |
| 事故被**真的撤销**（DROP TABLE 的表回来了、事故事务没被重放） | ✅ 真实执行（P3/P4，§5） |
| 共享开发环境（`docker-postgres-1` / `agent_platform`）| ✅ **全程未被触碰**（脚本不读 `.env`、不连 `DATABASE_URL`；核对命令见 §10，演练后三次核对均无 `pitr-drill-*` 残留，共享容器 `RestartCount=0`） |
| 幂等 / 残留清理（`--clean-stale`）| ✅ 真实执行（第 3 轮清掉第 2 轮 `--keep` 的残留：2 容器 + 3 卷） |
| **生产量级**（TB 级库、生产 IO）的 RTO/RPO | ❌ **未验证**——本机基线 50.7MB / 90 表 / 545 行，数字**不可外推**（§7/§9） |
| **真实归档介质**（对象存储 / 异地 / 归档盘）的取回时间与失败重试 | ❌ **未验证**——本机 `archive_command='cp %p /archive/%f'` 是**同盘拷贝**（§8） |
| 主从切换 / 多可用区故障转移 / 切换期间 `/ready` | ❌ **未验证**——promote 的是"恢复实例"本身，不是真实集群（§8） |
| 归档中断、WAL 缺口、归档损坏 | ❌ **未注入**——本演练只覆盖"归档健康"这条路径（§9） |
| 归档加密 / 保留生命周期 / 告警 | ❌ 未做——归档侧的加密与保留是**生产落地项**（§8 checklist；逻辑备份的加密在 M11-P9） |

**绝对不要把本机数字当成生产承诺。** 本演练的增量是"**这条链路被证明能跑通，且每一步都有数字和断言**"，
不是"生产 RTO 已经达标"。

## 1. 为什么需要它（逻辑备份救不了的那一类事故）

`m10-runbook.md` §2.1 已经写明：`backup.ts` 是**逻辑备份**，它的 RPO = **上次备份时刻**。
于是 m8 §7 失败矩阵里这两行有明确的空洞：

| 场景 | m8 给出的恢复路径 | 逻辑备份是否够用 |
| --- | --- | --- |
| **误删数据**（DROP TABLE / 误删行 / 错误迁移） | PITR 到删除前一刻 | ❌ 只能回灌到上次备份，中间几小时的数据丢了 |
| **主库损坏** | PITR 优先 | ❌ 同上 |

本演练就是补这两行的**可验证性**：证明"基线 + WAL 归档 → 恢复到任意时刻"这条链路在
**不碰任何共享环境**的前提下可以反复跑通，并且**恢复结果能被逐层核对**（含内容级）。

**它不做什么**（避免误解）：不做生产拓扑、不做切换、不做归档介质选型、不做量级测试。

## 2. 脚本入口与安全边界

```bash
cd apps/api
npx tsx scripts/pitr-drill.ts --help          # --help 不创建任何资源
```

### 2.1 命令

```bash
# ① 默认就是 dry-run：只打印计划（端口 / 卷名 / 10 个阶段 / 校验项 / 诚实边界），不创建任何东西
npx tsx scripts/pitr-drill.ts

# ② 真跑一轮（约 40~55s；含四层校验与 PITR 断言）
npx tsx scripts/pitr-drill.ts --confirm

# ③ 保留容器与卷做人工取证（默认演练结束即删）
npx tsx scripts/pitr-drill.ts --confirm --keep

# ④ 清理历史残留（严格命名匹配：只删 pitr-drill-<stamp>-<rand>-{src,dst,archive,base,restore}）
npx tsx scripts/pitr-drill.ts --confirm --clean-stale

# ⑤ 机器可读报告 + 调参（抽样表数 / 账本行数 / 静默窗口）
npx tsx scripts/pitr-drill.ts --confirm --report-json /tmp/pitr.json --verify-sample 8 --ledger-rows 2000
```

### 2.2 参数（全部有默认值；未知参数**直接失败**，退出码 2）

| 参数 | 默认 | 说明 |
| --- | --- | --- |
| `--confirm` | — | 不加就只打印计划（**默认 dry-run**） |
| `--dry-run` | — | 显式 dry-run（与默认等价；把"没打算真跑"写清楚） |
| `--keep` | — | 保留容器/卷（人工取证） |
| `--clean-stale` | — | 先清理残留（默认只告警不删） |
| `--pg-image` | `pgvector/pgvector:pg16` | 需自带 `pg_basebackup`（本机实测 PostgreSQL 16.15） |
| `--port` | `0` | 源实例宿主端口（0 = 自动挑空闲端口，**只绑 127.0.0.1**） |
| `--gap-ms` | `2000` | 最后一次变更提交 → 事故 之间的静默间隔（目标时刻必须落在这段窗口内） |
| `--target-offset-ms` | `400` | 目标时刻 = 最后一次变更提交时刻 + 该偏移（必须显著小于 `--gap-ms`，否则拒绝执行） |
| `--ledger-rows` | `500` | 变更阶段写入的账本行数（分 3 个事务） |
| `--verify-sample` | `5` | D 层内容级抽样表数（0 = 关闭） |
| `--timeout-ms` | `60000` | 容器就绪 / 归档追上的等待上限 |
| `--skip-schema-replay` | — | 跳过 38 个迁移的重放（只建演练表，用于快速验证 PITR 通路本身） |
| `--report-json` | — | 机器可读报告落盘路径 |

### 2.3 安全边界（**本脚本最重要的性质**）

| 边界 | 做法 |
| --- | --- |
| **绝不触碰共享开发环境** | 不读 `.env`、不连 `DATABASE_URL`、不 `docker exec` 任何既有容器；全部动作在本次生成的 `pitr-drill-<stamp>-<rand>-*` 命名空间内 |
| **删除操作只认严格命名** | `docker rm` / `docker volume rm` 之前先断言名字匹配 `^pitr-drill-\d{8}-\d{6}-[0-9a-f]{6}-(src\|dst)$`（卷同理），不匹配直接退出码 4 |
| **口令不进 argv** | 容器口令每次运行随机生成（`randomBytes(12)`），经 `docker run -e POSTGRES_PASSWORD`（**无值形式**，从 docker 客户端环境透传）传入；`ps` / 日志里看不到明文 |
| **默认 dry-run** | 不加 `--confirm` 不创建任何资源；`--confirm` 与 `--dry-run` 同时给出时 `--dry-run` 获胜 |
| **一次性端口** | 两个实例各绑一个 `127.0.0.1` 空闲端口（绑定 `0` 让内核分配后释放），不撞共享环境的 5433 |
| **退出码即契约** | 复用 m10 §1.3：0 成功 / 1 执行失败 / 2 参数错误 / **3 校验失败** / 4 前置条件不满足 |

## 3. 演练编排（10 步，每步都对应一个真实失败模式）

| # | 阶段 | 关键动作 |
| --- | --- | --- |
| 1 | 准备实例 | 3 个一次性卷（archive/base/restore）+ `chmod 777`（postgres 以 uid 999 跑）+ `docker run -d`，参数：`archive_mode=on`、`archive_command='cp %p /archive/%f'`、`wal_level=replica`、`max_wal_senders=4` |
| 2 | 建 schema | `CREATE EXTENSION vector`（**迁移文件里只有 pgcrypto**，pgvector 是运维前置）+ 逐个重放 38 个迁移文件（每文件一个事务）+ 合成 `_prisma_migrations`（checksum = 迁移文件真实 sha256）+ 播种 `Plan` 3 行 + 建 2 张演练表 |
| 3 | 基准备份 | `pg_basebackup -h 127.0.0.1 -D /base -Xs -c fast`（`-Xs` 流式带 WAL，等于"基线 + 边界处 WAL"） |
| 4 | 变更 | 3 个事务（`BEGIN…COMMIT`）共 500 行账本 + 事件行——**全部发生在基准备份之后**，因此只能靠 WAL 重放找回来 |
| 5 | 目标时刻 | 取 **DB 时钟**（`clock_timestamp()`）而不是墙钟；目标 = 最后一次变更提交 + 400ms，且落在 2000ms 静默窗口内 |
| 6 | 事故 | **一个事务**里 `DELETE FROM "Plan"` + `DROP TABLE "UsageRecord"` + 写事故事件行（事务性 DDL ⇒ 只有一个提交时刻，恢复要么整件事没发生、要么整件发生） |
| 7 | 归档追上 | `pg_switch_wal()` + 轮询 `pg_stat_archiver.last_archived_wal` 直到覆盖 `pg_walfile_name(pg_current_wal_insert_lsn())` 且 `failed_count=0` |
| 8 | 恢复 | 基线副本 → 恢复卷 + `touch recovery.signal` + 追加 `restore_command` / `recovery_target_time` / `recovery_target_action='promote'`（**不用 shell printf 生成配置**）→ `docker run -d` |
| 9 | 校验 | 四层 A/B/C/D（口径同 m10 §4.3）+ P1~P5（§5），全部进报告 |
| 10 | 清理 | `docker rm -f` + `docker volume rm`（本次命名空间）；`--keep` 则保留并打印核对命令 |

## 4. 实测（2026-09-28，本机 Windows 11 + Docker Desktop 29.7.2，镜像 `pgvector/pgvector:pg16`）

8 次执行，全部落在**一次性容器**里；共享环境（`docker-postgres-1`/`agent_platform`）全程未被触碰。

| 轮次 | 目的 | 结论 | 总耗时 | 迁移重放 | 基准备份 | 归档滞后 | 启动→ready | RTO→promote | 端到端 RTO | 丢弃窗口 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 首次真跑 | **PASS** | 52.69s | 8.03s | 2.76s | 496ms | 2.98s | 3.17s | —（该轮未测物化） | 5.41s |
| 2 | `--keep`（保留取证） | **PASS** | 45.16s | 9.09s | 2.97s | 367ms | 2.48s | 2.62s | — | 5.21s |
| 3 | `--clean-stale`（清第 2 轮残留） | **PASS** | 41.64s | 7.99s | 2.24s | 307ms | 1.82s | 1.95s | — | 3.87s |
| 4a | 就绪判据修复**前** | **FAIL（退出码 1）** | 4.34s | 0ms | — | — | — | — | — | — |
| 4b | 修复后复跑 | **PASS** | 42.63s | 7.54s | 2.38s | 288ms | 2.71s | 2.86s | — | 3.92s |
| 5 | 复跑（稳定性） | **PASS** | 39.23s | 7.73s | 2.01s | 356ms | 2.70s | 2.85s | — | 3.64s |
| 6 | `--label m11-p15-final`（首次记录含物化计时） | **PASS** | 50.13s | 11.54s | 2.56s | 304ms | 2.90s | 3.07s | 4.40s | 4.02s |
| 7 | **最终记录轮**（脚本定稿后复跑，§4.1/§4.2/§5.3 引用的是这一轮） | **PASS** | 47.74s | 7.88s | 4.55s | 356ms | 4.20s | 4.40s | **8.29s** | 4.09s |

- 基线规模：**50.7 MB（53,163,365 字节）**；schema 指纹 **表 90 / 列 1036 / 索引 292 / 枚举 38 / 外键 152 / 迁移 38 / 扩展 `pgcrypto,plpgsql,vector`**。
- 每轮 10 项校验全 PASS，逐字数字见 §5.3。
- 第 4a 轮的失败是**真实踩坑**（不是抖动）：`pg_isready` 对 entrypoint 的临时 initdb 服务器返回 0，
  紧接着发查询撞上 `FATAL: the database system is shutting down`——细节见 §6.4。修复后连跑 4 轮全 PASS。
- **第 6 轮与第 7 轮之间只有 IO 型阶段变慢**（基线 `pg_basebackup` 2.56s → 4.55s、RTO 3.07s → 4.40s、
  端到端 4.40s → 8.29s），而**校验项与内容数字逐字相同**（§5.3）。第 7 轮跑的时候本机还有**别的
  Agent 的一次性 PG/Redis 容器在同时跑**（`docker ps` 可见），Docker Desktop（WSL2）的磁盘 IO 是共享的
  ——所以本机这几个秒数只能当"同一台机器上 IO 竞争下的区间"，不是能力上界。**不要拿单轮数字下结论**，
  要看 §7.2 的区间。

> 90 张表 = **88 张业务/schema 表 + 2 张演练自建表**（`pitr_drill_event`/`pitr_drill_ledger`）。
> 这与 m10 §4.4 的"88 表"对得上；但**列 1036 / 索引 292 / 迁移 38 与 m10 的 1026 / 280 / 33 不同**，
> 那是 M10 时点值，本机的差额来自 M10 之后的迁移（含 W0 的 `Session.deviceId`）——两边不要混着引用。

### 4.1 记录第 7 轮的命令

```bash
cd apps/api
npx tsx scripts/pitr-drill.ts --confirm --label "m11-p15-final" --report-json /tmp/pitr-report7.json
# → 结论：PASS（总耗时 47.74s）；退出码 0
```

本轮对应的脚本定稿版本：`apps/api/scripts/pitr-drill.ts`，66,272 字节（1,297 行）/
`sha256 = 44278a289b9464ac4115b48fedb6157ef4d227b3ed8c9e10bdf6ce85d4c6e7fb`
（与 `lib/cli.ts` 的 `sha256File` 同算法；本节及 §4.2/§5.3 的数字全部来自这一版脚本的这一轮运行）。

### 4.2 第 7 轮报告原文（节选，未改数字）

```text
schema    ：重放迁移 38 个（7.88s），表 90 张
时间线    ：基准备份 2026-09-28 09:56:09.674872+00 → 最后变更 09:56:10.249829+00 → 目标 09:56:10.649+00 → 事故 09:56:14.741338+00
基准备份  ：50.7 MB（53163365 字节）（4.55s）
WAL 归档  ：段 000000010000000000000004 归档耗时 356ms（累计 5 段 / failed=0）
恢复准备  ：基线物化 + 恢复配置 3.89s
恢复      ：启动 4.20s（→ pg_isready）/ RTO 4.40s（→ promote 完成，可写）
端到端 RTO：8.29s（基线物化 → 可写；不含"人发现事故 + 决定恢复到哪个时刻"的决策时间）
恢复结果  ：timeline 2；最后重放事务时刻 2026-09-28 09:56:10.111498+00
丢弃窗口  ：4.09s（目标时刻 → 事故事务提交，PITR 有意丢弃）
```

恢复实例的关键日志（说明这次恢复**为什么**可信）：

```text
2026-09-28 09:56:25.962 UTC [29] LOG:  redo starts at 0/3000028
2026-09-28 09:56:25.976 UTC [29] LOG:  restored log file "000000010000000000000004" from archive
2026-09-28 09:56:25.987 UTC [29] LOG:  completed backup recovery with redo LSN 0/3000028 and end LSN 0/3000100
2026-09-28 09:56:25.987 UTC [29] LOG:  consistent recovery state reached at 0/3000100
cp: cannot stat '/archive/000000010000000000000005': No such file or directory
2026-09-28 09:56:25.990 UTC [29] LOG:  recovery stopping before commit of transaction 1328, time 2026-09-28 09:56:14.302467+00
2026-09-28 09:56:25.990 UTC [29] LOG:  redo done at 0/4067B70 system usage: CPU: user: 0.00 s, system: 0.00 s, elapsed: 0.02 s
2026-09-28 09:56:26.122 UTC [29] LOG:  restored log file "000000010000000000000004" from archive
cp: cannot stat '/archive/00000002.history': No such file or directory
2026-09-28 09:56:26.139 UTC [29] LOG:  selected new timeline ID: 2
cp: cannot stat '/archive/00000001.history': No such file or directory
2026-09-28 09:56:26.193 UTC [29] LOG:  archive recovery complete
2026-09-28 09:56:26.196 UTC [27] LOG:  checkpoint starting: end-of-recovery immediate wait
2026-09-28 09:56:26.248 UTC [27] LOG:  checkpoint complete: wrote 64 buffers (0.4%); 0 WAL file(s) added, 0 removed, 1 recycled; write=0.009 s, sync=0.026 s, total=0.056 s; sync files=21, longest=0.004 s, average=0.002 s; distance=16798 kB, estimate=16798 kB; lsn=0/4067B70, redo lsn=0/4067B70
```

> 三行 `cp: cannot stat ... No such file or directory` **不是错误**：restore_command 去取"下一段 WAL"和
> "两个时间线历史文件"时必然各失败一次，PG 正是靠这个失败判断"归档到此为止"。报告里会带一行同样的注解，
> 免得看日志的人误判（并且脚本只在**没有** `archive recovery complete` 或出现
> `recovery ended before configured recovery target was reached` 时才判失败）。

## 5. 校验口径（与 m10 §4.3 **同一套 A/B/C/D**，但期望值来源不同）

### 5.1 四层 + 五项 PITR 断言

| 层 | 查什么 | 本演练的期望值来自哪里 |
| --- | --- | --- |
| **A 指纹** | 表/列/索引/枚举/外键/迁移数/扩展 **七项** | **目标时刻**源实例的七项（不是事故后的源实例） |
| **B 逐表行数** | 90/90 张表 `count(*)` 逐表比对（并检查"恢复库多出的表"） | 同上 |
| **C 关键表** | 6 张关键表（`User`/`Organization`/`AgentRun`/`UsageRecord`/`Credential`/`_prisma_migrations`）**逐张点名**，外加事故被删掉的那张 | 同上 |
| **D 抽样内容** | 抽中的表**再 `pg_dump --data-only -t` 一次**，与目标时刻那一段 COPY **逐行原样文本**比对（选表规则与"为什么原样比"同 m10 §4.3） | 同上 |

| 断言 | 查什么 | 判据 |
| --- | --- | --- |
| **P1 目标时刻到达** | 恢复日志 | 有 `archive recovery complete`，且**没有** `recovery ended before configured recovery target was reached` |
| **P2 WAL 真的被重放** | 基线之后的写入只能来自 WAL | 恢复实例里 `change-*` 事件行 3 条 + 账本 500/500 行 |
| **P3 目标时刻之后的被排除** | 恢复确实停在目标时刻 | 事故的事件行在恢复实例中 **0 条** |
| **P4 事故被撤销** | DROP TABLE 的表回来了 | 事故后源实例中 `UsageRecord` 已不存在、恢复实例中存在 |
| **P5 已提升且可写** | promote 真的发生 | 时间线 > 1 **且**恢复实例上实际 `INSERT` 成功 |
| 附加 **A-accident-visible** | 事故确实留下了 schema 级痕迹（否则 P4 没有对照物） | 事故后源实例的 `tables/columns/indexes/fks` 偏离目标时刻 |

### 5.2 与 m10 §4.3 的关键差异（**容易搞错的地方**）

m10 的教训是"**不要拿源库当前行数当基准**"（源库在备份后仍被写入 ⇒ 假失败）。
PITR 的版本是同一句话换了名字：**"当前"= 事故之后的源库**，拿它当基准**必然假失败**（表都被删了）。
所以期望值必须在**事故之前、目标时刻**采集——本脚本第 5 步就是干这个的（`golden` 快照 + 抽样内容 dump）。

**顺序也是口径的一部分**：抽样内容、行数、指纹都在**制造事故之前**采集；
P5 的"写入验证"放在**所有内容比对之后**（否则那一行会污染 D 层比对）。

### 5.3 第 7 轮校验原文

```text
[PASS] A-fingerprint：七项全等于目标时刻：tables=90 / columns=1036 / indexes=292 / enums=38 / fks=152 / prisma_migrations=38 / extensions=pgcrypto,plpgsql,vector
[PASS] A-accident-visible：事故后源实例偏离目标时刻的项：tables(90 → 89)、columns(1036 → 1017)、indexes(292 → 286)、fks(152 → 148)
[PASS] B-rowcounts：90/90 张表一致，合计 545 行
[PASS] C-key-tables：User=0 / Organization=0 / AgentRun=0 / UsageRecord=0 / Credential=0 / _prisma_migrations=38 / Plan=3 / pitr_drill_event=4 / pitr_drill_ledger=500
[PASS] D-sampled-content：_prisma_migrations（38 行）：逐行一致；Plan（3 行）：逐行一致；pitr_drill_event（4 行）：逐行一致；pitr_drill_ledger（500 行）：逐行一致
[PASS] P1-target-reached：归档恢复完整走完（archive recovery complete）；停止点：recovery stopping before commit of transaction 1328, time 2026-09-28 09:56:14.302467+00
[PASS] P2-wal-replayed：基准备份之后写入的数据只能来自 WAL 重放：事件行 3 条、账本 500/500 行
[PASS] P3-post-target-excluded：目标时刻之后的事故事务事件行在恢复实例中为 0 条（期望 0 ⇒ 恢复停在了目标时刻）
[PASS] P4-accident-rolled-back：事故删掉的 UsageRecord 在恢复实例中已回来（事故后源实例中已不存在）
[PASS] P5-promoted-writable：时间线 2（恢复后分叉，> 1 说明确实做过 promote）；恢复实例可写（已实际写入一行验证）
```

**B 层的 545 行**是 90 张表的合计（业务表在空库基线里都是 0 行，数据全在 `_prisma_migrations` 38 +
`Plan` 3 + `pitr_drill_event` 4 + `pitr_drill_ledger` 500）。本演练**不假装**它是业务数据量级：
它证明的是"**内容级**一致"，不是"生产行数下也一致"。

## 6. 踩到的坑（都写进脚本了，别重新踩）

### 6.1 `recovery_target_time` 只有在"被重放到的第一个 ≥ 目标的 COMMIT"上才成立

目标时刻必须取自 **DB 时钟**并落在**无写入的静默窗口**内。第一次尝试时目标时间晚于最后一条 WAL，
PG 直接硬失败：`FATAL: recovery ended before configured recovery target was reached`——
**恢复不是"退回到最近的可用点"，而是直接起不来**。脚本因此：
① 用 `clock_timestamp()` 取时刻；② `--gap-ms` 静默窗口（默认 2000ms）；③ 拒绝 `--target-offset-ms ≥ --gap-ms` 的调用（退出码 2）。

### 6.2 `pg_switch_wal()` 必须在**事故之后**调用，而且必须等归档追上

两个反直觉点：

1. **切换只归档"切换那一刻活跃的那一段"**。事故写在切换前的活跃段里——若在事故**之前**切换，
   事故事务所在的段永远不会归档，恢复照样撞上 §6.1 的 FATAL（这是第二次失败的原因）。
   正确顺序：**事故 → `pg_switch_wal()`**。
2. 切换返回不等于归档完成（`cp` 是异步的）。必须轮询 `pg_stat_archiver.last_archived_wal`
   直到 ≥ `pg_walfile_name(pg_current_wal_insert_lsn())`（在切换**之前**取）且 `failed_count=0`。

脚本把这步单独做一个阶段并**打印归档滞后**（实测 288~496ms）——这个数字就是本机 RPO 的关键观测值（§7）。

### 6.3 `pg_basebackup` 的目标目录必须为空；`-Xs` 别省

`-D /base` 指向空卷；`-Xs` 让基线自带边界处的 WAL，否则"基线 + 归档"之间会缺一段。

### 6.4 `pg_isready` 会骗人（第 4a 轮就是这么失败的）

官方 `postgres` 镜像的 entrypoint 在**空数据目录**时先起一个**临时服务器**跑 initdb/init 脚本，
它同样让 `pg_isready` 返回 0，紧接着 `pg_ctl stop`。此时发查询 → `FATAL: the database system is shutting down`。

第 4a 轮的现场（4.34s 结束、**退出码 1**、报告里 schema 0ms / 表 0 张）：

```text
[error] psql 查询失败（退出码 2）：psql: error: connection to server on socket "/var/run/postgresql/.s.PGSQL.5432" failed:
        FATAL:  the database system is shutting down
```

修法（脚本现在的判据）：**两段式**——① 日志里出现 entrypoint 的 `ready for start up`（仅空库初始化时要求），
② 一次**真实查询** `psql -At -c 'SELECT 1'` 成功。光看端口/`pg_isready` 不够。

### 6.5 别用 shell 生成 `postgresql.auto.conf`

调试期用 `printf` 往配置里写 `archive_command='cp %p /archive/%f'`，`%p` 被 shell 当成格式指令吞掉，
写进去的是一段**语法错误**的配置（下次启动直接失败）。脚本改成：用 `sh -c 'cat >> file'` 从 stdin 灌内容，
写完再 `grep -q recovery_target_time` 自校验。

### 6.6 具名卷要 `chmod 777`

postgres 在官方镜像里以 uid 999 运行，而 Docker 新建的具名卷挂载点属 root ⇒ 空库初始化直接失败。
脚本在启动前用同一个镜像跑一次性 helper 容器（root）把三个卷 `chmod 777`。

### 6.7 `vector` 扩展不是迁移创建的

`prisma/migrations/**` 只创建 `pgcrypto`；HNSW 索引那条迁移依赖 `vector`。在**全新实例**上直接重放迁移
会失败——生产是运维前置创建，演练脚本显式 `CREATE EXTENSION IF NOT EXISTS vector`（并同样补 `pgcrypto`）。

### 6.8 Windows/Git Bash 下 `/archive` 会被改写

手动调试时 `docker exec <c> ls /archive` 会被 MSYS 改写成 `C:/Program Files/Git/archive`；`export MSYS_NO_PATHCONV=1`。
**脚本本身不受影响**：所有子进程都走 `spawn`（不经 shell），参数逐字传递。

## 7. RPO / RTO 观察（本机口径，**不可外推**）

### 7.1 RPO

| 观测 | 本机实测 | 含义 |
| --- | --- | --- |
| 归档滞后（`pg_switch_wal` → 该段落盘） | **288 / 304 / 307 / 356 / 356 / 367 / 496 ms**（7 轮；极差 208ms） | 归档健康时，"最坏能恢复到多久之前"≈ 归档滞后 + 当前未归档段的写入量 |
| 恢复到的时刻（`pg_last_xact_replay_timestamp()`） | 与目标时刻差 **0.538s（第 7 轮）/ 0.565s（第 6 轮）**，更早轮次落在 0.543~0.609s（= 人为目标偏移 400ms + 取"最后变更时刻"那一步的延迟） | 证明停在的是**目标时刻**（最后变更被完整重放、事故事务被排除），不是"回退到某个近似点" |
| 数据丢失窗口（目标 → 事故提交） | 3.64~5.41s | **这是演练刻意留的静默窗口（`--gap-ms`），不是 RPO 的下限证据** |

对 m8 §1 的 `PG RPO ≤ 5min`：本演练**没有**证明它，也没有反驳它。
它证明的是"恢复机制本身能命中指定时刻"，而"≤5min"取决于**归档介质与归档频率**（生产项，§8）。
另外提醒：本机归档是**同盘 cp**，磁盘一坏基线和归档一起没——生产必须异地（m8 §3.4）。

### 7.2 RTO

| 阶段 | 第 7 轮 | 已测轮次区间 | 说明 |
| --- | --- | --- | --- |
| 基线物化 + 落恢复配置 | **3.89s** | 1.32~3.89s（仅第 6/7 轮测了物化） | 50.7MB 基线 `cp -a` 到恢复卷 + 写 `recovery.signal`/`restore_command` |
| 容器启动 → `pg_isready` | **4.20s** | 1.82~4.20s（7 轮） | 含 PG 启动、读到 `recovery.signal`、开始 redo |
| `pg_isready` → promote 完成（可写） | **0.20s** | 0.17~0.20s | redo 只重放基线**之后**的极少量 WAL |
| **端到端 RTO（物化 → 可写）** | **8.29s** | 4.40~8.29s（仅第 6/7 轮） | 不含"人发现事故 + 决定恢复到哪个时刻"的决策时间 |
| 全轮总耗时（含建 schema/造数据/校验/清理） | 47.74s | 39~53s（7 轮） | 与 RTO 无关，只是脚本自身耗时 |

**第 6 轮与第 7 轮相差近一倍，原因在 IO 竞争而不在恢复逻辑**：两轮之间校验项与内容数字逐字相同，
变慢的只有 `pg_basebackup` / `cp -a` / 容器启动这三个 IO 型阶段（第 7 轮跑时本机另有别的 Agent 的
一次性容器在跑）。所以真正的 RTO 量级是 **"秒级到十秒级"**（本机、50.7MB 基线），不是某个精确数字。

对 m8 §1 的 `PG RTO ≤ 30min`：本机 4.40~8.29s 与 30min 之间**没有可比性**。生产 RTO 的三个乘数在本机全部缺席：
① 库体积（本机 50.7MB，生产可能是 TB ⇒ 基线物化与取回时间线性增长）；
② 归档介质取回速度（本机同盘 cp，生产是对象存储/归档盘/异地）；
③ **人工决策时间**（判断"恢复到哪个时刻"、停写、摘流量——m8 §4.2 的流程本身要时间）。
值得注意的是 ②③ 才是生产 RTO 的大头：redo 重放的量只跟"基线之后的 WAL"有关，与库总量关系不大。

## 8. 生产差异（诚实口径：**本机一次性容器 ≠ 生产 WAL 归档拓扑**）

| 维度 | 本演练（本机） | 生产应当是 |
| --- | --- | --- |
| 归档介质 | `archive_command='cp %p /archive/%f'`，**同盘** | 归档盘 / 对象存储（`wal-g`/`pgbackrest`/`archive_library`），**与数据库不同故障域**（m8 §3.4 保留 ≥7 天） |
| 归档失败处理 | 无（本机 cp 不会失败） | 必须监控 `pg_stat_archiver.failed_count` + 归档滞后告警；`archive_timeout` 兜底（否则低频写入时归档滞后无上限） |
| 实例 | 一次性容器 + 具名卷；Docker Desktop（WSL2 虚拟磁盘） | 真实主机/托管 PG；IO 特性与 fsync 行为完全不同 |
| 拓扑 | 单实例；promote 的是"恢复实例"本身 | 主从/多可用区；PITR 通常恢复到**新实例**再切流量（m8 §4.2：摘流量 → 停 Worker → 恢复 → 校验 → 起 API → 起 Worker） |
| 基线 | `pg_basebackup` 现取现用 | 定时 `pg_basebackup` + 保留策略（否则"最老能恢复到多久之前"= 最老基线） |
| 目标时刻 | 脚本自己记录的 DB 时钟 | **人工**从审计/日志推断事故时刻（本演练不含这一步的时间成本） |
| 加密 / 合规 | 无（演练数据是造出来的） | 归档与基线的静态加密（逻辑备份的加密见 M11-P9；归档侧加密**本 Phase 未做**） |
| 演练对象 | 一次性容器，随便删 | **绝不在生产主库上演练**；用预发/从库/临时实例 |

### 8.1 生产落地 checklist（要开的东西，本演练**没有**替你做）

- [ ] `wal_level=replica`、`archive_mode=on`、`archive_command`（或 `archive_library`）、`max_wal_senders ≥ 1`
- [ ] `archive_timeout`（低频写入时给归档滞后封顶；本演练没测这条路径）
- [ ] 定时 `pg_basebackup` + 保留策略 + 异地副本（m8 §3.4）
- [ ] 归档健康监控：`failed_count`、`last_archived_wal` 与 `pg_current_wal_lsn()` 的差距、归档目录余量
- [ ] 归档与基线的静态加密、访问控制（归档里有**全部**数据，不比数据库本身轻）
- [ ] 每季度演练一次（m8 §9）：**在预发/从库上**跑本脚本的等价流程 + 用真实归档介质实测取回时间
- [ ] 把"恢复到哪个时刻"的决策路径写进流程（谁有权决定、依据什么，m8 §4.2）

## 9. 未验证清单（**本演练不覆盖的部分**）

| 项 | 状态 | 如何补齐 |
| --- | --- | --- |
| 生产量级（TB 级 / 千万行）的 RTO | ❌ 未验证 | 本机 50.7MB/545 行；需在预发用生产量级（或脱敏副本）实测 |
| 真实归档介质（S3/异地/归档盘）的取回时间与失败重试 | ❌ 未验证 | 本机同盘 cp；需按生产 `archive_command` 重跑本演练 |
| 归档**中断/缺口/损坏**的恢复行为 | ❌ 未注入 | 本演练只覆盖"归档健康"。生产要额外演练：故意删一段归档 → 确认恢复**明确报错**而不是静默给一个旧点 |
| `archive_timeout` 触发的归档路径 | ❌ 未覆盖 | 本演练靠 `pg_switch_wal()` 手动切换 |
| 时间线历史文件（`.history`）跨分支恢复 | ❌ 未覆盖 | 本演练只做一次 promote（timeline 2）；多分支需要多次 promote 的实验室 |
| 主从切换 / 多可用区 / 切换期间 `/ready` | ❌ 未验证 | 需生产拓扑（m8 §8 同项仍为未验证） |
| 长事务/大事务在 redo 期间的放大 | ❌ 未覆盖 | 本演练事务都是毫秒级；生产需注入长事务 |
| 归档/基线的加密与保留生命周期 | ❌ 未做 | 生产落地项（§8.1）；逻辑备份加密见 M11-P9 |
| 恢复到**已有实例**（而非全新实例）的路径 | ❌ 未覆盖 | 本演练总是恢复到全新的一次性实例（m8 §4.2 的人工流程覆盖"就地恢复"） |
| 与 m10 逻辑备份**交叉验证**（PITR 恢复到 T，与 T 时刻的 pg_dump 比内容） | ❌ 未做 | 需要一次"逻辑备份 + 归档"同时可用的窗口；建议 M12 补 |

## 10. 幂等与清理

- **幂等**：每次运行用随机命名空间（`pitr-drill-<yyyyMMdd-HHmmss>-<6 位随机 hex>-{src,dst,archive,base,restore}`），
  端口自动挑选，互不干扰；重复运行的结果**在内容层完全一致**（实测 7 轮 PASS，A/B/C/D 的每一项数字逐字相同），
  差异只在 IO 型阶段的秒数（§7.2）。**不需要为了重跑先手动清理**。
- **自动清理**：默认（不加 `--keep`）在 `finally` 分支删除 2 个容器 + 3 个卷，**只删本次命名空间**
  （名字断言失败会退出码 4 而不是删错东西）。第 3 轮、第 6 轮、第 7 轮之后的核对：
  `docker ps -a --filter name=pitr-drill` 与 `docker volume ls --filter name=pitr-drill` **均为空**。
- **残留处理**：异常中断（Ctrl-C / 宿主重启）会留下资源，脚本下次运行会**告警列出**但默认不删；
  加 `--clean-stale` 才清理（严格命名匹配）。第 3 轮实测清掉了第 2 轮 `--keep` 的 2 容器 + 3 卷。
- **`--keep` 后的人工核对**（脚本会打印同样的命令）：

```bash
export MSYS_NO_PATHCONV=1                     # Git Bash 下防路径改写
docker ps -a --filter name=pitr-drill
docker volume ls --filter name=pitr-drill
docker logs <容器名>-dst | grep -E "recovery|timeline"     # 恢复实例日志
docker exec -it <容器名>-dst psql -U drill -d drilldb -c 'SELECT timeline_id FROM pg_control_checkpoint()'
```

- **共享环境核对**（每轮都做）：

```bash
# ① 不能有本脚本的残留
docker ps -a --filter name=pitr-drill --format '{{.Names}}'    # 期望：空
docker volume ls --filter name=pitr-drill --format '{{.Name}}' # 期望：空
# ② 既有的共享容器必须仍在运行、且没有被本脚本动过
docker ps --format '{{.Names}}'    # 应含 docker-postgres-1 / docker-redis-1 / docker-minio-1
docker inspect -f '{{.State.StartedAt}}' docker-postgres-1     # 启动时间应当是"很久以前"，不是刚才
```

> 注意：并行的其它 Agent 会起自己的验证容器（实测时容器列表里就有 `a16-verify-pg`/`a16-verify-redis`），
> 所以"容器列表里只有 5 个"不是判据；判据是**没有 `pitr-drill-*` 残留**、且 `docker-postgres-1` 仍为
> `(healthy)`、`RestartCount=0`。
>
> 本次实测的诚实附注：`docker-postgres-1` / `docker-redis-1` / `docker-minio-1` 三个容器的
> `StartedAt` 都落在 **2026-09-28T09:42:53~54Z** 的同两秒内（脚本**第一次**真跑是在
> **09:43:17Z**，即它们比演练早约 24 秒启动）。三个容器（含 `b2c-*`）同一秒启动、且
> `RestartCount=0`，指向引擎/WSL 层面的一次整体重启，不是本脚本所为：脚本不含任何
> `restart`/`stop`/`kill` 动作，只对自己命名空间内的容器 `rm -f`（名字断言不过就退出码 4），
> 也从不 `docker compose`。**无法在本机证明"不是我"**——这条留给读者与 §8.1 的生产纪律去核对。
> 演练全程**没有连过** `agent_platform`，对共享库**没有写入**——脚本按构造就不读 `.env`、不认 `DATABASE_URL`。

## 11. 与其它文档的关系

| 文档 | 关系 |
| --- | --- |
| `m8-disaster-recovery.md` §1/§3.1/§4.2/§7/§8 | 本演练的上位：**WAL 归档 + PITR** 的要求与目标 RPO/RTO 来自这里；§8 的"PITR ❌ 未演练"由本文件承接（**本机一次性容器**口径，不是生产） |
| `m10-runbook.md` §4.3 | 四层校验 A/B/C/D 的**口径来源**；本文件只换了"期望值来源"（§5.2），算法与选表规则没改 |
| `m10-runbook.md` §1.3/§1.4 | 退出码契约与"口令不进 argv"的纪律，本脚本直接复用 |
| `m11-implementation-plan.md` §2 P15 / §6 A15 / §13 | 本 Phase 的规格；§13 "PITR 生产量级/主从真切换/多可用区"仍是**再延**项（本文件 §9 登记） |
