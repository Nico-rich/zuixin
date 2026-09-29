# M12-P5 PITR × 逻辑备份交叉验证（`scripts/pitr-backup-crosscheck.ts`）

> 一句话：把**两条恢复链路**（PITR 时间点恢复 / 逻辑备份还原）放在**同一份数据**上互相对照——
> 如果 PITR 的恢复态能被"对它做一次生产口径的 pg_dump + 回灌 + 四层比对"完全复现，
> 那么逻辑备份链路就是可信的；反之，任何一处**说不清来源的差异**都必须让整轮 FAIL。

## 0. 可信度声明（先读这一节）

- 本脚本**不重复实现 PITR 编排**：它要么自己跑一轮 `pitr-drill.ts --confirm --keep`（约 40~70s），
  要么用 `--drill-report` 复用既有 `--keep` 报告。PITR 本身的编排、四层校验口径见
  `docs/operations/m11-pitr-drill.md`；本文只描述**交叉验证**这一段增量。
- 本机一次性容器 ≠ 生产拓扑。**"逻辑备份能复现 PITR 恢复态"这个结论可外推**（它是"导出/导入是否忠实"的性质）；
  **RTO/RPO 数字不可外推**（见 §7）。
- 与 `pitr-drill.ts` 同源的安全边界，但**风险不继承**：本脚本只**读** drill 的容器与卷
  （`docker exec` 查询 + `docker exec pg_dump`），**绝不删除**它的任何资源。

## 1. 为什么需要它（两条链路各能证明什么）

| 链路 | 能证明 | **不能**证明 |
| --- | --- | --- |
| PITR（WAL 归档 + `recovery_target_time`） | "能回到事故前那一刻"（含窗口内被删/被 DROP 的对象） | 备份文件本身是否**可还原**（归档不是自描述产物） |
| 逻辑备份（`pg_dump` + 回灌） | "能独立于原实例重建出等价库" | 能否回到**任意时刻**（只有 dump 那一瞬） |

两条链路共同的死角是**"我以为我备份了"**：dump 少了 COPY 段、扩展没带、回灌静默跳过了某些表，
这些都不会让脚本失败，只会在**真正需要恢复的那天**才暴露。交叉验证用 PITR 的恢复态做"标尺"，
把逻辑备份链路按**逐表逐内容**的口径钉死：

```
pitr-drill --confirm --keep            ← 上游：一次真实 PITR 演练（src=事故后源库 / dst=恢复到目标时刻）
        ↓ 只读连接 + 生产口径 pg_dump（两边各一份）
pitr-backup-crosscheck.ts
        ↓ 回灌到一次性空实例（两个独立库，走 psql -v ON_ERROR_STOP=1 生产路径）
   等价 A：dst ↔ 它的逻辑还原        等价 B：src ↔ 它的逻辑还原
   分歧 C：dst 与 src 的差异必须**恰好**是事故足迹（不多不少）
   语义 D：事故行只在 src；恢复后写入行只在 dst
```

## 2. 脚本入口与安全边界

### 2.1 命令

```bash
# ① 默认就是 dry-run：只打印计划（上游来源 / 自建实例名 / 产物目录 / 检查项 / 安全边界），不调用 docker
npx tsx scripts/pitr-backup-crosscheck.ts

# ② 自跑一轮 drill + 交叉验证（约 1.5~2 分钟；结束后自建实例即删）
npx tsx scripts/pitr-backup-crosscheck.ts --confirm

# ③ 复用既有 drill --keep 报告（省掉 ~40~70s；最常用于"已有人做过取证"的现场）
npx tsx scripts/pitr-backup-crosscheck.ts --confirm --drill-report /tmp/pitr-drill-report.json

# ④ 保留自建实例与卷人工取证 + 机器可读报告
npx tsx scripts/pitr-backup-crosscheck.ts --confirm --keep --report-json /tmp/xcheck.json

# ⑤ 先清理历史残留的 pitr-xcheck 容器/卷（严格命名匹配），再跑一轮
npx tsx scripts/pitr-backup-crosscheck.ts --confirm --clean-stale
```

### 2.2 参数（全部有默认值；未知参数**直接失败**，退出码 2）

| 参数 | 默认 | 说明 |
| --- | --- | --- |
| `--confirm` | 关（dry-run） | 真执行；不加只打印计划 |
| `--drill-report <path>` | 无 | 复用既有 `pitr-drill --keep` 报告（缺省 = 本脚本自己跑一轮） |
| `--keep` | 关 | 保留**自建**实例与卷（drill 的资源无论如何都不动） |
| `--clean-stale` | 关 | 先删残留 `pitr-xcheck-<stamp>-<rand>-xr` 容器与 `...-data` 卷（严格命名匹配） |
| `--pg-image <image>` | `pgvector/pgvector:pg16` | 自跑 drill 时的镜像（复用报告时以报告里的镜像为准） |
| `--verify-sample <n>` | 5 | D 层内容级抽样表数（0 = 关闭） |
| `--plan-rows <n>` | 3 | drill 播种的 `Plan` 行数（事故 `DELETE` 的行数基准，用于精确核对分歧） |
| `--timeout-ms <ms>` | 120000 | 自建实例就绪等待上限 |
| `--work-dir <dir>` | 系统临时目录 `pitr-xcheck-<stamp>` | pg_dump 产物落盘目录 |
| `--report-json <path>` | 无 | 机器可读报告 |
| `--label <tag>` | `pitr-xcheck` | 报告标签 |

退出码：`0` 成功 / `1` 执行失败 / `2` 参数错误 / `3` **校验失败**（任一交叉断言不成立）/ `4` 前置条件不满足
（drill 报告不存在、drill 结论非 PASS、名字闸门不通过等）。

### 2.3 安全边界（**本脚本最重要的性质**）

1. **drill 的资源只读**：连接前先过 `assertDrillContainer`（名字必须匹配
   `^pitr-drill-\d{8}-\d{6}-[0-9a-f]{6}-(src|dst)$`），否则拒绝连接；任何情况下都不对 drill 执行 `rm`/`volume rm`。
   drill 的清理是它自己的事：`npx tsx scripts/pitr-drill.ts --confirm --clean-stale`。
2. **自建资源删除前先认名字**：`pitr-xcheck-<stamp>-<rand>-xr` / `...-data` 两个严格正则，逐个断言后才删；
   **绝不"尽力而为地删"**（近似名、少后缀、前缀相同的别人资源一律拒绝）。
3. **自建实例不暴露宿主端口**：只有 `docker exec` 内的 unix socket 连接，口令随机生成、通过
   `-e POSTGRES_PASSWORD`（**值不进 argv**）注入，脚本自己也不读它。
4. **共享开发容器绝不触碰**：报告里记录 `sharedContainersStillRunning`（`docker-*` / `b2c-*`）作为事后证据。
5. 逻辑备份产物是**明文**，只落在本机一次性临时目录；不加密、不上传（生产备份必须加密，
   见 `docs/operations/m11-backup-encryption.md`）。

## 3. 交叉验证编排（6 步）

| # | 步骤 | 失败模式（这一步防的是什么） |
| --- | --- | --- |
| 0 | 上游基线：自跑 `pitr-drill --confirm --keep` 或读 `--drill-report`；**结论非 PASS 直接退出码 4** | 在不可信的基线上做结论（"恢复错了一个时刻"会被下游当成"备份有问题"） |
| 1 | 连 dst / src 做连通性探测（`ping`） | 容器在、但库没起来（`pg_isready` 说谎的历史见 m11 §6.4） |
| 2 | 对 **dst** 与 **src** 各做一次**生产口径** `pg_dump`（`lib/dump.ts` 的一致性参数：`--no-owner --no-privileges` 等），并用 `parseDumpStatsText` 回读真实"表数 / COPY 段数 / 行数 / 扩展" | dump 静默少段（扩展缺失、大对象丢失、COPY 段被跳过） |
| 3 | 建**一次性**空实例（`pgvector/pgvector:pg16`，宿主不暴露端口），把两份 dump 分别回灌到两个库（`psql -v ON_ERROR_STOP=1`） | 回灌路径与生产 restore 不一致（错误被静默吞掉） |
| 4 | **等价 A/B（四层）**：A 指纹（表/列/索引/枚举/外键/迁移/扩展 七项）、B 逐表行数、C 关键表行数、D 抽样表**逐行内容**（经 `COPY` 段规范化后比对） | "表数对了但列/索引/外键丢了"、"行数对了但内容不同" |
| 5 | **分歧 C（事故足迹精确匹配）**：dst 与 src 的差异必须**恰好**是事故定义的那几项（`Plan` 行数差、`UsageRecord` 表缺失），其余表逐表一致 | 用"备份也能跑完"掩盖数据面漂移；也是**两侧接反**的探测器 |
| 6 | **语义 D（点位断言）**：事故行只在 src（PITR 有意丢弃事故窗口）、`promote` 后写入行只在 dst（恢复实例确实可写） | 把"两个库都从同一份基线来"错认成"恢复了" |

> 分歧 C 的**差值方向固定为"参考侧 − 对照侧"**（参考侧 = PITR 恢复态 dst）：事故是"删数据"，
> 所以恢复侧应当**更多**（正差值）。这个方向写反过一次——见 §6.1。

## 4. 实测（2026-09-29，本机 Windows 11 + Docker Desktop 29.7.2，镜像 `pgvector/pgvector:pg16`）

同日共三轮，全部留有报告原文（临时目录，非仓库产物）：

| 轮次 | 命令 | 上游 | 结论 | 耗时 |
| --- | --- | --- | --- | --- |
| 1 | `--confirm --keep --report-json …` | **自跑** drill（`pitr-drill` 69.18s，RTO 3.22s） | **FAIL 17/18**（脚本自身判定符号 bug，见 §6.1） | 1m33.3s |
| 2 | `--confirm --drill-report <第 1 轮 drill 报告> --keep` | 复用（drill PASS） | **PASS 18/18** | 14.03s |
| 3 | `--confirm --clean-stale --drill-report <同上>` | 复用（drill PASS） | **PASS 18/18**（并清掉 2 个残留容器 + 2 个残留卷） | 14.03s |

### 4.1 第 2 轮报告原文（节选，未改数字）

```
上游 PITR ：pitr-drill-20260929-114641-8a890b-src / pitr-drill-20260929-114641-8a890b-dst
            （结论 PASS，最后重放 2026-09-29 03:47:28.674425+00）
结论      ：PASS（18/18 项通过，耗时 14.03s）
  [ok] drill-verdict — 上游演练结论 PASS
  [ok] connect-dst / connect-src — 连通性 ok
  [ok] dump-from-pitr-stats — 表 90 / COPY 段 90 / 行 546 / 扩展 [pgcrypto,vector]
  [ok] dump-from-src-stats  — 表 89 / COPY 段 89 / 行 543 / 扩展 [pgcrypto,vector]
  [ok] restore-from-pitr — 回灌到 xcheck_from_pitr 成功（2.25s）
  [ok] restore-from-src  — 回灌到 xcheck_from_src 成功（2.74s）
  [ok] 等价A(dst↔逻辑还原)-A-指纹 — 7 项一致（表 90 / 列 1036 / 索引 292 / 枚举 38 / 外键 152 / 迁移 38 / 扩展 [pgcrypto,plpgsql,vector]）
  [ok] 等价A(dst↔逻辑还原)-B-行数 — 90 张表 / 546 行逐表一致
  [ok] 等价A(dst↔逻辑还原)-C-关键表 — User=0/0 Organization=0/0 AgentRun=0/0 UsageRecord=0/0 Credential=0/0 _prisma_migrations=38/38
  [ok] 等价A(dst↔逻辑还原)-D-抽样内容 — _prisma_migrations: ok；Plan: ok；pitr_drill_event: ok；pitr_drill_ledger: ok
  [ok] 等价B(src↔逻辑还原)-A-指纹 — 7 项一致（表 89 / 列 1017 / 索引 286 / 枚举 38 / 外键 148 / 迁移 38 / 扩展 [pgcrypto,plpgsql,vector]）
  [ok] 等价B(src↔逻辑还原)-B-行数 — 89 张表 / 543 行逐表一致
  [ok] 等价B(src↔逻辑还原)-C-关键表 — User=0/0 Organization=0/0 AgentRun=0/0 UsageRecord=0/0 Credential=0/0 _prisma_migrations=38/38
  [ok] 等价B(src↔逻辑还原)-D-抽样内容 — _prisma_migrations: ok；pitr_drill_event: ok；pitr_drill_ledger: ok
  [ok] 分歧C-事故足迹精确匹配 — 两侧差异恰好是事故足迹（UsageRecord 在 src 不存在；Plan 差 3 行；其余 88 张表逐表一致）
  [ok] 语义D-事故行只在源库 — 事故行 src=1 / dst=0（PITR 有意丢弃事故窗口）
  [ok] 语义D-恢复后可写行只在恢复实例 — promote 后写入行 dst=1 / src=0
行数      ：dst 90表/546行 · 逻辑还原 90表/546行 · src 89表/543行 · 逻辑还原 89表/543行
逻辑备份  ：from-pitr 265.61 KB（271985 字节）/193ms（sha256 ec21a30047e0…） · from-src 260.85 KB（267115 字节）/184ms（sha256 cc033e5d49f2…）
事故足迹  ：UsageRecord 在 PITR=0/src=null · Plan PITR=3/src=0
```

### 4.2 数字怎么读

- **"等价"不是"像"**：A 层 7 项 + B 层 90/90 表逐表 + D 层 4 张表逐行，都是**全量**比对，
  没有"抽几张表看看"的余量（`--verify-sample` 只影响 D 层的表数，A/B/C 恒为全量）。
- **dst 90 张表 / src 89 张表**：差的正是事故 `DROP TABLE "UsageRecord"`；`Plan` 3 行 vs 0 行，
  差的正是事故 `DELETE FROM "Plan"`（`--plan-rows 3` 的基准）。**这两处差异是"预期的分歧"**，
  所以分歧 C 把"恰好是它们"写成断言，而不是把"两侧一致"写成断言。
- **两次 dump 的 sha256 必然不同**（连同一容器连做两次也不同）：PG ≥ 16.10 的 `pg_dump` 会在头部写一行
  随机 `\restrict <token>`（`\unrestrict` 收尾）作为防注入令牌。所以报告里的 sha256 是**本次产物指纹**，
  用来跟"同一轮"的两份产物对账，**不能**用来跨轮比较（跨轮的等价性由 A/B/C/D 四层保证）。
- **基准行数 546 vs drill 报告的 545**：交叉验证这一轮读到的 dst 比 drill 报告多 1 行——那是 drill
  在 `promote` 之后、校验阶段的"恢复后可写"探针行（语义 D 断言的 `dst=1`）。这不是漂移，
  是**两次采样时刻不同**；因此交叉验证**只与自己同轮的两侧互相印证**，不拿 drill 报告的行数做基准。

### 4.3 第 1 轮为什么 FAIL（值得留着看）

第 1 轮的 17/18 只差一项：

```
[FAIL] 分歧C-事故足迹精确匹配 — 未声明的差异：Plan；明细 Plan(差值 -3，期望 3)
```

这不是数据问题，是**脚本自己的差值方向写反了**（详见 §6.1）。修复后第 2/3 轮 18/18。
保留这条记录的意义在于：**它是一次真实运行抓出来的**——只跑单测（当时那 9 个纯函数用例全绿）
不会暴露它，因为测试夹具按同一套错误约定写的。

## 5. 判定口径

| 层 | 比对对象 | 期望值来源 | 不一致时 |
| --- | --- | --- | --- |
| A 指纹 | dst/src 与其逻辑还原库的 7 项元数据（表/列/索引/枚举/外键/迁移/扩展） | 参考侧自身 | FAIL（"结构漂了"） |
| B 行数 | 逐表行数（表集合必须相同） | 参考侧自身 | FAIL（"数据漂了"） |
| C 关键表 | `KEY_TABLES`（User/Organization/AgentRun/UsageRecord/Credential）+ `_prisma_migrations` | 参考侧自身 | FAIL |
| D 内容 | `--verify-sample` 张抽样表**逐行**（经 COPY 文本规范化） | 参考侧自身 | FAIL（"行数对了内容不对"） |
| 分歧 C | dst vs src | **事故定义**（`Plan` −3 行、`UsageRecord` 表消失） | FAIL（"差异说不清来源"） |
| 语义 D | 事故行 / 恢复后写入行 在两侧的存在性 | 事故与 promote 的定义 | FAIL（"接反了" 或 "没真恢复"） |

## 6. 踩到的坑（都写进脚本了，别重新踩）

### 6.1 差值方向必须钉死成"参考侧 − 对照侧"

第一版写的是 `delta = 对照侧 − 参考侧`，而期望表（`expectedDeltas`）按"恢复侧多 3 行"填的正数，
于是**正确的数据被判成 FAIL**。这类符号错误在真实运行前很难发现，所以现在：
`verifyIncidentFootprint` 的输出里**直接带 `delta` 字段并在 detail 里明写方向**，
单测同时锁住 `+3`（参考侧多）与 `2, 期望 3`（不足）两种取值。

### 6.2 `pg_dump` 的 sha256 不可跨轮比较

见 §4.2：PG ≥ 16.10 头部有随机 `\restrict` 令牌。**别**把两次运行的 sha256 不同当成数据漂移。

### 6.3 上游脚本不能当库 import

`pitr-drill.ts` 顶层是 `void main()`（无条件执行），import 它会**当场跑一轮演练**。所以本脚本
**不 import** drill，而是：① 用 `createRequire(__filename).resolve('tsx/package.json')` 解析 tsx CLI，
② 以子进程 `node <tsx-cli> scripts/pitr-drill.ts --confirm --keep --report-json <path>` 跑，
③ 只读它的 **JSON 报告**（`environment.containers.{src,dst}` 等字段；缺字段直接 FAIL 而非猜）。
本脚本自己加了 `require.main === module` 守卫，**不重犯**同样的错（可被 spec 安全 import）。

### 6.4 dump 只做一次：先落盘、再以流回灌

同一份 dump 既要用于"统计表数/COPY 段/行数"（`createDumpStatsCollector` 在流式输出上就地统计），
又要用于回灌。若"统计一遍、回灌再 dump 一遍"，两次产物在活跃库上可能不同（尤其 PG ≥ 16.10 的
随机 `\restrict` 令牌），**比对就失去了意义**。所以流程是：一次 `pg_dump` 写到 `<workDir>/from-*.sql`
→ 统计口径回读同一份文本 → 用 `createReadStream` 经 stdin 喂给 `psql -v ON_ERROR_STOP=1`。
命令执行一律走 `lib/cli.ts` 的原始 spawn（**不经 shell**），保证字节与参数原样透传
（Windows/Git Bash 下 shell 会改写路径与引号）。

### 6.5 密钥不进 argv

自建实例的口令走 `-e POSTGRES_PASSWORD`（**只给名字、不给值**），由 docker 从环境变量注入；
脚本连读都不读它（连接全在容器内 unix socket）。drill 的口令同理，本脚本从不接触。

## 7. 诚实边界（**本机一次性容器 ≠ 生产**）

**可外推**：逻辑备份链路的忠实性（"dump + 回灌能否复现参考库"）——这是导出/导入工具的性质，
与数据量级无关（大数据量下只是耗时不同）。

**不可外推**：

- **RTO / RPO**：本轮 14.03s 的交叉验证耗时、drill 的 3.22s RTO，都是"空库 schema + 数百行"的本机数字；
  生产量级的恢复时间取决于备份体积、网络与磁盘 IOPS。
- **WAL 归档拓扑**：drill 的归档是本地 `cp`（同盘），没有对象存储/异地网络延迟，也没有归档失败告警链路。
- **逻辑备份的远端链路**：本脚本的 dump/restore 全在**本机**（`docker exec` + 本地容器），
  **没有**覆盖 `backup.ts --upload` 的 MinIO 上传/下载路径（那条链路的明文闸门另见 `m12-data-plane-misc.md` §4）。
- **生产角色的受限权限**：本机用 superuser（drill 内部用户 + 自建实例的 `postgres`），
  生产若用受限角色，`pg_dump`/`psql` 可能因权限差异行为不同（如 `--no-owner` 之外的 ACL）。
- **密钥/口令丢失**：`ENCRYPTION_KEY` / GPG 私钥不在本演练范围（见 `m8-production-readiness.md`）。

## 8. 未验证清单（**本脚本不覆盖**）

- 备份**介质损坏**（坏块、静默位翻转）——四层比对是"能读出来的内容等价"，不校验介质可靠性。
- **跨版本**恢复（dump 来自其它 PG 大版本）——本轮两侧同为 `pgvector/pgvector:pg16`。
- **并发写入**下的 dump 一致性——`pg_dump` 默认在 REPEATABLE READ 快照上跑，本轮两侧都是静止库。
- `--upload` 的真实远端（MinIO）往返 + 保留策略清理的组合场景（属 `backup.ts` 的角色）。
- 大数据量（TB 级）的耗时/内存表现。

## 9. 幂等与清理

```bash
# ① 不能有本脚本的残留（--clean-stale 会按严格命名删除；dry-run 下只提示不删）
npx tsx scripts/pitr-backup-crosscheck.ts --confirm --clean-stale

# ② drill 的资源由它自己清（本脚本绝不代劳）
npx tsx scripts/pitr-drill.ts --confirm --clean-stale

# ③ 人工核对：除共享容器外，不应再有 pitr-* / pitr-xcheck-* 资源
docker ps -a --format '{{.Names}}' | grep -E '^pitr-(drill|xcheck)-' || echo "干净"
docker volume ls --format '{{.Name}}' | grep -E '^pitr-(drill|xcheck)-' || echo "干净"
```

- 默认（无 `--keep`）运行结束即删自建实例与卷；`--keep` 保留人工取证，事后用 `--clean-stale` 收尾。
- 删除动作**先过名字闸门再执行**；`finally` 阶段即使校验失败也会清理（失败轮次不留垃圾）。
- 本脚本可重复执行：drill 报告可复用，自建实例名带时间戳+随机后缀，不冲突（重名冲突会以退出码 4 提前失败）。

## 10. 与其它文档的关系

| 文档 | 关系 |
| --- | --- |
| `docs/operations/m11-pitr-drill.md` | **上游**：PITR 演练与四层校验口径；本文的"参考侧"由它产出 |
| `docs/operations/m11-backup-encryption.md` | 逻辑备份的加密/口令口径（本文的 dump 是明文临时产物，只在本机一次性目录） |
| `docs/operations/m8-disaster-recovery.md` | 备份/恢复的原始手工命令（`backup.ts` / `restore.ts` 的来源） |
| `docs/operations/m10-runbook.md` §4 | 恢复演练三步法与 A/B/C/D 口径（本文与 drill 共用同一套） |
| `docs/operations/m12-data-plane-misc.md` | M12-P5 的其余数据面增量（Analytics 聚合 / 孤儿清扫 / 上传闸门 / mc 信号清理） |
