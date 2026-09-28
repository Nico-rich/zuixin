# Pre-M9 冻结基线（2026-09-28）

> M0-M8 Final Architecture Audit（9 个 P0 + 多个 P1）→ Pre-M9 修复包 → 验收门 → 本基线。
> 规格：m9-pre-m9-security-spec.md / m9-pre-m9-performance-spec.md / m9-pre-m9-reliability-spec.md / m9-pre-m9-testing-spec.md
> 设计基线（M9 轮）：m9-phase1-3-design.md / m9-phase4-6-design.md

## 1. 提交序列

```
b34540b  wip(api): Pre-M9 schema 预整合（T1/S1/P6 迁移+回填断言；fresh 重放 26/26）
dfcca08  wip(api): P4 HNSW 向量索引预整合（vector(1536)+hnsw cosine；mock 嵌入默认 1536）
aa5b56d  feat(api): Pre-M9 计费正确性包
c9b1865  feat(shared): 安全包错误码 + 安全/性能包规格文档
0aafb36  feat(api): Pre-M9 安全包
3b7a9b2  fix(api): 重试退避测试开关 + 安全包合并
3b92951  perf(api): Pre-M9 性能包 P1-P6
33bf33d  Merge pre-m9-performance
91ba710  feat(api): Pre-M9 可靠性包 G1-G11/C5/D5
e31b60a  fix(api): 可靠性合并 + m8-p2 终态入账轮询
d584081  feat(api): 测试补强 api 侧（多实例抓 2 真并发 bug + 故障注入 + 三方对账）
ffe936b  feat(web): Web 测试体系（8 文件/69 用例）
818e5d5  test(api): 补强稳定性 + web 合并
```

## 2. 验收门结果（2026-09-28）

| 项 | 结果 |
|---|---|
| P0 修复（F1/F3-A/F4/Scheduler IDOR/U1/S1/C2/T1+R3/workflow viewer 写） | 全部修复 + 各自 e2e 全绿 |
| P1 critical（R1/R2/G1-G11/C1/C5/D1/D5/F2/F7/A2/A3） | 全部修复 + 测试全绿 |
| api 测试 | **143 文件 / 1230 测试全绿**（全量） |
| web 测试 | **8 文件 / 69 用例全绿**（3 连稳） |
| typecheck | 4/4 零缓存 |
| build | 3/3 零缓存 |
| fresh-DB 迁移重放 | 28 迁移全部成功（含 HNSW；临时库已删） |
| 现有库迁移 | 一致（migrate diff 除已知 HNSW Unsupported 列限制外零差异） |
| 多实例 | 2 API + 2 Worker 真实 e2e（Redis DB 4 隔离） |
| SSE/停机 | pre-m9-shutdown e2e（模拟 SIGTERM 九阶段） |
| 计费对账 | 三方（事实↔账本↔分析）一致 + 对账端点 |
| Provider 故障注入 | stall→idle 超时 / 熔断 open→跳过→fallback 归因 / unavailable 不重试 |
| Git | CLEAN |

## 3. 测试补强实抓的真 bug（多实例 e2e 价值证明）

1. **ensureSubscription 懒创建竞态**：并发 createAsync → 唯一键 P2002 未捕获 → 500（修复：P2002 复用赢家行）。
2. **C1 预留顺序竞态**：预留行在计数之后写入 → 同瞬并发全部读到预留前状态 → 超量准入（修复：先预留、后计数、超限回滚；安全属性 = 绝不超量准入，极端交错保守少放行属可接受语义）。
3. m6-p3/m8-p2 两个"终态后写入"的最终一致断言在负载下随机失败（修复：轮询等待收尾）。

## 4. 如实记录的差异 / NOT VERIFIED

- G3 规格 10 步合并为 9 实现阶段（差异逐条注释于 lifecycle-registry.ts）。
- G10 EventEnvelope 冻结：published 无消费者长期滞留 = 预期现象（方案 B）。
- P4：1000 行时规划器在 HNSW/Sort 间摇摆（如实记录）；生产规模选择性未验证。
- P1 实测往返 6（规格 ~5）。
- G5/G6 无真实供应商端到端（注入 fetch 单测覆盖）；G4 无 Redis 真挂 e2e。
- C5 多实例为同进程双实例模拟。
- DNS 重绑定 TOCTOU 窗口（连接未固定）；生产 NODE_ENV Secure cookie——延续 M8 NOT VERIFIED 清单。
- web findings：lib/api.ts 401 守卫死条件（`/auth/` vs `/api/v1/auth/` 前缀）、run-timeline 图标缺口、web 无审批 UI、CRLF 分帧不支持（api 全 LF 无影响）。

## 5. 并行 worktree 教训（供 M9 轮遵守）

- **e2e 必须 REDIS_URL DB 号隔离**（共享队列跨版本 worker 污染已两次确证：旧代码 worker 消费新代码作业）。
- 回归只在无并行 agent 时跑；worktree 建在 `../agent-m9-*`（bash cwd 会漂移，用 `git -C` 或绝对路径）。

## 6. 冻结声明

Pre-M9 全部代码自本基线冻结；M9 轮（P1 Evaluation / P2 Advanced Memory / P3 Routing 接线并行 → P4→P5→P6 串行）按 m9-phase1-3-design.md / m9-phase4-6-design.md 实施。
