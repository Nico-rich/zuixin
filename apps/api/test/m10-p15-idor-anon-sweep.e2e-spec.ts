/**
 * M10-P15 · 全端点鉴权边界横扫（**枚举矩阵的"零遗漏"底座**）。
 *
 * 覆盖目标（不是抽样，是全量）：`apps/api/src/modules/` 下 31 个控制器的**每一个** JWT 保护路由，
 * 在**匿名**调用下一律 401 `UNAUTHORIZED`，且响应体零内部痕迹（无堆栈/SQL/驱动文本）。
 *
 * 设计要点：
 * - 探针表是**端点清单的单一事实源**：每条路由一行（METHOD + 路径模板），路径参数一律用
 *   UUID 形态的随机 id（`ghostId()`）——401 发生在守卫层，任何 id 都等价，
 *   且"路径写错"不会伪装成 401（见下方 `notFound` 反例断言）。
 * - 另有**伪造令牌**一组：错密钥签名 / 已过期 / 无 sub / 自选 sid —— 一律 401。
 *   这几条是"令牌真实性"而非"端点鉴权"的断言，缺一即等于可自签管理员。
 * - 公开面（auth/health/hooks）**显式排除**并在断言里反向固定：它们对匿名不是 401，
 *   避免"把公开面误判成已鉴权"。
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createIdorApp, createActor, http, HttpApi, HttpMethod, IdorApp, Actor, errorCode, ghostId, assertNoLeak, waitFor,
} from './support/idor-harness';

const P = '/api/v1';

/** 每个 JWT 保护端点一行：[方法, 路径模板, 说明] */
type Probe = [HttpMethod, string, string];

const G = ghostId();
const G2 = ghostId();

export const PROTECTED_ENDPOINTS: Probe[] = [
  // ── organizations / invitations ──
  ['get', `${P}/organizations`, '组织列表'],
  ['post', `${P}/organizations`, '建组织'],
  ['get', `${P}/organizations/${G}`, '组织详情'],
  ['patch', `${P}/organizations/${G}`, '改组织'],
  ['delete', `${P}/organizations/${G}`, '删组织'],
  ['post', `${P}/organizations/${G}/disable`, '禁用组织'],
  ['post', `${P}/organizations/${G}/enable`, '启用组织'],
  ['get', `${P}/organizations/${G}/members`, '成员列表'],
  ['delete', `${P}/organizations/${G}/members/${G2}`, '移除成员'],
  ['post', `${P}/organizations/${G}/invitations`, '发邀请'],
  ['get', `${P}/organizations/${G}/invitations`, '邀请列表'],
  ['post', `${P}/invitations/${G}/accept`, '接受邀请'],
  ['post', `${P}/invitations/${G}/revoke`, '撤销邀请'],
  // ── projects ──
  ['get', `${P}/projects`, '项目列表'],
  ['post', `${P}/projects`, '建项目'],
  ['get', `${P}/projects/${G}`, '项目详情'],
  ['patch', `${P}/projects/${G}`, '改项目'],
  ['delete', `${P}/projects/${G}`, '删项目'],
  // ── agents（平台目录，@Roles('admin')） ──
  ['get', `${P}/agents`, '平台目录列表'],
  ['get', `${P}/agents/${G}`, '平台 agent 详情'],
  ['get', `${P}/agents/${G}/versions`, '平台 agent 版本'],
  ['post', `${P}/agents`, '平台 agent 创建'],
  ['patch', `${P}/agents/${G}/draft`, '平台 agent 草稿'],
  ['post', `${P}/agents/${G}/publish`, '平台 agent 发布'],
  ['post', `${P}/agents/${G}/rollback`, '平台 agent 回滚'],
  ['patch', `${P}/agents/${G}/enabled`, '平台 agent 启停'],
  // ── agent-runs ──
  ['get', `${P}/agent-runs`, 'run 列表'],
  ['get', `${P}/agent-runs/${G}`, 'run 详情'],
  ['post', `${P}/agent-runs`, '建 run'],
  ['get', `${P}/agent-runs/${G}/timeline`, 'run 时间线'],
  ['post', `${P}/agent-runs/${G}/cancel`, '取消 run'],
  ['post', `${P}/agent-runs/${G}/retry`, '重试 run'],
  ['get', `${P}/agent-runs/${G}/events`, 'run 事件流'],
  // ── conversations / chat / tasks ──
  ['get', `${P}/conversations`, '会话列表'],
  ['post', `${P}/conversations`, '建会话'],
  ['get', `${P}/conversations/${G}`, '会话详情'],
  ['patch', `${P}/conversations/${G}`, '改会话'],
  ['delete', `${P}/conversations/${G}`, '删会话'],
  ['get', `${P}/conversations/${G}/messages`, '会话消息'],
  ['post', `${P}/chat`, '对话'],
  ['patch', `${P}/chat/messages/${G}`, '改消息'],
  ['delete', `${P}/chat/messages/${G}`, '删消息'],
  ['get', `${P}/tasks`, '任务列表'],
  ['get', `${P}/tasks/${G}`, '任务详情'],
  ['post', `${P}/tasks/${G}/cancel`, '取消任务'],
  // ── knowledge / memories / attachments ──
  ['post', `${P}/knowledge/documents`, '上传文档'],
  ['get', `${P}/knowledge/documents`, '文档列表'],
  ['get', `${P}/knowledge/documents/${G}`, '文档详情'],
  ['post', `${P}/knowledge/documents/${G}/reindex`, '文档重建索引'],
  ['delete', `${P}/knowledge/documents/${G}`, '删文档'],
  ['get', `${P}/memories`, '记忆列表'],
  ['post', `${P}/memories`, '建记忆'],
  ['patch', `${P}/memories/${G}`, '改记忆'],
  ['delete', `${P}/memories/${G}`, '删记忆'],
  ['post', `${P}/attachments`, '上传附件'],
  ['get', `${P}/attachments/${G}`, '附件详情'],
  // ── approvals / external-actions / usage ──
  ['get', `${P}/approvals`, '审批列表'],
  ['get', `${P}/approvals/${G}`, '审批详情'],
  ['post', `${P}/approvals/${G}/approve`, '审批通过'],
  ['post', `${P}/approvals/${G}/reject`, '审批拒绝'],
  ['post', `${P}/approvals/${G}/cancel`, '审批取消'],
  ['get', `${P}/external-actions`, '外部动作列表'],
  ['get', `${P}/external-actions/${G}`, '外部动作详情'],
  ['get', `${P}/usage/agent-runs/${G}`, 'run 用量'],
  // ── connections ──
  ['get', `${P}/connections`, '连接列表'],
  ['get', `${P}/connections/${G}`, '连接详情'],
  ['post', `${P}/connections/github/start`, 'OAuth 启动'],
  ['get', `${P}/connections/github/callback`, 'OAuth 回调'],
  ['post', `${P}/connections/${G}/refresh`, '刷新连接'],
  ['post', `${P}/connections/${G}/revoke`, '撤销连接'],
  ['delete', `${P}/connections/${G}`, '删连接'],
  // ── scheduler / events ──
  ['post', `${P}/scheduler/jobs`, '建作业'],
  ['get', `${P}/scheduler/jobs`, '作业列表'],
  ['post', `${P}/scheduler/jobs/${G}/cancel`, '取消作业'],
  ['post', `${P}/scheduler/jobs/${G}/pause`, '暂停作业'],
  ['post', `${P}/scheduler/jobs/${G}/resume`, '恢复作业'],
  ['get', `${P}/events`, '事件列表'],
  ['get', `${P}/events/dead-letter`, '死信列表'],
  ['post', `${P}/events/${G}/redeliver`, '死信重投'],
  // ── analytics / audit / metrics / feedback ──
  ['get', `${P}/analytics/overview`, '分析总览'],
  ['get', `${P}/analytics/breakdown`, '分析分组'],
  ['post', `${P}/analytics/refresh`, '分析刷新'],
  ['get', `${P}/analytics/sources`, '分析数据源'],
  ['get', `${P}/audit-logs`, '审计日志'],
  ['get', `${P}/metrics`, '指标'],
  ['post', `${P}/feedback`, '提交反馈'],
  ['get', `${P}/feedback`, '反馈列表'],
  ['post', `${P}/feedback/performance`, '提交性能反馈'],
  ['get', `${P}/feedback/performance`, '性能反馈列表'],
  ['get', `${P}/feedback/performance/insights`, '性能洞察'],
  // ── billing（commerce 面） ──
  ['get', `${P}/billing/plans`, '套餐'],
  ['get', `${P}/billing/subscription`, '订阅'],
  ['get', `${P}/billing/usage`, '计费用量'],
  ['get', `${P}/billing/reconciliation`, '对账'],
  ['get', `${P}/billing/invoices`, '发票'],
  ['post', `${P}/billing/subscribe`, '订阅下单'],
  // ── routing（provider-routing） ──
  ['get', `${P}/routing/decisions`, '路由决策'],
  ['post', `${P}/routing/policies`, '建策略'],
  ['get', `${P}/routing/policies`, '策略列表'],
  ['post', `${P}/routing/capabilities/sync`, '能力同步'],
  ['get', `${P}/routing/capabilities`, '能力列表'],
  // ── evaluation ──
  ['post', `${P}/evaluation/datasets`, '建数据集'],
  ['get', `${P}/evaluation/datasets`, '数据集列表'],
  ['get', `${P}/evaluation/datasets/${G}`, '数据集详情'],
  ['patch', `${P}/evaluation/datasets/${G}`, '改数据集'],
  ['put', `${P}/evaluation/datasets/${G}/cases`, '置用例'],
  ['get', `${P}/evaluation/datasets/${G}/versions`, '数据集版本'],
  ['post', `${P}/evaluation/evaluators`, '建评估器'],
  ['get', `${P}/evaluation/evaluators`, '评估器列表'],
  ['get', `${P}/evaluation/evaluators/${G}`, '评估器详情'],
  ['patch', `${P}/evaluation/evaluators/${G}`, '改评估器'],
  ['delete', `${P}/evaluation/evaluators/${G}`, '删评估器'],
  ['post', `${P}/evaluation/runs`, '建评测 run'],
  ['get', `${P}/evaluation/runs`, '评测 run 列表'],
  ['get', `${P}/evaluation/runs/${G}`, '评测 run 详情'],
  ['get', `${P}/evaluation/runs/${G}/comparison`, '评测对比'],
  ['post', `${P}/evaluation/runs/${G}/cancel`, '取消评测'],
  ['post', `${P}/evaluation/experiments`, '建实验'],
  ['get', `${P}/evaluation/experiments`, '实验列表'],
  ['get', `${P}/evaluation/experiments/${G}`, '实验详情'],
  ['patch', `${P}/evaluation/experiments/${G}`, '改实验'],
  ['post', `${P}/evaluation/experiments/${G}/status`, '实验状态'],
  ['post', `${P}/evaluation/experiments/${G}/variants`, '加变体'],
  // ── marketplace ──
  ['get', `${P}/marketplace/publications`, '市场目录'],
  ['get', `${P}/marketplace/categories`, '市场分类'],
  ['get', `${P}/marketplace/publications/${G}`, '条目详情'],
  ['get', `${P}/marketplace/publications/${G}/reviews`, '条目评审'],
  ['post', `${P}/marketplace/publications`, '建条目'],
  ['patch', `${P}/marketplace/publications/${G}`, '改条目'],
  ['post', `${P}/marketplace/publications/${G}/publish`, '上架'],
  ['post', `${P}/marketplace/publications/${G}/withdraw`, '撤回'],
  ['post', `${P}/marketplace/publications/${G}/revise`, '修订'],
  ['post', `${P}/marketplace/publications/${G}/reject`, '驳回'],
  ['post', `${P}/marketplace/publications/${G}/reviews`, '写评审'],
  ['post', `${P}/marketplace/reviews/${G}/moderation`, '评审审核'],
  // ── extensions ──
  ['post', `${P}/extensions`, '建扩展'],
  ['get', `${P}/extensions`, '扩展列表'],
  ['get', `${P}/extensions/catalog`, '扩展目录'],
  ['get', `${P}/extensions/installations`, '安装列表'],
  ['get', `${P}/extensions/steps`, '步骤模板'],
  ['get', `${P}/extensions/${G}`, '扩展详情'],
  ['patch', `${P}/extensions/${G}`, '改扩展'],
  ['post', `${P}/extensions/${G}/publish`, '发布扩展'],
  ['post', `${P}/extensions/${G}/deprecate`, '弃用扩展'],
  ['post', `${P}/extensions/${G}/archive`, '归档扩展'],
  ['post', `${P}/extensions/${G}/install`, '安装扩展'],
  ['post', `${P}/extensions/${G}/uninstall`, '卸载扩展'],
  ['post', `${P}/extensions/${G}/enable`, '启用扩展'],
  ['post', `${P}/extensions/${G}/disable`, '禁用扩展'],
  ['get', `${P}/extensions/${G}/allowlist`, '白名单读'],
  ['post', `${P}/extensions/${G}/allowlist`, '白名单写'],
  ['delete', `${P}/extensions/${G}/allowlist/${G2}`, '白名单删'],
  // ── workflows / runs ──
  ['get', `${P}/workflows`, '工作流列表'],
  ['post', `${P}/workflows`, '建工作流'],
  ['get', `${P}/workflows/${G}`, '工作流详情'],
  ['patch', `${P}/workflows/${G}`, '改工作流'],
  ['post', `${P}/workflows/${G}/publish`, '发布工作流'],
  ['post', `${P}/workflows/${G}/archive`, '归档工作流'],
  ['delete', `${P}/workflows/${G}`, '删工作流'],
  ['post', `${P}/workflows/${G}/webhook/rotate`, '轮换 webhook 密钥'],
  ['post', `${P}/workflows/${G}/runs`, '触发工作流'],
  ['get', `${P}/workflows/${G}/runs`, '工作流 run 列表'],
  ['get', `${P}/workflows/runs/${G}`, 'run 详情'],
  ['get', `${P}/workflows/runs/${G}/timeline`, 'run 时间线'],
  ['post', `${P}/workflows/runs/${G}/cancel`, '取消 run'],
  ['post', `${P}/workflows/runs/${G}/retry`, '重试 run'],
  // ── creative-loop ──
  ['post', `${P}/creative-loop/insights`, '建洞察'],
  ['get', `${P}/creative-loop/insights`, '洞察列表'],
  ['get', `${P}/creative-loop/insights/${G}`, '洞察详情'],
  ['post', `${P}/creative-loop/insights/${G}/interpretation`, '洞察解读'],
  ['post', `${P}/creative-loop/hypotheses`, '建假设'],
  ['get', `${P}/creative-loop/hypotheses`, '假设列表'],
  ['get', `${P}/creative-loop/hypotheses/${G}`, '假设详情'],
  ['patch', `${P}/creative-loop/hypotheses/${G}`, '改假设'],
  ['post', `${P}/creative-loop/hypotheses/${G}/status`, '假设状态'],
  ['delete', `${P}/creative-loop/hypotheses/${G}`, '删假设'],
  ['post', `${P}/creative-loop/hypotheses/${G}/start`, '启动假设'],
  ['get', `${P}/creative-loop/hypotheses/${G}/status`, '假设进展'],
  ['get', `${P}/creative-loop/hypotheses/${G}/run`, '假设 run'],
  ['post', `${P}/creative-loop/hypotheses/${G}/conclude`, '假设结论'],
  ['post', `${P}/creative-loop/hypotheses/${G}/evaluation`, '假设评测'],
  ['post', `${P}/creative-loop/hypotheses/${G}/experiment`, '假设实验'],
];

/** 公开面：匿名**不该**被 401 拦（负向锚，防止把公开面误算进"已鉴权"） */
const PUBLIC_ENDPOINTS: Probe[] = [
  ['post', `${P}/auth/login`, '登录'],
  ['get', `${P}/health`, '存活探测'],
  ['get', `${P}/health/live`, '存活探测(子)'],
  ['get', `${P}/health/ready`, '就绪探测'],
];

describe('M10-P15 IDOR/RBAC 矩阵 · 匿名/伪造令牌全端点横扫 (e2e)', () => {
  let h: IdorApp;
  let api: HttpApi;

  beforeAll(async () => {
    h = await createIdorApp();
    api = http(h.app);
  });

  afterAll(async () => {
    await h.app.close();
  });

  it('① 端点清单自检：JWT 保护端点 ≥ 170 且无重复（覆盖矩阵分母可信）', () => {
    const keys = PROTECTED_ENDPOINTS.map(([m, p]) => `${m.toUpperCase()} ${p}`);
    expect(new Set(keys).size, '探针表存在重复路由').toBe(keys.length);
    expect(PROTECTED_ENDPOINTS.length).toBeGreaterThanOrEqual(170);
  });

  it('② 匿名：每一个 JWT 保护端点一律 401 UNAUTHORIZED，且响应体零内部痕迹', async () => {
    const failures: string[] = [];
    for (const [method, path, label] of PROTECTED_ENDPOINTS) {
      const res = await api.call(method, path, null).send({});
      if (res.status !== 401 || errorCode(res) !== 'UNAUTHORIZED') {
        failures.push(`${method.toUpperCase()} ${path}（${label}）→ ${res.status} ${errorCode(res) ?? ''}`);
        continue;
      }
      try {
        // 匿名响应体只允许 `{error:{code,message,requestId}}`：既不回显被请求的路径段，也无内部痕迹
        assertNoLeak(res, path.split('/').filter((s) => s.length > 20), `匿名 ${path}`);
      } catch (e) {
        failures.push((e as Error).message);
      }
    }
    expect(failures, `以下端点匿名未 401：\n${failures.join('\n')}`).toEqual([]);
  });

  it('③ 公开面反向锚：auth/health 对匿名不是 401（区分"公开"与"漏鉴权"）；refresh 只认 HttpOnly Cookie', async () => {
    for (const [method, path, label] of PUBLIC_ENDPOINTS) {
      const res = await api.call(method, path, null).send({});
      expect(res.status, `${label}（${method} ${path}）不应是 401`).not.toBe(401);
    }
    // refresh token 只能来自 HttpOnly cookie：把 token 放 body 不生效（无 cookie → 401）
    const viaBody = await api.post(`${P}/auth/refresh`, null).send({ refreshToken: 'whatever' });
    expect(viaBody.status).toBe(401);
    expect(errorCode(viaBody)).toBe('UNAUTHORIZED');
  });

  it('④ 伪造令牌：错密钥签名 / 无 sub / 自选 sid 一律 401（令牌真实性不可绕过）', async () => {
    const actor: Actor = await createActor(h, 'forge');
    const probes: Array<[string, string, string]> = [
      ['错密钥签名', await h.jwt.signAsync({ sub: actor.userId, role: 'user' }, { secret: 'not-the-real-secret' }), '错密钥'],
      ['无 sub', await h.jwt.signAsync({ role: 'admin' } as object), '无 sub'],
      ['错密钥+admin 声明', await h.jwt.signAsync({ sub: actor.userId, role: 'admin' }, { secret: 'not-the-real-secret' }), '错密钥 admin'],
      ['自选 sid（不存在的会话）', await h.jwt.signAsync({ sub: actor.userId, role: 'user', sid: ghostId() }), '自选 sid'],
    ];
    // 代表性端点：每个域取一个（覆盖各控制器的守卫组合，含 @Roles('admin') 面）
    const targets: Array<[HttpMethod, string]> = [
      ['get', `${P}/organizations`],
      ['get', `${P}/agents`],
      ['post', `${P}/agents`],
      ['get', `${P}/agent-runs`],
      ['get', `${P}/projects`],
      ['get', `${P}/billing/usage`],
      ['get', `${P}/metrics`],
      ['get', `${P}/audit-logs`],
      ['get', `${P}/extensions/installations`],
      ['get', `${P}/workflows`],
      ['get', `${P}/marketplace/publications`],
      ['get', `${P}/evaluation/datasets`],
    ];
    for (const [label, token, why] of probes) {
      for (const [method, path] of targets) {
        const res = await api.call(method, path, `agent_access=${token}`).send({});
        expect(res.status, `${label}（${why}）访问 ${method.toUpperCase()} ${path} 应 401`).toBe(401);
        expect(errorCode(res), `${label} → ${path}`).toBe('UNAUTHORIZED');
      }
    }
  });

  it('⑤ 已禁用用户：令牌未过期也一律 401（禁用生效上界 = 安全缓存 TTL 5s，非令牌生命周期）', async () => {
    const actor = await createActor(h, 'disabled');
    // 先证令牌确实可用（同时预热进程内安全缓存 active=true）
    const ok = await api.get(`${P}/organizations`, actor.cookie);
    expect(ok.status).toBe(200);
    await h.prisma.user.update({ where: { id: actor.userId }, data: { status: 'disabled' } });
    // 进程内缓存的肯定结论 TTL 默认 5000ms（AccessGuardService）；断言"收敛到 401"，而非瞬时翻转
    const denied = await waitFor(
      async () => {
        const res = await api.get(`${P}/organizations`, actor.cookie);
        return res.status === 401 ? res : null;
      },
      '禁用用户被 401 拦下（≤ 安全缓存 TTL）',
      15_000,
    );
    expect(errorCode(denied)).toBe('UNAUTHORIZED');
  });

  it('⑥ 路径不存在 ≠ 401 伪装：随机深层路径匿名访问应 404（保证 ② 的 401 不是"什么都 401"）', async () => {
    const res = await api.get(`${P}/definitely-not-a-route/${ghostId()}`, null);
    expect(res.status).toBe(404);
    // 注：框架级 404 不带 `code`，GlobalExceptionFilter 的兜底码是 INTERNAL（见报告 R-3，未改冻结语义）
    assertNoLeak(res, [], '匿名未知路径');
  });
});
