import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import * as argon2 from 'argon2';
import { PrismaService } from '../src/modules/prisma/prisma.service';
import { ACCESS_TTL_SEC, REFRESH_TTL_SEC } from '../src/modules/auth/auth.constants';

/**
 * M10-P12 生产 cookie 属性 e2e（M9-06 / SA-3）。
 *
 * 形态：spawn **真实 API 进程**并登录（真 HTTP，不是 in-process 装配）：
 * ① `NODE_ENV=production` → `Set-Cookie` 必须带 `Secure`（+ 既有 HttpOnly / SameSite=Lax / Path / Max-Age）；
 * ② 对照组 `NODE_ENV=test` → 不得带 `Secure`（本地 http 开发不被破坏）——**判别式**：证明 ① 的 Secure
 *    来自生产语义而非常量硬编码/偶然；
 * ③ 显式开关 `COOKIE_SECURE=true`（非生产）→ 同样带 `Secure`（https 非生产环境路径）。
 * 覆盖**两条 cookie 写出路径**：登录下发 + 登出清除（Max-Age=0 的清除 cookie 也必须同属性）。
 *
 * 断言只锁定 cookie 属性：无论 A1（M10-P1 生产守卫/会话治理）是否已合并，本文件都应自然通过。
 * 生产进程按契约提供合法凭证：`ENCRYPTION_KEY` 必须是 base64 的 32 字节（CryptoService 构造即校验，
 * 否则进程启动即失败），`JWT_SECRET` 用测试专用随机值——绝不使用仓库 .env 里的开发密钥。
 * `SEED_ADMIN_PASSWORD` 同理必须显式给强口令：子进程 env 由 `...process.env` 展开，而本机 .env 按开发
 * 约定填的是占位/默认口令（M10-P1 启动守卫会在 `NODE_ENV=production` 下据此**拒绝启动**）。
 * 子进程只做 cookie 属性断言、不执行 seed，故这里给随机强口令既满足守卫也不影响断言。
 * Redis 用本 Agent 专属 DB 31（非 0；越界索引会静默回落 DB0 → 隔离失效，故 beforeAll 校验库容量）。
 */
const STAMP = `${Date.now()}`;
const DB_PROD = 31;
const XRW = { 'X-Requested-With': 'XMLHttpRequest', 'content-type': 'application/json' };

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface ChildHandle {
  name: string;
  proc: ChildProcess;
  pid: number;
  log: string[];
  exited: boolean;
  exitCode: number | null;
  port: number;
  base: string;
}

const children: ChildHandle[] = [];

function tail(h: ChildHandle, lines = 30): string {
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

/** 真进程必须基于已编译产物：本文件自带构建（先 build 再 spawn），保证单独运行也可执行。 */
function ensureBuild(apiDir: string): string {
  const cli = [
    path.join(apiDir, 'node_modules/@nestjs/cli/bin/nest.js'),
    path.resolve(apiDir, '../../node_modules/@nestjs/cli/bin/nest.js'),
  ].find((p) => existsSync(p));
  if (!cli) throw new Error('找不到 @nestjs/cli（无法执行 nest build）');
  const res = spawnSync(process.execPath, [cli, 'build'], { cwd: apiDir, encoding: 'utf8', timeout: 300_000 });
  if (res.status !== 0) throw new Error(`nest build 失败（status=${res.status}）:\n${res.stdout ?? ''}\n${res.stderr ?? ''}`);
  const entry = path.join(apiDir, 'dist/src/main.js'); // build 输出为 dist/src/*（非 dist/main.js）
  if (!existsSync(entry)) throw new Error(`构建产物缺失：${entry}`);
  return entry;
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

function spawnApi(name: string, entry: string, cwd: string, env: NodeJS.ProcessEnv, port: number): ChildHandle {
  const proc = spawn(process.execPath, [entry], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  const handle: ChildHandle = {
    name, proc, pid: proc.pid ?? -1, log: [], exited: false, exitCode: null,
    port, base: `http://127.0.0.1:${port}`,
  };
  const push = (chunk: Buffer) => {
    handle.log.push(chunk.toString());
    if (handle.log.length > 400) handle.log.splice(0, handle.log.length - 400);
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

async function waitReady(h: ChildHandle, timeoutMs = 90_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (h.log.some((l) => l.includes('API 已启动'))) {
      try {
        const res = await fetch(`${h.base}/api/v1/health/ready`);
        if (res.ok) return;
      } catch {
        /* 尚未监听 */
      }
    }
    if (h.exited) throw new Error(`${h.name} 提前退出（code=${h.exitCode}）:\n${tail(h)}`);
    await delay(200);
  }
  throw new Error(`${h.name} 未在 ${timeoutMs}ms 内就绪:\n${tail(h)}`);
}

async function killChild(h: ChildHandle, graceMs = 8_000): Promise<void> {
  if (h.exited) return;
  h.proc.kill('SIGTERM'); // Windows：等价 TerminateProcess
  const deadline = Date.now() + graceMs;
  while (Date.now() < deadline && !h.exited) await delay(100);
  if (!h.exited && h.pid > 0) {
    spawnSync('taskkill', ['/PID', String(h.pid), '/T', '/F'], { stdio: 'ignore' });
    await delay(300);
  }
}

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

// ────────────────────────────── cookie 断言辅助 ──────────────────────────────

interface CookieJar {
  /** cookie 名 → 完整 Set-Cookie 串（含属性） */
  byName: Map<string, string>;
  /** cookie 名 → 值 */
  value: Map<string, string>;
  raw: string[];
}

function cookieJar(headers: Headers): CookieJar {
  const raw = typeof headers.getSetCookie === 'function' ? headers.getSetCookie() : [];
  const byName = new Map<string, string>();
  const value = new Map<string, string>();
  for (const c of raw) {
    const [pair, ...attrs] = c.split(';');
    const eq = pair!.indexOf('=');
    const name = pair!.slice(0, eq).trim();
    byName.set(name, c);
    value.set(name, pair!.slice(eq + 1).trim());
    void attrs;
  }
  return { byName, value, raw };
}

/** 断言一条 cookie 的属性集合：必须/禁止出现（大小写不敏感，属性名大小写不敏感但取值大小写敏感） */
function expectAttrs(cookie: string, what: string, must: string[], mustNot: string[] = []): void {
  const parts = cookie.split(';').map((p) => p.trim());
  const has = (needle: string) => parts.some((p) => p.toLowerCase() === needle.toLowerCase());
  for (const m of must) {
    expect(has(m), `${what} 缺少属性 ${m}：${cookie}`).toBe(true);
  }
  for (const m of mustNot) {
    expect(has(m), `${what} 不应出现属性 ${m}：${cookie}`).toBe(false);
  }
}

async function loginOn(target: ChildHandle, email: string, password: string): Promise<CookieJar> {
  const res = await fetch(`${target.base}/api/v1/auth/login`, {
    method: 'POST', headers: XRW, body: JSON.stringify({ email, password }),
  });
  const text = await res.text();
  // Nest 对 POST 的默认状态码是 201（handler 用 @Res().json 自行写出，两种都属正常契约）
  expect([200, 201], `${target.name} 登录失败（${res.status}）：${text}`).toContain(res.status);
  return cookieJar(res.headers);
}

async function logoutOn(target: ChildHandle, jar: CookieJar): Promise<CookieJar> {
  const cookie = ['agent_access', 'agent_refresh']
    .filter((n) => jar.value.has(n))
    .map((n) => `${n}=${jar.value.get(n)}`)
    .join('; ');
  const res = await fetch(`${target.base}/api/v1/auth/logout`, {
    method: 'POST', headers: { ...XRW, cookie },
  });
  expect(res.status, `${target.name} 登出失败（${res.status}）`).toBeLessThan(300);
  return cookieJar(res.headers);
}

describe('M10-P12 生产 cookie 属性 (e2e, 真 API 进程)', () => {
  let prisma: PrismaService;
  let prod: ChildHandle;
  let dev: ChildHandle;
  let explicit: ChildHandle;
  let userId = '';
  let email = '';

  beforeAll(async () => {
    const databaseUrl = process.env.DATABASE_URL;
    if (!databaseUrl) throw new Error('缺少 DATABASE_URL（仓库根 .env 未加载）');
    const apiDir = findApiDir();
    const entry = ensureBuild(apiDir);
    const [pProd, pDev, pExplicit] = await reservePorts(3);

    const jwtSecret = randomBytes(48).toString('base64url');
    // 契约：ENCRYPTION_KEY 必须是 base64 的 **32 字节**（CryptoService 构造即校验；否则生产进程启动即失败）
    const encryptionKey = randomBytes(32).toString('base64');
    // 生产启动守卫（M10-P1）会拒绝占位/默认 SEED_ADMIN_PASSWORD —— 显式覆盖，绝不继承本机 .env 的开发口令
    const seedPassword = `Prod-Guard-${randomBytes(18).toString('base64url')}`;

    const envFor = (nodeEnv: string, port: number, extra: Record<string, string> = {}): NodeJS.ProcessEnv => ({
      ...process.env,
      NODE_ENV: nodeEnv,
      API_PORT: String(port),
      DATABASE_URL: databaseUrl,
      REDIS_URL: `redis://localhost:6379/${DB_PROD}`,
      JWT_SECRET: jwtSecret,
      ENCRYPTION_KEY: encryptionKey,
      SEED_ADMIN_PASSWORD: seedPassword,
      ...extra,
    });

    prod = spawnApi('prod(NODE_ENV=production)', entry, apiDir, envFor('production', pProd!), pProd!);
    dev = spawnApi('dev(NODE_ENV=test)', entry, apiDir, envFor('test', pDev!, { COOKIE_SECURE: '' }), pDev!);
    explicit = spawnApi('explicit(COOKIE_SECURE=true)', entry, apiDir, envFor('test', pExplicit!, { COOKIE_SECURE: 'true' }), pExplicit!);
    await Promise.all([waitReady(prod), waitReady(dev), waitReady(explicit)]);

    prisma = new PrismaService();
    await prisma.$connect();
    email = `prem10-cookie-${STAMP}@example.com`;
    const user = await prisma.user.create({ data: { email, passwordHash: await argon2.hash(`p12-cookie-pass-${STAMP}`) } });
    userId = user.id;
  }, 600_000);

  afterAll(async () => {
    for (const h of children) await killChild(h).catch(() => undefined);
    try {
      await prisma?.session.deleteMany({ where: { userId } });
      await prisma?.user.deleteMany({ where: { id: userId } });
    } finally {
      await prisma?.$disconnect().catch(() => undefined);
    }
  }, 60_000);

  it('生产进程（NODE_ENV=production）：登录下发的 agent_access/agent_refresh 均带 Secure + HttpOnly + SameSite=Lax + 正确 Path/Max-Age，且 cookie 真实可用', async () => {
    const jar = await loginOn(prod, email, `p12-cookie-pass-${STAMP}`);
    const access = jar.byName.get('agent_access');
    const refresh = jar.byName.get('agent_refresh');
    expect(access, `缺少 agent_access：${JSON.stringify(jar.raw)}`).toBeTruthy();
    expect(refresh, `缺少 agent_refresh：${JSON.stringify(jar.raw)}`).toBeTruthy();

    // 生产语义的核心断言：Secure（M9-06）
    expectAttrs(access!, 'agent_access', ['Secure', 'HttpOnly', 'SameSite=Lax', 'Path=/', `Max-Age=${ACCESS_TTL_SEC}`]);
    expectAttrs(refresh!, 'agent_refresh', ['Secure', 'HttpOnly', 'SameSite=Lax', 'Path=/api/v1/auth', `Max-Age=${REFRESH_TTL_SEC}`]);
    // 值必须是真的令牌（非空、access 为 JWT 三段式）——Secure 只是属性，不能拿空值糊弄
    expect(jar.value.get('agent_access')!.split('.')).toHaveLength(3);
    expect(jar.value.get('agent_refresh')!.length).toBeGreaterThan(20);

    // cookie 可用性：带生产 cookie 访问受保护端点
    const me = await fetch(`${prod.base}/api/v1/auth/me`, {
      headers: { 'X-Requested-With': 'XMLHttpRequest', cookie: `agent_access=${jar.value.get('agent_access')}` },
    });
    expect(me.status, await me.text()).toBe(200);

    // 清除路径（登出）同样必须带 Secure/HttpOnly/SameSite=Lax——两条写出路径都要审计
    const cleared = await logoutOn(prod, jar);
    const clearAccess = cleared.byName.get('agent_access');
    const clearRefresh = cleared.byName.get('agent_refresh');
    expect(clearAccess, `登出未清除 agent_access：${JSON.stringify(cleared.raw)}`).toBeTruthy();
    expect(clearRefresh, `登出未清除 agent_refresh：${JSON.stringify(cleared.raw)}`).toBeTruthy();
    expectAttrs(clearAccess!, '登出 agent_access', ['Secure', 'HttpOnly', 'SameSite=Lax', 'Path=/', 'Max-Age=0']);
    expectAttrs(clearRefresh!, '登出 agent_refresh', ['Secure', 'HttpOnly', 'SameSite=Lax', 'Path=/api/v1/auth', 'Max-Age=0']);
    expect(cleared.value.get('agent_access')).toBe('');
  }, 120_000);

  it('对照组（NODE_ENV=test，非显式开启）：同样两条 cookie 不得带 Secure —— 证明生产 Secure 来自生产语义而非硬编码', async () => {
    const jar = await loginOn(dev, email, `p12-cookie-pass-${STAMP}`);
    const access = jar.byName.get('agent_access');
    const refresh = jar.byName.get('agent_refresh');
    expect(access, `缺少 agent_access：${JSON.stringify(jar.raw)}`).toBeTruthy();
    expectAttrs(access!, 'agent_access(dev)', ['HttpOnly', 'SameSite=Lax', 'Path=/', `Max-Age=${ACCESS_TTL_SEC}`], ['Secure']);
    expectAttrs(refresh!, 'agent_refresh(dev)', ['HttpOnly', 'SameSite=Lax', 'Path=/api/v1/auth', `Max-Age=${REFRESH_TTL_SEC}`], ['Secure']);
    const cleared = await logoutOn(dev, jar);
    expectAttrs(cleared.byName.get('agent_access')!, '登出 agent_access(dev)', ['HttpOnly', 'SameSite=Lax', 'Max-Age=0'], ['Secure']);
  }, 120_000);

  it('显式开关（非生产 COOKIE_SECURE=true）：两条 cookie 带 Secure —— 覆盖 https 非生产部署路径', async () => {
    const jar = await loginOn(explicit, email, `p12-cookie-pass-${STAMP}`);
    const access = jar.byName.get('agent_access');
    const refresh = jar.byName.get('agent_refresh');
    expect(access, `缺少 agent_access：${JSON.stringify(jar.raw)}`).toBeTruthy();
    expectAttrs(access!, 'agent_access(explicit)', ['Secure', 'HttpOnly', 'SameSite=Lax', 'Path=/', `Max-Age=${ACCESS_TTL_SEC}`]);
    expectAttrs(refresh!, 'agent_refresh(explicit)', ['Secure', 'HttpOnly', 'SameSite=Lax', 'Path=/api/v1/auth', `Max-Age=${REFRESH_TTL_SEC}`]);
    const cleared = await logoutOn(explicit, jar);
    expectAttrs(cleared.byName.get('agent_access')!, '登出 agent_access(explicit)', ['Secure', 'HttpOnly', 'SameSite=Lax', 'Max-Age=0']);
  }, 120_000);

  it('三个进程在整个用例期间均存活（生产模式无启动守卫异常/依赖降级），readiness 均 200', async () => {
    for (const h of [prod, dev, explicit]) {
      expect(h.exited, `${h.name} 意外退出（code=${h.exitCode}）：\n${tail(h)}`).toBe(false);
      const ready = await fetch(`${h.base}/api/v1/health/ready`);
      expect(ready.status, `${h.name} readiness 非 200`).toBe(200);
    }
    expect(new Set([prod.pid, dev.pid, explicit.pid]).size).toBe(3); // 三个独立 OS 进程
  }, 60_000);
});
