/**
 * M11-P13：Playwright 真实浏览器验证的“真基础设施”支撑层。
 *
 * 设计口径（与 m11-implementation-plan §9/§10 一致）：
 * - **真进程**：e2e 自己起 api（tsx src/main.ts）+ worker（tsx src/worker.ts）+ web（next dev），
 *   不 mock 后端、不 mock 浏览器网络；afterAll/globalTeardown 全部清理（含 Windows 进程树）。
 * - **同源口径**：浏览器只访问 web 源（Next rewrites `/api/*` → 后端），与生产 nginx 同域名反代一致
 *   （架构 §12.1）。因此 **不设置 NEXT_PUBLIC_API_URL**（它同时会内联进客户端 bundle，令浏览器直连
 *   API 跨源，破坏 CSRF/Cookie 用例的语义）。
 * - **实例隔离**：REDIS_URL 固定独立 DB 号（默认 /33），与其他 worktree 的并行 e2e 互不串队列；
 *   断言一律按“本套件创建的 id”收敛（Pub/Sub 通道实例全局，禁全局负向断言）。
 * - **端口**：web 默认 3000（PW_WEB_PORT 可覆盖）；api 固定 3001——Next rewrites 的默认后端就是
 *   http://localhost:3001，改端口就必须同时改客户端 API_BASE（跨源），故不做该让步而是启动前
 *   显式检测端口占用并给出明确错误。
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const HERE = typeof __dirname === 'string' ? __dirname : process.cwd();
/** 仓库根 = apps/web/e2e/support 上溯 4 层（support → e2e → web → apps → <仓库根>） */
export const REPO_ROOT = path.resolve(HERE, '../../../..');
const API_DIR = path.join(REPO_ROOT, 'apps/api');
const WEB_DIR = path.join(REPO_ROOT, 'apps/web');
/** 主仓库根（worktree 位于 <主仓库>/.claude/worktrees/<name>）——实测 .env 只存在于主仓库根 */
const HOST_REPO_ROOT = path.resolve(REPO_ROOT, '../../..');

export const WEB_PORT = Number(process.env.PW_WEB_PORT ?? 3000);
export const API_PORT = Number(process.env.PW_API_PORT ?? 3001);
export const WEB_ORIGIN = `http://localhost:${WEB_PORT}`;
export const API_ORIGIN = `http://localhost:${API_PORT}`;
/** 非白名单源：同一 web 进程的 127.0.0.1 别名（CORS 负向用例的“攻击者源”） */
export const FOREIGN_ORIGIN = `http://127.0.0.1:${WEB_PORT}`;
/** 独立 Redis DB 号（并行 worktree 铁律：队列/锁/事件不与他人共享） */
export const REDIS_URL = process.env.PW_REDIS_URL ?? 'redis://localhost:6379/33';

/** 每个字符的 mock 流式延迟：足够慢以便在真实浏览器里观测“增量渲染”与 running 态 */
export const MOCK_DELAY_MS = process.env.PW_MOCK_DELAY_MS ?? '30';

export const E2E_TMP = path.join(tmpdir(), 'm11p13-web-e2e');
export const LOG_DIR = path.join(E2E_TMP, 'logs');
export const STORAGE_DIR = path.join(E2E_TMP, 'storage');
const STATE_FILE = path.join(E2E_TMP, 'stack.json');

export interface StackState {
  apiPid: number | null;
  webPid: number | null;
  workerPid: number | null;
  startedAt: string | null;
}

const EMPTY_STATE: StackState = { apiPid: null, webPid: null, workerPid: null, startedAt: null };

export function ensureDirs(): void {
  for (const dir of [E2E_TMP, LOG_DIR, STORAGE_DIR]) mkdirSync(dir, { recursive: true });
}

export function readState(): StackState {
  try {
    return { ...EMPTY_STATE, ...(JSON.parse(readFileSync(STATE_FILE, 'utf8')) as Partial<StackState>) };
  } catch {
    return { ...EMPTY_STATE };
  }
}

export function writeState(patch: Partial<StackState>): StackState {
  ensureDirs();
  const next = { ...readState(), ...patch };
  writeFileSync(STATE_FILE, JSON.stringify(next, null, 2));
  return next;
}

/** 极简 .env 解析（KEY=VALUE、可选引号、# 注释）；不引入新依赖 */
export function parseEnvFile(file: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!existsSync(file)) return out;
  for (const raw of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).replace(/^export\s+/, '').trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

/** 环境变量文件候选：显式指定 → 工作区根 → apps/api → 主仓库根（worktree 场景） */
export function loadEnvValues(): { file: string | null; values: Record<string, string> } {
  const candidates = [
    process.env.PW_ENV_FILE,
    path.join(REPO_ROOT, '.env'),
    path.join(API_DIR, '.env'),
    path.join(HOST_REPO_ROOT, '.env'),
  ].filter((x): x is string => !!x);
  for (const file of candidates) {
    const values = parseEnvFile(file);
    if (Object.keys(values).length > 0) return { file, values };
  }
  return { file: null, values: {} };
}

/**
 * 子进程环境：.env 值 → process.env 覆盖（显式传入优先）→ 本套件强制覆盖（进程内隔离）。
 * NEXT_PUBLIC_API_URL 一律删除：保证浏览器同源（见文件头）。
 */
export function buildEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const { values } = loadEnvValues();
  const env: Record<string, string | undefined> = { ...values, ...process.env };
  delete env.NEXT_PUBLIC_API_URL;
  // 显式固定 dev 口径的 Cookie 语义（明文 HTTP 下不带 Secure）；生产 Secure 由其单测覆盖
  delete env.COOKIE_SECURE;
  return {
    ...env,
    REDIS_URL,
    API_PORT: String(API_PORT),
    STORAGE_LOCAL_DIR: STORAGE_DIR,
    MOCK_DELAY_MS,
    // 白名单 = 本套件的 web 源（默认 http://localhost:3000，与 DEFAULT_CORS_ORIGINS 一致）
    CORS_ORIGINS: `http://localhost:${WEB_PORT}`,
    NEXT_TELEMETRY_DISABLED: '1',
    ...extra,
  } as NodeJS.ProcessEnv;
}

export function adminCredentials(): { email: string; password: string } {
  const { values } = loadEnvValues();
  return {
    email: process.env.SEED_ADMIN_EMAIL ?? values.SEED_ADMIN_EMAIL ?? 'admin@example.com',
    password: process.env.SEED_ADMIN_PASSWORD ?? values.SEED_ADMIN_PASSWORD ?? 'admin123456',
  };
}

/** Chrome/Edge channel 解析：优先本机已装 Chrome，缺省退化 Edge（免下载浏览器） */
export function resolveChannel(): string {
  if (process.env.PW_CHANNEL) return process.env.PW_CHANNEL;
  const candidates: Array<{ channel: string; paths: string[] }> = [
    { channel: 'chrome', paths: [path.join(process.env['PROGRAMFILES'] ?? 'C:/Program Files', 'Google/Chrome/Application/chrome.exe'), 'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe'] },
    { channel: 'msedge', paths: ['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', path.join(process.env['PROGRAMFILES'] ?? 'C:/Program Files', 'Microsoft/Edge/Application/msedge.exe')] },
  ];
  for (const c of candidates) {
    if (c.paths.some((p) => existsSync(p))) return c.channel;
  }
  throw new Error(
    '未检测到本机 Chrome/Edge（Playwright channel）。请安装其一，或用 PW_CHANNEL=chrome|msedge 显式指定；' +
      '本套件不使用 Playwright 自带下载浏览器（离线环境）。',
  );
}

function spawnManaged(name: string, cmd: string, args: string[], cwd: string, env: NodeJS.ProcessEnv): ChildProcess {
  ensureDirs();
  const out = openSync(path.join(LOG_DIR, `${name}.log`), 'a');
  const child = spawn(cmd, args, {
    cwd,
    env,
    shell: true, // Windows：pnpm 需要 shell 解析 .cmd 垫片；进程树由 taskkill /T 回收
    windowsHide: true,
    stdio: ['ignore', out, out],
  });
  child.on('error', (err) => {
    writeFileSync(path.join(LOG_DIR, `${name}.error.log`), String((err as Error).stack ?? err));
  });
  return child;
}

export function startApi(env: NodeJS.ProcessEnv = buildEnv()): ChildProcess {
  return spawnManaged('api', 'pnpm', ['exec', 'tsx', 'src/main.ts'], API_DIR, env);
}

export function startWeb(env: NodeJS.ProcessEnv = buildEnv()): ChildProcess {
  return spawnManaged('web', 'pnpm', ['exec', 'next', 'dev', '-p', String(WEB_PORT)], WEB_DIR, env);
}

export function startWorker(env: NodeJS.ProcessEnv = buildEnv()): ChildProcess {
  const child = spawnManaged('worker', 'pnpm', ['exec', 'tsx', 'src/worker.ts'], API_DIR, env);
  writeState({ workerPid: child.pid ?? null });
  return child;
}

export function isAlive(pid: number | null | undefined): boolean {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** 杀进程树（Windows: taskkill /T /F；POSIX: 进程组） */
export function killTree(pid: number | null | undefined): void {
  if (!pid) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
  } else {
    try { process.kill(pid, 'SIGKILL'); } catch { /* 已退出 */ }
  }
}

/** 兜底：按监听端口回收残留进程（防止上一次异常退出留下的 dev server 干扰本轮） */
export function killByPort(port: number, ignorePids: Array<number | null> = []): number[] {
  if (process.platform !== 'win32') return [];
  const res = spawnSync('netstat', ['-ano'], { encoding: 'utf8' });
  const killed = new Set<number>();
  for (const line of (res.stdout ?? '').split(/\r?\n/)) {
    if (!/LISTENING/i.test(line)) continue;
    if (!new RegExp(`[:.]${port}\\s`).test(line)) continue;
    const pid = Number(line.trim().split(/\s+/).pop());
    if (!pid || !Number.isFinite(pid) || ignorePids.includes(pid)) continue;
    killTree(pid);
    killed.add(pid);
  }
  return [...killed];
}

export async function isHttpReachable(url: string, timeoutMs = 2500): Promise<boolean> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), redirect: 'manual' });
    return res.status > 0;
  } catch {
    return false;
  }
}

/** 轮询等待 HTTP 就绪（api 健康检查 / web 首页 200） */
export async function waitForHttp(
  url: string,
  { timeoutMs = 120_000, label = url, accept }: { timeoutMs?: number; label?: string; accept?: (res: Response) => boolean } = {},
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let last = 'no-response';
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(5000), redirect: 'manual' });
      if (res.status > 0 && (!accept || accept(res))) return;
      last = `HTTP ${res.status}`;
    } catch (err) {
      last = (err as Error).message;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`等待 ${label} 就绪超时（${timeoutMs}ms，最后状态：${last}）。日志见 ${LOG_DIR}`);
}

export async function waitForApi(timeoutMs = 150_000): Promise<void> {
  await waitForHttp(`${API_ORIGIN}/api/v1/health`, { timeoutMs, label: `API ${API_ORIGIN}/api/v1/health`, accept: (r) => r.ok });
}

export async function waitForWeb(timeoutMs = 180_000): Promise<void> {
  await waitForHttp(`${WEB_ORIGIN}/login`, { timeoutMs, label: `Web ${WEB_ORIGIN}/login`, accept: (r) => r.ok });
}

/** 停 worker 并等到确认退出（任务卡“排队中”态用例需要确定性的“无消费者”窗口） */
export async function stopWorkerAndWait(timeoutMs = 15_000): Promise<boolean> {
  const { workerPid } = readState();
  if (!workerPid) return false;
  killTree(workerPid);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline && isAlive(workerPid)) await new Promise((r) => setTimeout(r, 200));
  writeState({ workerPid: null });
  return true;
}

export function logPath(name: string): string {
  return path.join(LOG_DIR, `${name}.log`);
}
