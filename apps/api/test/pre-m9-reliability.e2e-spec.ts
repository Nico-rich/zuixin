import { Test } from '@nestjs/testing';
import { INestApplication, INestApplicationContext } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import request from 'supertest';
import cookieParser from 'cookie-parser';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { AppModule } from '../src/app.module';
import { WorkerModule } from '../src/worker.module';
import { GlobalExceptionFilter } from '../src/common/filters/global-exception.filter';
import { TransformInterceptor } from '../src/common/interceptors/transform.interceptor';
import { csrfProtection } from '../src/modules/auth/csrf.middleware';
import { PrismaService } from '../src/modules/prisma/prisma.service';
import { CryptoService } from '../src/core/crypto/crypto.service';
import { CircuitBreakerService } from '../src/core/circuit-breaker/circuit-breaker.service';
import { ModelRouterService } from '../src/core/model-router/model-router.service';
import { AppError } from '../src/common/errors/app-error';
import { BillingService } from '../src/modules/billing/billing.service';
import { ExternalActionsService } from '../src/modules/external-actions/external-actions.service';
import { MockExternalActionProvider } from '../src/modules/external-actions/mock-external-action.provider';
import { MediaCleanupService } from '../src/modules/generations/media-cleanup.service';
import { VideoManagerService } from '../src/providers/video/video-manager.service';
import { CredentialService } from '../src/modules/connections/credentials.service';
import { OAuthProvidersService } from '../src/modules/connections/oauth/oauth-providers.service';
import { MockOAuthProvider } from '../src/modules/connections/oauth/mock-oauth.provider';
import { OrganizationsService } from '../src/modules/organizations/organizations.service';

/**
 * Pre-M9 可靠性包 e2e（真实 PostgreSQL + 真实 Redis + 真实 Worker 进程）：
 * - G1/G2 熔断自愈：真实 Redis 熔断器（TTL 半开 + 探针复位，绝不永久排除 provider）；
 * - G7 远端恢复：GenerationTask（remoteTaskId 回读）与 ExternalAction（executing 残留）——provider 是权威，
 *   已完成就恢复、仍在跑就保持非终态、绝不重复执行副作用；
 * - G8 支付事务一致性：事件与发票同生同死 + P2002 补齐（发票永不永久 unpaid）；
 * - G9 scheduler dead resume：dead 是"需人工裁决"而非"永久不可用"（不新增状态值）；
 * - C5 多实例 refresh：跨实例 DB 租约兜底 → 并发 refresh 只发生一次远端调用（进程内折叠保留）。
 *
 * 注意：必须以独立 Redis DB 运行（共享队列跨版本污染）：
 *   REDIS_URL=redis://localhost:6379/2 npx vitest run test/pre-m9-reliability.e2e-spec.ts
 * 本文件自建行（任务/附件/动作/发票/事件/作业/连接）在 afterAll 全部清理。
 */

const XRW = { 'X-Requested-With': 'XMLHttpRequest' };
const STAMP = Date.now();

describe('Pre-M9 Reliability (e2e)：熔断自愈 / 远端恢复 / 支付事务 / dead resume / 多实例 refresh', () => {
  let app: INestApplication;
  let worker: INestApplicationContext | undefined;
  let prisma: PrismaService;
  let crypto: CryptoService;
  let cookie: string;
  let userId = '';
  let orgId = '';
  const taskIds: string[] = [];
  const actionIds: string[] = [];
  const invoiceIds: string[] = [];
  const eventIds: string[] = [];
  const jobIds: string[] = [];
  const connectionIds: string[] = [];

  beforeAll(async () => {
    process.env.MOCK_DELAY_MS = '0';
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

    const login = await request(app.getHttpServer()).post('/api/v1/auth/login').set(XRW)
      .send({ email: process.env.SEED_ADMIN_EMAIL ?? 'admin@example.com', password: process.env.SEED_ADMIN_PASSWORD ?? 'admin123456' });
    expect([200, 201]).toContain(login.status);
    cookie = (login.headers['set-cookie'] as unknown as string[]).map((c) => c.split(';')[0]).join('; ');
    userId = login.body.data.user.id as string;
    orgId = (await moduleRef.get(OrganizationsService).ensurePersonalOrganization(userId)).id;

    // 真实 Worker 进程（scheduler 队列消费；media-cleanup 周期 sweep 亦随其启动）
    worker = await NestFactory.createApplicationContext(WorkerModule, { bufferLogs: false });
  }, 90_000);

  afterAll(async () => {
    await prisma.attachment.deleteMany({ where: { taskId: { in: taskIds } } }).catch(() => undefined);
    await prisma.usageRecord.deleteMany({ where: { taskId: { in: taskIds } } }).catch(() => undefined);
    await prisma.usageLedgerEntry.deleteMany({
      where: { OR: [{ idempotencyKey: { startsWith: 'ea:' } }, { idempotencyKey: { startsWith: `g8-${STAMP}` } }] },
    }).catch(() => undefined);
    await prisma.generationTask.deleteMany({ where: { id: { in: taskIds } } }).catch(() => undefined);
    await prisma.auditLog.deleteMany({ where: { targetId: { in: actionIds } } }).catch(() => undefined);
    await prisma.externalAction.deleteMany({ where: { id: { in: actionIds } } }).catch(() => undefined);
    await prisma.paymentEvent.deleteMany({ where: { id: { in: eventIds } } }).catch(() => undefined);
    await prisma.paymentEvent.deleteMany({ where: { providerEventId: { contains: STAMP.toString() } } }).catch(() => undefined);
    await prisma.invoice.deleteMany({ where: { id: { in: invoiceIds } } }).catch(() => undefined);
    await prisma.scheduledJob.deleteMany({ where: { id: { in: jobIds } } }).catch(() => undefined);
    await prisma.credential.deleteMany({ where: { connectionId: { in: connectionIds } } }).catch(() => undefined);
    await prisma.connection.deleteMany({ where: { id: { in: connectionIds } } }).catch(() => undefined);
    await worker?.close();
    await app.close();
  }, 60_000);

  // ================= G1/G2 熔断自愈 =================

  describe('G1/G2 熔断自愈（真实 Redis：TTL 半开 + 探针复位，绝不永久排除）', () => {
    it('连续失败 → open（候选被剔除）→ 冷却到期自动 half_open → 探针失败重开 → 探针成功复位并重新可路由', async () => {
      const cb = app.get(CircuitBreakerService);
      const providerId = `prem9-cb-${STAMP}`;
      const candidates = [{ modelId: 'm1', providerId, priority: 1, cost: 0, latencyMs: 1 }];
      // sleep 替身：保留真实路由/熔断逻辑，只去掉回退间 1s 等待（不改变任何判定）
      const router = new ModelRouterService(cb, async () => undefined);

      expect(await cb.state(providerId)).toBe('healthy');
      expect(await router.order(candidates)).toHaveLength(1);

      for (let i = 0; i < 5; i++) {
        await expect(router.execute(candidates, async () => {
          throw new AppError('PROVIDER_TIMEOUT', 'provider 调用超时');
        })).rejects.toMatchObject({ code: 'PROVIDER_TIMEOUT' });
      }
      expect(await cb.state(providerId)).toBe('open');
      expect(await router.order(candidates)).toEqual([]); // open → 无候选（不再打到故障 provider）

      // 冷却期未到：仍 open；冷却到期：自动 half_open（无需外部干预 = G1 自愈）
      expect(await cb.state(providerId, { cooldownSec: 1 })).toBe('open');
      await new Promise((r) => setTimeout(r, 1_100));
      expect(await cb.state(providerId, { cooldownSec: 1 })).toBe('half_open');
      expect(await cb.canCall(providerId, { cooldownSec: 1 }, false)).toBe(false); // 普通调用仍拒绝
      expect(await cb.canCall(providerId, { cooldownSec: 1 }, true)).toBe(true); // 只放行探测
      expect(await cb.canProbe(providerId, { cooldownSec: 1 })).toBe(true); // 探针槽单飞（真实 Redis NX）
      expect(await cb.canProbe(providerId, { cooldownSec: 1 })).toBe(false);

      // 探测失败 → 重新打开（冷却重计时：openedAt 归零，此刻必为 open——若只 warn 不重开，此处会是 half_open）
      expect(await cb.recordFailure(providerId, { cooldownSec: 1 })).toBe(true);
      expect(await cb.state(providerId, { cooldownSec: 1 })).toBe('open');
      await new Promise((r) => setTimeout(r, 1_100));
      expect(await cb.state(providerId, { cooldownSec: 1 })).toBe('half_open'); // 自愈可重复（无永久键）

      // 探测成功 → 复位 healthy，且候选重新可路由（G1 的核心修复：不存在"永久排除"的键）
      await cb.recordSuccess(providerId);
      expect(await cb.state(providerId)).toBe('healthy');
      expect(await router.order(candidates)).toHaveLength(1);
    }, 40_000);
  });

  // ================= G7 ExternalAction 远端恢复 =================

  describe('G7 外部动作恢复（executing 残留 → provider 权威，绝不重复执行副作用）', () => {
    let connectionId = '';

    beforeAll(async () => {
      const start = await request(app.getHttpServer()).post('/api/v1/connections/mock/start').set(XRW).set('Cookie', cookie).send({}).expect(201);
      const cb = await request(app.getHttpServer()).get('/api/v1/connections/mock/callback').set(XRW).set('Cookie', cookie)
        .query({ state: start.body.data.state, code: `code-g7-${STAMP}` }).expect(200);
      connectionId = cb.body.data.id as string;
      connectionIds.push(connectionId);
    }, 30_000);

    async function seedExecuting(actionType: string): Promise<string> {
      const row = await prisma.externalAction.create({
        data: {
          userId, organizationId: orgId, provider: 'mock', actionType, permission: 'external_action', riskLevel: 'low',
          input: { title: 'G7 恢复' }, status: 'executing', externalRequestId: `g7-${actionType}-${STAMP}`,
          idempotencyKey: `g7-${actionType}-${STAMP}`, connectionId, startedAt: new Date(Date.now() - 30 * 60_000),
        },
      });
      actionIds.push(row.id);
      return row.id;
    }

    it('远端已完成 → 条件更新落 completed（结果来自 provider；execute 未被再次调用；计量幂等）', async () => {
      const actions = app.get(ExternalActionsService);
      const mock = app.get(MockExternalActionProvider);
      const actionId = await seedExecuting('success');
      const before = mock.executeCount;

      expect(await actions.recoverExecutingAction(actionId)).toBe('completed');
      const row = await prisma.externalAction.findUnique({ where: { id: actionId } });
      expect(row!.status).toBe('completed');
      expect((row!.result as { recovered?: boolean; externalId?: string }).recovered).toBe(true);
      expect((row!.result as { externalId?: string }).externalId).toContain(`g7-success-${STAMP}-done`);
      expect(mock.executeCount).toBe(before); // 恢复绝不重放副作用（远端是既成事实）

      // 幂等：再次恢复不产生第二次计量/旁路（终态行不被复活）
      expect(await actions.recoverExecutingAction(actionId)).toBe('unknown');
      expect(await prisma.externalAction.findUnique({ where: { id: actionId } })).toMatchObject({ status: 'completed' });
      expect(await prisma.usageLedgerEntry.count({ where: { idempotencyKey: `ea:${actionId}` } })).toBe(1);
    }, 40_000);

    it('远端已失败 → 落 failed（错误来自 provider）；远端无结论（processing）→ 保持 executing，绝不伪造终态', async () => {
      const actions = app.get(ExternalActionsService);
      const failedId = await seedExecuting('failure');
      expect(await actions.recoverExecutingAction(failedId)).toBe('failed');
      const failed = await prisma.externalAction.findUnique({ where: { id: failedId } });
      expect(failed!.status).toBe('failed');
      expect(failed!.errorCode).toBe('PROVIDER_UNKNOWN');

      const unknownId = await seedExecuting('timeout'); // mock remoteStatus：无权威结论 → processing
      expect(await actions.recoverExecutingAction(unknownId)).toBe('processing');
      const keep = await prisma.externalAction.findUnique({ where: { id: unknownId } });
      expect(keep!.status).toBe('executing'); // 绝不把"查不到"当成失败
      expect(keep!.errorCode).toBeNull();

      // 批量清扫（media-cleanup 周期调用）：静默 executing 行被恢复，已终态行不被触碰
      const batch = await actions.recoverStaleExecutingActions(60_000);
      expect(batch.scanned).toBeGreaterThanOrEqual(1);
      expect(await prisma.externalAction.findUnique({ where: { id: failedId } })).toMatchObject({ status: 'failed' });
    }, 40_000);
  });

  // ================= G7 GenerationTask 远端恢复 =================

  describe('G7 媒体任务恢复（remoteTaskId 回读：远端权威，超时兜底让位）', () => {
    const VIDEO_MODEL = 'seed-vid-mock-model';
    const VIDEO_PROVIDER = 'seed-vid-mock';

    async function seedCrashedTask(remoteTaskId: string, startedAtMsAgo: number): Promise<string> {
      const row = await prisma.generationTask.create({
        data: {
          userId, type: 'video', providerId: VIDEO_PROVIDER, modelId: VIDEO_MODEL, status: 'processing',
          input: { prompt: 'g7 远端恢复', duration: 5, aspectRatio: '16:9' },
          remoteTaskId, startedAt: new Date(Date.now() - startedAtMsAgo),
        },
      });
      taskIds.push(row.id);
      return row.id;
    }

    it('远端已完成 → 清扫按真实结果恢复为 completed（附件/用量落库），绝不判 MEDIA_TASK_TIMEOUT', async () => {
      const video = app.get(VideoManagerService);
      const cleanup = app.get(MediaCleanupService);
      const { adapter } = await video.resolve(VIDEO_MODEL);
      const remoteTaskId = (await (adapter as unknown as { submit(p: unknown): Promise<{ remoteTaskId: string }> })
        .submit({ prompt: 'g7', duration: 5, aspectRatio: '16:9' })).remoteTaskId;
      await new Promise((r) => setTimeout(r, 3_200)); // mock-video：3s 后远端报 completed

      const taskId = await seedCrashedTask(remoteTaskId, 31 * 60_000); // 已超 30min 视频护栏
      await cleanup.sweep();

      const row = await prisma.generationTask.findUnique({ where: { id: taskId } });
      expect(row!.status).toBe('completed');
      expect(row!.errorCode).toBeNull();
      expect((row!.output as { attachments?: string[] }).attachments).toHaveLength(1);
      const attachments = await prisma.attachment.findMany({ where: { taskId } });
      expect(attachments).toHaveLength(1);
      expect(attachments[0].mimeType).toBe('video/mp4');
      expect(attachments[0].kind).toBe('generated_video');
    }, 60_000);

    it('远端已失败 → 落 provider 的失败原因（不是本地"任务超时"伪造）', async () => {
      const cleanup = app.get(MediaCleanupService);
      const taskId = await seedCrashedTask(`g7-missing-${STAMP}`, 31 * 60_000);
      await cleanup.sweep();
      const row = await prisma.generationTask.findUnique({ where: { id: taskId } });
      expect(row!.status).toBe('failed');
      expect(row!.errorCode).toBe('PROVIDER_UNKNOWN');
      expect(row!.errorMessage).toContain('任务不存在'); // 文案/错误码来自 provider 权威结论
      expect(row!.errorCode).not.toBe('MEDIA_TASK_TIMEOUT');
    }, 60_000);

    it('远端仍在执行（护栏内）→ 保持非终态（远端权威优先于本地超时）', async () => {
      const video = app.get(VideoManagerService);
      const cleanup = app.get(MediaCleanupService);
      const { adapter } = await video.resolve(VIDEO_MODEL);
      const remoteTaskId = (await (adapter as unknown as { submit(p: unknown): Promise<{ remoteTaskId: string }> })
        .submit({ prompt: 'g7-running', duration: 5, aspectRatio: '16:9' })).remoteTaskId;

      const taskId = await seedCrashedTask(remoteTaskId, 31 * 60_000); // 超本地超时，但 < 2× 护栏
      await cleanup.sweep();
      const row = await prisma.generationTask.findUnique({ where: { id: taskId } });
      expect(row!.status).toBe('processing'); // mock-video 3s 内报 processing → 不判死
      expect(row!.errorCode).toBeNull();
    }, 60_000);
  });

  // ================= G8 支付事务一致性 =================

  describe('G8 支付事件与发票同生同死（P2002 补齐）', () => {
    async function openInvoice(tag: string): Promise<string> {
      const inv = await prisma.invoice.create({
        data: {
          organizationId: orgId, number: `PRE-M9-${tag}-${STAMP}`, status: 'open', amount: 100, currency: 'CNY',
          periodStart: new Date(Date.now() - 86_400_000), periodEnd: new Date(),
        },
      });
      invoiceIds.push(inv.id);
      return inv.id;
    }

    it('正常支付：事件 + 发票 paid 原子提交；重复投递幂等且**补齐**发票终态；无发票则整体回滚', async () => {
      const billing = app.get(BillingService);
      const invoiceId = await openInvoice('ok');

      const first = await billing.applyPayment(orgId, invoiceId, 100);
      expect(first.duplicate).toBe(false);
      eventIds.push(first.paymentEventId);
      expect(await prisma.invoice.findUnique({ where: { id: invoiceId } })).toMatchObject({ status: 'paid' });
      expect(await prisma.paymentEvent.count({ where: { invoiceId } })).toBe(1);

      // 重复投递（provider 重复回调/崩溃后重放）→ 只入账一次 + 发票保持 paid
      const dup = await billing.applyPayment(orgId, invoiceId, 100);
      expect(dup.duplicate).toBe(true);
      expect(await prisma.paymentEvent.count({ where: { invoiceId } })).toBe(1);
      expect((await prisma.invoice.findUnique({ where: { id: invoiceId } }))!.status).toBe('paid');

      // 崩溃场景（旧实现的两个独立写之间挂掉）：事件已存在而发票仍 open → 重投必须把发票补齐
      const repairId = await openInvoice('repair');
      const evt = await prisma.paymentEvent.create({
        data: {
          organizationId: orgId, provider: 'mock', providerEventId: `mock-pay-${repairId}-100`,
          type: 'payment.succeeded', amount: 100, currency: 'CNY', invoiceId: repairId,
        },
      });
      eventIds.push(evt.id);
      const repaired = await billing.applyPayment(orgId, repairId, 100);
      expect(repaired.duplicate).toBe(true);
      expect((await prisma.invoice.findUnique({ where: { id: repairId } }))!.status).toBe('paid'); // 不再永久 unpaid

      // 发票不存在/非 open → 事务回滚：绝不留下"已收款但无发票终态"的事件
      const ghostId = `ghost-${STAMP}`;
      await expect(billing.applyPayment(orgId, ghostId, 7)).rejects.toMatchObject({ code: 'NOT_FOUND' });
      expect(await prisma.paymentEvent.count({ where: { providerEventId: `mock-pay-${ghostId}-7` } })).toBe(0);
    }, 40_000);
  });

  // ================= G9 scheduler dead resume =================

  describe('G9 dead 可 resume（不新增状态值）', () => {
    it('dead → resume → scheduled（attempts 归零/错误清空）→ 真实 worker 重新执行至 completed', async () => {
      const row = await prisma.scheduledJob.create({
        data: {
          organizationId: orgId, ownerUserId: userId, name: `G9 dead 复活 ${STAMP}`, type: 'one-shot',
          runAt: new Date(Date.now() - 60_000), status: 'dead', handler: 'noop',
          attempts: 3, maxAttempts: 3, lastError: '重试超限', completedAt: new Date(),
        },
      });
      jobIds.push(row.id);

      const res = await request(app.getHttpServer()).post(`/api/v1/scheduler/jobs/${row.id}/resume`).set(XRW).set('Cookie', cookie).expect(201);
      expect(res.body.data).toMatchObject({ resumed: true, status: 'scheduled' });
      const mid = await prisma.scheduledJob.findUnique({ where: { id: row.id } });
      expect(mid!.attempts).toBe(0); // 重试预算重置
      expect(mid!.lastError).toBeNull();
      expect(mid!.completedAt).toBeNull();

      const deadline = Date.now() + 20_000;
      let status = 'scheduled';
      while (Date.now() < deadline) {
        status = (await prisma.scheduledJob.findUnique({ where: { id: row.id } }))!.status;
        if (status === 'completed') break;
        await new Promise((r) => setTimeout(r, 100));
      }
      expect(status).toBe('completed'); // 真实 worker 消费（dead 复活后可再执行）
      expect((await prisma.scheduledJob.findUnique({ where: { id: row.id } }))!.attempts).toBe(1);

      // 终态不复活：cancelled 行 resume → 400
      const cancelled = await prisma.scheduledJob.create({
        data: {
          organizationId: orgId, ownerUserId: userId, name: `G9 cancelled ${STAMP}`, type: 'one-shot',
          runAt: new Date(), status: 'cancelled', handler: 'noop',
        },
      });
      jobIds.push(cancelled.id);
      const bad = await request(app.getHttpServer()).post(`/api/v1/scheduler/jobs/${cancelled.id}/resume`).set(XRW).set('Cookie', cookie).expect(400);
      expect(bad.body.error.code).toBe('VALIDATION_ERROR');
    }, 40_000);
  });

  // ================= C5 多实例 refresh =================

  describe('C5 多实例 refresh：跨实例 DB 租约兜底（远端刷新只发生一次）', () => {
    it('两实例并发 refresh → provider 仅刷新一次，双方都拿到新令牌（进程内折叠仍保留）', async () => {
      const start = await request(app.getHttpServer()).post('/api/v1/connections/mock/start').set(XRW).set('Cookie', cookie).send({}).expect(201);
      const cb = await request(app.getHttpServer()).get('/api/v1/connections/mock/callback').set(XRW).set('Cookie', cookie)
        .query({ state: start.body.data.state, code: `code-c5-${STAMP}` }).expect(200);
      const connectionId = cb.body.data.id as string;
      connectionIds.push(connectionId);

      const mock = app.get(MockOAuthProvider);
      const before = mock.refreshCount;
      // 第二个「API 实例」的凭证服务：独立进程内折叠表，只共享 DB（这正是多实例场景）
      const peer = new CredentialService(prisma, crypto, app.get(OAuthProvidersService));

      const [a, b] = await Promise.all([
        request(app.getHttpServer()).post(`/api/v1/connections/${connectionId}/refresh`).set(XRW).set('Cookie', cookie),
        peer.refresh(connectionId),
      ]);
      expect([200, 201]).toContain(a.status);
      expect(mock.refreshCount).toBe(before + 1); // 并发只发生一次远端刷新（DB 租约兜底）
      expect(b.accessToken).toBeTruthy();
      const rows = await prisma.credential.findMany({ where: { connectionId, type: 'access_token' } });
      expect(rows).toHaveLength(1); // 凭证行未被并发替换成多行
      expect(crypto.decrypt(rows[0].encryptedValue)).toBe(b.accessToken); // 双方拿到同一份新令牌
      const conn = await prisma.connection.findUnique({ where: { id: connectionId } });
      expect((conn!.metadata as Record<string, unknown> | null)?.refreshLeaseUntil).toBeUndefined(); // 租约已释放
    }, 40_000);
  });
});
