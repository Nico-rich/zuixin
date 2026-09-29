/**
 * M13-W9 闭环断裂修复 · e2e（真实 PostgreSQL + 真实 Redis 隔离 DB + 真实 HTTP：supertest → Nest）。
 *
 * 修复的两处闭环断裂（M13 Web 审计）：
 *  ① `chat.service.ts` SSE 白名单缺 approval.* / delegation.waiting / artifact.created
 *     → run 卡 waiting_approval 时**前端静默**（单元面已锁：chat.service.spec.ts 的
 *     "M13-W9 白名单：… 原样透传" 两例；此处覆盖审批**消费面**的端到端可达性）；
 *  ② Artifacts 只有 service、**无 HTTP 面** → 制品在 Web 完全不可见（本文件覆盖新增只读面）。
 *
 * 覆盖（断言一律针对真实 HTTP 语义，不 mock 授权层）：
 *  ① 制品只读面：列表归属过滤 / 类型筛选 / limit 收敛；详情、下载的"不存在 vs 他人"
 *     **零信息差**（同状态码 + 同错误码 + 同文案）；响应体绝不泄漏 `storageKey` / `idempotencyKey`；
 *  ② 制品下载：走既有附件代理口径（服务端流式 + `private` 缓存 + **强制 attachment** + `nosniff`，
 *     制品字节可能来自 LLM/外部工具 ⇒ UNTRUSTED，绝不交给浏览器渲染）；
 *  ③ 制品面**没有任何写端点**（POST/PATCH/DELETE 一律 404）——"工具即接口"，HTTP 面不新增第二写路径；
 *  ④ 电商只读展示面：分析/简报列表归属过滤 + 跨用户详情 404；同样无写端点；
 *     分层标注（facts=service-computed / possibleCauses=llm-interpretation）原样透出，推测绝不冒充事实；
 *  ⑤ 审批消费面：跨用户 list 不可见、跨用户 get/approve 404 **且零副作用**（状态仍 requested）；
 *     绑定摘要在 payload 的 `__binding` 里（前端只用它渲染摘要，敏感 payload 不外显）——
 *     本文件不改动任何审批语义（审批决定的唯一入口仍是既有 POST /approvals/:id/{approve,reject}）。
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { INestApplication } from '@nestjs/common';
import {
  Actor, assertIndistinguishable, assertNoLeak, createActor, createIdorApp, data, errorCode,
  ghostId, http, HttpApi, IdorApp,
} from './support/idor-harness';

const P = '/api/v1';

// 存储驱动 = 本地磁盘（默认），根目录重定向到临时目录（在 AppModule 实例化前生效）
const STORAGE_DIR = mkdtempSync(join(tmpdir(), 'm13w9-storage-'));
process.env.STORAGE_LOCAL_DIR = STORAGE_DIR;

const STORAGE_KEY = 'm13w9/artifact.bin';
// 每次运行唯一（idempotencyKey 有部分唯一索引，固定值会让第二次运行 500）；仍保留可断言的标记子串
const RUN = Math.random().toString(36).slice(2, 10);
// 字节里刻意含 NUL / SOH / 0xFF（转义写法，源文件保持纯文本）：证明下载通道是二进制安全的，不是文本搬运
const ARTIFACT_BYTES = Buffer.from('M13-W9-ARTIFACT-BYTES-\u0000\u0001\u00ff', 'latin1');

interface ArtifactView {
  id: string; type: string; title: string; summary: string | null; content: unknown;
  status: string; runId: string | null; toolCallId: string | null; downloadUrl: string | null;
  createdAt: string; updatedAt: string;
}

describe('M13-W9 闭环断裂修复 · 制品只读面 / 电商只读面 / 审批消费面 (e2e)', () => {
  let h: IdorApp;
  let app: INestApplication;
  let api: HttpApi;

  let userA: Actor; let userB: Actor;

  // A 的制品（直插：授权发生在任何业务读取之前）
  let artifactReport: string;        // 有文件（可下载）
  let artifactImage: string;         // 无文件（downloadUrl=null）
  let artifactOther: string;         // 类型筛选用
  let artifactB: string;             // B 的私密制品
  let analysisA: string; let briefA: string; let analysisB: string;
  let approvalA: string;

  const get = (path: string, cookie: string | null) => api.get(path, cookie);
  const post = (path: string, cookie: string, body: unknown = {}) => api.post(path, cookie).send(body as object);

  beforeAll(async () => {
    mkdirSync(join(STORAGE_DIR, 'm13w9'), { recursive: true });
    writeFileSync(join(STORAGE_DIR, 'm13w9', 'artifact.bin'), ARTIFACT_BYTES);

    h = await createIdorApp();
    app = h.app;
    api = http(app);
    userA = await createActor(h, 'w9-a');
    userB = await createActor(h, 'w9-b');

    artifactReport = (await h.prisma.artifact.create({
      data: {
        userId: userA.userId, type: 'report', title: 'A 的周报', summary: '转化率下降',
        content: { markdown: '# A 的私密报告正文' }, storageKey: STORAGE_KEY, status: 'ready',
        idempotencyKey: `m13w9-idem-${RUN}`,
      },
    })).id;
    artifactImage = (await h.prisma.artifact.create({
      data: { userId: userA.userId, type: 'image', title: 'A 的配图', content: { url: 'x' }, status: 'ready' },
    })).id;
    artifactOther = (await h.prisma.artifact.create({
      data: { userId: userA.userId, type: 'other', title: 'A 的其他制品', status: 'draft' },
    })).id;
    artifactB = (await h.prisma.artifact.create({
      data: {
        userId: userB.userId, type: 'report', title: 'B 的私密制品',
        summary: 'B-SUMMARY-MARKER', content: { secret: 'B-CONTENT-MARKER' },
        storageKey: 'm13w9/b-secret.bin', idempotencyKey: `B-IDEM-MARKER-${RUN}`,
      },
    })).id;

    analysisA = (await h.prisma.commerceAnalysis.create({
      data: {
        userId: userA.userId, analysisType: 'sales', timeRange: { start: '2026-01-01', end: '2026-01-31' },
        facts: { revenue: 800, secret: 'A-FACTS-MARKER' }, derived: { roas: 2 },
        anomalies: [{ metric: 'revenue', direction: 'decline', rule: 'server-threshold' }],
        possibleCauses: { source: 'llm-interpretation', items: ['流量质量下降（推测）'] },
        recommendations: { source: 'llm-recommendation', items: ['优化主图'] },
      },
    })).id;
    briefA = (await h.prisma.creativeBrief.create({
      data: {
        userId: userA.userId, problem: '转化率下降', objective: '提升点击率', platform: 'meta',
        commerceAnalysisId: analysisA, status: 'ready', evidence: { source: 'commerce-analysis-snapshot' },
      },
    })).id;
    analysisB = (await h.prisma.commerceAnalysis.create({
      data: {
        userId: userB.userId, analysisType: 'traffic', timeRange: { start: 'S', end: 'E' },
        facts: { visits: 1, secret: 'B-FACTS-MARKER' }, derived: { ctr: 0.01 },
      },
    })).id;

    approvalA = (await h.prisma.approval.create({
      data: {
        userId: userA.userId, status: 'requested', reason: 'A 的私密审批理由', riskLevel: 'high',
        payload: {
          // 审批绑定（M7-P1）：决定必须固定到被审的 action（LLM 不参与决定）
          __binding: { actionType: 'external_action.demo', payloadHash: 'sha256:abcdef0123456789', boundAt: '2026-01-01T00:00:00.000Z' },
          secret: 'A-PAYLOAD-MARKER',
        },
        expiresAt: new Date(Date.now() + 3600_000),
      },
    })).id;
  });

  afterAll(async () => {
    await app.close();
    rmSync(STORAGE_DIR, { recursive: true, force: true });
  });

  // ───────────────────────────── ① 制品列表 ─────────────────────────────

  it('① 制品列表：只返回本人制品（服务端归属过滤），且不泄漏内部列', async () => {
    const res = await get(`${P}/artifacts`, userA.cookie).expect(200);
    const rows = data<ArtifactView[]>(res);

    const ids = rows.map((r) => r.id);
    expect(ids).toEqual(expect.arrayContaining([artifactReport, artifactImage, artifactOther]));
    expect(ids).not.toContain(artifactB); // 跨用户制品不可见
    // storageKey / idempotencyKey / userId 是内部列：storageKey 是"越权直接读文件"的钥匙
    // 另：列表不搬运 content 证据体（正文只在详情端点）
    assertNoLeak(res, [STORAGE_KEY, 'm13w9-idem-', artifactB, 'B-SUMMARY-MARKER', 'B-IDEM-MARKER', 'A 的私密报告正文'], '制品列表');
    const report = rows.find((r) => r.id === artifactReport)!;
    expect(report).toMatchObject({ type: 'report', title: 'A 的周报', status: 'ready' });
    expect(report).not.toHaveProperty('storageKey');
    expect(report).not.toHaveProperty('idempotencyKey');
    expect(report).not.toHaveProperty('userId');
    // 有文件 → 代理下载链接；无文件 → null（绝不给出预签名外链）
    expect(report.downloadUrl).toBe(`/api/v1/artifacts/${artifactReport}/download`);
    expect(rows.find((r) => r.id === artifactImage)!.downloadUrl).toBeNull();
  });

  it('① 制品列表：类型筛选在归属之上叠加；越界/非法参数 400（不放大查询）', async () => {
    const typed = await get(`${P}/artifacts?type=image`, userA.cookie).expect(200);
    expect(data<ArtifactView[]>(typed).map((r) => r.id)).toEqual([artifactImage]);

    const limited = await get(`${P}/artifacts?limit=1`, userA.cookie).expect(200);
    expect(data<ArtifactView[]>(limited)).toHaveLength(1);

    for (const q of ['limit=0', 'limit=1000', 'type=magic', 'projectId=not-a-uuid']) {
      const bad = await get(`${P}/artifacts?${q}`, userA.cookie).expect(400);
      expect(errorCode(bad)).toBe('VALIDATION_ERROR');
    }
  });

  it('① 制品列表：B 只看得到自己的（横轴对称）', async () => {
    const res = await get(`${P}/artifacts`, userB.cookie).expect(200);
    expect(data<ArtifactView[]>(res).map((r) => r.id)).toEqual([artifactB]);
  });

  // ───────────────────────── ② 制品详情 / ③ 下载 ─────────────────────────

  it('② 制品详情：本人 200；**不存在 vs 他人制品** 404 零信息差（反枚举）', async () => {
    const own = await get(`${P}/artifacts/${artifactReport}`, userA.cookie).expect(200);
    expect(data<ArtifactView>(own)).toMatchObject({ id: artifactReport, type: 'report' });
    assertNoLeak(own, [STORAGE_KEY], '制品详情');

    const foreign = await get(`${P}/artifacts/${artifactB}`, userA.cookie);
    const missing = await get(`${P}/artifacts/${ghostId()}`, userA.cookie);
    expect(foreign.status).toBe(404);
    assertIndistinguishable(missing, foreign, '制品详情');
    assertNoLeak(foreign, [artifactB, 'B-SUMMARY-MARKER', 'B-CONTENT-MARKER', STORAGE_KEY], '他人制品详情');
  });

  it('③ 制品下载：服务端流式回源（私有缓存 + 强制附件 + nosniff），绝不泄漏 storageKey', async () => {
    const res = await get(`${P}/artifacts/${artifactReport}/download`, userA.cookie).expect(200);
    expect(res.headers['content-type']).toContain('application/octet-stream');
    // attachment（非 inline）：制品字节 UNTRUSTED，绝不交给浏览器渲染
    expect(res.headers['content-disposition']).toContain('attachment');
    expect(res.headers['cache-control']).toContain('private');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(Buffer.compare(res.body as Buffer, ARTIFACT_BYTES)).toBe(0);
    expect(JSON.stringify(res.headers)).not.toContain(STORAGE_KEY);
  });

  it('③ 制品下载：无关联文件 / 他人制品 / 不存在 → 一律 404 且零信息差', async () => {
    const noFile = await get(`${P}/artifacts/${artifactImage}/download`, userA.cookie);
    const foreign = await get(`${P}/artifacts/${artifactB}/download`, userA.cookie);
    const missing = await get(`${P}/artifacts/${ghostId()}/download`, userA.cookie);
    expect(noFile.status).toBe(404); // "存在但无文件" 与 "根本不存在" 不可区分
    assertIndistinguishable(missing, foreign, '制品下载');
    expect(errorCode(noFile)).toBe(errorCode(missing));
    assertNoLeak(foreign, [artifactB, STORAGE_KEY, 'm13w9/b-secret.bin'], '他人制品下载');
  });

  it('③ 制品面**没有写端点**（POST/PATCH/DELETE → 404）：HTTP 面不产生第二写路径', async () => {
    await post(`${P}/artifacts`, userA.cookie, { type: 'report', title: '偷偷写入' }).expect(404);
    await api.patch(`${P}/artifacts/${artifactReport}`, userA.cookie).send({ title: '偷偷改名' }).expect(404);
    await api.delete(`${P}/artifacts/${artifactReport}`, userA.cookie).expect(404);
    const after = await get(`${P}/artifacts/${artifactReport}`, userA.cookie).expect(200);
    expect(data<ArtifactView>(after).title).toBe('A 的周报'); // 行未被改写
  });

  it('制品面匿名访问 → 401（列表/详情/下载）', async () => {
    for (const path of [`${P}/artifacts`, `${P}/artifacts/${artifactReport}`, `${P}/artifacts/${artifactReport}/download`]) {
      const res = await get(path, null).expect(401);
      expect(errorCode(res)).toBe('UNAUTHORIZED');
    }
  });

  // ───────────────────────── ④ 电商只读展示面 ─────────────────────────

  it('④ 电商分析：列表归属过滤 + 详情跨用户 404 零信息差；分层标注原样透出', async () => {
    const listA = await get(`${P}/commerce/analyses`, userA.cookie).expect(200);
    const rowsA = data<Array<{ analysisId: string }>>(listA);
    expect(rowsA.map((r) => r.analysisId)).toEqual([analysisA]);
    assertNoLeak(listA, [analysisB, 'B-FACTS-MARKER'], '电商分析列表');

    const listB = await get(`${P}/commerce/analyses`, userB.cookie).expect(200);
    expect(data<Array<{ analysisId: string }>>(listB).map((r) => r.analysisId)).toEqual([analysisB]);

    const own = await get(`${P}/commerce/analyses/${analysisA}`, userA.cookie).expect(200);
    const detail = data<{ layering: Record<string, string>; possibleCauses: { source: string } }>(own);
    // 红线：LLM 推测绝不冒充事实（layering 是服务端标注，前端据此渲染）
    expect(detail.layering).toMatchObject({
      facts: 'service-computed', derived: 'service-computed', anomalies: 'service-rule',
      possibleCauses: 'llm-interpretation', recommendations: 'llm-recommendation',
    });
    expect(detail.possibleCauses.source).toBe('llm-interpretation');

    const foreign = await get(`${P}/commerce/analyses/${analysisB}`, userA.cookie);
    const missing = await get(`${P}/commerce/analyses/${ghostId()}`, userA.cookie);
    expect(foreign.status).toBe(404);
    assertIndistinguishable(missing, foreign, '电商分析详情');
    assertNoLeak(foreign, ['B-FACTS-MARKER'], '他人分析详情');
  });

  it('④ 电商简报：列表/详情归属过滤；跨用户 404 零信息差', async () => {
    const listA = await get(`${P}/commerce/briefs`, userA.cookie).expect(200);
    const rows = data<Array<{ briefId: string; analysisId: string | null }>>(listA);
    expect(rows).toEqual([expect.objectContaining({ briefId: briefA, analysisId: analysisA })]);

    const own = await get(`${P}/commerce/briefs/${briefA}`, userA.cookie).expect(200);
    expect(data<{ objective: string }>(own).objective).toBe('提升点击率');

    const foreign = await get(`${P}/commerce/briefs/${briefA}`, userB.cookie);
    const missing = await get(`${P}/commerce/briefs/${ghostId()}`, userB.cookie);
    expect(foreign.status).toBe(404);
    assertIndistinguishable(missing, foreign, '创意简报详情');
  });

  it('④ 电商面**没有写端点**（"工具即接口"：写路径只由 Agent 工具执行）', async () => {
    await post(`${P}/commerce/analyses`, userA.cookie, { analysisType: 'sales' }).expect(404);
    await post(`${P}/commerce/briefs`, userA.cookie, { problem: 'p', objective: 'o' }).expect(404);
    await api.patch(`${P}/commerce/briefs/${briefA}`, userA.cookie).send({ status: 'approved' }).expect(404);
    const after = await get(`${P}/commerce/briefs/${briefA}`, userA.cookie).expect(200);
    expect(data<{ status: string }>(after).status).toBe('ready');
  });

  it('电商面匿名访问 → 401', async () => {
    for (const path of [`${P}/commerce/analyses`, `${P}/commerce/briefs`, `${P}/commerce/analyses/${analysisA}`]) {
      await get(path, null).expect(401);
    }
  });

  // ───────────────────────── ⑤ 审批消费面（语义未改） ─────────────────────────

  it('⑤ 审批：A 可见自己的待审批（绑定摘要在 payload.__binding）；B 列表不可见', async () => {
    const listA = await get(`${P}/approvals?status=requested`, userA.cookie).expect(200);
    const mine = data<Array<{ id: string; status: string; payload: { __binding?: { actionType: string; payloadHash: string } } }>>(listA);
    const row = mine.find((r) => r.id === approvalA)!;
    expect(row).toBeTruthy();
    // 页面的"绑定 action 摘要"唯一来源：actionType + payloadHash（LLM 不参与决定）
    expect(row.payload.__binding).toMatchObject({ actionType: 'external_action.demo' });
    expect(row.payload.__binding!.payloadHash).toMatch(/^sha256:/);

    const listB = await get(`${P}/approvals`, userB.cookie).expect(200);
    expect(data<Array<{ id: string }>>(listB).map((r) => r.id)).not.toContain(approvalA);
    assertNoLeak(listB, [approvalA, 'A-PAYLOAD-MARKER', 'A 的私密审批理由'], '他人审批列表');
  });

  it('⑤ 审批：跨用户 get/approve → 404 零信息差，且**零副作用**（状态仍 requested）', async () => {
    const foreignGet = await get(`${P}/approvals/${approvalA}`, userB.cookie);
    const missingGet = await get(`${P}/approvals/${ghostId()}`, userB.cookie);
    expect(foreignGet.status).toBe(404);
    assertIndistinguishable(missingGet, foreignGet, '审批详情');

    await post(`${P}/approvals/${approvalA}/approve`, userB.cookie).expect(404);
    await post(`${P}/approvals/${approvalA}/reject`, userB.cookie).expect(404);
    const row = await h.prisma.approval.findUnique({ where: { id: approvalA } });
    expect(row!.status).toBe('requested'); // 决定未被他人改写
    expect(row!.approvedAt).toBeNull();
  });

  it('⑤ 审批：本人 decide 仍走既有条件更新（本次改动不新增/不改写审批语义）', async () => {
    const ok = await post(`${P}/approvals/${approvalA}/reject`, userA.cookie).expect(201);
    expect(data<{ status?: string }>(ok)).toMatchObject({ status: 'rejected' });
    // 终态不可复活：重复决定 → 409（既有语义）
    const again = await post(`${P}/approvals/${approvalA}/approve`, userA.cookie);
    expect(again.status).toBe(409);
    expect(errorCode(again)).toBeDefined();
  });
});
