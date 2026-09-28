# M11-P9 备份静态加密 + 真实桶归档（backup/restore 收尾）

> **上游文档**：`docs/operations/m10-runbook.md`（§2 备份、§3 密钥清单、§4 恢复演练——本文件**不重复**那些
> 流程，只写 M11-P9 的增量：**加密**、**真实桶 e2e**、**统一解压/解密链路**、**表数校正**）。
> 审计来源：D1-13（静态加密）、NV-25（上传真实桶端到端）、D2-19（`--expect-tables` 示例数字过期）。
>
> **本文件的全部数字都是在本机真实跑出来的**（2026-09-28，dev 库 `agent_platform` @ `localhost:5433`，
> MinIO `localhost:9000`，gpg 2.4.9）。**它们不可外推到生产量级**（见 §7）。

## 0. 可信度声明（先读这一节）

| 内容 | 状态 |
| --- | --- |
| `backup.ts --encrypt gpg` 对称加密 + **解密自检**（回读 sha256 == 明文 dump） | ✅ 真实执行（§3.1，退出码 0，自检 284ms） |
| 加密产物 **恢复演练**（临时库 → 6 项校验 → 自动 DROP） | ✅ 真实执行（§3.3，PASS，88/88 表 + 3 张表逐行一致，合计 67,938 行） |
| `--upload` **真实桶**端到端（建桶 → 上传 → 体积 + **ETag/md5 内容级**核对） | ✅ 真实执行（§4，ETag `5b3bf9e6…` == 本地 md5） |
| 失败路径退出码（口令错/缺失、公钥缺失、`.gpg.gz` 逆序、自检失败） | ✅ 真实执行（§6：4 / 4 / 4 / 2 / 3） |
| 脚本单测（扩展名链、保留策略、gpg argv、真实加解密往返） | ✅ 75 用例 / 5 文件全绿（`apps/api/scripts/vitest.config.ts`） |
| **公钥加密**（`--encrypt-recipient`）的端到端 | ❌ **未验证**——本机 keyring 无私钥；只验证了"缺公钥 ⇒ 退出码 4"的前置检查（§6） |
| **生产量级**（TB 级库、GB 级产物）的耗时/内存/`mc` 行为 | ❌ **未验证**——dump 仅 12.16 MB，数字不可外推（§7） |
| 密钥托管（Vault/KMS/HSM）、口令轮换周期 | ❌ **未验证**——本机口令来自环境变量/临时文件（§7） |
| `--mc-mode native`（不在容器里跑 mc） | ❌ **未验证**——本机无原生 mc（§7） |

## 1. 加密怎么用（最小路径）

```bash
cd apps/api

# ① 对称加密（口令只经环境变量 → stdin；**绝不**进 argv）
BACKUP_GPG_PASSPHRASE="$(pass show db-backup)" \
  npx tsx scripts/backup.ts -o /var/backups/agent-platform --label daily \
    --expect-tables 88 --encrypt gpg

# ② 恢复：同一条口令环境变量 + 产物路径（脚本按扩展名链自动解密+解压）
BACKUP_GPG_PASSPHRASE="$(pass show db-backup)" \
  npx tsx scripts/restore.ts -f /var/backups/.../agent_platform-daily-20260928-175022.sql.gz.gpg -t drill_tmp --confirm

# ③ 公钥加密（运维机不需要口令；私钥只在使用端）
npx tsx scripts/backup.ts --encrypt gpg --encrypt-recipient ops@example.com
```

**口令纪律（三条，都是硬规则）**：口令只在环境变量 `BACKUP_GPG_PASSPHRASE` 里，经 **stdin** 传给 gpg
（`--passphrase-fd 0`）；日志/报告只回显"已设置（长度 N）"或"缺失"，**从不回显值**；argv、manifest、
错误信息里都不出现口令。备份/恢复两侧的 gpg 调用**永远**带 `--batch --pinentry-mode loopback`——
少了 `loopback` 会去弹 pinentry 图形框，在 CI/Cron 里表现为"脚本挂住"（本 Phase 单测实测踩到过，见 §5）。

## 2. 产物形态：扩展名链（`.sql[.gz][.gpg]`）

| 形态 | 何时产生 | 读取链（反序） |
| --- | --- | --- |
| `.sql` | `--no-compress`（外加默认保留明文时也短暂存在） | 直接读 |
| `.sql.gz` | 压缩、不加密（M10 起的默认形态） | gunzip |
| `.sql.gpg` | `--no-compress --encrypt gpg` | gpg 解密 |
| `.sql.gz.gpg` | **压缩 + 加密（加密开启时的默认形态）** | gpg 解密 → gunzip |

**顺序固定为"先压缩后加密"**：`.gpg.gz` 明确拒绝（退出码 2，原因直说）——先加密再压缩既无收益，
而"猜顺序猜错"会把密文当 gzip 流喂给 gunzip，得到一个"解析不出任何表"的**假失败**。

**为什么把三处收敛成一条链路（D1-13 的实质）**：`restore.ts` 原先在三个地方各写一份
`file.endsWith('.gz') ? gunzip : 原样`（内容统计、抽样内容、回灌）。三份实现必然出现"改了两处漏一处"：
给回灌加了 `.gpg` 而统计路径没加 ⇒ 统计到 0 张表 ⇒ 演练以"备份无效"的**假失败**告终（更糟的是反向：
校验被绕过）。现在 `lib/artifact.ts` 的 `openArtifactStream()` 是唯一实现，三个调用点共用，
`finished` 上集中汇报链上任一环的失败（gpg 退出码、gunzip 报错、文件截断）。

## 3. 实测：加密备份 → 上传 → 恢复（同一条产物，2026-09-28）

产物：`agent_platform-m11p9-enc-20260928-175022.sql.gz.gpg`

### 3.1 备份（`--encrypt gpg --upload --bucket db-backups --prune`，退出码 0）

| 指标 | 数值 |
| --- | --- |
| `pg_dump` | 12,754,944 字节（12.16 MB）/ **467 ms**（sha256 `febe7321393ba74f…`） |
| 内容统计 | 88 张表 / 88 个 COPY 段 / **67,938 行** / 202 条索引语句 / 39 行 `_prisma_migrations` / 扩展 `pgcrypto,vector` |
| 关键表行数 | User=1178、Organization=1220、AgentRun=1103、UsageRecord=1613、Credential=26 |
| gzip -6 | 3,668,629 字节（**3.48×**）/ 245 ms（sha256 `e62fa262…`，即 manifest 的 `preEncryptionSha256`） |
| gpg AES256 | 3,668,802 字节（**+173 字节 = +0.00%**）/ **203 ms** |
| **解密自检** | 回读（gpg→gunzip）sha256 == 明文 dump 的 sha256 / **284 ms** ✅ |
| 产物 sha256 | `6460a363b1627a537c87ef8b666d59fd5c73164416da808f31e56985e8c2db63` |
| 校验结论 | 6/6 通过（file-non-empty / has-tables / copy-segments-match-tables / expected-table-count / row-count-floor / **encrypted-artifact-decryptable**） |
| 耗时 | dump 467 / 统计 67 / 压缩 245 / **加密 203** / 合计 **3,421 ms**（不含上传） |

> 加密开销就是这两笔：**gpg 203ms** + **自检回读 284ms**（自检是"密文确实解得开"的唯一证明，
> 值得付）。密文比 `.gz` 只大 173 字节（gpg 包头），因为压缩已经在前面做过了。

### 3.2 上传（NV-25，见 §4）

远端 `db-backups/postgres/`：产物 + manifest 两个对象；体积与内容级核对均通过。

### 3.3 恢复演练（临时库 `m10p9_m11enc3`，`--confirm`，退出码 0）

| 校验 | 结果 |
| --- | --- |
| 产物形态识别 | `.gz.gpg`（压缩：gzip；加密：gpg）——**读取链路自动还原**，无需人工解压 |
| `create-database` | `CREATE DATABASE m10p9_m11enc3 TEMPLATE template0` |
| `load` | `psql -v ON_ERROR_STOP=1` 退出码 0，**stderr 0 字节** |
| `fingerprint` | tables=88（dump 88）/ migrations=39（dump 39）/ columns=1027 / indexes=290 / enums=38 / fks=152 / 扩展 `pgcrypto,plpgsql,vector` |
| `row-counts` | **88/88 张表逐表一致**；恢复库合计 67,938 行 == dump 67,938 行 |
| `key-tables` | User 1178/1178、Organization 1220/1220、AgentRun 1103/1103、UsageRecord 1613/1613、Credential 26/26、`_prisma_migrations` 39/39 |
| `sample-consistency` | 抽样 3 张表**逐行**比对全部一致（User 1178 行、Organization 1220 行、ExtensionVersion 27 行） |
| 总耗时 / 清理 | **10.15 s**；临时库**已自动 DROP**（`--keep` 可留证） |

同一脚本在早前的加密产物上也跑过一次完整演练（`m10p9_m11enc`）：回灌 14.50 s、总计 26.77 s、PASS。
两次都是**临时库**，源库 `agent_platform` 全程只读（pg_dump 只读 + 校验只读），从未被写入。

## 4. 真实桶归档 e2e（NV-25）

```bash
BACKUP_GPG_PASSPHRASE="…" npx tsx scripts/backup.ts --encrypt gpg \
  --upload --bucket db-backups --prefix postgres/ --label m11p9-enc
```

实测（退出码 0）：

| 步骤 | 证据 |
| --- | --- |
| 建桶 | `mc mb --ignore-existing m10/db-backups`（专用桶，**不与业务桶混用**） |
| 上传 | `mc cp` 一次性容器（`--network container:docker-minio-1`，凭证经 **0600 临时 env 文件**注入，用完即删） |
| 体积核对 | `mc ls -r --json` ⇒ 3,668,802 字节 == 本地产物字节数 |
| **内容级核对** | `mc stat --json` ⇒ ETag `5b3bf9e6472b21f83d84e4e29f121482`；与本地 `md5(产物)` **一致**（独立用 node 复算过） |
| manifest | 数据文件传完后才定稿并单独补传（远端与本地同一份） |

**为什么用 ETag 而不是 `mc cat \| md5`**：单段上传的 S3 ETag 就是对象内容的 MD5，`stat` 是**零传输**的
内容级证明；把 GB 级对象拉回来算 md5 在生产上不可接受。多段上传的 ETag 形如 `<md5>-<n>`，
此时脚本**不假装核对过**：如实打 warn 并写 `remote.contentVerified=false`（需要内容级证明时改用
`minio-mirror.ts --checksum-sample`）。本次两个上传（`…-172637`、`…-175022`）的 ETag 都是单段 md5。

> **本 Phase 实测抓到的真问题**：首版 `parseMcStatJson()` 只认 `key` 字段，而 `mc stat --json` 对
> **文件**目标返回的是 `name`（`key` 只在 `ls --json` 里）⇒ 解析恒为 null ⇒ ETag 明明在响应里却被丢掉，
> 上传核对**静默降级成"只比了体积"**，日志还会把责任推给服务端（"ETag 不是单段 md5"）。
> 已修（两种字段都认）+ 用**真实响应报文**做单测；修后同一命令输出"内容级核对：通过（ETag …）"。

## 5. 保留策略：整套删、整套留

保留策略按 `backupSetKey()`（扩展名链解析）归组：`<库名>-<时间戳>` 一套 = `.sql` / `.gz` / `.gpg` /
`manifest.json` 的集合，**要么整套留、要么整套删**。

- 旧实现是一条正则白名单（`.sql|.sql.gz|manifest.json`），加密后新增的 `.sql.gz.gpg`
  **匹配不上** ⇒ 加密备份永远不会被回收（磁盘悄悄涨满，直到某天备份失败才发现）。
- 只删密文留下 manifest（或反之）都是坏状态：前者恢复时才发现文件没了，后者把"这份备份当时的校验
  结论"抹掉——而 manifest 的全部意义就是留证据。
- **白名单之外的文件一律不动**（其他库的备份、`restore-*.report.json`、运维手工放的 README），
  并在日志里如实回报数量。

实测（`--prune --prune-keep 3`）：`扫描 4 份备份集，删除 1 套（3 个文件）（保留最近 3 套；含
.sql/.gz/.gpg/manifest 整套删除）：agent_platform-m11p9-enc-20260928-172456` + `4 个文件不匹配本脚本
命名规则，未参与清理（原样保留）`。

## 6. 失败路径实测（退出码契约，全部真跑过）

| 场景 | 命令要点 | 退出码 | 现象 |
| --- | --- | --- | --- |
| **口令错误** | 恢复时给错 `BACKUP_GPG_PASSPHRASE` | **4** | 报 `gpg 解密失败（退出码 2）：… decryption failed: Bad session key`，并附"下游现象：unexpected end of file"+口令提示 |
| 口令缺失（加密备份） | `--encrypt gpg` 但无 `BACKUP_GPG_PASSPHRASE` | **4** | `gpg 前置：FAIL — 缺少环境变量 BACKUP_GPG_PASSPHRASE`，**在 pg_dump 之前**就拒绝 |
| 公钥不在 keyring | `--encrypt-recipient nobody@example.invalid` | **4** | `keyring 里没有收件人公钥 …`（同样在 dump 之前） |
| 扩展名逆序 | 恢复 `.sql.gpg.gz` | **2** | `不支持的扩展名顺序 ".gz"：只承认「先压缩后加密」(.sql.gz.gpg)` |
| **加密自检失败** | （开发期实测：自检比对基准曾经取错） | **3** | 退出码 3，且**保留明文 `.sql`**——自检没过时绝不删掉唯一可用副本 |

> **口令错误为什么是 4 而不是 3**：两者处置相反。4 = "环境不对，去把口令取回来"（备份可能是好的）；
> 3 = "这份备份不可用，立刻改用别的备份"。首版把口令错误报成
> `读取/解析备份文件失败：unexpected end of file`（gunzip 的抱怨）⇒ 会把"口令不对"**误诊为"备份损坏"**。
> 现在失败时先问链路本身，把 gpg 的原始错误摆出来。

## 7. 未验证 / 边界（不要当成能力承诺）

1. **生产量级**：本机 dump 12.16 MB、产物 3.5 MB。GB/TB 级库的耗时、内存、`mc` 上传行为、
   gpg 是否成为瓶颈——**全部未验证，数字不可外推**。压缩/加密都是流式的（不整份读进内存），
   但**自检回读会再读一遍产物**：10 GB 产物意味着多一次全量读 + 解密，预算要算进去
   （`--no-compress` 时自检链路是 gpg 单段，成本相同）。
2. **公钥加密端到端未验证**：只验证了前置检查（缺公钥 ⇒ 4）。真实场景还需验证"私钥在另一台机器上
   解得出"以及私钥丢失的后果（= 备份不可用，且**没有**对称口令可以兜底）。
   公钥模式的一个真实好处：**备份机上不需要口令**（webhook/凭证类泄露面更小）。
3. **口令/密钥托管未验证**：本机口令是临时文件里的 32 字符随机串；生产必须来自 Vault/KMS/CI Secret，
   并明确**轮换周期**（注意：轮换只影响**新**备份，老备份要用老口令解——建议口令带版本号存档）。
4. **`--mc-mode native` 未验证**：本机只有容器里的 mc；`native` 分支的路径映射（`-v` 挂载 vs 本机路径）
   只在代码层做了区分。
5. **对象生命周期/异地**：桶的版本控制、生命周期规则、跨区域复制、对象锁（WORM）都**未配置**——
   备份桶的权限应单独最小化（只允许该前缀 `PutObject`/`ListBucket`），且**不要**用业务桶。
6. **时间点恢复（PITR）**：本文全是逻辑备份，RPO = 备份时刻；WAL 归档仍未做（同 m10-runbook §9）。

## 8. D2-19：`--expect-tables` 的数字校正

- `backup.ts --help` 的示例由 **73 → 88**，并加了硬提示：**"随迁移递增，务必用当前真实表数"**；
  `lib/pg.ts` 里同口径的注释一并同步（两处数字来源必须一致，否则运维照抄注释就会误报）。
- 为什么要写死提示：表数缩水正是"备份到一个空库/半库"的最强信号（退出码 3），
  但**提示里的数字过期**会让这个保护反过来变成噪音——运维看到"期望 73 实际 88"的告警会开始忽略它。
- 巡检建议（生产）：把当前表数纳入日常巡检（`select count(*) from information_schema.tables where
  table_schema='public'`），迁移上线后同步更新 CronJob 的 `--expect-tables`。
- 本文所有实测均用 `--expect-tables 88`（= 当时真实表数），并同时给了 `--min-rows` 下限。

---
**相关产物**：`apps/api/scripts/backup.ts`、`apps/api/scripts/restore.ts`、
`apps/api/scripts/lib/{artifact,gpg,mc,manifest,cli,pg}.ts` + 同目录 `*.spec.ts`。
演练报告样例：`restore-m10p9_m11enc3-<stamp>.report.json`（含 6 项校验的逐条结论）。
