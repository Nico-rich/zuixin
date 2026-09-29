# M11 Final Baseline（2026-09-29）

> M11（四维审计 → 17 Phase / 16+1 Agent 并行 DAG → 集成 → Final Audit → 修复回归）**最终冻结基线**。
> 计划：`m11-implementation-plan.md`；执行基线：M10 Final Baseline（`2a907d6`）；审计来源：M10 Deferred 25 项逐项核实 + 代码增量 19 项 + NOT VERIFIED/生产就绪 36 项 + 全景快照 v2。

## 1. 提交序列（M10 冻结后）

```
036e48d  docs(architecture): M11 Implementation Plan（四维审计→17 Phase/16+1 Agent 并行 DAG）
04b9453  feat(api): M11 W0 schema 预整合（Session.deviceId+索引；DB CHECK×3 DO 幂等段；fresh 38/38）
1ea364e  Merge M11-P13 暂停点（7 个 Playwright spec+config+组件修复）
2954c18  Merge M11-P16 暂停点（Dockerfile.api/.web）
（P1~P12、P15 共 13 个 Merge——各 Phase commit 见 merge 信息）
3e72452  fix(web): M11-P13 完成——Playwright 17 通过/0 失败；实抓新会话 history 查询永不启用缺陷
7996647  fix(api): 集成收尾批次2——m8-p3 队列深度断言去全局化
b8a4391  fix(api,web): 集成收尾批次1——workflow-lease 分页补做/.env.example 补登/@smithy 显式依赖
88cb58a  fix(api,docker,docs): M11 Final Audit 修复批次——8 MEDIUM 全闭环+11 LOW
```

（执行中：16 Agent 曾全体 402 中断→用户重试→SendMessage 恢复 11 个→P16 worktree 损坏重建新 Agent；P13/P16 暂停点文件落盘后由 Coordinator 提交合并并完成验证。）

## 2. 各 Phase 核心机制（详见各 commit 报告）

- **P1 密钥轮换收尾**：keyVersion 密文自述落库（同语句写，绝不失配）；rewrap CLI（id>lastId 游标——规避 Prisma cursor 并发删除**静默截断**陷阱；CAS 写回；审计摘要零明文）；读路径版本裁决+节流 warn。
- **P2 会话治理补全**：设备下线（X-Device-Id 优先+清洗；三端点 404 反枚举）；DEVICE_REVOKED 接线（拒绝结论恒来自 DB，Redis 只细化错误码）；rotate 新会话行；jti ZSET 懒清理+pipeline；三缓存上限 5000。
- **P3 计费正确性**：ledger-only 独立校验段+unlinked 盲区；历史月窗口统一 [当月,下月)；UTC 日界 utcDayWindow；storageMb/seats 死配置摘除。
- **P4 Runtime 计费口径**：watchdog 超时/中断回合 1-token 保守记账（对账自洽零 wrongAmount）；预检失败不虚计（providerContacted 门槛）；路由延迟 45s TTL；凭据门控真实厂商 spec（无 key 显式 skip）。
- **P5 CreativeLoop 正确性**：状态 CAS 补 version 谓词+interpretation 双锚点（HTTP 竞态 e2e 证明 lost-update 修复）；回填主键游标分批+skipDuplicates+失败退避。
- **P6 Workflow 订阅治理**：unregisterEvent 精确 handler 解绑+空键回收；watchChildRun 登记回收+订阅后终态竞态校验。
- **P7 无界载入治理**：4 处分页（recoverStale/media-cleanup/scheduler/workflow-lease 集成补做）+判定下推 SQL+timeline 子行截断+委派重入重建订阅。
- **P8 保留策略+归档活性**：MetricSample 30d 保留（索引友好轮转）；RecurringJobProvisioner 周期探测+指数退避；归档/保留活性指标（含 0 值）。
- **P9 运维脚本收尾**：gpg 加密（--batch --pinentry-mode loopback+stdin 口令+自检回读）；真实桶 ETag 内容核对；保留策略正则修复等 3 真问题。
- **P10 配置收尾**：worker.ts 生产守卫接线（E-08）；alerts/configmap/secret/runbook 修正（APP_URL 摘除/SHUTDOWN_WAIT 8000/pgcrypto 权限说明）。
- **P11 存储可靠性**：S3Client NodeHttpHandler 超时+AbortSignal；withStorageDeadline 调用面（StorageTimeoutError 不误报 Redis）。
- **P12 Marketplace 治理位**：marketplace.moderate 权限位落地（fail-closed+漂移告警前置+矩阵 tripwire）。
- **P13 Playwright 浏览器验证**：channel:chrome 零下载；17 通过/0 失败（真进程 api+worker+web）。**实抓真产品缺陷**：新会话 history 查询键用路由 prop 永不启用→附件不刷新（改 activeConversationId 键+按 id 合并+不清流式态）；task-card 队列暂停确定性窗口；worker 残留命令行回收；pushState 首条消息卡死修复。
- **P14 HNSW 交叉点+DNS 投毒**：检索显式事务 set_config is_local 钉死 rpc=1.1/ef_search=40；交叉点结论表 1e3~1e6×rpc 5 档（危险窗口 1e3~3e3，**必须钉死而非等规模**）；翻转解析器投毒 8 用例+负控判别。
- **P15 PITR 演练**：一次性容器 archive_mode=on→basebackup→造 WAL→recovery_target_time→四层校验 10/10；8 轮演练 RTO 3~4.4s。
- **P16 Dockerfile+k8s 实机**：双镜像构建+冒烟（API live/ready 全探针绿+生产守卫双路径；web /login 200）；代理 ARG/ENV（仅构建期生效）；k8s 实机因无集群 NOT VERIFIED。
- **P17 小时级 soak**：**用户决定不做**（如实登记）。

## 3. 实施中实抓并修复的真 bug

1. **chat-workspace history 查询永不启用**（P13 浏览器实抓）——新会话附件/历史永不刷新。
2. **Windows pnpm→cmd→node 进程链 taskkill /T 后幸存消费者**（P13 实抓）——task-card 确定性窗口失效，改队列暂停。
3. **Prisma cursor 并发删除静默截断**（P1 实抓）——rewrap 改 id>lastId。
4. **bash heredoc $$ 展开毁 SQL**（W0 实抓）——引号 heredoc+显式反斜杠字节。
5. **备份保留策略正则漏 .sql.gz.gpg → 加密备份永不回收**（P9 实抓）。
6. **mc stat --json 对象名在 name 非 key → ETag 核对静默降级**（P9 实抓）。
7. **口令错误误诊为"备份损坏"**（P9 实抓）——gpg 原始 Bad session key 透出。
8. **m8-p3 队列深度全局断言并发脆弱**（集成实抓）——集合齐备口径。
9. **workflow-lease 两段扫描 spec fake 双计**（集成实抓）——fake 忠实实现 where/分页。
10. **Docker 构建锁文件过期**（集成实抓）——@smithy 显式依赖后补 pnpm install。

## 4. 最终验收数字（2026-09-29，全部实测）

- **api 测试**：239 文件 / **2433 测试连续三轮全绿**（404s/405s/404s；3 跳过=凭据门控 spec 设计使然）
- **web 测试**：105 用例全绿；**Playwright 真浏览器**：17 通过/0 失败/1 跳过（49.7s）
- **typecheck 4/4**；**build 3/3**；**fresh-DB 38 迁移重放**（HNSW 完好+3 CHECK 幂等）
- **基础设施**：PostgreSQL(pgvector)/Redis(64 DB)/BullMQ/MinIO 全程真实
- **镜像**：API 冒烟 live/ready 全探针绿+生产守卫拒绝/放行双路径；web /login 200；构建大小 1.55GB/1.62GB
- **PITR**：8 轮演练 RTO 3~4.4s、四层校验 10/10；**备份加密**：AES256 自检回读+ETag 内容核对+恢复演练 PASS
- **Git**：CLEAN @ `88cb58a`

## 5. 偏离登记与 Deferred（如实记录，不伪造）

**偏离登记**：CREDENTIAL_REWRAP_REQUIRED 无 HTTP 面抛出点（读面"不阻断迁移窗口"是 P1 显式设计——§2 字面验收项以偏离登记闭环）；EventEnvelope 仍只归档不物理删除（M9 冻结条件）；webhook 全局闸单键跨租户（M10 登记延续）；k8s 实机验证无可用集群（P16 登记）。

**Deferred（→ M12+）**：真实厂商端到端（无凭据，凭据门控骨架已备）；生产量级 PITR/主从/多机；小时级 soak（用户取消）；AV 扫描；OCR/Thinking/Commerce/毛利定价/embedding 快分类器/用户级模型指定/预签名直传（v1 路线裁决登记）；UsageRecord turnIndex 唯一键（无重复计费实证不触发）；孤儿附件清扫器（需 storage list 能力）；backup --upload 明文需产品口径（非本地桶要求显式确认）；mc 凭据文件 SIGINT 清理、pitr 失败保留现场等 LOW 项。

## 6. 冻结声明

M11 全部代码（W0 + P1~P16 + 集成收尾 + Final Audit 修复）自本基线冻结；M12 未开始。**本文件为基线快照。**
