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
import { DelegationService } from '../src/modules/agent-delegation/delegation.service';

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
 * M7-P7 Multi-Agent / Delegation e2e（真实 PostgreSQL + Redis/BullMQ + Worker）：
 * 全链路委派（子 run 血缘/深度/权限子集 → waiting → 子终态唤醒 → 结构化结果回喂）；
 * 子失败结构化回喂；级联取消；深度上限/环检测（服务层直连断言）。
 */
describe('M7-P7 Multi-Agent / Delegation (e2e, 真实 Queue + Worker)', () => {
  let app: INestApplication;
  let worker: INestApplicationContext;
  let prisma: PrismaService;
  let cookie: string;
  let userId = '';
  let parentAgentId = '';
  let parentVersionId = '';
  let childAgentId = '';
  let createdRunIds: string[] = [];

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

    // 父 Agent：含委派工具 + knowledge/image（权限超集）
    const parent = await prisma.agent.create({
      data: {
        slug: `parent-${Date.now()}`, name: '监督 Agent', enabled: true, builtin: false, kind: 'custom', scope: 'system',
        versions: {
          create: {
            version: 1, status: 'published', systemPrompt: '你是监督 Agent', temperature: 0.7,
            tools: ['agent.delegate', 'knowledge.search', 'image.generate'] as never,
            config: { maxSteps: 6 } as never,
          },
        },
      },
      include: { versions: true },
    });
    parentAgentId = parent.id;
    parentVersionId = parent.versions[0].id;
    await prisma.agent.update({ where: { id: parent.id }, data: { activeVersionId: parent.versions[0].id } });
    // 子 Agent：权限子集候选（父清单的子集 = 交集）
    const child = await prisma.agent.create({
      data: {
        slug: `child-${Date.now()}`, name: '评审 Agent', enabled: true, builtin: false, kind: 'custom', scope: 'system',
        versions: {
          create: {
            version: 1, status: 'published', systemPrompt: '你是评审 Agent', temperature: 0.7,
            tools: ['knowledge.search', 'image.generate'] as never,
            config: { maxSteps: 4 } as never,
          },
        },
      },
      include: { versions: true },
    });
    childAgentId = child.id;
    await prisma.agent.update({ where: { id: child.id }, data: { activeVersionId: child.versions[0].id } });

    const { NestFactory } = await import('@nestjs/core');
    worker = await NestFactory.createApplicationContext(WorkerModule, { bufferLogs: false });
  });

  afterAll(async () => {
    if (createdRunIds.length) {
      await prisma.generationTask.deleteMany({ where: { runId: { in: createdRunIds } } });
      await prisma.artifact.deleteMany({ where: { runId: { in: createdRunIds } } });
      await prisma.usageRecord.deleteMany({ where: { runId: { in: createdRunIds } } });
      await prisma.agentRunMessage.deleteMany({ where: { runId: { in: createdRunIds } } });
      await prisma.agentDelegation.deleteMany({ where: { OR: [{ parentRunId: { in: createdRunIds } }, { childRunId: { in: createdRunIds } }] } });
      await prisma.agentRun.deleteMany({ where: { id: { in: createdRunIds } } });
    }
    if (parentAgentId) await prisma.agent.delete({ where: { id: parentAgentId } }).catch(() => undefined);
    if (childAgentId) await prisma.agent.delete({ where: { id: childAgentId } }).catch(() => undefined);
    await worker?.close().catch(() => undefined);
    await app.close();
  });

  it('P7 全链路委派：LLM 委派 → 子 run（血缘/depth/权限子集）→ 父 waiting → 子终态唤醒 → 结构化结果回喂 → completed', async () => {
    const res = await request(app.getHttpServer()).post('/api/v1/agent-runs').set(XRW).set('Cookie', cookie)
      .send({ agentId: parentAgentId, message: '请委派一个子任务' })
      .expect(201);
    const runId = res.body.data.runId as string;
    createdRunIds.push(runId);

    // 父 waiting：waitingOnDelegationId 指向委派行；lease 释放
    await waitForStatus(prisma, runId, ['waiting'], 25_000);
    const waiting = await prisma.agentRun.findUnique({ where: { id: runId } });
    expect(waiting?.waitingOnDelegationId).toBeTruthy();
    expect(waiting?.workerId).toBeNull();

    const delegation = await prisma.agentDelegation.findUnique({ where: { id: waiting!.waitingOnDelegationId! } });
    expect(delegation).toBeTruthy();
    expect(delegation!.parentRunId).toBe(runId);
    expect(delegation!.delegatedByRunId).toBe(runId);
    expect(delegation!.depth).toBe(1);
    const childId = delegation!.childRunId;
    createdRunIds.push(childId);
    // 子 run 血缘 + 权限子集快照（交集 = 父与子版本工具的交集；缺省目标 = general-assistant）
    const child = await prisma.agentRun.findUnique({ where: { id: childId } });
    expect(child?.parentRunId).toBe(runId);
    expect(child?.depth).toBe(1);
    const childTools = (child?.metadata as { delegationTools?: string[] }).delegationTools ?? [];
    // 子集保证：全部落在父清单内（缺省子 Agent 的工具与父交集）
    expect(childTools.every((t) => ['agent.delegate', 'knowledge.search', 'image.generate'].includes(t))).toBe(true);
    expect(childTools).toContain('knowledge.search'); // 交集非空（权限子集已注入执行快照）

    // 子 run 自然完成（mock LLM 文本回复）→ 唤醒父 → 结构化结果回喂 → 父 completed
    expect(await waitForStatus(prisma, runId, ['completed', 'failed'], 30_000)).toBe('completed');
    expect((await prisma.agentDelegation.findUnique({ where: { id: delegation!.id } }))?.status).toBe('completed');
    const toolRow = await prisma.agentRunMessage.findFirst({ where: { runId, role: 'tool' } });
    expect(toolRow?.content).toContain(childId);
    expect(toolRow?.content).toContain('"status":"completed"'); // 结构化结果（非原始推理）
    // usage：父 = 委派回合 + final 回合（子独立计费）
    expect(await prisma.usageRecord.count({ where: { runId, kind: 'llm_chat' } })).toBe(2);
    expect(await prisma.usageRecord.count({ where: { runId: childId, kind: 'llm_chat' } })).toBe(1);
  });

  it('P7 子失败：结构化失败结果回喂父（父不直接 failed，由 LLM 决定）', async () => {
    // 构造崩溃现场：父 transcript 已有 assistant(tool_calls delegate) + running ToolCall 行 + 委派行（子已 failed 终态）
    const run = await prisma.agentRun.create({
      data: { userId, agentId: parentAgentId, agentVersionId: parentVersionId, status: 'queued', startedAt: new Date(), maxSteps: 8, metadata: {} },
    });
    createdRunIds.push(run.id);
    const step = await prisma.agentRunStep.create({
      data: { runId: run.id, stepIndex: 0, type: 'tool_call', status: 'running' },
    });
    const callArgs = '{"task":"请确认创意方向：黑金质感"}';
    const idempotencyKey = createHash('sha256').update(`${run.id}:${step.id}:0:agent.delegate:${callArgs}`).digest('hex');
    await prisma.agentRunMessage.createMany({
      data: [
        { runId: run.id, sequence: 0, role: 'user', content: '请委派一个子任务' },
        { runId: run.id, sequence: 1, role: 'assistant', content: '', toolCalls: [{ id: 'call_fail', name: 'agent.delegate', arguments: callArgs }] as never },
      ],
    });
    await prisma.toolCall.create({
      data: { runStepId: step.id, toolName: 'agent.delegate', idempotencyKey, input: JSON.parse(callArgs) as never, status: 'running' },
    });
    const child = await prisma.agentRun.create({
      data: {
        userId, agentId: childAgentId, status: 'failed', errorCode: 'AGENT_MAX_STEPS', errorMessage: '步骤耗尽',
        parentRunId: run.id, delegatedByRunId: run.id, depth: 1, startedAt: new Date(), completedAt: new Date(), maxSteps: 8, metadata: {},
      },
    });
    createdRunIds.push(child.id);
    await prisma.agentDelegation.create({
      data: { parentRunId: run.id, delegatedByRunId: run.id, childRunId: child.id, agentId: childAgentId, task: 'x', idempotencyKey, status: 'failed', depth: 1, errorCode: 'AGENT_MAX_STEPS', completedAt: new Date() },
    });

    const { Queue } = await import('bullmq');
    const q = new Queue('agent-run', { connection: { url: process.env.REDIS_URL ?? 'redis://localhost:6379', maxRetriesPerRequest: null } });
    await q.add('execute', { runId: run.id }, { attempts: 2, removeOnComplete: true, removeOnFail: { count: 500 } });
    await q.close();

    expect(await waitForStatus(prisma, run.id, ['completed', 'failed'], 30_000)).toBe('completed'); // 失败不直接 failed
    const toolRow = await prisma.agentRunMessage.findFirst({ where: { runId: run.id, role: 'tool' } });
    expect(toolRow?.content).toContain('"status":"failed"');
    expect(toolRow?.content).toContain('AGENT_MAX_STEPS');
    // 幂等：绝未重开第二个子 run
    expect(await prisma.agentDelegation.count({ where: { parentRunId: run.id } })).toBe(1);
  });

  it('P7 级联取消：父 cancelled → 子（queued/running/waiting）条件取消，绝不复活', async () => {
    // 构造：父 waiting + 委派行 + 子 queued（未入队）
    const parent = await prisma.agentRun.create({
      data: { userId, agentId: parentAgentId, agentVersionId: parentVersionId, status: 'waiting', startedAt: new Date(), maxSteps: 8, metadata: {} },
    });
    createdRunIds.push(parent.id);
    const child = await prisma.agentRun.create({
      data: { userId, agentId: childAgentId, status: 'queued', parentRunId: parent.id, delegatedByRunId: parent.id, depth: 1, startedAt: new Date(), maxSteps: 8, metadata: {} },
    });
    createdRunIds.push(child.id);
    const delegation = await prisma.agentDelegation.create({
      data: { parentRunId: parent.id, delegatedByRunId: parent.id, childRunId: child.id, agentId: childAgentId, task: 'x', idempotencyKey: `cancel-${Date.now()}`, status: 'queued', depth: 1 },
    });
    await prisma.agentRun.update({ where: { id: parent.id }, data: { waitingOnDelegationId: delegation.id } });

    await request(app.getHttpServer()).post(`/api/v1/agent-runs/${parent.id}/cancel`).set(XRW).set('Cookie', cookie).expect(201);
    expect((await prisma.agentRun.findUnique({ where: { id: child.id } }))?.status).toBe('cancelled');
    expect((await prisma.agentDelegation.findUnique({ where: { id: delegation.id } }))?.status).toBe('cancelled');
    expect((await prisma.agentRun.findUnique({ where: { id: parent.id } }))?.status).toBe('cancelled');
  });

  it('P7 深度上限：depth=3 的父再委派 → DELEGATION_DEPTH_EXCEEDED（服务层直连）', async () => {
    const parent = await prisma.agentRun.create({
      data: { userId, agentId: parentAgentId, agentVersionId: parentVersionId, status: 'completed', depth: 3, startedAt: new Date(), completedAt: new Date(), maxSteps: 8, metadata: {} },
    });
    createdRunIds.push(parent.id);
    const delegation = worker.get(DelegationService);
    await expect(delegation.delegate({
      userId, parentRunId: parent.id, idempotencyKey: `depth-${Date.now()}`, task: 'x',
    })).rejects.toMatchObject({ code: 'DELEGATION_DEPTH_EXCEEDED' });
  });

  it('P7 环检测：目标 Agent 已在血缘链（父自身同 Agent）→ DELEGATION_CYCLE', async () => {
    const parent = await prisma.agentRun.create({
      data: { userId, agentId: parentAgentId, agentVersionId: parentVersionId, status: 'completed', depth: 0, startedAt: new Date(), completedAt: new Date(), maxSteps: 8, metadata: {} },
    });
    createdRunIds.push(parent.id);
    const delegation = worker.get(DelegationService);
    await expect(delegation.delegate({
      userId, parentRunId: parent.id, idempotencyKey: `cycle-${Date.now()}`, task: 'x', agentId: parentAgentId,
    })).rejects.toMatchObject({ code: 'DELEGATION_CYCLE' });
  });
});
