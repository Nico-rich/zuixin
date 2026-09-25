import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import cookieParser from 'cookie-parser';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { AppModule } from '../src/app.module';
import { GlobalExceptionFilter } from '../src/common/filters/global-exception.filter';
import { TransformInterceptor } from '../src/common/interceptors/transform.interceptor';
import { csrfProtection } from '../src/modules/auth/csrf.middleware';
import { PrismaService } from '../src/modules/prisma/prisma.service';
import { RoutingService } from '../src/modules/provider-routing/routing.service';
import { ProviderCapabilitiesService } from '../src/modules/provider-routing/capabilities.service';
import { RedisKVService } from '../src/core/circuit-breaker/redis-kv.service';

const XRW = { 'X-Requested-With': 'XMLHttpRequest' };
const TAG = `e2e-routing-${Date.now()}`;

interface Candidate {
  providerId: string; modelId: string | null; reasonCode: string;
  accepted: boolean; estimatedCost: number | null; policyId: string | null;
}

/**
 * M8-P7 Intelligent Provider Routing e2e（真实 PostgreSQL/Redis）：
 * 能力目录派生 → 服务端 deterministic 路由（健康 + 价格）→ enabled/deny/unhealthy 过滤 →
 * 回退链句柄（决策改写 fallback）→ 决策审计 API → 跨组织 403。
 */
describe('M8-P7 Provider Routing (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let routing: RoutingService;
  let capabilities: ProviderCapabilitiesService;
  let kv: RedisKVService;
  let cookie = '';
  let userId = '';
  let orgId = '';
  let cheapId = '';
  let priceyId = '';
  let cheapModelId = '';
  let priceyModelId = '';
  let otherOrgId = '';
  let otherUserId = '';
  let preExistingCapabilityIds: string[] = [];

  const candidatesOf = (row: { candidates: unknown }): Candidate[] => row.candidates as Candidate[];
  const findCand = (row: { candidates: unknown }, providerId: string) =>
    candidatesOf(row).find((c) => c.providerId === providerId)!;
  const lastDecision = async (runId: string) =>
    prisma.routingDecision.findFirst({ where: { runId }, orderBy: { decidedAt: 'desc' } });

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
    routing = app.get(RoutingService);
    capabilities = app.get(ProviderCapabilitiesService);
    kv = app.get(RedisKVService);

    const login = await request(app.getHttpServer()).post('/api/v1/auth/login').set(XRW)
      .send({ email: process.env.SEED_ADMIN_EMAIL ?? 'admin@example.com', password: process.env.SEED_ADMIN_PASSWORD ?? 'admin123456' });
    cookie = (login.headers['set-cookie'] as unknown as string[]).map((c) => c.split(';')[0]).join('; ');
    userId = login.body.data.user.id;
    orgId = (await prisma.organization.findFirst({ where: { ownerUserId: userId, isPersonal: true } }))!.id;

    preExistingCapabilityIds = (await prisma.providerCapability.findMany({ select: { id: true } })).map((r) => r.id);

    // 2 个测试用 mock provider：同一 provider.priority（5，低于种子 provider 的 100）→ 由价格决出胜负
    const cheap = await prisma.provider.create({
      data: {
        id: `${TAG}-cheap`, name: `${TAG} cheap`, type: 'llm', adapter: 'mock', baseUrl: '',
        enabled: true, priority: 5, healthStatus: 'healthy', retryConfig: { failureThreshold: 5, cooldownSec: 60 } as never,
      },
    });
    cheapId = cheap.id;
    const pricey = await prisma.provider.create({
      data: {
        id: `${TAG}-pricey`, name: `${TAG} pricey`, type: 'llm', adapter: 'mock', baseUrl: '',
        enabled: true, priority: 5, healthStatus: 'healthy',
      },
    });
    priceyId = pricey.id;
    cheapModelId = (await prisma.model.create({
      data: {
        id: `${TAG}-cheap-model`, providerId: cheapId, name: 'cheap-model', apiModelId: 'mock-echo',
        type: 'llm', capabilities: { jsonObject: true } as never, inputPrice: 10, outputPrice: 30,
        contextWindow: 128000, enabled: true, priority: 100,
      },
    })).id;
    priceyModelId = (await prisma.model.create({
      data: {
        id: `${TAG}-pricey-model`, providerId: priceyId, name: 'pricey-model', apiModelId: 'mock-echo',
        type: 'llm', capabilities: {} as never, inputPrice: 100, outputPrice: 100,
        contextWindow: 8000, enabled: true, priority: 100,
      },
    })).id;

    // 他人组织（用于跨组织 403）
    const other = await prisma.user.create({ data: { email: `${TAG}-other@example.com`, passwordHash: 'unused-hash' } });
    otherUserId = other.id;
    otherOrgId = (await prisma.organization.create({
      data: {
        name: `${TAG} other org`, slug: `${TAG}-other-org`, ownerUserId: otherUserId,
        members: { create: { userId: otherUserId, role: 'owner' } },
      },
    })).id;
  });

  afterAll(async () => {
    await prisma.routingDecision.deleteMany({ where: { OR: [{ organizationId: orgId }, { runId: { startsWith: TAG } }] } });
    await prisma.providerPolicy.deleteMany({ where: { organizationId: orgId } });
    // sync 会为全部真实 provider 派生能力行：只删本次新增的，DB 恢复到测试前状态
    await prisma.providerCapability.deleteMany({ where: { id: { notIn: preExistingCapabilityIds } } });
    await prisma.model.deleteMany({ where: { providerId: { in: [cheapId, priceyId] } } });
    await prisma.provider.deleteMany({ where: { id: { in: [cheapId, priceyId] } } });
    await prisma.organization.delete({ where: { id: otherOrgId } }).catch(() => undefined);
    await prisma.user.delete({ where: { id: otherUserId } }).catch(() => undefined);
    for (const id of [cheapId, priceyId]) {
      await kv.del(`cb:${id}:consecutiveFailures`).catch(() => undefined);
      await kv.del(`cb:${id}:openedAt`).catch(() => undefined);
    }
    await app?.close();
  });

  it('P7 能力目录：syncFromProviders 从真实 Provider/Model 派生（幂等 + 平台声明可读）', async () => {
    const first = await capabilities.syncFromProviders();
    expect(first.providers).toBeGreaterThanOrEqual(2);
    const mine = await prisma.providerCapability.findMany({ where: { providerId: { in: [cheapId, priceyId] } } });
    const cheapCaps = mine.filter((r) => r.providerId === cheapId);
    expect(cheapCaps.map((r) => r.capability)).toContain('text_generation');
    expect(cheapCaps.find((r) => r.capability === 'text_generation')!.modelIds).toEqual([cheapModelId]);
    // vision 未声明 → 不臆造能力
    expect(cheapCaps.map((r) => r.capability)).not.toContain('vision');

    // 二次同步幂等：不产生重复行
    const before = await prisma.providerCapability.count();
    await capabilities.syncFromProviders();
    expect(await prisma.providerCapability.count()).toBe(before);

    // API：能力目录读取（登录即可）+ 平台维护仅 admin（本用例即 admin）
    const listed = await request(app.getHttpServer()).get(`/api/v1/routing/capabilities?capability=text_generation`).set(XRW).set('Cookie', cookie).expect(200);
    expect((listed.body.data as Array<{ providerId: string }>).some((r) => r.providerId === cheapId)).toBe(true);
    const synced = await request(app.getHttpServer()).post('/api/v1/routing/capabilities/sync').set(XRW).set('Cookie', cookie).expect(201);
    expect(synced.body.data.capabilities).toBeGreaterThan(0);
  });

  it('P7 路由：健康 + 价格低者胜（种子 provider 优先级更低也不越权）+ 决策行落库', async () => {
    const runId = `${TAG}-run-1`;
    const r = await routing.route({ capability: 'text_generation', organizationId: orgId, runId, requestId: 'req-1' });
    expect(r.providerId).toBe(cheapId);
    expect(r.modelId).toBe(cheapModelId);
    expect(r.estimatedCost).toBeCloseTo(0.04, 6); // (1000×10 + 1000×30)/1e6
    expect(r.reasonCode).toBe('cost_optimal');    // 同优先级下成本决定

    const row = (await lastDecision(runId))!;
    expect(row).toMatchObject({ organizationId: orgId, providerId: cheapId, runId, requestId: 'req-1', capability: 'text_generation' });
    expect(row.estimatedCost).toBeCloseTo(0.04, 6);
    const cands = candidatesOf(row);
    expect(cands.length).toBeGreaterThanOrEqual(2);
    for (const c of cands) {
      expect(typeof c.reasonCode).toBe('string'); // 候选含被拒原因
      expect(typeof c.accepted).toBe('boolean');
    }
    expect(findCand(row, cheapId)).toMatchObject({ accepted: true, reasonCode: 'selected' });
    expect(findCand(row, priceyId)).toMatchObject({ accepted: true, reasonCode: 'fallback' });
    expect(findCand(row, priceyId).estimatedCost).toBeCloseTo(0.2, 6); // 更贵者进回退链
  });

  it('P7 回退链：首选运行时失败 → 句柄自动切下一候选，决策改写为 fallback', async () => {
    const runId = `${TAG}-run-fallback`;
    const r = await routing.route({ capability: 'text_generation', organizationId: orgId, runId });
    expect(r.providerId).toBe(cheapId);

    const attempts: string[] = [];
    const out = await r.invoke(async (target) => {
      attempts.push(target.providerId);
      if (target.providerId === cheapId) throw new Error('mock provider 500');
      return `ok:${target.modelId}`;
    });
    expect(attempts).toEqual([cheapId, priceyId]);
    expect(out).toBe(`ok:${priceyModelId}`);

    const row = (await lastDecision(runId))!;
    expect(row).toMatchObject({ providerId: priceyId, reasonCode: 'fallback' }); // 审计记录实际使用的 provider
  });

  it('P7 enabled=false → 剔除（reasonCode=disabled），换另一个候选', async () => {
    await prisma.provider.update({ where: { id: cheapId }, data: { enabled: false } });
    const runId = `${TAG}-run-disabled`;
    const r = await routing.route({ capability: 'text_generation', organizationId: orgId, runId });
    expect(r.providerId).toBe(priceyId);
    const row = (await lastDecision(runId))!;
    expect(findCand(row, cheapId)).toMatchObject({ accepted: false, reasonCode: 'disabled' });

    await prisma.provider.update({ where: { id: cheapId }, data: { enabled: true } });
    const back = await routing.route({ capability: 'text_generation', organizationId: orgId, runId: `${TAG}-run-reenabled` });
    expect(back.providerId).toBe(cheapId);
  });

  it('P7 组织 deny 策略 → 该 provider 硬剔除（reasonCode=policy_deny），策略按组织隔离', async () => {
    const created = await request(app.getHttpServer()).post('/api/v1/routing/policies').set(XRW).set('Cookie', cookie)
      .send({ organizationId: orgId, providerId: priceyId, allow: false, costCeilingPerRequest: 0.5 }).expect(201);
    expect(created.body.data).toMatchObject({ organizationId: orgId, providerId: priceyId, allow: false });
    const policyId = created.body.data.id as string;

    const listed = await request(app.getHttpServer()).get(`/api/v1/routing/policies?organizationId=${orgId}`).set(XRW).set('Cookie', cookie).expect(200);
    expect((listed.body.data as Array<{ providerId: string }>).some((p) => p.providerId === priceyId)).toBe(true);

    const runId = `${TAG}-run-deny`;
    const r = await routing.route({ capability: 'text_generation', organizationId: orgId, runId });
    expect(r.providerId).toBe(cheapId);
    const row = (await lastDecision(runId))!;
    expect(findCand(row, priceyId)).toMatchObject({ accepted: false, reasonCode: 'policy_deny', policyId });

    // 策略只作用于本组织：无组织上下文（平台级策略作用域）时该 provider 仍是可用候选
    const platform = await routing.route({ capability: 'text_generation', runId: `${TAG}-run-nopolicy` });
    expect(findCand((await lastDecision(`${TAG}-run-nopolicy`))!, priceyId).reasonCode).not.toBe('policy_deny');
    expect(platform.candidates.some((c) => c.providerId === cheapId)).toBe(true);

    await prisma.providerPolicy.deleteMany({ where: { organizationId: orgId, providerId: priceyId } });
  });

  it('P7 健康过滤：healthStatus=unhealthy → 剔除（reasonCode=unhealthy）', async () => {
    await prisma.provider.update({ where: { id: cheapId }, data: { healthStatus: 'unhealthy' } });
    const runId = `${TAG}-run-unhealthy`;
    const r = await routing.route({ capability: 'text_generation', organizationId: orgId, runId });
    expect(r.providerId).toBe(priceyId);
    const row = (await lastDecision(runId))!;
    expect(findCand(row, cheapId)).toMatchObject({ accepted: false, reasonCode: 'unhealthy' });
    expect(row.reasonCode).toBe('health_score'); // 决定因素是健康
    await prisma.provider.update({ where: { id: cheapId }, data: { healthStatus: 'healthy' } });
  });

  it('P7 决策审计 API：runId 过滤可查、候选原因完整；跨组织策略 403', async () => {
    const runId = `${TAG}-run-audit`;
    await routing.route({ capability: 'text_generation', organizationId: orgId, runId });

    const res = await request(app.getHttpServer())
      .get(`/api/v1/routing/decisions?runId=${runId}&organizationId=${orgId}`).set(XRW).set('Cookie', cookie).expect(200);
    const rows = res.body.data as Array<{ runId: string; candidates: Candidate[]; providerId: string; reasonCode: string }>;
    expect(rows.length).toBe(1);
    expect(rows[0]).toMatchObject({ runId, providerId: cheapId });
    expect(rows[0].candidates.some((c) => c.reasonCode === 'selected')).toBe(true);
    expect(rows[0].candidates.every((c) => typeof c.accepted === 'boolean')).toBe(true);

    // 只给 runId（不给组织）：仍可查（按请求者所属组织收窄）
    const byRun = await request(app.getHttpServer())
      .get(`/api/v1/routing/decisions?runId=${runId}`).set(XRW).set('Cookie', cookie).expect(200);
    expect((byRun.body.data as Array<{ runId: string }>).length).toBe(1);

    // 跨组织：他人组织的策略/审计一律 403（服务端 membership，绝不信客户端 organizationId）
    await request(app.getHttpServer()).post('/api/v1/routing/policies').set(XRW).set('Cookie', cookie)
      .send({ organizationId: otherOrgId, providerId: cheapId, allow: false }).expect(403);
    await request(app.getHttpServer()).get(`/api/v1/routing/policies?organizationId=${otherOrgId}`).set(XRW).set('Cookie', cookie).expect(403);
    await request(app.getHttpServer()).get(`/api/v1/routing/decisions?organizationId=${otherOrgId}`).set(XRW).set('Cookie', cookie).expect(403);
  });

  it('P7 无可用 provider → PROVIDER_UNAVAILABLE（服务端裁决）且审计留痕', async () => {
    // 测试内的两个 provider 停用 + 组织级 deny 其余全部 llm provider → 候选耗尽
    const allLlm = await prisma.provider.findMany({ where: { type: 'llm' }, select: { id: true } });
    await prisma.provider.updateMany({ where: { id: { in: [cheapId, priceyId] } }, data: { enabled: false } });
    await prisma.providerPolicy.createMany({
      data: allLlm.map((p) => ({ organizationId: orgId, providerId: p.id, allow: false, priority: 100, enabled: true })),
    });
    const runId = `${TAG}-run-unavailable`;
    await expect(routing.route({ capability: 'text_generation', organizationId: orgId, runId }))
      .rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE' });
    const row = (await lastDecision(runId))!;
    expect(row).toMatchObject({ providerId: null, reasonCode: 'denied' });
    expect(findCand(row, cheapId).reasonCode).toBe('disabled'); // 停用先于策略判定
    expect(candidatesOf(row).every((c) => !c.accepted)).toBe(true);
    await prisma.providerPolicy.deleteMany({ where: { organizationId: orgId } });
    await prisma.provider.updateMany({ where: { id: { in: [cheapId, priceyId] } }, data: { enabled: true } });
  });

  it('P7 敏感数据不流向被禁 provider：deny + 组织缺省 → 该 provider 不出现在任何候选链上', async () => {
    await prisma.providerPolicy.create({
      data: { organizationId: orgId, providerId: priceyId, allow: false, priority: 100, enabled: true },
    });
    const r = await routing.route({ capability: 'text_generation', organizationId: orgId, runId: `${TAG}-run-deny2` });
    expect(r.chain.some((t) => t.providerId === priceyId)).toBe(false);
    expect(r.candidates.find((c) => c.providerId === priceyId)!.reasonCode).toBe('policy_deny');
    await prisma.providerPolicy.deleteMany({ where: { organizationId: orgId, providerId: priceyId } });
  });
});
