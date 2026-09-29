import { API_PORT, WEB_PORT, isAlive, killByCommandLine, killByPort, killTree, readState, writeState } from './stack';

/**
 * 全量清理：worker → web → api（顺序保证 worker 不再消费队列后 api 才下线），
 * 再按端口兜底回收孤儿子进程。Windows 下走 `taskkill /T /F` 杀整棵进程树。
 */
export default async function globalTeardown(): Promise<void> {
  const state = readState();
  const ordered: Array<[string, number | null]> = [
    ['worker', state.workerPid],
    ['web', state.webPid],
    ['api', state.apiPid],
  ];
  for (const [name, pid] of ordered) {
    if (!pid) continue;
    killTree(pid);
    console.log(`[e2e] 已停止 ${name} pid=${pid}`);
  }
  await new Promise((r) => setTimeout(r, 800));

  const leftovers = [
    ...killByPort(WEB_PORT, [state.webPid]).map((pid) => `web:${pid}`),
    ...killByPort(API_PORT, [state.apiPid]).map((pid) => `api:${pid}`),
    ...killByCommandLine('src/worker.ts', [state.workerPid]).map((pid) => `worker:${pid}`),
  ];
  if (leftovers.length) console.log(`[e2e] 端口/命令行兜底回收：${leftovers.join(', ')}`);

  const stillAlive = (state.workerPid && isAlive(state.workerPid)) || (state.apiPid && isAlive(state.apiPid)) || (state.webPid && isAlive(state.webPid));
  writeState({ apiPid: null, webPid: null, workerPid: null });
  console.log(`[e2e] 进程栈已清理${stillAlive ? '（存在未退出的进程，已尽力 taskkill /T /F）' : ''}`);
}
