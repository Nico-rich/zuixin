import type { FullConfig } from '@playwright/test';
import { execSync } from 'node:child_process';
import {
  API_ORIGIN, FOREIGN_ORIGIN, LOG_DIR, REDIS_URL, REPO_ROOT, WEB_ORIGIN,
  buildEnv, ensureDirs, isHttpReachable, killByCommandLine, killTree, loadEnvValues, readState, resolveChannel,
  startApi, startWeb, startWorker, waitForApi, waitForWeb, writeState,
} from './stack';

/**
 * 真实进程栈启动（api + worker + web）。
 * 顺序：环境/端口预检 → api 就绪 → web 就绪 → worker 就绪（worker 最后，避免抢跑）。
 */
export default async function globalSetup(config: FullConfig): Promise<void> {
  ensureDirs();
  const channel = resolveChannel();
  const { file } = loadEnvValues();
  console.log(`[e2e] 浏览器 channel=${channel}（本机已装浏览器，不下载）`);
  console.log(`[e2e] 工作区根=${REPO_ROOT}  环境文件=${file ?? '(未找到，依赖默认值/既有环境变量)'}`);
  console.log(`[e2e] REDIS_URL=${REDIS_URL}  API=${API_ORIGIN}  WEB=${WEB_ORIGIN}  非白名单源=${FOREIGN_ORIGIN}`);

  // 残骸回收：只回收“本套件上一次运行记录的 pid”，绝不动别人的进程
  const prev = readState();
  for (const pid of [prev.workerPid, prev.webPid, prev.apiPid]) if (pid) killTree(pid);
  // 第二道保险：上一次异常中断（Ctrl+C/崩溃）可能留下脱管的 pnpm→cmd→pnpm→node 链，
  // 继续消费本套件的 Redis DB——task-card 的“无消费者窗口”会因此失效（实抓根因）
  const strays = killByCommandLine('src/worker.ts', [prev.workerPid]);
  if (strays.length) console.log(`[e2e] 回收脱管 worker 残留 pid=[${strays.join(',')}]`);
  writeState({ apiPid: null, webPid: null, workerPid: null });

  if (process.env.PW_REUSE_SERVERS === '1') {
    console.log('[e2e] PW_REUSE_SERVERS=1 → 复用已在运行的 api/web（仅限本机调试）');
    await waitForApi(30_000);
    await waitForWeb(30_000);
    return;
  }

  const apiBusy = await isHttpReachable(`${API_ORIGIN}/api/v1/health`);
  const webBusy = await isHttpReachable(`${WEB_ORIGIN}/login`);
  if (apiBusy || webBusy) {
    throw new Error(
      `端口被占用：${apiBusy ? `API ${API_ORIGIN} 已可响应` : ''}${apiBusy && webBusy ? '；' : ''}${webBusy ? `WEB ${WEB_ORIGIN} 已可响应` : ''}。\n` +
        '本套件要求独占 3001(api)/3000(web) 以保持“同源代理 + 真实进程”口径：请先停掉占用进程，或临时用 PW_WEB_PORT 指定 web 端口（api 端口由 Next rewrites 默认后端决定，不可改）。',
    );
  }

  const env = buildEnv();
  const api = startApi(env);
  writeState({ apiPid: api.pid ?? null, startedAt: new Date().toISOString() });
  console.log(`[e2e] 启动 api pid=${api.pid}（tsx src/main.ts，REDIS db=${REDIS_URL.split('/').pop()}）`);
  await waitForApi();

  const web = startWeb(env);
  writeState({ webPid: web.pid ?? null });
  console.log(`[e2e] 启动 web pid=${web.pid}（next dev -p ${WEB_ORIGIN.split(':').pop()}）`);
  await waitForWeb();

  const worker = startWorker(env);
  console.log(`[e2e] 启动 worker pid=${worker.pid}`);
  console.log(`[e2e] 进程日志目录：${LOG_DIR}`);

  // 记录运行时信息，便于失败时定位（浏览器版本对“真实浏览器”结论很重要）
  try {
    const version = execSync('pnpm exec playwright --version', { cwd: config.rootDir, encoding: 'utf8' }).trim();
    console.log(`[e2e] ${version}`);
  } catch { /* 版本探测失败不影响执行 */ }
}
