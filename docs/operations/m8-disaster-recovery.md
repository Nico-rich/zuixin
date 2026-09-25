# M8-P9 灾难恢复手册（可执行 Runbook）

> 配套文档：`docs/operations/m8-production-readiness.md`（健康检查 / 优雅停机 / 背压 / 熔断 / 性能实测）。
> 本文所有命令都在**本机 Docker 开发环境**（`docker-postgres-1` / `docker-redis-1` / `docker-minio-1`）里
> **真实执行过**，第 6 节给出实测数字与校验哈希。生产环境请把容器名/连接参数换成生产的（见每节的「生产改写」）。

## 0. 可信度声明（先读这一节）

| 内容 | 状态 |
| --- | --- |
| PostgreSQL 备份（`pg_dump`）→ 校验非空 / 行数 / 哈希 | ✅ **真实执行**（第 6.1 节） |
| PostgreSQL 恢复到**独立临时库** + schema 指纹 + 逐表行数比对 | ✅ **真实执行**（第 6.2 节，临时容器已销毁） |
| 对象存储 `mc mirror` 备份 / 恢复 / 逐对象 md5 比对 | ✅ **真实执行**（第 6.3 节，用**临时桶**，未触碰生产桶） |
| Redis 数据级恢复（RDB/AOF 回灌） | ❌ **未演练**——本项目 Redis 是**可重建的调度层**，不做数据级恢复（见第 5 节，这是设计选择不是遗漏） |
| 生产环境（多节点 / 主备 / PITR）下的恢复 | ❌ **未验证**——本机是单实例单容器，无 WAL 归档、无主从（见第 8 节） |
| 「主库损坏」「误删表」等场景的**端到端**演练 | ⚠️ 只演练了「备份 → 临时库恢复 → 校验」这一可安全执行的核心链路；破坏生产库的演练**不做**（见第 4/8 节） |

**绝对不要把本机 RTO/RPO 数字当成生产承诺**：本机 5MB 库的恢复耗时不能外推到生产 TB 级库。

## 1. 目标 RPO / RTO

| 资产 | RPO 目标（生产） | RTO 目标（生产） | 本机实测 |
| --- | --- | --- | --- |
| PostgreSQL | ≤ 5min（需开 WAL 归档 / PITR；**仅靠 `pg_dump` 时 RPO = 上次备份时间点**） | ≤ 30min | 备份 0.72s / 恢复 2.16s（5.3MB 库） |
| 对象存储（MinIO / S3） | ≤ 24h（每日 `mc mirror`；开了 bucket 版本控制/复制可到分钟级） | ≤ 2h | mirror 往返 + md5 校验全通过（196K 级） |
| Redis | **无 RPO 要求（可接受全丢）** | ≤ 10min（重建队列 + 等 `recoverStale` 兜底） | 未演练（设计为可丢弃） |
| `.env`（含 `ENCRYPTION_KEY`） | 0（任何一次变更即备份；丢失不可恢复） | ≤ 30min（从密钥管理系统取回） | 未演练（纯流程要求） |

## 2. 资产与「真相源」分层（决定恢复顺序）

```
PostgreSQL  ── 唯一权威事实源（用户/组织/run/step/审批/计量/连接凭证密文/BullMQ 之外的业务状态）
   ↑ recoverStale（每 5min 清扫）按 DB 状态把丢失的 job 重新投递
Redis       ── 可重建的调度层（BullMQ 队列/锁/熔断计数/SSE 事件通道）——丢数据不丢业务事实
对象存储    ── 内容字节（生成产物 artifact / 上传文件）——DB 里只有引用（key/URL）
.env        ── 密钥与连接串（ENCRYPTION_KEY / JWT_SECRET）——**不在任何自动备份里，必须单独备份**
```

**恢复顺序（重要）**：① PostgreSQL → ② `.env`/密钥 → ③ 对象存储 → ④ 启动 API → ⑤ 启动 Worker
（Redis 不用恢复，第 5 节）。理由：先有事实源再放 worker 进来消费，避免 worker 在空库上把 run 判成失败。

**凭证加密范围（丢失 `ENCRYPTION_KEY` 的后果）**：`CryptoService`（AES-256-GCM at rest）用于
M7-P2 连接/凭证、M7-P6 webhook secret、M8-P6 扩展包签名（HMAC 平台密钥同源）。**密钥丢失 ⇒ 这些密文永久不可解**
（不是「恢复后重试」，是数学上不可逆）⇒ 只能让用户重新授权/重建连接。

## 3. 备份（按周期执行）

### 3.1 PostgreSQL

```bash
cd <repo 根>            # .env 所在目录

# 用户名/库名从 .env 解析（只导出到进程环境，**不回显任何带密码的串**；已实测输出 user=agent db=agent_platform）
set -a; . ./.env; set +a
PGUSER=$(node -e "console.log(new URL(process.env.DATABASE_URL).username)")
PGDB=$(node -e "console.log(new URL(process.env.DATABASE_URL).pathname.slice(1))")

mkdir -p backup
docker exec docker-postgres-1 pg_dump -U "$PGUSER" -d "$PGDB" \
  --no-owner --no-privileges --clean --if-exists \
  > "backup/agent_platform-$(date +%Y%m%d-%H%M%S).sql" 2> backup/dump.err

# 必须校验（空文件 / 报错 / 0 张表都当过"成功"是常见事故）
test -s backup/agent_platform-*.sql || { echo "备份为空，失败"; exit 1; }
test ! -s backup/dump.err || { echo "pg_dump 有 stderr，人工确认"; cat backup/dump.err; }
grep -c '^CREATE TABLE' backup/agent_platform-*.sql     # 应等于表数（本次 = 73）
sha256sum backup/agent_platform-*.sql | tee backup/last.sha256
```

- `--clean --if-exists`：让备份文件可**直接回灌到已有库**（恢复时会先 DROP 再 CREATE）。
- `--no-owner --no-privileges`：恢复目标库的用户名/角色可能与生产不同（临时库演练必须）。
- 若要「物理级/时间点恢复」，生产必须额外开 `wal_level=replica` + `archive_mode=on` + 归档目录，
  定时 `pg_basebackup`；`pg_dump` 逻辑备份**做不到 PITR**（本机也没有开）。

**生产改写**：`docker exec` → 在 DB 主机上直接 `pg_dump`（或用 `PGPASSWORD` 走 TCP），
输出到大容量盘并按第 3.4 节异地留存。恢复演练用**从库/临时实例**，不要在生产主库上试。

### 3.2 对象存储（MinIO / S3）

```bash
# 用 mc（MinIO 客户端）镜像，直接复用同一 Docker 网络访问 minio（本机实测可用）
# 凭据从 .env 取，写入一个临时 env 文件（用完立刻删除——不要留在磁盘上）
umask 077
grep -E '^STORAGE_(ACCESS_KEY_ID|SECRET_ACCESS_KEY)=' .env > /tmp/s3.env   # 绝不 cat/echo 该文件

docker run --rm --network container:docker-minio-1 --env-file /tmp/s3.env \
  --entrypoint /bin/sh quay.io/minio/mc:latest -c '
    mc alias set dr http://localhost:9000 "$STORAGE_ACCESS_KEY_ID" "$STORAGE_SECRET_ACCESS_KEY" &&
    mc mb --ignore-existing dr/m8-backup &&
    mc mirror --overwrite --remove dr/agent-storage dr/m8-backup &&   # 生产：目标换成异地 S3/NAS
    mc ls -r --summarize dr/m8-backup
  '
rm -f /tmp/s3.env

# 生产写法（异地桶，比"备份到自己同一个 MinIO"强得多）：
#   mc mirror --overwrite --remove prod/agent-storage offsite/agent-storage-backup
```

注意：`STORAGE_DRIVER=local` 时（本机开发环境）对象在 **API/Worker 宿主机的 `./data/storage`**，
不在 MinIO 里——此时备份对象 = 备份那个目录（见下），MinIO 备份命令只在切到 S3 驱动后才有意义。

```bash
# local 驱动：tar 打包（必须校验：能解开且文件数一致）
tar -czf backup/local-storage-$(date +%Y%m%d).tar.gz -C apps/api data/storage
tar -tzf backup/local-storage-$(date +%Y%m%d).tar.gz | wc -l
```

### 3.3 配置与密钥（`.env`）

- `.env` **不在 git 里**（`.gitignore`），因此**不会**随代码备份——必须显式备份；
- `ENCRYPTION_KEY` / `JWT_SECRET` 必须先进入密钥管理系统（Vault / KMS / K8s Secret），`chmod 600` + 加密存储；
- 备份 `.env` 时**不要**贴进工单/聊天/CI 日志。丢失 `ENCRYPTION_KEY` 的后果见第 2 节。

### 3.4 保留与异地

| 层 | 频率 | 保留 | 位置 |
| --- | --- | --- | --- |
| PG 逻辑备份 | 每日 1 次 + 变更前 | 30 天 | 异地对象存储（**与 DB 不同故障域**） |
| PG PITR 归档（生产必开） | 连续 | 7 天 | 归档盘/对象存储 |
| 对象存储 | 每日 mirror | 30 天 | 异地桶 |
| `.env` / 密钥 | 每次变更 | 永久 | 密钥管理系统 |

## 4. 恢复

### 4.1 恢复到**临时库**（校验用；本机已实测，生产演练也应走这条）

```bash
# ① 起一个全新的空容器（绝不复用生产容器/端口）
docker run -d --name m8p9-dr-restore -e POSTGRES_PASSWORD=drill -e POSTGRES_USER=drill \
  -e POSTGRES_DB=drill -p 5544:5432 pgvector/pgvector:pg16

# ② 等就绪（不要用 sleep 猜）
until docker exec m8p9-dr-restore pg_isready -U drill -d drill >/dev/null 2>&1; do sleep 1; done

# ③ 回灌（ON_ERROR_STOP=1：任何一条 SQL 失败立即退出，绝不"带错恢复"）
docker exec -i m8p9-dr-restore psql -U drill -d drill -v ON_ERROR_STOP=1 \
  < backup/agent_platform-YYYYmmdd-HHMMSS.sql > restore.out 2> restore.err
echo "exit=$?  stderr_bytes=$(wc -c < restore.err)"     # 期望 exit=0 且 stderr 为空

# ④ 校验 A：schema 指纹（表/列/索引/枚举/外键/迁移数/扩展 七项）
docker exec m8p9-dr-restore psql -U drill -d drill -At -F'|' -c "
  select 'tables', count(*) from pg_class c join pg_namespace n on n.oid=c.relnamespace where c.relkind='r' and n.nspname='public'
  union all select 'columns', count(*) from information_schema.columns where table_schema='public'
  union all select 'indexes', count(*) from pg_indexes where schemaname='public'
  union all select 'enums', count(distinct t.oid) from pg_type t join pg_enum e on e.enumtypid=t.oid
  union all select 'fks', count(*) from pg_constraint where contype='f'
  union all select 'prisma_migrations', count(*) from _prisma_migrations
  union all select 'extensions', string_agg(extname, ',' order by extname) from pg_extension;"

# ⑤ 校验 B：逐表行数 —— **必须与 dump 文件自身的 COPY 段比较**，
#    不要与源库"当前"行数比较（源库在备份之后可能仍在被写入 → 会得到假失败）
for t in $(docker exec m8p9-dr-restore psql -U drill -d drill -At -c "select relname from pg_class c join pg_namespace n on n.oid=c.relnamespace where c.relkind='r' and n.nspname='public' order by relname"); do
  echo "$t|$(docker exec m8p9-dr-restore psql -U drill -d drill -At -c "select count(*) from \"$t\"")"
done > dst-counts.txt

# ⑥ 校验 C：业务冒烟（在临时库上跑只读查询，确认关键表可用）
docker exec m8p9-dr-restore psql -U drill -d drill -c 'select count(*) from "AgentRun";'

# ⑦ 销毁临时容器（演练不留痕）
docker rm -f m8p9-dr-restore
```

### 4.2 生产恢复（就地/切主）

```bash
# 0) 先摘流量：把 API/Worker 的 readiness 打进维护态或直接停 API（避免恢复中途被写入）
# 1) 停 Worker（先停消费端，防止在空/半恢复库上把 run 判失败）：kubectl scale deploy worker --replicas=0
# 2) 备份"损坏前的现状"（万一恢复后发现拿错文件，还能回退）：
#       pg_dump 到一个新文件 → backup/pre-restore-<ts>.sql
# 3) 恢复（二选一）：
#    a. 逻辑恢复（本手册实测路径）：
#         psql -U <user> -d <db> -v ON_ERROR_STOP=1 < backup/agent_platform-<ts>.sql
#    b. PITR（生产推荐，需 WAL 归档）：
#         pg_restore 基础备份 → 在 postgresql.conf 配 recovery_target_time → 启动 → 到达目标点后 promote
# 4) 校验：第 4.1 节的 ④⑤⑥ 三步 + `_prisma_migrations` 与代码 `prisma migrate status` 一致
# 5) 起 API（确认 /ready 200 且 db/redis state=up）→ 起 Worker（观察 recoverStale 兜底把 queued/running 的 run 收尾）
# 6) 事后核对：AgentRun 里 status='running' 且 leaseUntil 过期的行，应由 recoverStale 在 ≤7min 内收尾（见 readiness §3.1）
```

**关键约束**：恢复期间**不要在库上跑 `prisma migrate deploy`**——备份里已含 `_prisma_migrations`，
先让状态一致再谈迁移；不一致时以 `migrate status` 的差集为准人工处理。

### 4.3 对象存储恢复

```bash
# 桶级：镜像回灌（--overwrite 覆盖同名；恢复演练请回灌到**新桶**再校验，不要直接覆盖生产桶）
docker run --rm --network container:docker-minio-1 --env-file /tmp/s3.env \
  --entrypoint /bin/sh quay.io/minio/mc:latest -c '
    mc alias set dr http://localhost:9000 "$STORAGE_ACCESS_KEY_ID" "$STORAGE_SECRET_ACCESS_KEY" &&
    mc mb --ignore-existing dr/agent-storage-restore &&
    mc mirror --overwrite dr/m8-backup dr/agent-storage-restore &&
    mc ls -r --summarize dr/agent-storage-restore'

# 完整性：逐对象 md5 比对（源 → 恢复端），数量与体积也必须相等
#   mc cat <target>/<key> | md5sum     对比   本地/源端 md5sum
```

- **DB 与对象存储的一致性**：`Artifact` 行里的 key 指向对象；对象缺失 ⇒ 前台 404/裂图，但**不影响 run 状态机**。
- 恢复后**不要让 API 去"补写"缺失对象**——artifact 是只读产物，缺失按业务报错处理。

### 4.4 恢复后的验收清单

- [ ] `GET /api/v1/ready` → 200，`db.state=up`、`redis.state=up`
- [ ] 关键表行数 ≥ 备份时刻（`AgentRun` / `User` / `Organization` / `UsageRecord`）
- [ ] `_prisma_migrations` 与代码期望一致（`npx prisma migrate status`）
- [ ] 登录可成功（JWT 可签发 ⇒ `JWT_SECRET` 正确）
- [ ] 抽查一条 Connection/Credential 能解密使用（⇒ `ENCRYPTION_KEY` 正确；**这条最容易漏，错了等于所有凭证报废**）
- [ ] 起 Worker 后 5~7min 内，遗留 `queued/running` run 被 `recoverStale` 收尾，且**无重复执行**（LLM 计量行数不翻倍）

## 5. Redis 恢复策略：不恢复，重建

**设计立场**：Redis 只承载可重建状态，**不做数据级备份/恢复**。

| Redis 里的东西 | 丢失后果 | 兜底 |
| --- | --- | --- |
| BullMQ 队列 job（agent-run / workflow / image / video / scheduler / media-cleanup） | 在途 job 消失 | DB 是事实源：`recoverStale`（media-cleanup 每 5min）按 `AgentRun/WorkflowRun.status ∈ {queued,running,waiting}` 重新入队（条件更新 + 唯一 jobId ⇒ 不重复执行） |
| 周期调度（`media-cleanup-scheduler` 等 `upsertJobScheduler`） | 清扫停摆 | Worker 启动时 `OnModuleInit` 重新 upsert（幂等），**不需要备份** |
| 熔断计数（CircuitBreaker KV） | 全部回到 `healthy` | 可接受：最坏是多打几次故障 provider，随后重新熔断 |
| SSE 事件通道（EventBus pub/sub） | 前端实时流断开 | 前端重连 + `recoverStale` 状态兜底；事件本身有落库通道 |
| 速率限制计数 | 短时限流放宽 | 可接受（安全边界由鉴权/配额决定，不限流不等于越权） |

**重建步骤**：

```bash
# 1) 确认 Redis 可用（不要用 flushall 清生产键——重建靠"什么都不做"）
docker exec docker-redis-1 redis-cli -h 127.0.0.1 -p 6379 ping        # PONG
# 2) 重启 Worker：周期调度重新 upsert，队列消费端重新连接
# 3) 等待 ≤7min：观察日志出现 "lease 过期（worker 失联）→ 重新入队恢复" / "queued 超时无执行迹象（job 丢失）→ 兜底重入队"
# 4) 核对：AgentRun 中不应再存在"长时间 running 且 leaseUntil 过期"的行
#    psql -c "select count(*) from \"AgentRun\" where status='running' and (\"leaseUntil\" is null or \"leaseUntil\" < now() - interval '10 minutes');"
```

**Redis 需要持久化吗？** 本项目立场：**不需要**（AOF 可选，只为缩短"重建窗口"，不作为恢复依赖）。
**禁止**把 Redis 当作唯一事实源使用（会破坏第 2 节的分层）。

## 6. 演练记录（2026-09-25，真实执行）

### 6.1 PostgreSQL 备份

```
命令   docker exec docker-postgres-1 pg_dump -U agent -d agent_platform --no-owner --no-privileges --clean --if-exists
结果   文件 5,310,135 字节 / 23,911 行 / 73 个 CREATE TABLE / 73 个 COPY 段 / 1 个 CREATE EXTENSION(vector)
       sha256 = e06e5e8e14c8218bdad7268caae05511c33816c8eb92de67c2cafac710ab96e0
       耗时 0.72s，退出码 0，stderr 0 字节
数据量 public schema 73 张表合计 18,227 行（含 _prisma_migrations 24 行）
```

### 6.2 PostgreSQL 恢复（临时库，未触碰生产库）

```
目标   临时容器 m8p9-dr-restore（pgvector/pgvector:pg16，端口 5544，库/用户 drill），演练后已 docker rm -f
回灌   psql -v ON_ERROR_STOP=1 → 退出码 0，耗时 2.16s，无 SQL 错误
指纹   源 == 目标：tables 73 / columns 862 / indexes 238 / enums 36 / fks 122 /
       _prisma_migrations 24 / extensions plpgsql,vector
行数   逐表 73/73 全部一致，合计 18,227 == 18,227
```

**踩到的真坑（方法论修正）**：最初把恢复库行数与**源库当前行数**比较，得到差异——
原因是源库被并行任务持续写入，而备份是**时间点快照**。正确口径是拿恢复库与**dump 文件自身的 COPY 段**比对
（或与恢复前的源库快照比对）。任何 DR 演练都必须固定这个口径，否则永远"校验失败"。

### 6.3 对象存储（MinIO）mirror 往返

```
前置   mc alias set 成功；配置桶 agent-storage 存在但**当前 0 对象 / 0B**
       （本机 STORAGE_DRIVER=local，对象落在 ./data/storage，因此生产桶里没有数据）
演练   用**临时桶**做真实往返（绝不碰生产桶）：
       m8p9-dr-source（2 个真实随机对象：64KB + 128KB）
         → mc mirror --overwrite --remove → /backup/m8p9-dr-source（196K）
         → mc mirror --overwrite → 新桶 m8p9-dr-restore（2 对象）
校验   obj-a.bin md5 f766241022480b322100305186e28424 MATCH
       obj-b.bin md5 c0c598b1a244b51063edbffb6b9cce8f MATCH
清理   mc rb --force 两个临时桶 + rm -rf 本地备份目录 → 只剩 1 个桶（agent-storage）
```

⚠️ **本环境该演练只证明了「命令可执行 + 往返数据一致」**，不含生产量级验证（生产桶为空）。
切到 S3 驱动后必须重跑并核对**对象数与总体积**。

本地驱动（`STORAGE_DRIVER=local`）另做了 tar 往返：`tar -czf` → `tar -tzf` 可解，118 字节（目录为空）。

### 6.4 生产库保护

演练全过程**只读**生产库（`pg_dump` 为只读操作），恢复与销毁都发生在独立临时容器 + 独立端口；
`docker ps` 复核共享容器（`docker-postgres-1` / `docker-redis-1` / `docker-minio-1`）自始至终未被停止或重建。

## 7. 失败场景矩阵

| 场景 | 影响 | 首要动作 | 恢复路径 | 目标 RTO | 数据损失 |
| --- | --- | --- | --- | --- | --- |
| **主库损坏**（数据文件/实例不可用） | 全站不可用（`/ready` 503），run 全部停摆 | 摘流量 + 停 Worker；切从库 or 新实例 | §4.2（PITR 优先，否则最近 pg_dump） | ≤ 30min（本机实测秒级；生产按库大小） | PITR ≈ 0；仅 pg_dump ⇒ 到上次备份 |
| **误删数据**（DROP TABLE / 误删行 / 错误迁移） | 局部功能不可用；run 可能报错 | **立即停写**（停 API/Worker）防止覆盖；记录删除时刻 | PITR 到删除前一刻；或逻辑恢复后**只回灌受影响表** | ≤ 30min | PITR ≈ 0 |
| **Worker 集群全挂** | 新 run 一直 `queued`；队列深度上涨触发背压 429 | 排查（OOM/镜像/节点）；重启 Worker | 无需恢复数据：Worker 起来后正常消费；停机期间的 run 由 `recoverStale`（≤7min）与正常消费接管 | ≤ 10min（重启即恢复） | 无（条件更新保证不重复执行） |
| **Redis 数据丢失**（重启/清空/故障切换） | 队列 job 消失、实时事件断、熔断状态清零 | 重启 Worker | §5：不恢复数据，靠 `recoverStale` 重投 + 周期调度重新 upsert | ≤ 10min（+ 等候收尾 ≤7min） | 无业务数据损失 |
| **MinIO / 对象存储丢失** | 生成产物、上传文件 404；run 状态机不受影响 | 切备用桶/副本；`mc mirror` 回灌 | §4.3 | ≤ 2h（取决于体积） | 备份点之后的新对象 |
| **`ENCRYPTION_KEY` 丢失/错配** | 连接与 webhook 密钥**永久不可解**；扩展签名失效 | **立刻停写**，从密钥管理系统取回正确密钥 | 无技术恢复手段；只能用户重新授权 | 不可恢复（除非有备份） | 全部加密凭证作废 |
| **节点/宿主机整体故障** | 该节点上 API+Worker 全停 | 流量切到其他副本；重建节点 | 基础设施层（IaC 重建 + 挂载数据卷/从备份恢复） | 按编排能力 | 视数据卷 |
| **备份文件损坏/被加密勒索** | 无法恢复 | 用更早的异地备份 | §3.4 的多层保留（30 天 + 异地） | 取决于备份粒度 | 到更早备份点 |

## 8. 未验证项（诚实清单）

| 项 | 状态 | 如何补齐 |
| --- | --- | --- |
| 生产级数据量下的备份/恢复耗时 | ❌ 未验证 | 本机 5.3MB 库，0.72s/2.16s 不能外推；需在预发用生产量级（或脱敏副本）实测 |
| PITR（WAL 归档 → `recovery_target_time`） | ❌ 未演练 | 本机未开归档；生产开通后必须走一次完整 PITR 演练并记录 RTO |
| 主从切换 / 多可用区故障转移 | ❌ 未验证 | 本机单容器；需预发按生产拓扑演练（含切换期间 `/ready` 行为） |
| 对象存储真实数据量级 mirror | ⚠️ 仅命令级验证 | 生产桶当前 0 对象；切 S3 驱动后用真实桶重跑并核对对象数/体积 |
| Redis 数据级恢复（RDB/AOF） | ❌ 未演练（**设计上不需要**，见 §5） | 若未来把非可重建状态放进 Redis，必须先补该演练与文档 |
| 「停生产库」类演练 | 🚫 **故意不做** | 共享开发库被其他任务使用，且在生产做破坏性演练风险不可接受；用临时容器/预发替代 |
| 密钥管理系统（Vault/KMS）取回流程 | ❌ 未验证 | 纯流程项，需与运维确认演练（本机 `.env` 直读） |

## 9. 定期演练清单（建议每季度）

- [ ] `pg_dump` → **临时容器**恢复 → 指纹 + 逐表行数（与 dump COPY 段比对）→ 销毁临时容器
- [ ] 对象存储：临时桶 mirror 往返 + 逐对象 md5
- [ ] 真实 `kill -TERM` 一个 Worker 副本：确认在途 run 由 `recoverStale` 接管且**只执行一次**
- [ ] 真实重启 Redis：确认队列重建 + `≤7min` 内无"长期 running 且 lease 过期"的行
- [ ] 用**备份文件 + 备份的 `.env`** 在隔离环境完整起一套（含登录 + `ready` 200 + 凭证解密抽查）——这是唯一能证明"备份真的可用"的演练
- [ ] 演练后更新本文第 6 节（记录日期、真实数字、抽到的坑）
