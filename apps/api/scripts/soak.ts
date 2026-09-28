/**
 * M10-P17 长稳 soak（自实现：node:perf_hooks + fetch + 真实 DB/Redis/Worker）。
 *
 * 运行（必须在 apps/api 目录）：
 *   cd apps/api && npx tsx scripts/soak.ts            # 默认 30 分钟
 *   SOAK_MS=600000 npx tsx scripts/soak.ts            # 10 分钟
 *
 * 与 load-test.ts 的边界：load-test = 分钟级吞吐基线；本脚本 = 30 分钟级持续压测 +
 * 每 30s 采样（RSS 内存 / 队列深度 / 活跃 run 数）——用于暴露慢泄漏与长稳退化。
 * 诚实口径：本机 Docker PG/Redis + 进程内 Worker，绝对数字只在本机可比；是回归基线不是容量承诺。
 */
import '../src/env';
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
import { AgentRunStatus } from '@prisma/client';

const XRW = { 'X-Requested-With': 'XMLHttpRequest' };
const SOAK_MS = Number(process.env.SOAK_MS ?? 30 * 60_000);
const SAMPLE_INTERVAL_MS = 30_000;
const BURST_LIVE = 40; // 每采样周期对 /live 的请求数
const BURST_RUNS = 5;  // 每采样周期创建的 agent run 数
const TERMINAL: AgentRunStatus[] = ['completed', 'failed', 'timeout', 'cancelled'];
const PID = process.pid;

async function main() {
  const app = await NestFactory.create(AppModule, { logger: false });
  app.use(cookieParser());
  app.use('/api/v1', csrfProtection);
  app.setGlobalPrefix('api/v1');
  app.useGlobalFilters(app.get(GlobalExceptionFilter));
  app.useGlobalInterceptors(new TransformInterceptor());
  await app.listen(0);
  const base = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
  const worker = await NestFactory.createApplicationContext(WorkerModule, { logger: false });
  const prisma = app.get(PrismaService);
  const queue = new Queue(AGENT_RUN_QUEUE, {
    connection: { url: process.env.REDIS_URL ?? 'redis://localhost:6379', maxRetriesPerRequest: null },
  });

  const login = await fetch(`${base}/api/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...XRW },
    body: JSON.stringify({ email: process.env.SEED_ADMIN_EMAIL ?? 'admin@example.com', password: process.env.SEED_ADMIN_PASSWORD ?? 'admin123456' }),
  });
  if (!login.ok) throw new Error(`soak 登录失败 ${login.status}`);
  const setCookie = login.headers.get('set-cookie') ?? '';
  const cookie = setCookie.split(';')[0];
  const createdRunIds: string[] = [];

  const samples: Array<{ t: number; rssMb: number; queueDepth: number; activeRuns: number; liveErrors: number }> = [];
  const start = Date.now();
  console.log(`[soak] PID=${PID} 时长=${SOAK_MS}ms 采样周期=${SAMPLE_INTERVAL_MS}ms 每周期 live×${BURST_LIVE} run×${BURST_RUNS}`);

  let liveErrors = 0;
  let done = false;
  const timer = setTimeout(() => { done = true; }, SOAK_MS);

  while (!done) {
    const cycleStart = Date.now();
    // live 突发
    const live = await Promise.all(Array.from({ length: BURST_LIVE }, () =>
      fetch(`${base}/api/v1/live`).then((r) => { if (!r.ok) liveErrors++; }).catch(() => { liveErrors++; }),
    ));
    await Promise.all(live);
    // agent run 突发（终态轮询交给后台——soak 只观测创建成功率）
    const runs = await Promise.all(Array.from({ length: BURST_RUNS }, () =>
      fetch(`${base}/api/v1/agent-runs`, {
        method: 'POST', headers: { 'content-type': 'application/json', ...XRW, cookie },
        body: JSON.stringify({ message: `soak 探针 ${cycleStart}` }),
      }).then(async (r) => {
        if (!r.ok) { liveErrors++; return; }
        const body = (await r.json()) as { data: { runId: string } };
        createdRunIds.push(body.data.runId);
      }).catch(() => { liveErrors++; }),
    ));
    await Promise.all(runs);

    const rssMb = Math.round(process.memoryUsage().rss / 1024 / 1024);
    const counts = await queue.getJobCounts('waiting', 'active', 'paused').catch(() => null);
    const queueDepth = counts ? counts.waiting + counts.active + counts.paused : -1;
    const activeRuns = await prisma.agentRun.count({ where: { status: { in: ['queued', 'running', 'waiting'] } } }).catch(() => -1);
    samples.push({ t: Date.now() - start, rssMb, queueDepth, activeRuns, liveErrors });
    console.log(`[soak] t=${((Date.now() - start) / 1000).toFixed(0)}s rss=${rssMb}MB queue=${queueDepth} activeRuns=${activeRuns} errors=${liveErrors}`);

    const sleepMs = SAMPLE_INTERVAL_MS - (Date.now() - cycleStart);
    if (sleepMs > 0) await new Promise((r) => setTimeout(r, sleepMs));
  }
  clearTimeout(timer);

  // 终态收敛
  const drainDeadline = Date.now() + 60_000;
  let pending = createdRunIds.length;
  while (Date.now() < drainDeadline) {
    pending = await prisma.agentRun.count({ where: { id: { in: createdRunIds }, status: { notIn: TERMINAL } } });
    if (pending === 0) break;
    await new Promise((r) => setTimeout(r, 1000));
  }

  const samplesAfterWarmup = samples.slice(2); // 丢弃前两个周期（预热）
  const rssValues = samplesAfterWarmup.map((s) => s.rssMb);
  const result = {
    pid: PID,
    soakMs: SOAK_MS,
    createdRuns: createdRunIds.length,
    pendingAtEnd: pending,
    totalErrors: liveErrors,
    samples: samplesAfterWarmup.length,
    rssMb: {
      min: Math.min(...rssValues), max: Math.max(...rssValues),
      mean: Math.round(rssValues.reduce((a, b) => a + b, 0) / rssValues.length),
      firstAfterWarmup: rssValues[0] ?? -1, last: rssValues[rssValues.length - 1] ?? -1,
      // 慢泄漏判定：末值 - 预热后首值（正数 ≠ 泄漏；持续线性增长才可疑——由人工看 samples 序列）
      delta: (rssValues[rssValues.length - 1] ?? 0) - (rssValues[0] ?? 0),
    },
    maxQueueDepth: Math.max(...samplesAfterWarmup.map((s) => s.queueDepth)),
  };
  console.log('[soak] === /RESULT JSON ===');
  console.log(JSON.stringify(result, null, 2));

  // 清理本脚本创建的 run
  await prisma.agentRunMessage.deleteMany({ where: { runId: { in: createdRunIds } } }).catch(() => undefined);
  await prisma.usageRecord.deleteMany({ where: { runId: { in: createdRunIds } } }).catch(() => undefined);
  await prisma.agentRun.deleteMany({ where: { id: { in: createdRunIds } } }).catch(() => undefined);
  console.log(`[soak] 已清理 ${createdRunIds.length} 个 soak run`);

  await queue.close();
  await worker.close();
  await app.close();
  process.exit(0);
}

main().catch((err) => {
  console.error('[soak] FATAL', err);
  process.exit(1);
});
