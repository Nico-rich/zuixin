import { Test } from '@nestjs/testing';
import { INestApplication, INestApplicationContext } from '@nestjs/common';
import request from 'supertest';
import cookieParser from 'cookie-parser';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { AppModule } from '../src/app.module';
import { WorkerModule } from '../src/worker.module';
import { GlobalExceptionFilter } from '../src/common/filters/global-exception.filter';
import { TransformInterceptor } from '../src/common/interceptors/transform.interceptor';
import { csrfProtection } from '../src/modules/auth/csrf.middleware';
import { PrismaService } from '../src/modules/prisma/prisma.service';
import { AgentRunLeaseService } from '../src/core/agent-run-lease/agent-run-lease.service';
import { AgentRunTimelineService } from '../src/modules/agent-runs/agent-run-timeline.service';

const XRW = { 'X-Requested-With': 'XMLHttpRequest' };

async function waitForStatus(prisma: PrismaService, runId: string, targets: string[], timeoutMs = 25_000): Promise<string> {
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

/** 等待 run 进入 waiting 并返回其 Approval 行（approve/reject/cancel 的测试前置） */
async function waitForPendingApproval(prisma: PrismaService, runId: string, timeoutMs = 25_000) {
  await waitForStatus(prisma, runId, ['waiting'], timeoutMs);
  const approval = await prisma.approval.findFirst({ where: { agentRunId: runId, status: 'requested' } });
  if (!approval) throw new Error(`run ${runId} waiting 但无 requested Approval 行`);
  return approval;
}

/**
 * M7-P1 Approval e2e（真实 PostgreSQL + Redis/BullMQ + Worker）：
 * approve 全链路（waiting → 审批 → 唤醒 resume → Tool 执行 → completed）；
 * reject 回喂；expire 兜底唤醒；重复 decide 幂等；cancel 审批/取消 run 附带清理；deadline-while-waiting；越权矩阵。
 */
describe('M7-P1 Approval / Human-in-the-loop (e2e, 真实 Queue + Worker)', () => {
  let app: INestApplication;
  let worker: INestApplicationContext;
  let prisma: PrismaService;
  let cookie: string;
  let cookieB: string;
  let userId = '';
  let demoAgentId = '';
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

    // 用户 B（越权矩阵）
    const userB = await prisma.user.create({ data: { email: `userb-p1-${Date.now()}@example.com`, passwordHash: 'unused-hash' } });
    const { JwtService } = await import('@nestjs/jwt');
    const jwt = moduleRef.get(JwtService);
    cookieB = `agent_access=${await jwt.signAsync({ sub: userB.id, role: 'user' })}`;

    // 专属 Agent：只含 external_action.demo 工具（不触碰 general-assistant 冻结配置）
    const agent = await prisma.agent.create({
      data: {
        slug: `approval-demo-${Date.now()}`, name: '审批演示 Agent', enabled: true, builtin: false, kind: 'custom', scope: 'system',
        versions: {
          create: {
            version: 1, status: 'published', systemPrompt: '你是审批演示助手', temperature: 0.7,
            tools: ['external_action.demo'] as never, config: { maxSteps: 4 } as never,
          },
        },
      },
      include: { versions: true },
    });
    demoAgentId = agent.id;
    await prisma.agent.update({ where: { id: agent.id }, data: { activeVersionId: agent.versions[0].id } });

    const { NestFactory } = await import('@nestjs/core');
    worker = await NestFactory.createApplicationContext(WorkerModule, { bufferLogs: false });
  });

  afterAll(async () => {
    if (createdRunIds.length) {
      // FK 顺序：Restrict 引用（GenerationTask/Artifact）→ 无 FK（usage）→ transcript → run（steps/toolCalls/approvals Cascade）
      await prisma.generationTask.deleteMany({ where: { runId: { in: createdRunIds } } });
      await prisma.artifact.deleteMany({ where: { runId: { in: createdRunIds } } });
      await prisma.usageRecord.deleteMany({ where: { runId: { in: createdRunIds } } });
      await prisma.agentRunMessage.deleteMany({ where: { runId: { in: createdRunIds } } });
      await prisma.agentRun.deleteMany({ where: { id: { in: createdRunIds } } });
    }
    if (demoAgentId) await prisma.agent.delete({ where: { id: demoAgentId } }).catch(() => undefined);
    await worker?.close().catch(() => undefined);
    await app.close();
  });

  it('P1 全链路 approve：waiting（waitingOnApprovalId + 释放 lease）→ approve → 唤醒 resume → Tool 执行 → completed（ToolCall 单行、Artifact 单件、usage 2 回合）', async () => {
    const res = await request(app.getHttpServer()).post('/api/v1/agent-runs').set(XRW).set('Cookie', cookie)
      .send({ agentId: demoAgentId, message: '请发布主图' })
      .expect(201);
    const runId = res.body.data.runId as string;
    createdRunIds.push(runId);

    // waiting：waitingOnApprovalId 指向 Approval；workerId/leaseUntil/heartbeatAt 全释放
    const approval = await waitForPendingApproval(prisma, runId);
    const waiting = await prisma.agentRun.findUnique({ where: { id: runId } });
    expect(waiting?.waitingOnApprovalId).toBe(approval.id);
    expect(waiting?.waitingOnTaskId).toBeNull();
    expect(waiting?.workerId).toBeNull();
    expect(waiting?.leaseUntil).toBeNull();
    expect(waiting?.heartbeatAt).toBeNull();
    // 未决前不写 tool 结果；ToolCall 行 waiting_approval
    const rowsWhileWaiting = await prisma.agentRunMessage.findMany({ where: { runId }, orderBy: { sequence: 'asc' } });
    expect(rowsWhileWaiting.some((r) => r.role === 'tool')).toBe(false);
    const toolCallRow = await prisma.toolCall.findFirst({ where: { runStep: { runId } } });
    expect(toolCallRow?.status).toBe('waiting_approval');
    expect(approval.riskLevel).toBe('high'); // external_action → high
    expect(approval.toolCallId).toBe(toolCallRow?.id);

    // Timeline 投影反映审批等待
    const timelineSvc = app.get(AgentRunTimelineService);
    const timelineWhileWaiting = await timelineSvc.build(userId, runId);
    expect(timelineWhileWaiting.items.some((i) => i.type === 'run.waiting')).toBe(true);
    expect(timelineWhileWaiting.items.some((i) => i.type === 'approval.requested')).toBe(true);
    expect(timelineWhileWaiting.items.some((i) => i.type === 'tool.completed')).toBe(false); // 未决无终态项

    // 列表可见
    const list = await request(app.getHttpServer()).get('/api/v1/approvals').set(XRW).set('Cookie', cookie).expect(200);
    expect((list.body.data as Array<{ id: string }>).some((a) => a.id === approval.id)).toBe(true);

    // approve → 唤醒 → resume → 执行 → completed
    await request(app.getHttpServer()).post(`/api/v1/approvals/${approval.id}/approve`).set(XRW).set('Cookie', cookie).expect(201);
    const finalStatus = await waitForStatus(prisma, runId, ['completed', 'failed', 'timeout'], 30_000);
    expect(finalStatus).toBe('completed');

    const run = await prisma.agentRun.findUnique({
      where: { id: runId },
      include: { messages: { orderBy: { sequence: 'asc' } }, steps: { include: { toolCalls: true } } },
    });
    expect(run?.waitingOnApprovalId).toBeNull(); // resume 后清空
    const decided = await prisma.approval.findUnique({ where: { id: approval.id } });
    expect(decided?.status).toBe('approved');
    expect(decided?.approvedAt).toBeTruthy();
    // ToolCall 单行：waiting_approval → completed（绝不新建行）
    const calls = await prisma.toolCall.findMany({ where: { runStep: { runId } } });
    expect(calls).toHaveLength(1);
    expect(calls[0].status).toBe('completed');
    expect(calls[0].output).toMatchObject({ executed: true });
    // Artifact 单件（执行证据；resume 幂等绝不重复）
    const artifacts = await prisma.artifact.findMany({ where: { runId } });
    expect(artifacts).toHaveLength(1);
    // tool 结果回喂 transcript
    const toolRow = run!.messages.find((m) => m.role === 'tool');
    expect(toolRow?.content).toContain('"executed":true');
    // usage：工具回合 + resume 后 final 回合 = 2，无重复计费
    expect(await prisma.usageRecord.count({ where: { runId, kind: 'llm_chat' } })).toBe(2);
    // Timeline：approval.approved + run.completed；waiting 瞬态消失
    const timeline = await timelineSvc.build(userId, runId);
    expect(timeline.items.some((i) => i.type === 'approval.approved')).toBe(true);
    expect(timeline.items.some((i) => i.type === 'run.completed')).toBe(true);
    expect(timeline.items.some((i) => i.type === 'run.waiting')).toBe(false);
  });

  it('P1 reject：失败回喂 LLM（ToolCall failed APPROVAL_REJECTED，无 Artifact，run 不直接 failed）', async () => {
    const res = await request(app.getHttpServer()).post('/api/v1/agent-runs').set(XRW).set('Cookie', cookie)
      .send({ agentId: demoAgentId, message: '请发布主图' })
      .expect(201);
    const runId = res.body.data.runId as string;
    createdRunIds.push(runId);

    const approval = await waitForPendingApproval(prisma, runId);
    await request(app.getHttpServer()).post(`/api/v1/approvals/${approval.id}/reject`).set(XRW).set('Cookie', cookie).expect(201);
    expect(await waitForStatus(prisma, runId, ['completed', 'failed', 'timeout'], 30_000)).toBe('completed');

    const calls = await prisma.toolCall.findMany({ where: { runStep: { runId } } });
    expect(calls).toHaveLength(1);
    expect(calls[0].status).toBe('failed');
    expect(calls[0].errorCode).toBe('APPROVAL_REJECTED');
    expect(await prisma.artifact.count({ where: { runId } })).toBe(0); // 绝不执行副作用
    const toolRow = await prisma.agentRunMessage.findFirst({ where: { runId, role: 'tool' } });
    expect(toolRow?.content).toContain('拒绝');
  });

  it('P1 过期：expiresAt 已过 → recoverStale 兜底 expire + 唤醒 → resume 失败回喂（APPROVAL_EXPIRED，绝不执行）', async () => {
    const res = await request(app.getHttpServer()).post('/api/v1/agent-runs').set(XRW).set('Cookie', cookie)
      .send({ agentId: demoAgentId, message: '请发布主图' })
      .expect(201);
    const runId = res.body.data.runId as string;
    createdRunIds.push(runId);

    const approval = await waitForPendingApproval(prisma, runId);
    // 制造过期（真实 expire 走 24h TTL，测试缩短时间窗）
    await prisma.approval.update({ where: { id: approval.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
    // 过期后 approve 必须 409（绝不执行）
    await request(app.getHttpServer()).post(`/api/v1/approvals/${approval.id}/approve`).set(XRW).set('Cookie', cookie).expect(409);
    expect((await prisma.approval.findUnique({ where: { id: approval.id } }))?.status).toBe('expired');

    // recoverStale 兜底：审批已终态但 run 仍 waiting → 唤醒
    const lease = worker.get(AgentRunLeaseService);
    await lease.recoverStale();
    expect(await waitForStatus(prisma, runId, ['completed', 'failed', 'timeout'], 30_000)).toBe('completed');
    const calls = await prisma.toolCall.findMany({ where: { runStep: { runId } } });
    expect(calls[0].status).toBe('failed');
    expect(calls[0].errorCode).toBe('APPROVAL_EXPIRED');
    expect(await prisma.artifact.count({ where: { runId } })).toBe(0);
  });

  it('P1 幂等/竞态：重复 approve → 409 APPROVAL_NOT_PENDING；仅一次 Tool 执行、一个 Artifact', async () => {
    const res = await request(app.getHttpServer()).post('/api/v1/agent-runs').set(XRW).set('Cookie', cookie)
      .send({ agentId: demoAgentId, message: '请发布主图' })
      .expect(201);
    const runId = res.body.data.runId as string;
    createdRunIds.push(runId);

    const approval = await waitForPendingApproval(prisma, runId);
    await request(app.getHttpServer()).post(`/api/v1/approvals/${approval.id}/approve`).set(XRW).set('Cookie', cookie).expect(201);
    await request(app.getHttpServer()).post(`/api/v1/approvals/${approval.id}/approve`).set(XRW).set('Cookie', cookie).expect(409);
    await request(app.getHttpServer()).post(`/api/v1/approvals/${approval.id}/reject`).set(XRW).set('Cookie', cookie).expect(409);
    expect(await waitForStatus(prisma, runId, ['completed'], 30_000)).toBe('completed');
    expect(await prisma.artifact.count({ where: { runId } })).toBe(1);
    expect(await prisma.toolCall.count({ where: { runStep: { runId } } })).toBe(1);
  });

  it('P1 cancel 审批：run 仍 waiting → cancelled + 唤醒 → 失败回喂（APPROVAL_CANCELLED）', async () => {
    const res = await request(app.getHttpServer()).post('/api/v1/agent-runs').set(XRW).set('Cookie', cookie)
      .send({ agentId: demoAgentId, message: '请发布主图' })
      .expect(201);
    const runId = res.body.data.runId as string;
    createdRunIds.push(runId);

    const approval = await waitForPendingApproval(prisma, runId);
    await request(app.getHttpServer()).post(`/api/v1/approvals/${approval.id}/cancel`).set(XRW).set('Cookie', cookie).expect(201);
    expect(await waitForStatus(prisma, runId, ['completed', 'failed', 'timeout'], 30_000)).toBe('completed');
    const calls = await prisma.toolCall.findMany({ where: { runStep: { runId } } });
    expect(calls[0].status).toBe('failed');
    expect(calls[0].errorCode).toBe('APPROVAL_CANCELLED');
  });

  it('P1 取消 run（waiting 审批中）→ run cancelled + Approval 附带 cancelled（绝不复活）', async () => {
    const res = await request(app.getHttpServer()).post('/api/v1/agent-runs').set(XRW).set('Cookie', cookie)
      .send({ agentId: demoAgentId, message: '请发布主图' })
      .expect(201);
    const runId = res.body.data.runId as string;
    createdRunIds.push(runId);

    const approval = await waitForPendingApproval(prisma, runId);
    await request(app.getHttpServer()).post(`/api/v1/agent-runs/${runId}/cancel`).set(XRW).set('Cookie', cookie).expect(201);
    expect((await prisma.approval.findUnique({ where: { id: approval.id } }))?.status).toBe('cancelled');
    expect((await prisma.agentRun.findUnique({ where: { id: runId } }))?.status).toBe('cancelled');
    // 终态后 wake 绝不复活
    const lease = worker.get(AgentRunLeaseService);
    await lease.recoverStale();
    expect((await prisma.agentRun.findUnique({ where: { id: runId } }))?.status).toBe('cancelled');
  });

  it('P1 deadline-while-waiting：审批到达但 deadline 已过 → approve 直接 timeout，绝不复活', async () => {
    const res = await request(app.getHttpServer()).post('/api/v1/agent-runs').set(XRW).set('Cookie', cookie)
      .send({ agentId: demoAgentId, message: '请发布主图' })
      .expect(201);
    const runId = res.body.data.runId as string;
    createdRunIds.push(runId);

    const approval = await waitForPendingApproval(prisma, runId);
    // 制造 deadline 已过（40min 默认上限）
    await prisma.agentRun.update({ where: { id: runId }, data: { startedAt: new Date(Date.now() - 50 * 60_000) } });
    await request(app.getHttpServer()).post(`/api/v1/approvals/${approval.id}/approve`).set(XRW).set('Cookie', cookie).expect(201);
    expect((await prisma.agentRun.findUnique({ where: { id: runId } }))?.status).toBe('timeout');
    expect(await prisma.artifact.count({ where: { runId } })).toBe(0);
  });

  it('P1 越权矩阵：他人 approval GET/approve → 404（防枚举）；匿名 → 401', async () => {
    const res = await request(app.getHttpServer()).post('/api/v1/agent-runs').set(XRW).set('Cookie', cookie)
      .send({ agentId: demoAgentId, message: '请发布主图' })
      .expect(201);
    const runId = res.body.data.runId as string;
    createdRunIds.push(runId);
    const approval = await waitForPendingApproval(prisma, runId);

    await request(app.getHttpServer()).get(`/api/v1/approvals/${approval.id}`).set(XRW).expect(401);
    await request(app.getHttpServer()).get(`/api/v1/approvals/${approval.id}`).set(XRW).set('Cookie', cookieB).expect(404);
    await request(app.getHttpServer()).post(`/api/v1/approvals/${approval.id}/approve`).set(XRW).set('Cookie', cookieB).expect(404);
    await request(app.getHttpServer()).post(`/api/v1/approvals/${approval.id}/reject`).set(XRW).set('Cookie', cookieB).expect(404);
    // 归属未被破坏：A 仍可 approve
    await request(app.getHttpServer()).post(`/api/v1/approvals/${approval.id}/approve`).set(XRW).set('Cookie', cookie).expect(201);
    expect(await waitForStatus(prisma, runId, ['completed'], 30_000)).toBe('completed');
  });
});
