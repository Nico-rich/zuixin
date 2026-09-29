import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { AppModule } from '../src/app.module';
import { GlobalExceptionFilter } from '../src/common/filters/global-exception.filter';
import { TransformInterceptor } from '../src/common/interceptors/transform.interceptor';
import { csrfProtection } from '../src/modules/auth/csrf.middleware';
import { PrismaService } from '../src/modules/prisma/prisma.service';
import { LLMManagerService } from '../src/providers/llm/llm-manager.service';
import { RoutingService } from '../src/modules/provider-routing/routing.service';
import { CryptoService } from '../src/core/crypto/crypto.service';

/**
 * M13+ 模型配置 e2e（真实 PG/Redis/HTTP）。独立 Redis DB（M8 教训，绝不省略）：
 *   REDIS_URL=redis://localhost:6379/48 npx vitest run test/providers-admin.e2e-spec.ts
 *
 * 端到端事实：
 * ① RBAC：仅平台管理员（DB 权威 role='admin'）；成员/组织 owner/**伪造 admin 声明的合法签名 token** 一律 403；
 * ② GET 投影：hasKey 布尔、loaded/degradedReason 来自 manager、**响应体绝无 apiKey 子串**；
 * ③ 校验面：strict 未知键/越界/危险 baseUrl → 400 且 DB 未变；未知 id → 404；
 * ④ **热更新生效**（本特性核心）：PATCH enabled=false → 内存 getProvider 消失、路由回退链剔除该 provider；
 *    恢复 → 重新出现、路由重选、resolve 成功（重启级效果，零重启）；
 * ⑤ Key 只写：PATCH apiKey → hasKey=true；raw 行密文 ≠ 明文；crypto.decrypt 还原；响应/审计零明文；
 * ⑥ 审计：action=provider.update + metadata 无明文 + keyChanged；
 * ⑦ 默认模型通道（system-settings routingPolicy）：合法写 200、不存在/未知能力键 400 且存储未变。
 *
 * 副作用治理：共享 dev 库——beforeAll 快照被触碰的 provider 列与 routingPolicy 行，afterAll 逐条还原
 * （绝不依赖 seed：mock upsert 是 update:{}，重跑 seed 不恢复停用态）。
 */
process.env.REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379/48';

const XRW = { 'X-Requested-With': 'XMLHttpRequest' };
const STAMP = Date.now();
const TARGET = 'seed-llm-mock';

interface ProviderSnapshot { enabled: boolean; apiKeyEncrypted: string; baseUrl: string; priority: number; timeoutMs: number }
interface RouteChainItem { providerId: string; modelId?: string }

describe('M13+ 模型配置 (e2e, 真实 HTTP/PostgreSQL)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let crypto: CryptoService;
  let cookieAdmin = '';
  let cookieMember = '';
  let cookieForgedAdmin = '';
  const cleanupUserIds: string[] = [];
  const priorProviders = new Map<string, ProviderSnapshot>();
  let priorRoutingPolicy: unknown | null = null;
  let hadRoutingPolicyRow = false;

  const api = () => request(app.getHttpServer());
  const as = (cookie: string) => ({
    get: (path: string) => api().get(path).set(XRW).set('Cookie', cookie),
    patch: (path: string) => api().patch(path).set(XRW).set('Cookie', cookie),
  });

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
    crypto = moduleRef.get(CryptoService);

    const { JwtService } = await import('@nestjs/jwt');
    const jwt = moduleRef.get(JwtService);

    const login = await api().post('/api/v1/auth/login').set(XRW)
      .send({ email: process.env.SEED_ADMIN_EMAIL ?? 'admin@example.com', password: process.env.SEED_ADMIN_PASSWORD ?? 'admin123456' });
    expect([200, 201]).toContain(login.status);
    cookieAdmin = (login.headers['set-cookie'] as unknown as string[]).map((c) => c.split(';')[0]).join('; ');

    // 探针用户：DB 角色恒为 user（token 声明不被采信——红线）
    const member = await prisma.user.create({
      data: { email: `providers-admin-${STAMP}@example.com`, passwordHash: 'unused-hash', role: 'user' },
    });
    cleanupUserIds.push(member.id);
    cookieMember = `agent_access=${await jwt.signAsync({ sub: member.id, role: 'user' })}`;
    cookieForgedAdmin = `agent_access=${await jwt.signAsync({ sub: member.id, role: 'admin' })}`;

    // 快照（afterAll 还原）：本套件会触碰 seed-llm-mock 与 routingPolicy
    for (const id of [TARGET, 'seed-llm-mock-router']) {
      const row = await prisma.provider.findUnique({ where: { id } });
      if (row) priorProviders.set(id, { enabled: row.enabled, apiKeyEncrypted: row.apiKeyEncrypted, baseUrl: row.baseUrl, priority: row.priority, timeoutMs: row.timeoutMs });
    }
    const setting = await prisma.systemSetting.findUnique({ where: { key: 'routingPolicy' } });
    hadRoutingPolicyRow = Boolean(setting);
    priorRoutingPolicy = setting?.value ?? null;
  });

  afterAll(async () => {
    // 还原 provider 列（绝不依赖 seed）
    for (const [id, snap] of priorProviders) {
      await prisma.provider.update({ where: { id }, data: snap }).catch(() => undefined);
    }
    if (hadRoutingPolicyRow) {
      await prisma.systemSetting.upsert({
        where: { key: 'routingPolicy' }, update: { value: priorRoutingPolicy as never }, create: { key: 'routingPolicy', value: priorRoutingPolicy as never },
      }).catch(() => undefined);
    } else {
      await prisma.systemSetting.deleteMany({ where: { key: 'routingPolicy' } }).catch(() => undefined);
    }
    for (const userId of cleanupUserIds) {
      await prisma.user.deleteMany({ where: { id: userId } }).catch(() => undefined);
    }
    await app.close();
  });

  it('① RBAC：匿名 401；普通成员 403；伪造 admin 声明（DB=user）403；平台管理员 200', async () => {
    await api().get('/api/v1/providers').expect(401);
    await as(cookieMember).get('/api/v1/providers').expect(403);
    await as(cookieMember).patch(`/api/v1/providers/${TARGET}`).send({ enabled: false }).expect(403);
    await as(cookieForgedAdmin).get('/api/v1/providers').expect(403);
    await as(cookieForgedAdmin).patch(`/api/v1/providers/${TARGET}`).send({ enabled: false }).expect(403);
    await as(cookieAdmin).get('/api/v1/providers').expect(200);
  });

  it('② GET 投影：hasKey/loaded/degradedReason 齐备，响应体绝无 apiKey 子串', async () => {
    const res = await as(cookieAdmin).get('/api/v1/providers').expect(200);
    const providers = (res.body.data as { providers: Array<Record<string, unknown>> }).providers;
    const target = providers.find((p) => p.id === TARGET);
    expect(target).toBeDefined();
    expect(target?.hasKey).toBe(false);
    expect(target?.loaded).toBe(true); // TEST_ENSURE_MOCK_PROVIDERS 基建保证 mock 已启用
    expect(target).toHaveProperty('degradedReason');
    expect(target).toHaveProperty('keyVersion');
    expect(target).toHaveProperty('managedByExtension');
    expect(Array.isArray(target?.models)).toBe(true);
    expect(JSON.stringify(res.body)).not.toContain('apiKey');
    expect(JSON.stringify(res.body)).not.toContain('apiKeyEncrypted');
  });

  it('③ 校验面：strict 未知键/越界/危险 baseUrl/空补丁 → 400 且 DB 未变；未知 id → 404', async () => {
    const before = await prisma.provider.findUnique({ where: { id: TARGET } });
    for (const bad of [
      { type: 'image' }, { adapter: 'openai-compatible' }, { name: 'x' },
      { priority: -1 }, { timeoutMs: 999 },
      { baseUrl: 'http://evil.example.com/v1' }, { baseUrl: 'https://127.0.0.1/v1' },
      {},
    ]) {
      await as(cookieAdmin).patch(`/api/v1/providers/${TARGET}`).send(bad).expect(400);
    }
    await as(cookieAdmin).patch('/api/v1/providers/no-such-provider').send({ enabled: true }).expect(404);
    const after = await prisma.provider.findUnique({ where: { id: TARGET } });
    expect(after).toEqual(before); // 失败零副作用
  });

  it('④ 热更新生效：PATCH enabled=false → 内存消失+路由回退链剔除；恢复 → 重选+resolve 成功（零重启）', async () => {
    const llm = app.get(LLMManagerService);
    const routing = app.get(RoutingService);
    const chainBefore = await routing.route({ capability: 'text_generation', organizationId: null });
    expect(chainBefore.chain.some((c) => c.providerId === TARGET)).toBe(true);

    await as(cookieAdmin).patch(`/api/v1/providers/${TARGET}`).send({ enabled: false }).expect(200);
    expect(llm.getProvider(TARGET)).toBeUndefined();
    const routeOff = await routing.route({ capability: 'text_generation', organizationId: null });
    expect(routeOff.chain.some((c: RouteChainItem) => c.providerId === TARGET)).toBe(false);
    // 拒绝原因在候选审计行里可见（routing 决策的既有口径）
    expect(routeOff.candidates.find((c) => c.providerId === TARGET)?.reasonCode).toBe('disabled');

    await as(cookieAdmin).patch(`/api/v1/providers/${TARGET}`).send({ enabled: true }).expect(200);
    expect(llm.getProvider(TARGET)).toBeDefined();
    const chainOn = await routing.route({ capability: 'text_generation', organizationId: null });
    expect(chainOn.chain.some((c: RouteChainItem) => c.providerId === TARGET)).toBe(true);
    await expect(llm.resolve('seed-model-mock-echo')).resolves.toBeDefined(); // refresh 后真实可用
  });

  it('⑤ Key 只写：PATCH apiKey → hasKey=true、raw 密文 ≠ 明文、decrypt 还原；响应零明文', async () => {
    const key = `sk-e2e-${STAMP}`;
    const res = await as(cookieAdmin).patch(`/api/v1/providers/${TARGET}`).send({ apiKey: key }).expect(200);
    expect(res.body.data.hasKey).toBe(true);
    expect(JSON.stringify(res.body)).not.toContain(key);

    const raw = await prisma.provider.findUnique({ where: { id: TARGET } });
    expect(raw?.apiKeyEncrypted).toBeTruthy();
    expect(raw?.apiKeyEncrypted).not.toContain(key);
    expect(crypto.decrypt(raw!.apiKeyEncrypted)).toBe(key);
    expect(raw?.apiKeyEncrypted.startsWith('v')).toBe(true); // 自描述密文

    // 还原为空（快照值）
    await prisma.provider.update({ where: { id: TARGET }, data: { apiKeyEncrypted: priorProviders.get(TARGET)?.apiKeyEncrypted ?? '' } });
  });

  it('⑥ 审计：action=provider.update + metadata 无明文 + keyChanged', async () => {
    const key = `sk-audit-${STAMP}`;
    await as(cookieAdmin).patch(`/api/v1/providers/${TARGET}`).send({ apiKey: key, priority: 55 }).expect(200);
    const audit = await prisma.auditLog.findFirst({
      where: { action: 'provider.update', targetType: 'provider', targetId: TARGET },
      orderBy: { createdAt: 'desc' },
    });
    expect(audit).toBeDefined();
    expect(JSON.stringify(audit?.metadata)).not.toContain(key);
    expect((audit?.metadata as { keyChanged?: boolean })?.keyChanged).toBe(true);
    expect((audit?.metadata as { changed?: string[] })?.changed).toEqual(['apiKey', 'priority']);
    // 还原
    const snap = priorProviders.get(TARGET)!;
    await prisma.provider.update({ where: { id: TARGET }, data: { apiKeyEncrypted: snap.apiKeyEncrypted, priority: snap.priority } });
  });

  it('⑦ 默认模型通道（system-settings routingPolicy）：合法 200；不存在/未知能力键 400 且存储未变', async () => {
    const sys = as(cookieAdmin);
    const readRaw = () => prisma.systemSetting.findUnique({ where: { key: 'routingPolicy' } });

    await sys.patch('/api/v1/system-settings/routingPolicy').send({ defaults: { llm: 'seed-model-mock-echo' } }).expect(200);
    const before = await readRaw();

    await sys.patch('/api/v1/system-settings/routingPolicy').send({ defaults: { llm: 'no-such-model' } }).expect(400);
    expect(await readRaw()).toEqual(before);

    await sys.patch('/api/v1/system-settings/routingPolicy').send({ defaults: { vision: null } }).expect(400);
    expect(await readRaw()).toEqual(before);

    await sys.patch('/api/v1/system-settings/routingPolicy').send({ defaults: {} }).expect(400);
    expect(await readRaw()).toEqual(before);
  });
});
