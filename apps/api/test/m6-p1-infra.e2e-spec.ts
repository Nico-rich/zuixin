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
import { MediaCleanupService } from '../src/modules/generations/media-cleanup.service';
import { AgentRunMessagesService } from '../src/modules/agent-runs/agent-run-messages.service';

const XRW = { 'X-Requested-With': 'XMLHttpRequest' };

/**
 * M6-P1 基础设施 e2e（migration smoke + 数据层语义，真库验证）：
 * ① waiting 枚举与 lease/retry 字段可用；② terminal 不可被 sweep 复活；③ sweep 不误杀 async run（A2）；
 * ④ transcript CRUD/reconstruction/UNIQUE(runId,sequence)；⑤ IDOR（userId 首条件）；⑥ retryOfRunId FK 生效。
 */
describe('M6-P1 基础设施 (e2e, migration smoke)', () => {
  let app: INestApplication;
  let userId = '';
  let agentId = '';
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
    const login = await request(app.getHttpServer()).post('/api/v1/auth/login').set(XRW)
      .send({ email: process.env.SEED_ADMIN_EMAIL ?? 'admin@example.com', password: process.env.SEED_ADMIN_PASSWORD ?? 'admin123456' });
    userId = login.body.data.user.id;
    const prisma = moduleRef.get(PrismaService);
    agentId = (await prisma.agent.findFirst())!.id;
  });

  afterAll(async () => {
    const prisma = app.get(PrismaService);
    await prisma.agentRunMessage.deleteMany({ where: { runId: { in: createdRunIds } } });
    await prisma.agentRun.deleteMany({ where: { id: { in: createdRunIds } } });
    await app.close();
  });

  it('waiting 枚举 + lease/heartbeat/retry 字段可写可读（迁移生效）', async () => {
    const prisma = app.get(PrismaService);
    const runA = await prisma.agentRun.create({
      data: {
        userId, agentId, status: 'waiting',
        workerId: 'worker-1', leaseUntil: new Date(Date.now() + 60_000), heartbeatAt: new Date(),
      },
    });
    createdRunIds.push(runA.id);
    expect(runA.status).toBe('waiting');
    expect(runA.workerId).toBe('worker-1');
    expect(runA.attempt).toBe(1);

    const runB = await prisma.agentRun.create({
      data: { userId, agentId, status: 'completed', retryOfRunId: runA.id, attempt: 2 },
    });
    createdRunIds.push(runB.id);
    expect(runB.retryOfRunId).toBe(runA.id);
    expect(runB.attempt).toBe(2);

    // FK 生效：非法 retryOfRunId → 外键违反
    await expect(
      prisma.agentRun.create({ data: { userId, agentId, retryOfRunId: '0'.repeat(32) } }),
    ).rejects.toMatchObject({ code: 'P2003' });
  });

  it('M6-A2：sweep 不误杀 async run（workerId 非空）；同步 run 保持原 120s 语义', async () => {
    const prisma = app.get(PrismaService);
    const cleanup = app.get(MediaCleanupService);
    const old = new Date(Date.now() - 10 * 60_000);

    const asyncRun = await prisma.agentRun.create({
      data: { userId, agentId, status: 'running', workerId: 'worker-x', leaseUntil: new Date(Date.now() - 30_000), startedAt: old },
    });
    const syncRun = await prisma.agentRun.create({
      data: { userId, agentId, status: 'running', startedAt: old },
    });
    const waitingRun = await prisma.agentRun.create({
      data: { userId, agentId, status: 'waiting', startedAt: old },
    });
    createdRunIds.push(asyncRun.id, syncRun.id, waitingRun.id);

    await cleanup.sweepAgentRuns();

    expect((await prisma.agentRun.findUnique({ where: { id: asyncRun.id } }))?.status).toBe('running');   // 绝不误杀 async
    expect((await prisma.agentRun.findUnique({ where: { id: waitingRun.id } }))?.status).toBe('waiting'); // waiting 不在清扫域
    expect((await prisma.agentRun.findUnique({ where: { id: syncRun.id } }))?.status).toBe('timeout');    // 同步语义不变
  });

  it('terminal 不可 reopen：sweep 条件更新绝不复活终态 run', async () => {
    const prisma = app.get(PrismaService);
    const cleanup = app.get(MediaCleanupService);
    const completedRun = await prisma.agentRun.create({
      data: { userId, agentId, status: 'completed', startedAt: new Date(Date.now() - 10 * 60_000) },
    });
    createdRunIds.push(completedRun.id);

    await cleanup.sweepAgentRuns();
    expect((await prisma.agentRun.findUnique({ where: { id: completedRun.id } }))?.status).toBe('completed');
  });

  it('transcript：CRUD + reconstruction（合法 tool-calling 序列完整恢复）+ UNIQUE(runId,sequence)', async () => {
    const prisma = app.get(PrismaService);
    const messages = app.get(AgentRunMessagesService);
    const run = await prisma.agentRun.create({ data: { userId, agentId, status: 'running' } });
    createdRunIds.push(run.id);

    await messages.append(userId, run.id, { role: 'system', content: 'S' });
    await messages.append(userId, run.id, { role: 'user', content: '画一张黑金配色主图' });
    await messages.append(userId, run.id, { role: 'assistant', content: '', toolCalls: [{ id: 'call-1', name: 'image.generate', arguments: '{}' }] });
    await messages.append(userId, run.id, { role: 'tool', content: '{"taskId":"t-1"}', toolCallId: 'call-1' });

    const replay = await messages.list(userId, run.id);
    expect(replay.map((r) => r.sequence)).toEqual([0, 1, 2, 3]);
    expect(replay[2].role).toBe('assistant');
    expect((replay[2].toolCalls as Array<{ id: string }>)[0].id).toBe('call-1');
    expect(replay[3]).toMatchObject({ role: 'tool', toolCallId: 'call-1' });

    // 数据库层唯一约束：同 (runId, sequence) 二次插入 → P2002
    await expect(
      prisma.agentRunMessage.create({ data: { runId: run.id, sequence: 0, role: 'system', content: 'dup' } }),
    ).rejects.toMatchObject({ code: 'P2002' });
  });

  it('IDOR：非本人 run 的 transcript append/list → NOT_FOUND', async () => {
    const prisma = app.get(PrismaService);
    const messages = app.get(AgentRunMessagesService);
    const run = await prisma.agentRun.create({ data: { userId, agentId, status: 'running' } });
    createdRunIds.push(run.id);

    await expect(messages.append('other-user-id', run.id, { role: 'user', content: 'x' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(messages.list('other-user-id', run.id)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});
