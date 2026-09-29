/**
 * M8-P9 负载基准（**自实现，零外部压测框架**：只用 node:perf_hooks + fetch + 真实 DB/Redis/Worker）。
 *
 * 运行（必须在 apps/api 目录，.env 在仓库根）：
 *   cd apps/api && npx tsx scripts/load-test.ts
 *
 * 三项真实测量（**不是模拟流量**：真起 HTTP 服务、真入队、真跑 Worker、真写 DB）：
 *   ① HTTP 吞吐：50 并发 × 200 请求 GET /api/v1/live（另测 /ready 作为"含依赖探测"参考）
 *   ② Agent Run 并发：20 并发 POST /api/v1/agent-runs → 全部跑到终态，记录端到端分布
 *   ③ 队列吞吐：直接向 agent-run 队列投递 50 个真实 run job → 记录消费吞吐与单片执行时长
 *
 * 计时口径（诚实优先）：
 *   - 所有时长用 epoch ms（Date.now/completedAt）或 performance.now 单一口径，绝不混用；
 *   - 端到端 = 发起 → DB 终态（含入队/排队等待）；执行时长 = 终态 - 首个 step.startedAt（真干活的时间）；
 *   - 终态观测为 100ms 轮询粒度（报告已标注），因此端到端含 ≤100ms 观测误差。
 *
 * 环境：本机 Docker PostgreSQL/Redis + 本进程内 Worker——**绝对数字只在本机可比**，用途是
 * "回归基线 + 量级判断"，不是容量承诺（生产容量需按生产拓扑重跑）。
 */
import '../src/env';
import { assertProductionSafety } from '../src/modules/security/production-guards';
import { performance } from 'node:perf_hooks';
import { AddressInfo } from 'node:net';
import { NestFactory } from '@nestjs/core';
import cookieParser from 'cookie-parser';
import { Queue } from 'bullmq';
import { AppModule } from '../src/app.module';
import { WorkerModule } from '../src/worker.module';
import { GlobalExceptionFilter } from '../src/common/filters/global-exception.filter';
import { TransformInterceptor } from '../src/common/interceptors/transform.interceptor';
import { csrfProtection } from '../src/modules/auth/csrf.middleware';
import { PrismaService } from '../src/modules/prisma/prisma.service';
import { AGENT_RUN_QUEUE } from '../src/core/queue/queue.module';

const XRW = { 'X-Requested-With': 'XMLHttpRequest' };
const HTTP_CONCURRENCY = Number(process.env.LOAD_HTTP_CONCURRENCY ?? 50);
const HTTP_REQUESTS = Number(process.env.LOAD_HTTP_REQUESTS ?? 200);
const AGENT_RUN_CONCURRENCY = Number(process.env.LOAD_AGENT_RUN_CONCURRENCY ?? 20);
const QUEUE_JOBS = Number(process.env.LOAD_QUEUE_JOBS ?? 50);
const RUN_TIMEOUT_MS = Number(process.env.LOAD_RUN_TIMEOUT_MS ?? 300_000);
const TERMINAL = ['completed', 'failed', 'timeout', 'cancelled'];

interface Stats { count: number; errors: number; perSec: number; p50: number; p95: number; p99: number; min: number; max: number; mean: number }

const round = (n: number): number => Math.round(n * 100) / 100;

/** 最近邻百分位（nearest-rank）：不插值、不猜测——报的就是真实观测到的那个样本 */
function percentile(sorted: number[], p: number): number {
  if (!sorted.length) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return round(sorted[idx]);
}

function summarize(values: number[], elapsedMs: number, errors: number): Stats {
  const sorted = [...values].sort((a, b) => a - b);
  const sum = sorted.reduce((a, b) => a + b, 0);
  return {
    count: values.length, errors,
    perSec: round((values.length / elapsedMs) * 1000),
    p50: percentile(sorted, 50), p95: percentile(sorted, 95), p99: percentile(sorted, 99),
    min: round(sorted[0] ?? 0), max: round(sorted[sorted.length - 1] ?? 0),
    mean: round(sorted.length ? sum / sorted.length : 0),
  };
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function main(): Promise<void> {
  if (!process.env.DATABASE_URL) {
    console.error('[load-test] 未加载到 .env（DATABASE_URL 缺失）。请这样运行：cd apps/api && npx tsx scripts/load-test.ts');
    process.exit(1);
  }
  console.log(`[load-test] 开始 ${new Date().toISOString()} | HTTP ${HTTP_CONCURRENCY}×${HTTP_REQUESTS} | agent-run ${AGENT_RUN_CONCURRENCY} 并发 | 队列 ${QUEUE_JOBS} job`);

  const app = await NestFactory.create(AppModule, { logger: false, bufferLogs: false });
  app.use(cookieParser());
  app.use('/api/v1', csrfProtection);
  app.setGlobalPrefix('api/v1');
  app.useGlobalFilters(app.get(GlobalExceptionFilter));
  app.useGlobalInterceptors(new TransformInterceptor());
  await app.listen(0); // 随机端口：绝不占用开发实例的 3001
  const port = (app.getHttpServer().address() as AddressInfo).port;
  const base = `http://127.0.0.1:${port}`;
  const worker = await NestFactory.createApplicationContext(WorkerModule, { logger: false, bufferLogs: false });
  const prisma = app.get(PrismaService);
  const queue = new Queue(AGENT_RUN_QUEUE, { connection: { url: process.env.REDIS_URL ?? 'redis://localhost:6379', maxRetriesPerRequest: null } });
  const createdRunIds: string[] = [];
  const metricSampleIds: string[] = [];
  const agent = await prisma.agent.findFirstOrThrow({ where: { slug: 'general-assistant' }, include: { activeVersion: true } });
  const agentId = agent.id;
  const agentVersionId = agent.activeVersion!.id;

  try {
    // ===== 认证（真实登录 → 真实 cookie；密码绝不打印） =====
    const login = await fetch(`${base}/api/v1/auth/login`, {
      method: 'POST', headers: { 'content-type': 'application/json', ...XRW },
      body: JSON.stringify({
        email: process.env.SEED_ADMIN_EMAIL ?? 'admin@example.com',
        password: process.env.SEED_ADMIN_PASSWORD ?? 'admin123456',
      }),
    });
    if (!login.ok) throw new Error(`登录失败：HTTP ${login.status}`);
    const cookie = login.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
    const userId = ((await login.json()) as { data: { user: { id: string } } }).data.user.id;

    // ===== ① HTTP 吞吐 =====
    const live = await benchHttp(`${base}/api/v1/live`, HTTP_REQUESTS, HTTP_CONCURRENCY);
    const ready = await benchHttp(`${base}/api/v1/ready`, HTTP_REQUESTS, HTTP_CONCURRENCY);

    // ===== ② Agent Run 并发（真实 POST → 真实入队 → 真实 Worker 执行） =====
    const runStarts: Array<{ runId: string; t0: number }> = [];
    const postErrors: string[] = [];
    const epochStart2 = Date.now();
    const wallStart2 = performance.now();
    await Promise.all(Array.from({ length: AGENT_RUN_CONCURRENCY }, async () => {
      const t0 = Date.now(); // epoch 口径（与 DB completedAt 可直接相减）
      try {
        const res = await fetch(`${base}/api/v1/agent-runs`, {
          method: 'POST', headers: { 'content-type': 'application/json', ...XRW, cookie },
          body: JSON.stringify({ message: '你好' }),
        });
        const body = await res.json() as { data?: { runId?: string }; error?: { code?: string; message?: string } };
        if (res.status !== 201 || !body.data?.runId) postErrors.push(`HTTP ${res.status} ${body.error?.code ?? ''} ${body.error?.message ?? ''}`.trim());
        else { runStarts.push({ runId: body.data.runId, t0 }); createdRunIds.push(body.data.runId); }
      } catch (err) { postErrors.push((err as Error).message); }
    }));
    const postWallMs = performance.now() - wallStart2;
    const runTerminal = await waitTerminal(prisma, runStarts.map((r) => r.runId), RUN_TIMEOUT_MS);
    const runRows = await prisma.agentRun.findMany({ where: { id: { in: runStarts.map((r) => r.runId) } }, select: { id: true, completedAt: true } });
    const completedAtById = new Map(runRows.map((r) => [r.id, r.completedAt?.getTime() ?? 0]));
    const runE2e = runStarts.filter((r) => completedAtById.get(r.runId)).map((r) => completedAtById.get(r.runId)! - r.t0);
    const runExec = await measuredExecMs(prisma, runStarts.map((r) => r.runId), epochStart2);
    metricSampleIds.push(...runExec.sampleIds);
    const runWall = performance.now() - wallStart2;
    const runStats = summarize(runE2e, runWall, postErrors.length + (runStarts.length - runE2e.length));
    const runExecStats = summarize(runExec.values, runWall, runStarts.length - runExec.values.length);

    // ===== ③ 队列吞吐：直接投递 50 个真实 job（与 AgentRunsService 完全相同的 payload/选项） =====
    const rows = await Promise.all(Array.from({ length: QUEUE_JOBS }, () => prisma.agentRun.create({
      data: { userId, agentId, agentVersionId, status: 'queued', maxSteps: 8, metadata: {} },
      select: { id: true },
    })));
    const queuedIds = rows.map((r) => r.id);
    createdRunIds.push(...queuedIds);
    for (const id of queuedIds) await prisma.agentRunMessage.create({ data: { runId: id, sequence: 0, role: 'user', content: '你好' } });

    const queueT0 = Date.now(); // epoch：与 completedAt 同口径
    const enqueueStart = performance.now();
    await Promise.all(queuedIds.map((id) => queue.add(
      'execute', { runId: id },
      { jobId: `run-${id}`, attempts: 2, backoff: { type: 'exponential', delay: 2000 }, removeOnComplete: true, removeOnFail: { count: 500 } },
    )));
    const enqueueMs = performance.now() - enqueueStart;
    const queueTerminal = await waitTerminal(prisma, queuedIds, RUN_TIMEOUT_MS);
    const drainMs = Date.now() - queueT0;
    const queueRows = await prisma.agentRun.findMany({ where: { id: { in: queuedIds } }, select: { id: true, completedAt: true } });
    const qCompleted = new Map(queueRows.map((r) => [r.id, r.completedAt?.getTime() ?? 0]));
    const queueE2e = queueRows.filter((r) => qCompleted.get(r.id)).map((r) => qCompleted.get(r.id)! - queueT0);
    const queueExec = await measuredExecMs(prisma, queuedIds, queueT0);
    metricSampleIds.push(...queueExec.sampleIds);

    const summary = {
      ranAt: new Date().toISOString(),
      environment: {
        node: process.version,
        api: 'NestJS in-process（随机端口，仅本机回环）',
        worker: `in-process WorkerModule（AGENT_RUN_WORKER_CONCURRENCY=${process.env.AGENT_RUN_WORKER_CONCURRENCY ?? '2(默认)'}）`,
        db: '本机 Docker PostgreSQL（docker-postgres-1）',
        redis: '本机 Docker Redis（docker-redis-1）',
        llm: `mock provider：MOCK_DELAY_MS=${process.env.MOCK_DELAY_MS ?? '未设置'}（未设置时适配器默认 20ms/分块流式延迟，`
          + '长回复会被放大到秒级——**这是模拟的模型延迟，不是系统开销**；要测系统吞吐请用 MOCK_DELAY_MS=0 再跑一次）',
        note: '本机开发拓扑；绝对数字仅作回归基线，不是容量承诺',
      },
      httpLive: { url: 'GET /api/v1/live', concurrency: HTTP_CONCURRENCY, ...live },
      httpReady: { url: 'GET /api/v1/ready（含 DB+Redis+存储探测）', concurrency: HTTP_CONCURRENCY, ...ready },
      agentRunConcurrency: {
        requested: AGENT_RUN_CONCURRENCY, accepted: runStarts.length, postWallMs: round(postWallMs),
        httpErrors: postErrors.slice(0, 5), statusCounts: countBy([...runTerminal.values()]),
        e2eMs: runStats, execMs: runExecStats,
      },
      queueThroughput: {
        jobs: QUEUE_JOBS, enqueueMs: round(enqueueMs), drainMs,
        jobsPerSec: round((queueTerminal.size / drainMs) * 1000),
        statusCounts: countBy([...queueTerminal.values()]),
        e2eMs: summarize(queueE2e, drainMs, QUEUE_JOBS - queueTerminal.size),
        execMs: summarize(queueExec.values, drainMs, QUEUE_JOBS - queueExec.values.length),
      },
    };
    console.log('[load-test] === RESULT JSON ===');
    console.log(JSON.stringify(summary, null, 2));
    console.log('[load-test] === /RESULT JSON ===');
  } finally {
    // 清理：本次压测产生的 run 全删（绝不把压测数据留在开发库里）
    if (createdRunIds.length) {
      await prisma.generationTask.deleteMany({ where: { runId: { in: createdRunIds } } }).catch(() => undefined);
      await prisma.artifact.deleteMany({ where: { runId: { in: createdRunIds } } }).catch(() => undefined);
      await prisma.usageRecord.deleteMany({ where: { runId: { in: createdRunIds } } }).catch(() => undefined);
      await prisma.agentRunStep.deleteMany({ where: { runId: { in: createdRunIds } } }).catch(() => undefined);
      await prisma.agentRunMessage.deleteMany({ where: { runId: { in: createdRunIds } } }).catch(() => undefined);
      await prisma.agentRun.deleteMany({ where: { id: { in: createdRunIds } } }).catch(() => undefined);
      if (metricSampleIds.length) await prisma.metricSample.deleteMany({ where: { id: { in: metricSampleIds } } }).catch(() => undefined);
      console.log(`[load-test] 已清理 ${createdRunIds.length} 个压测 run（含 ${metricSampleIds.length} 条采样）`);
    }
    await queue.close().catch(() => undefined);
    await worker.close().catch(() => undefined);
    await app.close().catch(() => undefined);
  }
}

/** 定并发 HTTP 基准：concurrency 条流水线共发 total 个请求（真实读完整响应体，避免"未读 body"的乐观偏差） */
async function benchHttp(url: string, total: number, concurrency: number): Promise<Stats> {
  const latencies: number[] = [];
  let errors = 0;
  let issued = 0;
  const started = performance.now();
  await Promise.all(Array.from({ length: concurrency }, async () => {
    for (;;) {
      if (issued >= total) return;
      issued += 1;
      const t0 = performance.now();
      try {
        const res = await fetch(url);
        await res.arrayBuffer();
        if (!res.ok) errors += 1;
      } catch { errors += 1; }
      latencies.push(performance.now() - t0);
    }
  }));
  return summarize(latencies, performance.now() - started, errors);
}

/** 轮询到全部终态（100ms 粒度——报告里如实标注这是观测粒度） */
async function waitTerminal(prisma: PrismaService, ids: string[], timeoutMs: number): Promise<Map<string, string>> {
  const terminal = new Map<string, string>();
  if (!ids.length) return terminal;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const rows = await prisma.agentRun.findMany({ where: { id: { in: ids } }, select: { id: true, status: true } });
    for (const r of rows) if (TERMINAL.includes(r.status)) terminal.set(r.id, r.status);
    if (terminal.size === ids.length) return terminal;
    await sleep(100);
  }
  return terminal;
}

/**
 * 真实执行时长：直接读 Worker 自己的采样（M8-P3 `agent_run_duration_ms`，
 * 口径 = claim 成功 → 执行结束，由 processor 在 finally 里写入 metricSample）。
 * **不推算、不假设**：读不到样本的 run 计入 errors 字段而不是补 0。
 */
async function measuredExecMs(prisma: PrismaService, ids: string[], sinceEpochMs: number): Promise<{ values: number[]; sampleIds: string[] }> {
  if (!ids.length) return { values: [], sampleIds: [] };
  const idSet = new Set(ids);
  const found = new Map<string, { id: string; value: number }>();
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const rows = await prisma.metricSample.findMany({
      // 2s 容差：sampledAt 由 DB 生成，与本机时钟可能有毫秒级偏差（绝不因边界抖动丢样本）
      where: { name: 'agent_run_duration_ms', sampledAt: { gte: new Date(sinceEpochMs - 2_000) } },
      select: { id: true, value: true, labels: true },
    });
    for (const r of rows) {
      const runId = (r.labels as { runId?: string } | null)?.runId;
      if (runId && idSet.has(runId) && !found.has(runId)) found.set(runId, { id: r.id, value: r.value });
    }
    // run 终态先落库、采样在 processor 的 finally 里随后写入 → 允许有界追平（最多 5s）
    if (found.size >= idSet.size) break;
    await sleep(200);
  }
  return { values: [...found.values()].map((v) => v.value), sampleIds: [...found.values()].map((v) => v.id) };
}

function countBy(values: string[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const v of values) out[v] = (out[v] ?? 0) + 1;
  return out;
}

void main().catch((err) => {
  console.error('[load-test] 失败：', err);
  process.exit(1);
});
