import { Test } from '@nestjs/testing';
import { INestApplication, INestApplicationContext } from '@nestjs/common';
import request from 'supertest';
import cookieParser from 'cookie-parser';
import { createHash } from 'node:crypto';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { AppModule } from '../src/app.module';
import { WorkerModule } from '../src/worker.module';
import { GlobalExceptionFilter } from '../src/common/filters/global-exception.filter';
import { TransformInterceptor } from '../src/common/interceptors/transform.interceptor';
import { csrfProtection } from '../src/modules/auth/csrf.middleware';
import { PrismaService } from '../src/modules/prisma/prisma.service';
import { bindPayload } from '../src/modules/approvals/approval-binding';

const XRW = { 'X-Requested-With': 'XMLHttpRequest' };

async function waitForStatus(prisma: PrismaService, runId: string, targets: string[], timeoutMs = 30_000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  let last = '';
  while (Date.now() < deadline) {
    const run = await prisma.agentRun.findUnique({ where: { id: runId } });
    last = run?.status ?? 'missing';
    if (run && targets.includes(run.status)) return run.status;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`run ${runId} 未在 ${timeoutMs}ms 内到达 ${targets.join('/')}（当前 ${last}）`);
}

/**
 * M7-P3 External Action e2e（真实 PostgreSQL + Redis/BullMQ + Worker + mock 连接）：
 * 全链路（审批 → resume → Adapter 执行 → 审计行）；reject 零副作用；failure/timeout/retry 向量；
 * 崩溃残留 executing 行幂等续跑；连接吊销；越权矩阵；无连接失败路径。
 */
describe('M7-P3 External Action (e2e, 真实 Queue + Worker + mock provider)', () => {
  let app: INestApplication;
  let worker: INestApplicationContext;
  let prisma: PrismaService;
  let cookie: string;
  let cookieB: string;
  let userId = '';
  let demoAgentId = '';
  let demoVersionId = '';
  let createdRunIds: string[] = [];
  let connectionId = '';

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

    const login = await request(app.getHttpServer()).post('/api/v1/auth/login').set(XRW)
      .send({ email: process.env.SEED_ADMIN_EMAIL ?? 'admin@example.com', password: process.env.SEED_ADMIN_PASSWORD ?? 'admin123456' });
    cookie = (login.headers['set-cookie'] as unknown as string[]).map((c) => c.split(';')[0]).join('; ');
    userId = login.body.data.user.id;

    const userB = await prisma.user.create({ data: { email: `userb-p3-${Date.now()}@example.com`, passwordHash: 'unused-hash' } });
    const { JwtService } = await import('@nestjs/jwt');
    const jwt = moduleRef.get(JwtService);
    cookieB = `agent_access=${await jwt.signAsync({ sub: userB.id, role: 'user' })}`;

    // mock 连接（OAuth 全链路，P2 API）
    const start = await request(app.getHttpServer()).post('/api/v1/connections/mock/start').set(XRW).set('Cookie', cookie).send({}).expect(201);
    const cb = await request(app.getHttpServer()).get('/api/v1/connections/mock/callback').set(XRW).set('Cookie', cookie)
      .query({ state: start.body.data.state, code: 'p3-conn' }).expect(200);
    connectionId = cb.body.data.id;

    // 专属 Agent：只含 external_action.execute
    const agent = await prisma.agent.create({
      data: {
        slug: `ext-action-${Date.now()}`, name: '外部动作演示 Agent', enabled: true, builtin: false, kind: 'custom', scope: 'system',
        versions: {
          create: {
            version: 1, status: 'published', systemPrompt: '你是外部动作演示助手', temperature: 0.7,
            tools: ['external_action.execute'] as never, config: { maxSteps: 4 } as never,
          },
        },
      },
      include: { versions: true },
    });
    demoAgentId = agent.id;
    demoVersionId = agent.versions[0].id;
    await prisma.agent.update({ where: { id: agent.id }, data: { activeVersionId: agent.versions[0].id } });

    const { NestFactory } = await import('@nestjs/core');
    worker = await NestFactory.createApplicationContext(WorkerModule, { bufferLogs: false });
  });

  afterAll(async () => {
    if (createdRunIds.length) {
      await prisma.generationTask.deleteMany({ where: { runId: { in: createdRunIds } } });
      await prisma.artifact.deleteMany({ where: { runId: { in: createdRunIds } } });
      await prisma.usageRecord.deleteMany({ where: { runId: { in: createdRunIds } } });
      await prisma.agentRunMessage.deleteMany({ where: { runId: { in: createdRunIds } } });
      await prisma.externalAction.deleteMany({ where: { agentRunId: { in: createdRunIds } } });
      await prisma.agentRun.deleteMany({ where: { id: { in: createdRunIds } } });
    }
    await prisma.credential.deleteMany({ where: { connectionId } });
    await prisma.connection.deleteMany({ where: { id: connectionId } });
    if (demoAgentId) await prisma.agent.delete({ where: { id: demoAgentId } }).catch(() => undefined);
    await worker?.close().catch(() => undefined);
    await app.close();
  });

  /** 崩溃现场：transcript 已含 assistant(tool_calls) + waiting_approval ToolCall 行 + approved Approval（resume 直通执行） */
  async function fabricateRun(actionType: string, extraArgs: Record<string, unknown> = {}, tamper = false): Promise<{ runId: string; idempotencyKey: string }> {
    const run = await prisma.agentRun.create({
      data: { userId, agentId: demoAgentId, agentVersionId: demoVersionId, status: 'queued', startedAt: new Date(), maxSteps: 8, metadata: {} },
    });
    createdRunIds.push(run.id);
    const step = await prisma.agentRunStep.create({
      data: { runId: run.id, stepIndex: 0, type: 'tool_call', status: 'running' },
    });
    const callArgs = JSON.stringify({ actionType, payload: { title: '主图' }, ...extraArgs });
    const idempotencyKey = createHash('sha256').update(`${run.id}:${step.id}:0:external_action.execute:${callArgs}`).digest('hex');
    await prisma.agentRunMessage.createMany({
      data: [
        { runId: run.id, sequence: 0, role: 'user', content: '请发布到店铺' },
        { runId: run.id, sequence: 1, role: 'assistant', content: '', toolCalls: [{ id: `call_${actionType}`, name: 'external_action.execute', arguments: callArgs }] as never },
      ],
    });
    const toolCall = await prisma.toolCall.create({
      data: { runStepId: step.id, toolName: 'external_action.execute', idempotencyKey, input: JSON.parse(callArgs) as never, status: 'waiting_approval' },
    });
    await prisma.approval.create({
      data: {
        userId, agentRunId: run.id, toolCallId: toolCall.id, status: 'approved', riskLevel: 'high', reason: '测试', approvedAt: new Date(),
        // Pre-M9 Approval Binding：引擎审批门落库时按 (工具名, 工具入参) 绑定 —— 崩溃现场必须与生产同形，
        // 否则执行链会（正确地）以 APPROVAL_BINDING_MISMATCH 拒绝执行。tamper=true 模拟"审批被绑定到别的动作"。
        payload: (tamper
          ? bindPayload({ toolName: 'external_action.execute', input: { actionType, payload: { title: '别的载荷' } } }, 'external_action.execute', { actionType, payload: { title: '别的载荷' } })
          : bindPayload({ toolName: 'external_action.execute', input: JSON.parse(callArgs) }, 'external_action.execute', JSON.parse(callArgs))) as never,
      },
    });
    return { runId: run.id, idempotencyKey };
  }

  async function enqueue(runId: string): Promise<void> {
    const { Queue } = await import('bullmq');
    const q = new Queue('agent-run', { connection: { url: process.env.REDIS_URL ?? 'redis://localhost:6379', maxRetriesPerRequest: null } });
    await q.add('execute', { runId }, { attempts: 2, removeOnComplete: true, removeOnFail: { count: 500 } });
    await q.close();
  }

  it('P3 全链路：LLM → 审批 waiting → approve → resume → Adapter 执行 → ExternalAction completed + 审计绑定', async () => {
    const res = await request(app.getHttpServer()).post('/api/v1/agent-runs').set(XRW).set('Cookie', cookie)
      .send({ agentId: demoAgentId, message: '请发布到店铺' })
      .expect(201);
    const runId = res.body.data.runId as string;
    createdRunIds.push(runId);

    // waiting + 审批
    await waitForStatus(prisma, runId, ['waiting'], 25_000);
    const approval = await prisma.approval.findFirst({ where: { agentRunId: runId, status: 'requested' } });
    expect(approval).toBeTruthy();
    await request(app.getHttpServer()).post(`/api/v1/approvals/${approval!.id}/approve`).set(XRW).set('Cookie', cookie).expect(201);

    expect(await waitForStatus(prisma, runId, ['completed', 'failed'], 30_000)).toBe('completed');

    const action = await prisma.externalAction.findFirst({ where: { agentRunId: runId } });
    expect(action).toBeTruthy();
    expect(action!.status).toBe('completed');
    expect(action!.approvalId).toBe(approval!.id);       // 审批绑定
    // 连接绑定：默认解析 = 用户该 provider 的 active 连接（不绑定具体 id——历史残留连接可作默认目标）
    expect(action!.connectionId).toBeTruthy();
    expect(await prisma.connection.findFirst({ where: { id: action!.connectionId!, userId, status: 'active' } })).toBeTruthy();
    expect(action!.externalRequestId).toBeTruthy();       // 远端幂等键
    expect(action!.permission).toBe('external_action');
    expect(action!.result).toMatchObject({ ok: true });
    // input 不含凭证（服务端注入的 accessToken 从未进库）
    expect(JSON.stringify(action!.input)).not.toContain('mock_access');
    // ToolCall 行 completed（同行走完终态）
    const toolCall = await prisma.toolCall.findFirst({ where: { runStep: { runId } } });
    expect(toolCall?.status).toBe('completed');
    // 审计读取面
    const got = await request(app.getHttpServer()).get(`/api/v1/external-actions/${action!.id}`).set(XRW).set('Cookie', cookie).expect(200);
    expect(got.body.data.status).toBe('completed');
    const list = await request(app.getHttpServer()).get(`/api/v1/external-actions?agentRunId=${runId}`).set(XRW).set('Cookie', cookie).expect(200);
    expect((list.body.data as Array<{ id: string }>).some((a) => a.id === action!.id)).toBe(true);
  });

  it('P3 reject：绝不创建 ExternalAction（零副作用）', async () => {
    const res = await request(app.getHttpServer()).post('/api/v1/agent-runs').set(XRW).set('Cookie', cookie)
      .send({ agentId: demoAgentId, message: '请发布到店铺' })
      .expect(201);
    const runId = res.body.data.runId as string;
    createdRunIds.push(runId);
    await waitForStatus(prisma, runId, ['waiting'], 25_000);
    const approval = await prisma.approval.findFirst({ where: { agentRunId: runId, status: 'requested' } });
    await request(app.getHttpServer()).post(`/api/v1/approvals/${approval!.id}/reject`).set(XRW).set('Cookie', cookie).expect(201);
    expect(await waitForStatus(prisma, runId, ['completed', 'failed'], 30_000)).toBe('completed');
    expect(await prisma.externalAction.count({ where: { agentRunId: runId } })).toBe(0);
  });

  it('Pre-M9 Binding：审批绑定到别的动作（批准 A、执行 B）→ 拒绝执行 + 零 ExternalAction 行', async () => {
    const { runId } = await fabricateRun('success', {}, true); // tamper：审批的 __binding 绑定的是另一个载荷
    await enqueue(runId);
    expect(await waitForStatus(prisma, runId, ['completed', 'failed'], 30_000)).toBe('completed');
    // 零副作用：绝无 ExternalAction 行（既未创建也未执行）
    expect(await prisma.externalAction.count({ where: { agentRunId: runId } })).toBe(0);
    // 失败事实回喂：ToolCall 行 failed(APPROVAL_BINDING_MISMATCH)
    const toolRow = await prisma.toolCall.findFirst({ where: { runStep: { runId } } });
    expect(toolRow?.status).toBe('failed');
    expect(toolRow?.errorCode).toBe('APPROVAL_BINDING_MISMATCH');
  });

  it('P3 failure 向量：resume 直通执行 → Adapter 失败 → 行 failed(PROVIDER_UNKNOWN) → 失败回喂 LLM（run 不直接 failed）', async () => {
    const { runId } = await fabricateRun('failure');
    await enqueue(runId);
    expect(await waitForStatus(prisma, runId, ['completed', 'failed'], 30_000)).toBe('completed');
    const action = await prisma.externalAction.findFirst({ where: { agentRunId: runId } });
    expect(action?.status).toBe('failed');
    expect(action?.errorCode).toBe('PROVIDER_UNKNOWN');
    const toolRow = await prisma.agentRunMessage.findFirst({ where: { runId, role: 'tool' } });
    expect(toolRow?.content).toContain('外部执行失败');
  });

  it('P3 retry 向量：瞬时超时 → tool retryPolicy 重试（同一 externalRequestId）→ 成功（attempts=2，行单条）', async () => {
    const { runId } = await fabricateRun('retry');
    await enqueue(runId);
    expect(await waitForStatus(prisma, runId, ['completed', 'failed'], 30_000)).toBe('completed');
    const action = await prisma.externalAction.findFirst({ where: { agentRunId: runId } });
    expect(action?.status).toBe('completed');
    expect(action?.result).toMatchObject({ retried: true }); // 同 requestId 第二次调用成功
    expect(await prisma.externalAction.count({ where: { agentRunId: runId } })).toBe(1); // 幂等键单行
    const toolCall = await prisma.toolCall.findFirst({ where: { runStep: { runId } } });
    expect(toolCall?.attempts).toBe(2); // 同一 ToolCall 行内重试可观测
  });

  it('P3 timeout 向量：重试耗尽 → 行 failed(PROVIDER_TIMEOUT) + 回喂', async () => {
    const { runId } = await fabricateRun('timeout');
    await enqueue(runId);
    expect(await waitForStatus(prisma, runId, ['completed', 'failed'], 30_000)).toBe('completed');
    const action = await prisma.externalAction.findFirst({ where: { agentRunId: runId } });
    expect(action?.status).toBe('failed');
    expect(action?.errorCode).toBe('PROVIDER_TIMEOUT');
  });

  it('P3 崩溃残留幂等：executing 行 + externalRequestId → resume 复用同一行续跑（不建第二行，同键重调）', async () => {
    const { runId, idempotencyKey } = await fabricateRun('success');
    // 构造执行中崩溃残留（executing + externalRequestId）
    const step = await prisma.agentRunStep.findFirst({ where: { runId, stepIndex: 0 } });
    const toolCall = await prisma.toolCall.findFirst({ where: { runStepId: step!.id } });
    await prisma.externalAction.create({
      data: {
        userId, agentRunId: runId, toolCallId: toolCall!.id, approvalId: (await prisma.approval.findFirst({ where: { toolCallId: toolCall!.id } }))!.id,
        provider: 'mock', actionType: 'success', permission: 'external_action', riskLevel: 'high',
        input: {} as never, status: 'executing', externalRequestId: 'req-crash-1', idempotencyKey,
        startedAt: new Date(),
      },
    });
    await enqueue(runId);
    expect(await waitForStatus(prisma, runId, ['completed', 'failed'], 30_000)).toBe('completed');
    expect(await prisma.externalAction.count({ where: { agentRunId: runId } })).toBe(1); // 绝不建第二行
    const action = await prisma.externalAction.findFirst({ where: { agentRunId: runId } });
    expect(action?.status).toBe('completed');
    expect(action?.externalRequestId).toBe('req-crash-1'); // 同一幂等键续跑
  });

  it('P3 连接吊销：execute 前校验 → CONNECTION_REVOKED 回喂，无执行', async () => {
    // 显式 connectionId（不依赖默认连接解析，隔离历史残留连接的干扰）
    const { runId } = await fabricateRun('success', { connectionId });
    await request(app.getHttpServer()).post(`/api/v1/connections/${connectionId}/revoke`).set(XRW).set('Cookie', cookie).expect(201);
    await enqueue(runId);
    expect(await waitForStatus(prisma, runId, ['completed', 'failed'], 30_000)).toBe('completed');
    const toolRow = await prisma.agentRunMessage.findFirst({ where: { runId, role: 'tool' } });
    expect(toolRow?.content).toContain('吊销');
    expect(await prisma.externalAction.count({ where: { agentRunId: runId } })).toBe(0);
    // 恢复连接（reconnect）供后续用例
    const start = await request(app.getHttpServer()).post('/api/v1/connections/mock/start').set(XRW).set('Cookie', cookie).send({}).expect(201);
    await request(app.getHttpServer()).get('/api/v1/connections/mock/callback').set(XRW).set('Cookie', cookie)
      .query({ state: start.body.data.state, code: 'p3-conn' }).expect(200);
  });

  it('P3 越权矩阵：他人 external-actions 读 → 404；匿名 401', async () => {
    const { runId } = await fabricateRun('success');
    await enqueue(runId);
    expect(await waitForStatus(prisma, runId, ['completed', 'failed'], 30_000)).toBe('completed');
    const action = await prisma.externalAction.findFirst({ where: { agentRunId: runId } });
    await request(app.getHttpServer()).get(`/api/v1/external-actions/${action!.id}`).set(XRW).expect(401);
    await request(app.getHttpServer()).get(`/api/v1/external-actions/${action!.id}`).set(XRW).set('Cookie', cookieB).expect(404);
  });
});
