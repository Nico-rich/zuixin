import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { getQueueToken } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import request from 'supertest';
import cookieParser from 'cookie-parser';
import express from 'express';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { AppModule } from '../src/app.module';
import { GlobalExceptionFilter } from '../src/common/filters/global-exception.filter';
import { TransformInterceptor } from '../src/common/interceptors/transform.interceptor';
import { csrfProtection } from '../src/modules/auth/csrf.middleware';
import { PrismaService } from '../src/modules/prisma/prisma.service';
import { WORKFLOW_QUEUE } from '../src/core/queue/queue.module';
import { webhookSignature } from '../src/modules/workflows/webhook-secret';
import { ownSchedulerEntry, scheduleSchedulerId } from '../src/modules/workflows/workflow-triggers.service';
import Redis from 'ioredis';

const XRW = { 'X-Requested-With': 'XMLHttpRequest' };
const STAMP = Date.now();

const WF_DEF = (cron: string) => ({
  triggers: [{ type: 'manual' }, { type: 'webhook' }, { type: 'schedule', cron }],
  steps: [{ id: 'out', type: 'output', output: { ok: true } }],
});

/**
 * M10-P5 A5 e2e（SA-16/SA-17/SA-18 + X-06），真实 PostgreSQL/Redis/BullMQ：
 * ① webhook **全局总闸**：换 token 也绕不过 → 超限 429 RATE_LIMITED（per-token 闸的既有漏洞正是"键来自 URL"）；
 * ② secret 轮换**双 secret 过渡窗**：旧 secret 窗内可用 → 窗后 409 WEBHOOK_SECRET_ROTATION_REQUIRED、
 *    新 secret 即刻生效、盘上无明文；再次轮换只保留一代；
 * ③ 轮换 RBAC：owner 允许；member/viewer 403；非成员 404 反枚举；无凭证 401；
 * ④ schedule 重发布（X-06）：cron 变更**就地更新同一调度器**（绝不叠加）；归档后无残留。
 *
 * 运行方式（独立 Redis DB，与 m7-p6/m8-p5 的 db 0 隔离）：
 *   cd apps/api && REDIS_URL=redis://localhost:6379/25 npx vitest run test/pre-m10-webhook-secret-rotation.e2e-spec.ts
 */
describe('Pre-M10 webhook 速率/secret 轮换/schedule 重发布 (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let queue: Queue;
  let redis: Redis; // 直连：清理全局总闸的固定窗口计数（跨用例/跨轮次污染的唯一来源）
  let cookieOwner: string;
  let cookieMember: string;
  let cookieViewer: string;
  let cookieOutsider: string;
  let orgA = '';
  let workflowId = ''; // orgA 组织流程（webhook + schedule）
  const cleanupUserIds: string[] = [];
  const cleanupWorkflowIds: string[] = [];
  let webhook: { token: string; secret: string } | null = null;

  const postWebhook = (token: string, signature: string, timestamp: string, eventId: string, body: string) =>
    request(app.getHttpServer())
      .post(`/api/v1/hooks/workflows/${token}`)
      .set('Content-Type', 'application/json')
      .set({ 'X-Hook-Signature': signature, 'X-Hook-Timestamp': timestamp, 'X-Hook-Event-Id': eventId })
      .send(body);

  const signWith = (secret: string, body: string, eventId: string, timestamp = String(Date.now())) =>
    ({ timestamp, signature: webhookSignature(secret, timestamp, eventId, Buffer.from(body, 'utf8')) });

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.use(cookieParser());
    app.use('/api/v1/hooks', express.raw({ type: '*/*', limit: '1mb' })); // HMAC 需要原始字节
    app.use('/api/v1', csrfProtection);
    app.setGlobalPrefix('api/v1');
    app.useGlobalFilters(moduleRef.get(GlobalExceptionFilter));
    app.useGlobalInterceptors(new TransformInterceptor());
    await app.init();
    await app.listen(0);
    prisma = moduleRef.get(PrismaService);
    queue = app.get<Queue>(getQueueToken(WORKFLOW_QUEUE));
    redis = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379');

    const { JwtService } = await import('@nestjs/jwt');
    const jwt = moduleRef.get(JwtService);
    const login = await request(app.getHttpServer()).post('/api/v1/auth/login').set(XRW)
      .send({ email: process.env.SEED_ADMIN_EMAIL ?? 'admin@example.com', password: process.env.SEED_ADMIN_PASSWORD ?? 'admin123456' });
    cookieOwner = (login.headers['set-cookie'] as unknown as string[]).map((c) => c.split(';')[0]).join('; ');

    // 组织 + member/viewer/outsider 三个独立用户（成员行直接落库，与其他套件零交集）
    const org = await request(app.getHttpServer()).post('/api/v1/organizations').set(XRW).set('Cookie', cookieOwner)
      .send({ name: `prem10-hook-org-${STAMP}` }).expect(201);
    orgA = org.body.data.id as string;
    const mkUser = async (tag: string, role: 'member' | 'viewer' | null) => {
      const u = await prisma.user.create({ data: { email: `prem10-hook-${tag}-${STAMP}@example.com`, passwordHash: 'unused-hash' } });
      cleanupUserIds.push(u.id);
      if (role) await prisma.organizationMember.create({ data: { organizationId: orgA, userId: u.id, role } });
      return `agent_access=${await jwt.signAsync({ sub: u.id, role: 'user' })}`;
    };
    cookieMember = await mkUser('member', 'member');
    cookieViewer = await mkUser('viewer', 'viewer');
    cookieOutsider = await mkUser('outsider', null);

    const created = await request(app.getHttpServer()).post('/api/v1/workflows').set(XRW).set('Cookie', cookieOwner)
      .send({ name: `prem10 webhook wf ${STAMP}`, organizationId: orgA, definition: WF_DEF('0 9 * * 1') }).expect(201);
    workflowId = created.body.data.id as string;
    cleanupWorkflowIds.push(workflowId);
    const published = await request(app.getHttpServer()).post(`/api/v1/workflows/${workflowId}/publish`).set(XRW).set('Cookie', cookieOwner).expect(201);
    const webhookInfo = published.body.data.triggerInfo?.webhook as { token: string; secret: string } | null;
    expect(webhookInfo?.secret).toBeTruthy();
    webhook = webhookInfo;
  }, 60_000);

  afterAll(async () => {
    // 调度器先行清理（队列是 Redis 事实源，绝不留给后续套件）
    for (const id of cleanupWorkflowIds) {
      const schedulers = await queue.getJobSchedulers(0, -1, true).catch(() => []);
      for (const s of schedulers ?? []) {
        // 删除句柄是条目里的 `key`（BullMQ 5 的调度器 id 即 zset 成员；`id` 字段在真实数据里不存在）
        const owned = ownSchedulerEntry(s, id);
        if (owned) await queue.removeJobScheduler(owned.id).catch(() => undefined);
      }
    }
    await redis.del('ratelimit:webhook:global').catch(() => undefined); // 全局桶不留残余计数
    redis.disconnect();
    await prisma.workflowWebhook.deleteMany({ where: { workflowId: { in: cleanupWorkflowIds } } }).catch(() => undefined);
    await prisma.workflow.deleteMany({ where: { id: { in: cleanupWorkflowIds } } }).catch(() => undefined);
    if (orgA) {
      await prisma.organizationMember.deleteMany({ where: { organizationId: orgA } }).catch(() => undefined);
      await prisma.organization.deleteMany({ where: { id: orgA } }).catch(() => undefined);
    }
    await prisma.user.deleteMany({ where: { id: { in: cleanupUserIds } } }).catch(() => undefined);
    await app.close();
  });

  it('① 全局总闸（SA-16/SA-17）：换 token 也绕不过 —— 超限 429 RATE_LIMITED，抬高阈值后恢复', async () => {
    expect(webhook).toBeTruthy();
    const body = JSON.stringify({ orderId: 'throttle-1' });
    // 固定窗口计数在 Redis 里跨进程存活（上一轮/上一用例的残留会让首请求即 429）→ 先清桶再压阈值
    await redis.del('ratelimit:webhook:global');
    // per-token 闸（120/min）远高于本用例用量 → 唯一可能触发 429 的是全局闸
    process.env.WEBHOOK_GLOBAL_LIMIT = '3';
    process.env.WEBHOOK_GLOBAL_WINDOW_MS = '60000';
    try {
      for (const evt of ['g-1', 'g-2', 'g-3']) {
        const { timestamp, signature } = signWith(webhook!.secret, body, evt);
        await postWebhook(webhook!.token, signature, timestamp, evt, body).expect(201);
      }
      // 第 4 次换一个**完全不同的 token**（未持密钥、随机签名）→ per-token 计数是全新的 →
      // 仍 429 ⇒ 拦下它的一定是与 token 无关的全局闸（这正是 per-token 维度无法提供的上界）
      const { timestamp, signature } = signWith('c'.repeat(64), body, 'g-4');
      const throttled = await postWebhook('unknown-token-throttle-probe', signature, timestamp, 'g-4', body).expect(429);
      expect(throttled.body.error.code).toBe('RATE_LIMITED');
      expect(throttled.body.error.message).toContain('webhook');
      // 有效 token 同样被全局闸拦下（全局桶共享——背压语义，不是"只拦未授权者"）
      const valid = signWith(webhook!.secret, body, 'g-5');
      await postWebhook(webhook!.token, valid.signature, valid.timestamp, 'g-5', body).expect(429);
      // 抬高阈值 → 同一窗口内恢复（证明确实是阈值判定，而非被永久封禁）
      process.env.WEBHOOK_GLOBAL_LIMIT = '1000';
      const recovered = signWith(webhook!.secret, body, 'g-6');
      await postWebhook(webhook!.token, recovered.signature, recovered.timestamp, 'g-6', body).expect(201);
    } finally {
      delete process.env.WEBHOOK_GLOBAL_LIMIT;
      delete process.env.WEBHOOK_GLOBAL_WINDOW_MS;
    }
  });

  it('② secret 轮换双 secret 过渡窗（SA-18）：窗内旧 secret 可用 → 窗后 409 → 新 secret 即刻生效；盘上无明文', async () => {
    process.env.WEBHOOK_SECRET_GRACE_MS = '4000';
    const oldSecret = webhook!.secret;
    try {
      // 轮换前：旧 secret 正常验签（基线）
      const base = signWith(oldSecret, JSON.stringify({}), 'r-0');
      await postWebhook(webhook!.token, base.signature, base.timestamp, 'r-0', JSON.stringify({})).expect(201);

      const rotated = await request(app.getHttpServer()).post(`/api/v1/workflows/${workflowId}/webhook/rotate`)
        .set(XRW).set('Cookie', cookieOwner).expect(201);
      const newSecret = rotated.body.data.secret as string;
      expect(rotated.body.data.token).toBe(webhook!.token); // token 不变（端点地址不因轮换而变）
      expect(newSecret).toMatch(/^[0-9a-f]{64}$/);
      expect(newSecret).not.toBe(oldSecret);
      const expiresAt = Date.parse(rotated.body.data.previousSecretExpiresAt as string);
      expect(expiresAt).toBeGreaterThan(Date.now());

      // 盘上只有密文信封，绝无明文密钥
      const row = await prisma.workflowWebhook.findFirst({ where: { workflowId } });
      expect(row!.secretEncrypted).not.toContain(oldSecret);
      expect(row!.secretEncrypted).not.toContain(newSecret);

      // 过渡窗内：**旧 secret 仍可验签**（发送方有窗口切换密钥）+ 新 secret 立即可用
      const inWindow = signWith(oldSecret, JSON.stringify({}), 'r-1');
      await postWebhook(webhook!.token, inWindow.signature, inWindow.timestamp, 'r-1', JSON.stringify({})).expect(201);
      const fresh = signWith(newSecret, JSON.stringify({}), 'r-2');
      await postWebhook(webhook!.token, fresh.signature, fresh.timestamp, 'r-2', JSON.stringify({})).expect(201);

      // 过渡窗之后：旧 secret → 409 WEBHOOK_SECRET_ROTATION_REQUIRED（可诊断：仅"持过旧密钥者"可达）
      await new Promise((r) => setTimeout(r, Math.max(0, expiresAt - Date.now()) + 400));
      const expired = signWith(oldSecret, JSON.stringify({}), 'r-3');
      const rejected = await postWebhook(webhook!.token, expired.signature, expired.timestamp, 'r-3', JSON.stringify({})).expect(409);
      expect(rejected.body.error.code).toBe('WEBHOOK_SECRET_ROTATION_REQUIRED');
      // 窗口后新 secret 依然有效（轮换不是"作废端点"）
      const after = signWith(newSecret, JSON.stringify({}), 'r-4');
      await postWebhook(webhook!.token, after.signature, after.timestamp, 'r-4', JSON.stringify({})).expect(201);

      // 只保留一代：再次轮换 → 上一代（newSecret）在窗内可用，更早的（oldSecret）彻底不认识（401 而非 409）
      const second = await request(app.getHttpServer()).post(`/api/v1/workflows/${workflowId}/webhook/rotate`)
        .set(XRW).set('Cookie', cookieOwner).expect(201);
      const thirdSecret = second.body.data.secret as string;
      const prevGen = signWith(newSecret, JSON.stringify({}), 'r-5');
      await postWebhook(webhook!.token, prevGen.signature, prevGen.timestamp, 'r-5', JSON.stringify({})).expect(201);
      const tooOld = signWith(oldSecret, JSON.stringify({}), 'r-6');
      const gone = await postWebhook(webhook!.token, tooOld.signature, tooOld.timestamp, 'r-6', JSON.stringify({})).expect(401);
      expect(gone.body.error.code).toBe('WEBHOOK_SIGNATURE_INVALID');
      const current = signWith(thirdSecret, JSON.stringify({}), 'r-7');
      await postWebhook(webhook!.token, current.signature, current.timestamp, 'r-7', JSON.stringify({})).expect(201);
      webhook = { token: webhook!.token, secret: thirdSecret }; // 供后续用例使用
    } finally {
      delete process.env.WEBHOOK_SECRET_GRACE_MS;
    }
  }, 30_000);

  it('③ 轮换 RBAC：owner 允许；member/viewer 403；非成员 404 反枚举；无凭证 401', async () => {
    const url = `/api/v1/workflows/${workflowId}/webhook/rotate`;
    // 无凭证 → 401（JWT 守卫先于一切）
    await request(app.getHttpServer()).post(url).set(XRW).send({}).expect(401);
    // 非成员（另一用户）→ 404（与"工作流不存在"不可区分）
    await request(app.getHttpServer()).post(url).set(XRW).set('Cookie', cookieOutsider).send({}).expect(404);
    // 组织内 member（有 workflow.write）→ 403（密钥轮换是管理员面，比写权限更严）
    const memberRes = await request(app.getHttpServer()).post(url).set(XRW).set('Cookie', cookieMember).send({}).expect(403);
    expect(memberRes.body.error.code).toBe('FORBIDDEN');
    // viewer → 403（连 workflow.write 都没有）
    await request(app.getHttpServer()).post(url).set(XRW).set('Cookie', cookieViewer).send({}).expect(403);
    // owner → 允许
    const ok = await request(app.getHttpServer()).post(url).set(XRW).set('Cookie', cookieOwner).send({}).expect(201);
    expect(ok.body.data.secret).toMatch(/^[0-9a-f]{64}$/);
    webhook = { token: webhook!.token, secret: ok.body.data.secret as string };
  });

  it('④ schedule 重发布（X-06）：cron 变更就地更新同一调度器（绝不叠加）；归档后无残留', async () => {
    // 断言直接读 BullMQ 的真实条目：**调度器 id 在 `key`**（BullMQ 5 无 `id` 字段）——
    // 修复前只认 `s.id`，归属集合恒空 → "归档不注销 / 旧 cron 永久留存"在真实环境里必然发生。
    const ownSchedulers = async () => (await queue.getJobSchedulers(0, -1, true))
      .filter((s): s is NonNullable<typeof s> => !!ownSchedulerEntry(s, workflowId));

    // 发布时已注册（v1 cron）
    let schedulers = await ownSchedulers();
    expect(schedulers.map((s) => s.key)).toEqual([scheduleSchedulerId(workflowId)]);
    expect(schedulers[0].pattern).toBe('0 9 * * 1');

    // 重发布：cron 变更 → **同一个调度器**被就地更新（修复前旧调度器留存 + 新调度器叠加）
    await request(app.getHttpServer()).patch(`/api/v1/workflows/${workflowId}`).set(XRW).set('Cookie', cookieOwner)
      .send({ definition: WF_DEF('30 10 * * 4') }).expect(200);
    const republished = await request(app.getHttpServer()).post(`/api/v1/workflows/${workflowId}/publish`).set(XRW).set('Cookie', cookieOwner).expect(201);
    // 重发布复用既有 webhook 行（secret 不回传）→ **轮换后的凭据不被改写**（否则端点永久失联）
    expect(republished.body.data.triggerInfo?.webhook?.secret).toBeNull();
    const republishEvt = `republish-${STAMP}`;
    const stillValid = signWith(webhook!.secret, JSON.stringify({}), republishEvt);
    await postWebhook(webhook!.token, stillValid.signature, stillValid.timestamp, republishEvt, JSON.stringify({})).expect(201);
    schedulers = await ownSchedulers();
    expect(schedulers).toHaveLength(1); // 绝不叠加（X-06 的核心断言）
    expect(schedulers[0].key).toBe(scheduleSchedulerId(workflowId));
    expect(schedulers[0].pattern).toBe('30 10 * * 4');

    // 幂等：再发布一次（cron 未变）→ 仍只有一个调度器
    await request(app.getHttpServer()).post(`/api/v1/workflows/${workflowId}/publish`).set(XRW).set('Cookie', cookieOwner).expect(201);
    schedulers = await ownSchedulers();
    expect(schedulers).toHaveLength(1);

    // 归档 → 注销（归档后绝不留存调度器；含未跑过的 cron 也一并收敛）
    await request(app.getHttpServer()).post(`/api/v1/workflows/${workflowId}/archive`).set(XRW).set('Cookie', cookieOwner).expect(201);
    expect(await ownSchedulers()).toHaveLength(0);
  }, 30_000);
});
