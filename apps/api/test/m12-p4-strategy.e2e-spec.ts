import { Test } from '@nestjs/testing';
import { INestApplication, INestApplicationContext } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { Queue } from 'bullmq';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { AppModule } from '../src/app.module';
import { WorkerModule } from '../src/worker.module';
import { GlobalExceptionFilter } from '../src/common/filters/global-exception.filter';
import { TransformInterceptor } from '../src/common/interceptors/transform.interceptor';
import { csrfProtection } from '../src/modules/auth/csrf.middleware';
import { PrismaService } from '../src/modules/prisma/prisma.service';
import { EVALUATION_QUEUE } from '../src/core/queue/queue.module';

/**
 * M12-P4 策略与实验 e2e（真实 PostgreSQL + Redis + BullMQ Worker + 真实 HTTP）。
 *
 * **必须使用独立 Redis DB（并行 worktree 队列隔离——M8 教训，绝不省略）**：
 *   REDIS_URL=redis://localhost:6379/44 npx vitest run test/m12-p4-strategy.e2e-spec.ts
 * （文件内在未设置时兜底为 DB 44，避免裸跑污染共享队列。）
 *
 * 端到端事实（逐条对应 M12-P4 的需求与红线）：
 * ① 受控写面：仅**平台管理员**（DB 权威 role='admin'）可读写；组织 owner/admin 一律 403；
 *    **带 admin 声明但 DB 角色为 user 的合法签名 token 同样 403**（绝不采信 token 声明）；
 * ② 键白名单硬编码：未知键 404、配额子键只读 400、strict 未知子键 400、非法值 400、空补丁 400，
 *    且**失败绝不落库**；写入 = 深合并 + 最小存储 + 强制审计（action=systemSetting.update）；
 * ③ 阈值外部化**真的生效**：同一份绩效事实，在默认阈值下不产绩效记忆，晋级后的阈值下产出「表现好」
 *    记忆（不改代码 → 行为变化；负控 + 正控成对）；
 * ④ 评测工具能力：run 创建期声明 tools（⊆ AgentVersion.tools + 已注册 + 模型能力），
 *    越权/未注册/能力不符 → 400；合法 → 快照冻结 wire 定义；
 * ⑤ **只声明不执行**：声明后 mock 模型确定性发起 image.generate 调用 → rule `tool_called` 由
 *    不通过变通过，case 记录 `toolCalls:[{... output:null}]`，而**零 GenerationTask 副作用**（评测零副作用）；
 * ⑥ 实验受控晋级：结论只读（成员可读）→ 平台管理员人工确认（成员/组织管理员 403）→ 写受控键；
 *    指纹 CAS（陈旧指纹 400）；晋级**绝不改流量**（trafficPercent 一行未动）+ 审计 action=experiment.promotion。
 *
 * 全局副作用治理：本套件会写 `SystemSetting`（平台级键）。beforeAll 记录原行、afterAll 逐键还原，
 * 且用例内的写入都紧跟着断言 + 立即还原——把对其他套件（共享 DB）的窗口压到最小。
 */
process.env.REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379/44';
process.env.MOCK_DELAY_MS = process.env.MOCK_DELAY_MS ?? '0';

const XRW = { 'X-Requested-With': 'XMLHttpRequest' };
const STAMP = Date.now();
const SETTING_KEYS = ['routingPolicy', 'limits', 'policyThresholds'] as const;
/** 受控晋级目标（胜出变体创建时声明）：把 feedback 好评线从 0.03 调到 0.02 */
const PROMOTION_VALUE = { feedback: { goodCtr: 0.02 } };
const CASE_INPUT = '请生成一张商品主图（图片），用于工具声明端到端验证';

async function waitUntil(check: () => Promise<boolean> | boolean, timeoutMs: number, what: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await check()) return;
    if (Date.now() >= deadline) throw new Error(`等待超时：${what}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

describe('M12-P4 策略与实验 (e2e, 真实队列+Worker)', () => {
  let app: INestApplication;
  let worker: INestApplicationContext;
  let prisma: PrismaService;

  let cookieAdmin = '';
  let cookieMember = '';
  let cookieOrgAdmin = '';
  let cookieOutsider = '';
  let cookieForgedAdmin = '';
  let orgId = '';
  let agentVersionId = '';
  let agentVersionTools: string[] = [];
  let datasetId = '';
  let evaluatorId = '';
  let experimentId = '';
  let baselineVariantId = '';
  let candidateVariantId = '';
  let runNoToolsId = '';
  let runToolsId = '';
  let promotionHash = '';

  const modelId = 'seed-model-mock-echo'; // seed 默认 mock 模型（零新增全局行）
  const capabilityModelId = `m12p4-no-tools-model-${STAMP}`;
  const cleanupUserIds: string[] = [];
  const cleanupRunIds: string[] = [];
  /** beforeAll 快照的系统设置原行（afterAll 还原；key 缺失 → null） */
  const priorSettings = new Map<string, { value: unknown } | null>();

  const api = () => request(app.getHttpServer());
  // supertest 的 `.set()` 只存在于**已选方法**的 request 上 → 这里按方法包一层，统一带上 CSRF 头 + 管理员 cookie
  const asAdmin = () => ({
    get: (path: string) => api().get(path).set(XRW).set('Cookie', cookieAdmin),
    post: (path: string) => api().post(path).set(XRW).set('Cookie', cookieAdmin),
    patch: (path: string) => api().patch(path).set(XRW).set('Cookie', cookieAdmin),
  });

  const restoreSetting = async (key: string): Promise<void> => {
    const prior = priorSettings.get(key);
    if (prior === undefined) return;
    if (prior) {
      await prisma.systemSetting.upsert({ where: { key }, update: { value: prior.value as never }, create: { key, value: prior.value as never } }).catch(() => undefined);
    } else {
      await prisma.systemSetting.deleteMany({ where: { key } }).catch(() => undefined);
    }
  };
  const settingRow = async (key: string) => prisma.systemSetting.findUnique({ where: { key }, select: { value: true, updatedAt: true } });

  const getRun = async (runId: string) => {
    const res = await asAdmin().get(`/api/v1/evaluation/runs/${runId}`).expect(200);
    return res.body.data as {
      run: { status: string; completedCases: number; totalCases: number; configSnapshot: Record<string, unknown> };
      cases: Array<{
        id: string; status: string; output: { text: string } | null;
        toolCalls: Array<{ name: string; arguments: string; output: unknown }> | null;
        results: Array<{ evaluatorId: string; passed: boolean; score: number; evidence: Record<string, unknown> }>;
      }>;
    };
  };
  const awaitRunTerminal = async (runId: string, timeoutMs = 60_000) => {
    let body: Awaited<ReturnType<typeof getRun>> | null = null;
    await waitUntil(async () => {
      body = await getRun(runId);
      return ['completed', 'failed', 'cancelled'].includes(body.run.status);
    }, timeoutMs, `run ${runId} 到达终态`);
    return body!;
  };
  const insights = async (cookie: string) => {
    const res = await api().get('/api/v1/feedback/performance/insights').set(XRW).set('Cookie', cookie).expect(200);
    return res.body.data as { performanceMemory: Array<{ content: string }> };
  };
  const capture = async (cookie: string, metrics: Record<string, number>) => api()
    .post('/api/v1/feedback/performance').set(XRW).set('Cookie', cookie)
    .send({ metrics }).expect(201);

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.use(cookieParser());
    app.use('/api/v1', csrfProtection);
    app.setGlobalPrefix('api/v1');
    app.useGlobalFilters(moduleRef.get(GlobalExceptionFilter));
    app.useGlobalInterceptors(new TransformInterceptor());
    await app.init();
    await app.listen(0);
    prisma = moduleRef.get(PrismaService);
    worker = await NestFactory.createApplicationContext(WorkerModule, { bufferLogs: false });

    const { JwtService } = await import('@nestjs/jwt');
    const jwt = moduleRef.get(JwtService);
    const login = await api().post('/api/v1/auth/login').set(XRW)
      .send({ email: process.env.SEED_ADMIN_EMAIL ?? 'admin@example.com', password: process.env.SEED_ADMIN_PASSWORD ?? 'admin123456' });
    expect([200, 201]).toContain(login.status);
    cookieAdmin = (login.headers['set-cookie'] as unknown as string[]).map((c) => c.split(';')[0]).join('; ');

    const org = await asAdmin().post('/api/v1/organizations').send({ name: `m12p4-strategy-org-${STAMP}` }).expect(201);
    orgId = (org.body.data as { id: string }).id;

    // 三个探针用户的 **DB 角色恒为 user**（平台管理员只有 seed admin 一个；token 里的 role 声明不被采信）
    const mkUser = async (tag: string, memberRole: 'member' | 'admin' | null) => {
      const u = await prisma.user.create({ data: { email: `m12p4-${tag}-${STAMP}@example.com`, passwordHash: 'unused-hash', role: 'user' } });
      cleanupUserIds.push(u.id);
      if (memberRole) await prisma.organizationMember.create({ data: { organizationId: orgId, userId: u.id, role: memberRole } });
      return { userId: u.id, cookie: `agent_access=${await jwt.signAsync({ sub: u.id, role: 'user' })}` };
    };
    const member = await mkUser('member', 'member');
    cookieMember = member.cookie;
    cookieOrgAdmin = (await mkUser('orgadmin', 'admin')).cookie;
    cookieOutsider = (await mkUser('outsider', null)).cookie;
    // 红线探针：**合法签名**的 token，声明 role='admin'，但 DB 角色是 user → 必须 403（DB 权威）
    cookieForgedAdmin = `agent_access=${await jwt.signAsync({ sub: member.userId, role: 'admin' })}`;

    // 系统设置原行快照（afterAll 逐键还原）
    for (const key of SETTING_KEYS) {
      const row = await prisma.systemSetting.findUnique({ where: { key }, select: { value: true } });
      priorSettings.set(key, row ? { value: row.value } : null);
    }

    // 数据集（1 case：输入含「图/主图」——mock 替身在**声明了 image.generate** 时会确定性发起工具调用）
    const ds = await asAdmin().post('/api/v1/evaluation/datasets')
      .send({ organizationId: orgId, name: `m12p4 ds ${STAMP}`, cases: [{ input: CASE_INPUT, expected: null, tags: ['tools'] }] })
      .expect(201);
    datasetId = (ds.body.data as { id: string }).id;
    const ev = await asAdmin().post('/api/v1/evaluation/evaluators')
      .send({ organizationId: orgId, name: `tool_called ${STAMP}`, type: 'rule', config: { rules: [{ type: 'tool_called', value: 'image.generate' }] } })
      .expect(201);
    evaluatorId = (ev.body.data as { id: string }).id;

    const agent = await prisma.agent.findFirstOrThrow({ where: { slug: 'general-assistant' }, include: { activeVersion: true } });
    agentVersionId = agent.activeVersion!.id;
    agentVersionTools = (agent.activeVersion!.tools as string[] | null) ?? [];
    expect(agentVersionTools).toContain('image.generate');

    // 模型能力闸门用的独立模型行（priority 999 → 绝不抢默认模型；afterAll 删除）
    await prisma.model.create({
      data: {
        id: capabilityModelId, providerId: 'seed-llm-mock', name: `M12P4 no-tools ${STAMP}`, apiModelId: 'mock-echo',
        type: 'llm', capabilities: { functionCalling: false }, enabled: true, priority: 999, inputPrice: 1, outputPrice: 1,
      },
    });

    // 实验：completed + 基线（无版本 → 无事实）+ 候选（声明受控晋级目标）
    const exp = await asAdmin().post('/api/v1/evaluation/experiments').send({ organizationId: orgId, name: `m12p4 exp ${STAMP}` }).expect(201);
    experimentId = (exp.body.data as { id: string }).id;
    await asAdmin().post(`/api/v1/evaluation/experiments/${experimentId}/status`).send({ status: 'running' }).expect(201);
    await asAdmin().post(`/api/v1/evaluation/experiments/${experimentId}/status`).send({ status: 'completed' }).expect(201);
    const base = await asAdmin().post(`/api/v1/evaluation/experiments/${experimentId}/variants`)
      .send({ name: 'baseline', isBaseline: true, trafficPercent: 50 }).expect(201);
    baselineVariantId = ((base.body.data as { variants: Array<{ id: string; isBaseline: boolean }> }).variants.find((v) => v.isBaseline)!).id;
    const cand = await asAdmin().post(`/api/v1/evaluation/experiments/${experimentId}/variants`)
      .send({
        name: 'candidate', agentVersionId, trafficPercent: 50,
        configSnapshot: { promotion: { key: 'policyThresholds', value: PROMOTION_VALUE } },
      }).expect(201);
    candidateVariantId = ((cand.body.data as { variants: Array<{ id: string; name: string }> }).variants.find((v) => v.name === 'candidate')!).id;

    // 两次真实评测：同一个版本、同一 case —— 唯一差别是**是否声明工具**
    const r1 = await asAdmin().post('/api/v1/evaluation/runs')
      .send({ organizationId: orgId, datasetId, agentVersionId, evaluatorIds: [evaluatorId], modelId })
      .expect(201);
    runNoToolsId = (r1.body.data as { runId: string }).runId;
    cleanupRunIds.push(runNoToolsId);
    const r2 = await asAdmin().post('/api/v1/evaluation/runs')
      .send({ organizationId: orgId, datasetId, agentVersionId, evaluatorIds: [evaluatorId], modelId, tools: ['image.generate'] })
      .expect(201);
    runToolsId = (r2.body.data as { runId: string }).runId;
    cleanupRunIds.push(runToolsId);
    await awaitRunTerminal(runNoToolsId);
    await awaitRunTerminal(runToolsId);
  }, 180_000);

  afterAll(async () => {
    const queue = new Queue(EVALUATION_QUEUE, { connection: { url: process.env.REDIS_URL, maxRetriesPerRequest: null } });
    await queue.obliterate({ force: true }).catch(() => undefined);
    await queue.close().catch(() => undefined);
    // **全局键还原**（平台级事实：绝不把测试阈值留给其它套件/环境）
    for (const key of SETTING_KEYS) await restoreSetting(key);
    // 审计行（本套件写入的那两条精确匹配行；绝不清扫他人审计）
    await prisma?.auditLog.deleteMany({ where: { userId: { in: cleanupUserIds }, action: { in: ['systemSetting.update', 'experiment.promotion'] } } }).catch(() => undefined);
    await prisma?.evaluationResult.deleteMany({ where: { caseRun: { runId: { in: cleanupRunIds } } } }).catch(() => undefined);
    await prisma?.evaluationCaseRun.deleteMany({ where: { runId: { in: cleanupRunIds } } }).catch(() => undefined);
    await prisma?.evaluationRun.deleteMany({ where: { id: { in: cleanupRunIds } } }).catch(() => undefined);
    if (datasetId) {
      await prisma?.evaluationCase.deleteMany({ where: { datasetId } }).catch(() => undefined);
      await prisma?.evaluationDataset.deleteMany({ where: { id: datasetId } }).catch(() => undefined);
    }
    if (evaluatorId) await prisma?.evaluator.deleteMany({ where: { id: evaluatorId } }).catch(() => undefined);
    if (experimentId) {
      await prisma?.experimentVariant.deleteMany({ where: { experimentId } }).catch(() => undefined);
      await prisma?.experiment.deleteMany({ where: { id: experimentId } }).catch(() => undefined);
    }
    // 绩效/记忆事实（本套件用户）
    if (cleanupUserIds.length > 0) {
      await prisma?.performanceSnapshot.deleteMany({ where: { userId: { in: cleanupUserIds } } }).catch(() => undefined);
      await prisma?.creativePerformance.deleteMany({ where: { userId: { in: cleanupUserIds } } }).catch(() => undefined);
      await prisma?.memory.deleteMany({ where: { userId: { in: cleanupUserIds } } }).catch(() => undefined);
    }
    if (orgId) {
      await prisma?.usageRecord.deleteMany({ where: { organizationId: orgId } }).catch(() => undefined);
      await prisma?.usageLedgerEntry.deleteMany({ where: { organizationId: orgId } }).catch(() => undefined);
      await prisma?.metricSample.deleteMany({ where: { organizationId: orgId } }).catch(() => undefined);
      await prisma?.organizationMember.deleteMany({ where: { organizationId: orgId } }).catch(() => undefined);
      await prisma?.organization.deleteMany({ where: { id: orgId } }).catch(() => undefined);
    }
    await prisma?.model.deleteMany({ where: { id: capabilityModelId } }).catch(() => undefined);
    await prisma?.user.deleteMany({ where: { id: { in: cleanupUserIds } } }).catch(() => undefined);
    await worker?.close().catch(() => undefined);
    await app?.close().catch(() => undefined);
    await prisma?.$disconnect().catch(() => undefined);
  }, 120_000);

  it('① RBAC：仅平台管理员（DB 权威）；匿名 401、成员/组织管理员/token 自称 admin 一律 403', async () => {
    await api().get('/api/v1/system-settings').set(XRW).expect(401); // 匿名
    await api().get('/api/v1/system-settings').set(XRW).set('Cookie', cookieMember).expect(403);
    await api().get('/api/v1/system-settings').set(XRW).set('Cookie', cookieOutsider).expect(403);
    // 组织 owner/admin（organizationMember.role='admin'）也不行——策略阈值是**平台级**事实
    await api().get('/api/v1/system-settings').set(XRW).set('Cookie', cookieOrgAdmin).expect(403);
    await api().patch('/api/v1/system-settings/limits').set(XRW).set('Cookie', cookieOrgAdmin).send({ summaryRefineThreshold: 4096 }).expect(403);
    // **红线探针**：合法签名 + role:'admin' 声明，但 DB 角色是 user → 403（绝不采信 token 声明）
    await api().get('/api/v1/system-settings').set(XRW).set('Cookie', cookieForgedAdmin).expect(403);
    await api().patch('/api/v1/system-settings/limits').set(XRW).set('Cookie', cookieForgedAdmin).send({ summaryRefineThreshold: 4096 }).expect(403);

    const res = await asAdmin().get('/api/v1/system-settings').expect(200);
    const listed = (res.body.data as { settings: Array<{ key: string; description: string; readOnlySubKeys: string[] }> }).settings;
    expect(listed.map((s) => s.key).sort()).toEqual([...SETTING_KEYS].sort());
    expect(listed.find((s) => s.key === 'limits')!.readOnlySubKeys).toEqual(['dailyImage', 'dailyVideo', 'dailyMemoryCandidates', 'monthlyTokenBudget']);
    expect(JSON.stringify(listed)).not.toContain('passwordHash');
  });

  it('② 键白名单：未知键 404、配额子键只读 400、strict 未知子键 400、非法值/空补丁 400 且绝不落库', async () => {
    await asAdmin().get('/api/v1/system-settings/quota').expect(404);
    await asAdmin().get('/api/v1/system-settings/FeatureFlag').expect(404);
    await asAdmin().patch('/api/v1/system-settings/quota').send({ x: 1 }).expect(404);

    // 配额面只读（红线：不开放 quota 写入口）
    const quota = await asAdmin().patch('/api/v1/system-settings/limits').send({ dailyImage: 999_999 }).expect(400);
    expect(String((quota.body as { error: { message: string } }).error.message)).toContain('配额面');
    // 权限/RBAC 面更不在白名单内
    await asAdmin().patch('/api/v1/system-settings/rbac').send({ role: 'admin' }).expect(404);
    // strict：未知子键 → 400（绝不静默丢弃后照样写）
    await asAdmin().patch('/api/v1/system-settings/routingPolicy').send({ confidenceThreshold: 0.4, 越权: 1 }).expect(400);
    await asAdmin().patch('/api/v1/system-settings/policyThresholds').send({ quota: { dailyImage: 1 } }).expect(400);
    // 非法值（越界 / 跨字段组合）+ 空补丁
    await asAdmin().patch('/api/v1/system-settings/routingPolicy').send({ confidenceThreshold: 5 }).expect(400);
    await asAdmin().patch('/api/v1/system-settings/policyThresholds').send({ insight: { ratingBad: 5, ratingGood: 5 } }).expect(400);
    await asAdmin().patch('/api/v1/system-settings/limits').send({}).expect(400);
    await asAdmin().patch('/api/v1/system-settings/limits').send({ summaryRefineThreshold: 0 }).expect(400);
    // 以上失败**全部零副作用**：三个键的存储行与 beforeAll 快照逐字节一致
    for (const key of SETTING_KEYS) {
      const row = await settingRow(key);
      expect(row?.value ?? null).toEqual(priorSettings.get(key)?.value ?? null);
    }
    // 越权写也绝不产生审计噪声
    const noise = await prisma.auditLog.count({ where: { userId: { in: cleanupUserIds }, action: 'systemSetting.update' } });
    expect(noise).toBe(0);
  });

  it('③ 受控写入：深合并 + 最小存储 + 强制审计（action=systemSetting.update）；读投影不回声白名单外内容', async () => {
    const patch = await asAdmin().patch('/api/v1/system-settings/limits').send({ summaryRefineThreshold: 4096 }).expect(200);
    expect((patch.body.data as { value: Record<string, unknown> }).value).toMatchObject({ summaryRefineThreshold: 4096 });

    // 最小存储 = **既有值（seed 写入的基线）∪ 本次补丁**：绝不新增未声明的子键（不复制缺省快照）
    const prior = priorSettings.get('limits')!.value as Record<string, unknown>;
    const stored = await settingRow('limits');
    expect(stored!.value).toEqual({ ...prior, summaryRefineThreshold: 4096 });
    expect(Object.keys(stored!.value as Record<string, unknown>))
      .toEqual([...Object.keys(prior), 'summaryRefineThreshold']);
    const audited = await prisma.auditLog.findFirst({
      where: { action: 'systemSetting.update', targetType: 'systemSetting', targetId: 'limits' },
      orderBy: { createdAt: 'desc' },
    });
    expect(audited).toBeTruthy();
    expect(audited!.metadata).toMatchObject({ key: 'limits', changed: ['summaryRefineThreshold'] });

    // 二次写入 = 深合并（既有子键保留）
    await asAdmin().patch('/api/v1/system-settings/limits').send({ videoConcurrency: 2 }).expect(200);
    expect((await settingRow('limits'))!.value).toEqual({ ...prior, summaryRefineThreshold: 4096, videoConcurrency: 2 });

    // 读投影：DB 里夹带的越权子键绝不回显（也不进入运行面）
    await prisma.systemSetting.update({ where: { key: 'limits' }, data: { value: { summaryRefineThreshold: 4096, dailyImage: 7, 越权: 'x' } as never } });
    const view = await asAdmin().get('/api/v1/system-settings/limits').expect(200);
    const value = (view.body.data as { value: Record<string, unknown> }).value;
    expect(value).toMatchObject({ summaryRefineThreshold: 4096, dailyImage: 7 }); // 配额子键可见（运维排查）
    expect(JSON.stringify(value)).not.toContain('越权');
    await restoreSetting('limits');
  });

  it('④ 阈值外部化负控（默认阈值）：CTR 2% / ROAS 1.5 既不达标也不差 → 无绩效记忆', async () => {
    expect(priorSettings.get('policyThresholds')).toBeNull(); // 前提：本环境无 policyThresholds 行（缺省 = 编译期常量）
    const before = await insights(cookieAdmin);
    await capture(cookieAdmin, { impressions: 100, clicks: 2, spend: 100, conversions: 1, revenue: 150, orders: 1 });
    const after = await insights(cookieAdmin);
    expect(after.performanceMemory).toHaveLength(before.performanceMemory.length);
  });

  it('⑤ 评测工具白名单：越权/未注册/模型能力不符 → 400（绝不静默降级）；合法 → 201 且快照冻结 wire 定义', async () => {
    // 越权：已注册但**不在 AgentVersion.tools** 内 → 400
    await asAdmin().post('/api/v1/evaluation/runs')
      .send({ organizationId: orgId, datasetId, agentVersionId, modelId, tools: ['commerce.analysis.generate'] }).expect(400);
    // 未注册（也不在版本清单内）→ 400
    await asAdmin().post('/api/v1/evaluation/runs')
      .send({ organizationId: orgId, datasetId, agentVersionId, modelId, tools: ['not.a.tool'] }).expect(400);
    // 模型声明不支持工具调用 → 400（UNSUPPORTED_PARAMETER：客户端可修正的请求）
    const noCap = await asAdmin().post('/api/v1/evaluation/runs')
      .send({ organizationId: orgId, datasetId, agentVersionId, modelId: capabilityModelId, tools: ['image.generate'] }).expect(400);
    expect((noCap.body as { error: { code: string } }).error.code).toBe('UNSUPPORTED_PARAMETER');
    // 未声明 tools → 依旧可跑（缺省行为不变），快照 evaluationTools=[]
    const plain = await getRun(runNoToolsId);
    expect(plain.run.configSnapshot).toMatchObject({ tools: agentVersionTools, evaluationTools: [] });
    expect(plain.run.configSnapshot).not.toHaveProperty('toolDefinitions');
    // 合法声明 → 快照冻结 wire 定义（**创建即锁定**；执行期不再解析）
    const withTools = await getRun(runToolsId);
    expect(withTools.run.configSnapshot).toMatchObject({ tools: agentVersionTools, evaluationTools: ['image.generate'] });
    const defs = withTools.run.configSnapshot.toolDefinitions as Array<Record<string, unknown>>;
    expect(defs).toHaveLength(1);
    expect(defs[0]).toMatchObject({ type: 'function', function: { name: 'image.generate' } });
  });

  it('⑥ 只声明不执行：声明工具 → tool_called 规则由不通过变通过、case 记录 toolCalls(output:null)、零 GenerationTask 副作用', async () => {
    const noTools = await getRun(runNoToolsId);
    const withTools = await getRun(runToolsId);
    expect(noTools.run.status).toBe('completed');
    expect(withTools.run.status).toBe('completed');

    // 未声明工具：模型不知道有工具 → 无调用事实 → 规则不通过
    expect(noTools.cases[0].toolCalls ?? null).toBeNull();
    expect(noTools.cases[0].results[0]).toMatchObject({ passed: false, score: 0 });
    // 声明工具：替身确定性发起 image.generate 调用 → 事实落库（output 恒为 null = 从未执行）→ 规则通过
    expect(withTools.cases[0].toolCalls).toHaveLength(1);
    expect(withTools.cases[0].toolCalls![0]).toMatchObject({ name: 'image.generate', output: null });
    expect(withTools.cases[0].results[0]).toMatchObject({ passed: true, score: 1 });

    // **评测零副作用**：声明 image.generate 绝不产生图片生成任务（工具执行面不在评测进程里）
    const generations = await prisma.generationTask.count({ where: { userId: { in: cleanupUserIds } } });
    expect(generations).toBe(0);
  });

  it('⑦ 晋级结论：只读；组织成员可读、结论为 candidate + 指纹 + 同源证据', async () => {
    const res = await api().get(`/api/v1/evaluation/experiments/${experimentId}/promotion`).set(XRW).set('Cookie', cookieMember).expect(200);
    const proposal = res.body.data as {
      status: string; proposalHash: string | null; reason: string;
      winner: { variantId: string } | null; baseline: { variantId: string } | null;
      target: { key: string; value: Record<string, unknown> } | null;
      evidence: Array<{ variantId: string; runCount: number; evaluated: number; avgScore: number; passRate: number }>;
    };
    expect(proposal.status).toBe('candidate');
    expect(proposal.proposalHash).toMatch(/^[0-9a-f]{64}$/);
    expect(proposal.winner).toMatchObject({ variantId: candidateVariantId });
    expect(proposal.baseline).toMatchObject({ variantId: baselineVariantId });
    expect(proposal.target).toEqual({ key: 'policyThresholds', value: PROMOTION_VALUE });
    // 证据同源：候选有真实评测事实（2 个 completed run），基线无绑定版本 → 零样本
    const candEvidence = proposal.evidence.find((e) => e.variantId === candidateVariantId)!;
    expect(candEvidence.runCount).toBeGreaterThanOrEqual(2);
    expect(candEvidence.evaluated).toBeGreaterThanOrEqual(2);
    expect(proposal.evidence.find((e) => e.variantId === baselineVariantId)).toMatchObject({ runCount: 0, evaluated: 0 });
    promotionHash = proposal.proposalHash!;
  });

  it('⑧ 晋级确认：成员/组织管理员 403（仅平台管理员）；陈旧指纹 400 且不写入', async () => {
    await api().post(`/api/v1/evaluation/experiments/${experimentId}/promote`).set(XRW).set('Cookie', cookieMember)
      .send({ proposalHash: promotionHash }).expect(403);
    await api().post(`/api/v1/evaluation/experiments/${experimentId}/promote`).set(XRW).set('Cookie', cookieOrgAdmin)
      .send({ proposalHash: promotionHash }).expect(403);
    // 非成员 → **404 防枚举**（与 403 的语义分层：组织成员但无 evaluation.write 才是 403）
    await api().post(`/api/v1/evaluation/experiments/${experimentId}/promote`).set(XRW).set('Cookie', cookieOutsider)
      .send({ proposalHash: promotionHash }).expect(404);
    // 陈旧/伪造指纹 → 400（CAS：把"管理员看到的结论"与"确认时的事实"钉在一起）
    await asAdmin().post(`/api/v1/evaluation/experiments/${experimentId}/promote`)
      .send({ proposalHash: 'f'.repeat(64) }).expect(400);
    // 指纹长度非法 → 400（strict DTO）
    await asAdmin().post(`/api/v1/evaluation/experiments/${experimentId}/promote`)
      .send({ proposalHash: 'short' }).expect(400);
    expect(await settingRow('policyThresholds')).toBeNull(); // 三次失败全部零副作用
  });

  it('⑨ 晋级写入受控键（审计 action=experiment.promotion）且**流量与实验行一行未动**', async () => {
    const before = await api().get(`/api/v1/evaluation/experiments/${experimentId}`).set(XRW).set('Cookie', cookieAdmin).expect(200);
    const beforeVariants = (before.body.data as { variants: Array<{ id: string; trafficPercent: number; isBaseline: boolean }> }).variants;

    const res = await asAdmin().post(`/api/v1/evaluation/experiments/${experimentId}/promote`)
      .send({ proposalHash: promotionHash, reason: 'e2e：评测事实胜出' }).expect(201);
    const out = res.body.data as { key: string; value: unknown; trafficUnchanged: boolean; winner: { variantId: string }; proposalHash: string };
    expect(out).toMatchObject({ key: 'policyThresholds', trafficUnchanged: true, proposalHash: promotionHash, winner: { variantId: candidateVariantId } });
    expect(out.value).toMatchObject(PROMOTION_VALUE);

    // 受控键已写入（最小存储：只写声明项）
    expect((await settingRow('policyThresholds'))!.value).toEqual(PROMOTION_VALUE);
    // 审计：动作名区分于普通设置更新（同一条受控路径）
    const audited = await prisma.auditLog.findFirst({ where: { action: 'experiment.promotion', targetId: 'policyThresholds' }, orderBy: { createdAt: 'desc' } });
    expect(audited).toBeTruthy();
    expect(audited!.metadata).toMatchObject({ experimentId, variantId: candidateVariantId, proposalHash: promotionHash, reason: 'e2e：评测事实胜出' });

    // **红线**：流量分配绝不自动改变；实验状态/变体一行未动
    const after = await api().get(`/api/v1/evaluation/experiments/${experimentId}`).set(XRW).set('Cookie', cookieAdmin).expect(200);
    const afterExperiment = after.body.data as { status: string; variants: Array<{ id: string; trafficPercent: number; isBaseline: boolean }> };
    expect(afterExperiment.status).toBe('completed');
    expect(afterExperiment.variants.map((v) => ({ id: v.id, trafficPercent: v.trafficPercent, isBaseline: v.isBaseline })))
      .toEqual(beforeVariants.map((v) => ({ id: v.id, trafficPercent: v.trafficPercent, isBaseline: v.isBaseline })));
    const dbVariants = await prisma.experimentVariant.findMany({ where: { experimentId }, select: { id: true, trafficPercent: true }, orderBy: { id: 'asc' } });
    expect(dbVariants.map((v) => v.trafficPercent)).toEqual([50, 50]);
  });

  it('⑩ 阈值外部化正控（晋级后即刻生效）：同一份绩效事实产出「表现好」绩效记忆（不改代码 → 行为变化）', async () => {
    // 生效值可读（SystemSetting 优先 + 常量兜底：返回**完整快照**）
    const view = await asAdmin().get('/api/v1/system-settings/policyThresholds').expect(200);
    const value = (view.body.data as { value: { feedback: Record<string, number>; commerce: Record<string, number> } }).value;
    expect(value.feedback).toMatchObject({ goodCtr: 0.02, badCtr: 0.01 }); // 改的那项生效，其余仍为编译期缺省
    expect(value.commerce).toMatchObject({ anomalyPct: 10 });

    const before = await insights(cookieAdmin);
    await capture(cookieAdmin, { impressions: 100, clicks: 2, spend: 100, conversions: 1, revenue: 150, orders: 1 });
    const after = await insights(cookieAdmin);
    expect(after.performanceMemory.length).toBe(before.performanceMemory.length + 1);
    expect(after.performanceMemory[0].content).toContain('表现好');
  });
});
