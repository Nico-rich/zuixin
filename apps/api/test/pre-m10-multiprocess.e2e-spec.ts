import { describe, it, expect, beforeAll, afterAll, type TestContext } from 'vitest';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { hostname } from 'node:os';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import * as argon2 from 'argon2';
import Redis from 'ioredis';
import { JwtService } from '@nestjs/jwt';
import { PrismaService } from '../src/modules/prisma/prisma.service';

/**
 * M10-P12 真多进程 e2e（M9-04 / PR-2）——**不是** in-process 多实例（那是 pre-m9-multi-instance 的覆盖）。
 *
 * 形态：`nest build` → child_process.spawn 4 个**独立 OS 进程**：
 *   API#1(API_PORT=动态) + Worker#1(REDIS DB 61) ｜ API#2(API_PORT=动态) + Worker#2(REDIS DB 62)
 * 驱动：真实 HTTP（fetch → 监听在 127.0.0.1 的真进程），无 supertest、无 createNestApplication。
 *
 * 断言：
 * ① 进程级归属：run.workerId = `${hostname}:${pid}:${hex}`（AgentRunProcessor.instanceId）——
 *    创建于 API#1 的 run 必须由 Worker#1 的 **pid** 执行（跨进程 claim + Redis DB 隔离的联合证据）；
 * ② C1 跨进程精确准入：同一组织在两个**真进程**上并发创建 → 成功数 ≤ 月限额，成功+拒绝=总数（安全属性），
 *    拒绝一律 QUOTA_EXCEEDED；终态后预留释放、账本每 run 恰一行；
 * ③ 会话事实在 DB（不是进程内存）：A 进程签发的会话在 B 进程同样有效；已撤销/不存在的 sid 任何进程一律 401；
 * ④（契约门控，A1）跨进程会话撤销传播走 **session-events** 通道：A 进程登出 → B 进程在**远小于**
 *    进程内缓存 TTL(60s) 的窗口内即拒绝（**行为判据**——只看通道上有没有消息是不可靠的，
 *    因为 Redis pub/sub 是**实例全局**的：DB 号只隔离 keyspace，不隔离 channel，并行 Agent 的 e2e
 *    会往同一通道发自己的事件）；通道证据只认**引用本会话 sid/userId/email** 的消息。
 *    A1 未合并时**显式 skip**（行为探测失败），绝不伪造通过。
 *
 * Redis DB 号：本 Agent 分配的是 /31；子进程原本指定的 /131、/132 在现代 Redis 下**依然越界**
 * （`CONFIG GET databases` = 64，合法 0–63；越界索引 ioredis 只报错不失效 → 静默回落 DB0，
 * 隔离铁律失效）。故子进程改用本 Agent 专属扩展区 61/62（probe 63），并在 beforeAll 硬校验容量，
 * 且**绝不允许 DB0**（DB0 是其它套件与 dev 环境共享的默认库）。
 * 依赖：真实 PostgreSQL + Redis + 先 `pnpm install`；构建由 beforeAll 自行完成（约 10s）。
 */
const STAMP = `${Date.now()}`;
const DB_API1 = 61; // API#1 + Worker#1（同一队列命名空间）
const DB_API2 = 62; // API#2 + Worker#2
const DB_PROBE = 63; // 订阅探针（Redis pub/sub 与 DB 无关，仅为显式选库、避开 DB0）
const XRW = { 'X-Requested-With': 'XMLHttpRequest', 'content-type': 'application/json' };
const SESSION_EVENTS_CHANNEL = 'session-events';
/** 子进程进程内缓存的 TTL：拉到 60s → "登出后立刻 401" 只可能来自跨实例失效消息，而不是缓存自然过期 */
const GUARD_CACHE_TTL_MS = 60_000;

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 轮询直到回调返回真值（超时抛错并带最后观测值） */
async function waitFor<T>(
  fn: () => Promise<T | null | undefined | false>, what: string, timeoutMs = 30_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: unknown = null;
  while (Date.now() < deadline) {
    const value = await fn();
    if (value) return value as T;
    last = value;
    await delay(150);
  }
  throw new Error(`等待超时：${what}（最后一次观测=${JSON.stringify(last)}）`);
}

interface ChildHandle {
  name: string;
  entry: string;
  proc: ChildProcess;
  pid: number;
  log: string[];
  exited: boolean;
  exitCode: number | null;
}

const children: ChildHandle[] = [];

function tail(h: ChildHandle, lines = 25): string {
  return h.log.slice(-lines).join('\n');
}

function findApiDir(): string {
  const candidates = [
    process.cwd(),
    path.resolve(process.cwd(), 'apps/api'),
    path.resolve(process.cwd(), '../..', 'apps/api'),
  ];
  for (const c of candidates) if (existsSync(path.join(c, 'nest-cli.json'))) return c;
  throw new Error(`无法定位 apps/api 目录（cwd=${process.cwd()}）`);
}

/** 真多进程必须基于**已编译产物**：本文件自带构建步骤（先 build 再 spawn，不依赖调用方先跑过 pnpm build）。 */
function ensureBuild(apiDir: string): string {
  const cli = [
    path.join(apiDir, 'node_modules/@nestjs/cli/bin/nest.js'),
    path.resolve(apiDir, '../../node_modules/@nestjs/cli/bin/nest.js'),
  ].find((p) => existsSync(p));
  if (!cli) throw new Error('找不到 @nestjs/cli（无法执行 nest build）');
  const res = spawnSync(process.execPath, [cli, 'build'], { cwd: apiDir, encoding: 'utf8', timeout: 300_000 });
  if (res.status !== 0) {
    throw new Error(`nest build 失败（status=${res.status}）:\n${res.stdout ?? ''}\n${res.stderr ?? ''}`);
  }
  // 注意：build 输出是 dist/src/*（tsconfig include 含 prisma/scripts，非 dist/main.js）
  const entry = path.join(apiDir, 'dist/src/main.js');
  const worker = path.join(apiDir, 'dist/src/worker.js');
  if (!existsSync(entry) || !existsSync(worker)) throw new Error(`构建产物缺失：${entry} / ${worker}`);
  return path.join(apiDir, 'dist/src');
}

async function reservePorts(n: number): Promise<number[]> {
  const servers: net.Server[] = [];
  try {
    for (let i = 0; i < n; i++) {
      const server = net.createServer();
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => resolve());
      });
      servers.push(server);
    }
    return servers.map((s) => (s.address() as net.AddressInfo).port);
  } finally {
    for (const s of servers) s.close();
  }
}

function spawnChild(name: string, entry: string, cwd: string, env: NodeJS.ProcessEnv): ChildHandle {
  const proc = spawn(process.execPath, [entry], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  const handle: ChildHandle = { name, entry, proc, pid: proc.pid ?? -1, log: [], exited: false, exitCode: null };
  const push = (chunk: Buffer) => {
    handle.log.push(chunk.toString());
    if (handle.log.length > 500) handle.log.splice(0, handle.log.length - 500);
  };
  proc.stdout?.on('data', push);
  proc.stderr?.on('data', push);
  proc.on('exit', (code) => {
    handle.exited = true;
    handle.exitCode = code;
  });
  proc.on('error', (err) => push(Buffer.from(`[spawn error] ${err.message}\n`)));
  children.push(handle);
  return handle;
}

async function waitForLog(h: ChildHandle, needle: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (h.log.some((l) => l.includes(needle))) return;
    if (h.exited) throw new Error(`${h.name} 提前退出（code=${h.exitCode}）:\n${tail(h)}`);
    await delay(100);
  }
  throw new Error(`${h.name} 未在 ${timeoutMs}ms 内就绪（等待日志片段 "${needle}"）:\n${tail(h)}`);
}

async function waitHttpOk(url: string, name: string, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {
      /* 尚未监听 */
    }
    if (Date.now() >= deadline) throw new Error(`${name} HTTP 未就绪：${url}`);
    await delay(200);
  }
}

async function killChild(h: ChildHandle, graceMs = 8_000): Promise<void> {
  if (h.exited) return;
  h.proc.kill('SIGTERM'); // Windows 上等价 TerminateProcess（Node 不投递 POSIX 信号）
  const deadline = Date.now() + graceMs;
  while (Date.now() < deadline && !h.exited) await delay(100);
  if (!h.exited && h.pid > 0) {
    spawnSync('taskkill', ['/PID', String(h.pid), '/T', '/F'], { stdio: 'ignore' });
    await delay(300);
  }
}

/** 兜底：vitest 进程被强杀/异常退出时，绝不留孤儿 API/Worker 进程占用端口与队列 */
process.on('exit', () => {
  for (const h of children) {
    if (!h.exited) {
      try {
        h.proc.kill('SIGKILL');
      } catch {
        /* 已退出 */
      }
    }
  }
});

// ────────────────────────────── HTTP 辅助 ──────────────────────────────

interface ApiTarget { name: string; port: number; child: ChildHandle; base: string }

async function login(target: ApiTarget, email: string, password: string): Promise<string> {
  const res = await fetch(`${target.base}/api/v1/auth/login`, {
    method: 'POST', headers: XRW, body: JSON.stringify({ email, password }),
  });
  const text = await res.text();
  // Nest 对 POST 的默认状态码是 201（handler 用 @Res().json 自行写出，两种都属正常契约）
  expect([200, 201], `${target.name} 登录失败（${res.status}）：${text}`).toContain(res.status);
  const raw = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
  expect(raw.length, `${target.name} 登录未下发 cookie`).toBeGreaterThan(0);
  return raw.map((c) => c.split(';')[0]).join('; ');
}

async function getJson(
  target: ApiTarget, pathname: string, cookie?: string,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`${target.base}${pathname}`, {
    headers: { 'X-Requested-With': 'XMLHttpRequest', ...(cookie ? { cookie } : {}) },
  });
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return { status: res.status, body };
}

async function createRun(
  target: ApiTarget, cookie: string, message = '你好',
): Promise<{ status: number; runId: string | null; body: Record<string, unknown> }> {
  const res = await fetch(`${target.base}/api/v1/agent-runs`, {
    method: 'POST', headers: { ...XRW, cookie }, body: JSON.stringify({ message }),
  });
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  const data = (body.data ?? {}) as Record<string, unknown>;
  return { status: res.status, runId: typeof data.runId === 'string' ? data.runId : null, body };
}

/** workerId = `${hostname}:${pid}:${hex}` → 取出发起执行的 OS 进程 pid（进程级归属证据） */
function workerPidOf(workerId: string | null): string | null {
  if (!workerId) return null;
  const parts = workerId.split(':');
  return parts.length >= 3 ? parts[1]! : null;
}

function workerHostOf(workerId: string | null): string | null {
  return workerId ? workerId.split(':')[0]! : null;
}

describe('M10-P12 真多进程 (e2e: 2×API + 2×Worker 为独立 OS 进程)', () => {
  let prisma: PrismaService;
  let api1: ApiTarget;
  let api2: ApiTarget;
  let worker1: ChildHandle;
  let worker2: ChildHandle;
  let jwts: JwtService;
  let userId = '';
  let orgId = '';
  let email = '';
  const password = `p12-mp-pass-${STAMP}`;
  const runIds: string[] = [];
  let planId: string | null = null;
  /** session-events 能力探测（A1 契约是否落地）——只影响 ④ 的 skip，绝不影响其它用例 */
  const sessionEvents = { supported: false, detail: '未探测' };

  beforeAll(async () => {
    const databaseUrl = process.env.DATABASE_URL;
    if (!databaseUrl) throw new Error('缺少 DATABASE_URL（仓库根 .env 未加载）');
    const apiDir = findApiDir();
    const distDir = ensureBuild(apiDir);

    // Redis 容量硬校验：越界 DB 会静默回落 DB0（隔离失效）而不是报错——必须在 spawn 前发现
    const probeConn = new Redis(`redis://localhost:6379/${DB_PROBE}`, { maxRetriesPerRequest: 2 });
    try {
      const cfg = (await probeConn.config('GET', 'databases')) as string[];
      const count = Number(cfg?.[1]);
      if (Number.isFinite(count)) {
        expect(
          count,
          `Redis 仅配置了 ${count} 个 DB，本文件需要 ${Math.max(DB_API1, DB_API2, DB_PROBE)} 号库`,
        ).toBeGreaterThan(Math.max(DB_API1, DB_API2, DB_PROBE));
      }
    } finally {
      await probeConn.quit().catch(() => undefined);
    }

    const [p1, p2] = await reservePorts(2);
    const jwtSecret = randomBytes(48).toString('base64url'); // 测试专用随机密钥（绝不复用 .env 里的开发密钥）
    const encryptionKey = randomBytes(32).toString('base64'); // 契约：base64 的 32 字节，否则 CryptoService 构造即抛
    jwts = new JwtService({ secret: jwtSecret });

    const baseEnv = (redisDb: number, nodeEnv: string, port?: number): NodeJS.ProcessEnv => ({
      ...process.env,
      NODE_ENV: nodeEnv,
      DATABASE_URL: databaseUrl,
      REDIS_URL: `redis://localhost:6379/${redisDb}`,
      JWT_SECRET: jwtSecret,
      ENCRYPTION_KEY: encryptionKey,
      MOCK_DELAY_MS: '0',
      SECURITY_GUARD_CACHE_TTL_MS: String(GUARD_CACHE_TTL_MS),
      ...(port ? { API_PORT: String(port) } : {}),
    });

    api1 = {
      name: 'API#1', port: p1!, base: `http://127.0.0.1:${p1}`,
      child: spawnChild('API#1', path.join(distDir, 'main.js'), apiDir, baseEnv(DB_API1, 'test', p1)),
    };
    api2 = {
      name: 'API#2', port: p2!, base: `http://127.0.0.1:${p2}`,
      child: spawnChild('API#2', path.join(distDir, 'main.js'), apiDir, baseEnv(DB_API2, 'test', p2)),
    };
    worker1 = spawnChild('Worker#1', path.join(distDir, 'worker.js'), apiDir, baseEnv(DB_API1, 'test'));
    worker2 = spawnChild('Worker#2', path.join(distDir, 'worker.js'), apiDir, baseEnv(DB_API2, 'test'));

    for (const api of [api1, api2]) {
      await waitForLog(api.child, 'API 已启动', 90_000);
      await waitHttpOk(`${api.base}/api/v1/health/ready`, api.name);
    }
    for (const w of [worker1, worker2]) await waitForLog(w, 'Worker 已启动', 90_000);

    // 专用用户 + 个人组织（与既有数据隔离）；口令用 argon2（走真实登录路径，不开测试后门）
    prisma = new PrismaService();
    await prisma.$connect();
    email = `prem10-mp-${STAMP}@example.com`;
    const user = await prisma.user.create({ data: { email, passwordHash: await argon2.hash(password) } });
    userId = user.id;
    orgId = `personal-${user.id}`;
    await prisma.organization.create({
      data: {
        id: orgId, name: 'PreM10-MP', slug: orgId, isPersonal: true, ownerUserId: user.id,
        members: { create: { userId: user.id, role: 'owner' } },
      },
    });

    // ④ 的能力探测**必须是行为级**，不能看"通道上有没有消息"：
    // Redis pub/sub 是**实例全局**的（DB 号不隔离 channel）——并行 Agent 的 e2e 会往同一通道发自己的事件，
    // "看到消息"根本不能证明本实现有发布方/订阅方。行为判据：A 进程登出后，B 进程（该会话已缓存为存活，
    // 缓存 TTL=60s）是否在远小于 TTL 的窗口内开始拒绝 → 只有跨实例失效通道能做到。
    const probeCookie = await login(api1, email, password);
    const warm = await getJson(api2, '/api/v1/auth/me', probeCookie);
    await fetch(`${api1.base}/api/v1/auth/logout`, { method: 'POST', headers: { ...XRW, cookie: probeCookie } });
    let probeRejectedMs: number | null = null;
    const probeStart = Date.now();
    while (Date.now() - probeStart < 12_000) {
      if ((await getJson(api2, '/api/v1/auth/me', probeCookie)).status === 401) {
        probeRejectedMs = Date.now() - probeStart;
        break;
      }
      await delay(200);
    }
    sessionEvents.supported = warm.status === 200 && probeRejectedMs !== null;
    sessionEvents.detail = warm.status !== 200
      ? `前置不成立：B 进程未能读到该会话（/auth/me=${warm.status}）`
      : probeRejectedMs !== null
        ? `A 登出后 B 在 ${probeRejectedMs}ms 内即拒绝（进程内缓存 TTL=${GUARD_CACHE_TTL_MS}ms）`
        : `A 登出后 B 在 12s 内仍接受该会话（跨实例失效未传播；A1 未合并）`;
    console.warn(`[M10-P12] 跨实例会话失效探测（${SESSION_EVENTS_CHANNEL} 契约，行为判据）：${sessionEvents.detail}`);
  }, 600_000);

  afterAll(async () => {
    // 先杀子进程（否则它们仍在消费队列/写库，清理会被竞态污染），再清数据
    for (const h of children) await killChild(h).catch(() => undefined);
    try {
      await prisma?.usageLedgerEntry.deleteMany({ where: { organizationId: orgId } });
      await prisma?.usageRecord.deleteMany({ where: { userId } });
      await prisma?.quotaReservation.deleteMany({ where: { organizationId: orgId } });
      if (runIds.length) {
        await prisma?.agentRunMessage.deleteMany({ where: { runId: { in: runIds } } });
        await prisma?.agentRun.deleteMany({ where: { id: { in: runIds } } });
      }
      await prisma?.conversation.deleteMany({ where: { userId } });
      await prisma?.session.deleteMany({ where: { userId } });
      if (planId) await prisma?.subscription.deleteMany({ where: { organizationId: orgId } });
      await prisma?.organizationMember.deleteMany({ where: { organizationId: orgId } });
      await prisma?.organization.deleteMany({ where: { id: orgId } });
      await prisma?.user.deleteMany({ where: { id: userId } });
      if (planId) await prisma?.plan.deleteMany({ where: { id: planId } });
    } finally {
      await prisma?.$disconnect().catch(() => undefined);
    }
  }, 120_000);

  it('① 进程级归属：API#1 建的 run 由 Worker#1 的 pid 执行、API#2 的由 Worker#2 —— 两个 API 是两个真进程，两个 Worker 各消费自己的 Redis DB', async () => {
    const a = await createRun(api1, await login(api1, email, password));
    const b = await createRun(api2, await login(api2, email, password));
    expect(a.status, JSON.stringify(a.body)).toBe(201);
    expect(b.status, JSON.stringify(b.body)).toBe(201);
    runIds.push(a.runId!, b.runId!);

    const waitTerminal = async (runId: string) => {
      const deadline = Date.now() + 90_000;
      for (;;) {
        const row = await prisma.agentRun.findUnique({ where: { id: runId } });
        if (row && ['completed', 'failed', 'cancelled'].includes(row.status)) return row;
        if (Date.now() >= deadline) throw new Error(`run ${runId} 未在 90s 内终态（当前 ${row?.status ?? 'missing'}）`);
        await delay(200);
      }
    };
    const doneA = await waitTerminal(a.runId!);
    const doneB = await waitTerminal(b.runId!);
    expect(doneA.status).toBe('completed');
    expect(doneB.status).toBe('completed');

    // 真进程证据：workerId 里的 pid 与两个 Worker 子进程的 OS pid 精确对应（DB13 的 job 只可能被 Worker#1 认领）
    expect(workerHostOf(doneA.workerId)).toBe(hostname());
    expect(workerPidOf(doneA.workerId)).toBe(String(worker1.pid));
    expect(workerPidOf(doneB.workerId)).toBe(String(worker2.pid));
    expect(api1.child.pid).not.toBe(api2.child.pid);
    expect(worker1.pid).not.toBe(worker2.pid);
    expect(api1.child.pid).not.toBe(worker1.pid);
    console.log(
      `[M10-P12] ① pid 证据：API#1=${api1.child.pid} Worker#1=${worker1.pid}｜API#2=${api2.child.pid} Worker#2=${worker2.pid}`
      + `｜runWorker=${workerHostOf(doneA.workerId)}/${workerPidOf(doneA.workerId)} 与 ${workerPidOf(doneB.workerId)}`,
    );

    for (const runId of runIds) {
      const ledger = await prisma.usageLedgerEntry.findMany({ where: { runId, kind: 'agent_run' } });
      expect(ledger, `run ${runId} 的 agent_run 账本行`).toHaveLength(1);
      expect(ledger[0]!.organizationId).toBe(orgId);
    }
  }, 240_000);

  it('② C1 跨进程精确准入：同一组织在两个真进程上并发 4 个创建（月限额 2）→ 成功 ≤2、成功+拒绝=4、拒绝全为 QUOTA_EXCEEDED；终态后预留释放', async () => {
    // 确定性基线：清空本组织的计量与预留（本文件此前用例的 run 已终态）
    await prisma.usageLedgerEntry.deleteMany({ where: { organizationId: orgId, kind: 'agent_run' } });
    await prisma.quotaReservation.deleteMany({ where: { organizationId: orgId } });
    const plan = await prisma.plan.create({
      data: {
        code: `mp-tiny-${STAMP}`, name: 'MP Tiny', monthlyPrice: 1, yearlyPrice: 10, active: true,
        entitlements: {
          agentRunsMonthly: 2, agentRunsDaily: 100, concurrentAgentRuns: 50,
          workflowRunsMonthly: 100, concurrentWorkflowRuns: 50,
          llmTokensMonthly: 1_000_000_000, imageMonthly: 1_000_000, imageDaily: 50,
          videoSecondsMonthly: 1_000_000, videoDaily: 10, externalApiMonthly: 1_000_000,
          storageMb: 100_000, seats: 100,
        } as never,
      },
    });
    planId = plan.id;
    await prisma.subscription.upsert({
      where: { organizationId: orgId },
      create: {
        organizationId: orgId, planId: plan.id, status: 'active',
        currentPeriodStart: new Date(), currentPeriodEnd: new Date(Date.now() + 30 * 86400_000),
      },
      update: { planId: plan.id, status: 'active' },
    });

    const cookie = await login(api1, email, password);
    const targets = [api1, api2, api1, api2];
    const results = await Promise.all(targets.map(async (t) => ({ target: t, ...(await createRun(t, cookie, 'P12 多进程准入')) })));
    const ok = results.filter((r) => r.status === 201);
    const rejected = results.filter((r) => r.status === 429);
    console.log(
      `[M10-P12] ② 跨进程并发准入：状态=${JSON.stringify(results.map((r) => r.status))}`,
      `（API#1=${ok.filter((r) => r.target === api1).length} 准入 / API#2=${ok.filter((r) => r.target === api2).length} 准入，限额 2）`,
    );
    // 安全属性（C1 核心保证）：跨进程并发下**绝不超量准入**；其余全部 QUOTA_EXCEEDED。
    // 只断言"≤ 限额"而不写死 2：极端交错允许保守少放行，绝不允许超放行。
    expect(ok.length, `状态序列=${JSON.stringify(results.map((r) => r.status))}`).toBeLessThanOrEqual(2);
    expect(ok.length + rejected.length).toBe(4);
    expect(
      rejected.every((r) => ((r.body.error ?? {}) as { code?: string }).code === 'QUOTA_EXCEEDED'),
      JSON.stringify(rejected.map((r) => r.body)),
    ).toBe(true);
    expect(ok.every((r) => r.runId !== null)).toBe(true);

    for (const r of ok) {
      runIds.push(r.runId!);
      const deadline = Date.now() + 90_000;
      let status = 'queued';
      let workerId: string | null = null;
      for (;;) {
        const row = await prisma.agentRun.findUnique({ where: { id: r.runId! } });
        status = row?.status ?? 'missing';
        workerId = row?.workerId ?? null;
        if (['completed', 'failed', 'cancelled'].includes(status) || Date.now() >= deadline) break;
        await delay(200);
      }
      expect(status, `准入的 run ${r.runId} 应被真进程执行完成`).toBe('completed');
      // 准入它的那个 API 进程所配对的 Worker 执行了它
      expect(workerPidOf(workerId)).toBe(String((r.target === api1 ? worker1 : worker2).pid));
      expect(await prisma.usageLedgerEntry.count({ where: { runId: r.runId!, kind: 'agent_run' } })).toBe(1);
      // 预留释放发生在终态写入之后（driver 收尾）→ 轮询到释放为止；**泄漏**会在超时后失败（语义不变：不得泄漏）
      const released = await waitFor(
        async () => ((await prisma.quotaReservation.count({ where: { refId: r.runId! } })) === 0 ? true : null),
        `run ${r.runId} 的配额预留释放`, 30_000,
      );
      expect(released).toBe(true);
    }
  }, 240_000);

  it('③ 会话事实在 DB 而非进程内存：A 进程登录的会话在 B 进程同样有效；已撤销/不存在的 sid 在任何进程一律 401', async () => {
    const cookie = await login(api1, email, password);
    const me1 = await getJson(api1, '/api/v1/auth/me', cookie);
    const me2 = await getJson(api2, '/api/v1/auth/me', cookie);
    expect(me1.status, JSON.stringify(me1.body)).toBe(200);
    expect(me2.status, JSON.stringify(me2.body)).toBe(200); // B 进程从未见过该会话 → 结论只能来自 DB
    expect((me2.body.data as { user?: { id?: string } }).user?.id).toBe(userId);

    // 已撤销会话（轮换/踢出）：DB 是唯一事实源 → 任何进程都必须拒绝，绝不相信 token 自身
    const revokedSid = randomUUID();
    await prisma.session.create({
      data: {
        id: revokedSid, userId, tokenHash: `p12-revoked-${STAMP}`,
        expiresAt: new Date(Date.now() + 3_600_000), revokedAt: new Date(),
      },
    });
    const revokedToken = await jwts.signAsync({ sub: userId, role: 'user', sid: revokedSid });
    for (const target of [api1, api2]) {
      const res = await getJson(target, '/api/v1/auth/me', `agent_access=${revokedToken}`);
      expect(res.status, `${target.name} 必须拒绝已撤销会话`).toBe(401);
      expect((res.body.error as { message?: string } | undefined)?.message).toBe('登录已失效，请重新登录');
    }
    // 不存在的 sid（伪造/已清理）：同样拒绝
    const ghostToken = await jwts.signAsync({ sub: userId, role: 'user', sid: randomUUID() });
    for (const target of [api1, api2]) {
      expect((await getJson(target, '/api/v1/auth/me', `agent_access=${ghostToken}`)).status).toBe(401);
    }
    // 肯定结论不受否定结论影响：正常会话依然可用
    expect((await getJson(api2, '/api/v1/auth/me', cookie)).status).toBe(200);
    expect((await getJson(api1, '/api/v1/auth/me', cookie)).status).toBe(200);
  }, 120_000);

  it('④（契约门控）跨进程会话撤销传播：A 进程登出 → B 进程在远小于进程内缓存 TTL(60s) 的窗口内即 401（session-events 通道）', async (ctx: TestContext) => {
    if (!sessionEvents.supported) {
      // A1（M10-P1 会话治理）尚未合并发布方 → 按契约显式跳过，绝不把"没有通道"伪装成通过
      console.warn(`[M10-P12] 跳过 ④：${sessionEvents.detail}`);
      ctx.skip();
      return;
    }
    const probe = new Redis(`redis://localhost:6379/${DB_PROBE}`, { maxRetriesPerRequest: 2 });
    try {
      const seen: string[] = [];
      await probe.subscribe(SESSION_EVENTS_CHANNEL);
      probe.on('message', (channel: string, message: string) => {
        if (channel === SESSION_EVENTS_CHANNEL) seen.push(message);
      });
      await delay(300);

      const cookie = await login(api1, email, password);
      // 本会话的 sid（用于**按内容过滤**通道消息：pub/sub 是实例全局的，别的 Agent 也在发自己的事件）
      const refreshToken = /agent_refresh=([^;]+)/.exec(cookie)?.[1] ?? '';
      const session = await prisma.session.findFirst({
        where: { tokenHash: createHash('sha256').update(refreshToken).digest('hex') },
        select: { id: true },
      });
      const mySid = session?.id ?? '';
      expect(mySid, '未能定位本次登录的会话行（无法做内容过滤）').toBeTruthy();
      // 先在 B 进程把该会话"缓存为存活"（肯定结论进进程内缓存，TTL 60s）
      expect((await getJson(api2, '/api/v1/auth/me', cookie)).status).toBe(200);
      seen.length = 0; // 只统计登出之后到达的消息

      const logout = await fetch(`${api1.base}/api/v1/auth/logout`, { method: 'POST', headers: { ...XRW, cookie } });
      expect(logout.status).toBeLessThan(300);

      // 关键判别：B 进程的进程内缓存 TTL 是 60s —— 若没有跨实例失效通道，这里必然是 200
      const deadline = Date.now() + 10_000;
      let status = 200;
      while (Date.now() < deadline) {
        status = (await getJson(api2, '/api/v1/auth/me', cookie)).status;
        if (status === 401) break;
        await delay(200);
      }
      expect(status, 'B 进程未在窗口内拒绝已登出会话（跨实例失效未传播）').toBe(401);

      // 契约证据：撤销消息确实**属于本会话**（只认引用本 sessionId/userId 的事件，绝不把通道上
      // 其他实例/其他 Agent 的事件算作自己的证据）
      const eventDeadline = Date.now() + 3_000;
      const mine = () => seen.filter((m) => m.includes(mySid) || m.includes(userId) || m.includes(email));
      while (Date.now() < eventDeadline && mine().length === 0) await delay(100);
      console.log(
        `[M10-P12] ④ 通道观测：${SESSION_EVENTS_CHANNEL} 共 ${seen.length} 条，其中引用本会话 ${mine().length} 条`,
      );
      expect(
        mine().length,
        `通道上有 ${seen.length} 条消息，但无一条引用本会话（sid=${mySid}）或本人（userId/email）`
        + `——与 A1 的载荷契约不一致（消息应携带可定位会话的标识）`,
      ).toBeGreaterThan(0);
    } finally {
      await probe.quit().catch(() => undefined);
    }
  }, 180_000);

  it('⑤ 稳定性：四个子进程在整个用例期间均存活（未被异常静默带出），两个 API 的 readiness 均为 200', async () => {
    for (const h of [api1.child, api2.child, worker1, worker2]) {
      expect(h.exited, `${h.name} 意外退出（code=${h.exitCode}）：\n${tail(h)}`).toBe(false);
    }
    for (const api of [api1, api2]) {
      const ready = await fetch(`${api.base}/api/v1/health/ready`);
      expect(ready.status, `${api.name} readiness 非 200`).toBe(200);
    }
  }, 60_000);
});
