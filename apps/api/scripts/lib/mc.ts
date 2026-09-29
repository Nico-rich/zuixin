/**
 * M10-P9 运维脚本：MinIO 客户端（mc）封装 + **mirror 结果核对**（纯函数可单测）。
 *
 * 两种运行形态（同一套 argv，只有外层包装不同）：
 * - `docker`（本机开发环境默认）：用 `quay.io/minio/mc` 镜像跑一次性容器，`--network container:<minio 容器>`
 *   复用其网络（m8 手册 §3.2 的实测路径；镜像已在本机存在，不依赖外网）；
 * - `native`：宿主机/Job 里有 `mc` 时直连（生产推荐：不依赖 docker socket 权限）。
 *
 * 凭证纪律（**本文件最重要的约束**）：
 * - 用 `MC_HOST_<alias>` 环境变量注入 `scheme://key:secret@host`，**绝不**把密钥写进 argv
 *   （argv 会出现在 `ps`/`docker ps`/审计日志里）；
 * - docker 模式下该环境变量经**临时 env 文件**（0600、用完即删）传给容器；
 * - 所有回显/错误都过 `redactSecrets()`。
 *
 * M12-P5（审计项："mc 凭据 SIGINT 残留"）：临时 env 文件此前只在**正常返回路径**（`finally`）里删除
 * ——`Ctrl+C`（SIGINT）/`SIGTERM` 直接终止进程时，含密钥的文件会**留在临时目录里**（残留凭证）。
 * 现在：只要有临时文件在场，本模块就临时接管 SIGINT/SIGTERM——先删除全部临时文件，再按 shell 惯例
 * 退出（SIGINT → 130、SIGTERM → 143）；临时文件清零后立刻卸载处理器（**不在空转时改变进程的信号语义**）。
 */

import { chmodSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { redactSecrets, run, type RunResult } from './cli';

export type McMode = 'docker' | 'native';

export interface McOptions {
  mode: McMode;
  /** alias 名（`MC_HOST_<alias>`；默认 m10） */
  alias?: string;
  /** 端点 URL（如 http://localhost:9000） */
  origin: string;
  accessKey: string;
  secretKey: string;
  /** docker 模式：mc 镜像 */
  image?: string;
  /** docker 模式：网络（默认 container:docker-minio-1） */
  network?: string;
  dockerBin?: string;
  /** native 模式：mc 二进制路径 */
  mcBin?: string;
}

export interface McListEntry {
  key: string;
  sizeBytes: number;
  isDir: boolean;
}

export interface McMirrorSummary {
  /** 对象数（不含目录项） */
  count: number;
  totalBytes: number;
  objects: McListEntry[];
}

/**
 * 解析 `mc ls -r --json <target>` 的逐行 JSON。
 * 输出形如 `{"status":"success","type":"file","key":"a/b.bin","size":65536,...}`；
 * **目录项（type=folder 或 key 以 / 结尾）必须排除**——否则对象数会被目录占位撑大，核对永远不等。
 * 非 JSON 行（某些 mc 版本把人类可读错误写到 stdout）被忽略，由调用方按退出码判失败。
 */
export function parseMcListJson(text: string): McMirrorSummary {
  const files: McListEntry[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line.startsWith('{')) continue;
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    const key = typeof parsed.key === 'string' ? parsed.key : '';
    if (!key) continue;
    const type = typeof parsed.type === 'string' ? parsed.type : 'file';
    const size = typeof parsed.size === 'number' && Number.isFinite(parsed.size) ? parsed.size : 0;
    files.push({ key, sizeBytes: size, isDir: type === 'folder' || type === 'dir' || key.endsWith('/') });
  }
  const objects = files.filter((f) => !f.isDir);
  return { count: objects.length, totalBytes: objects.reduce((s, o) => s + o.sizeBytes, 0), objects };
}

export interface McStatEntry {
  key: string;
  sizeBytes: number;
  /** 服务端 ETag（**单段上传时为对象内容的 MD5**；多段上传带 `-N` 后缀，此时不可当 md5 用） */
  etag: string;
  /** ETag 是否可用作 md5 比对（32 位十六进制、无 `-N` 后缀） */
  etagIsMd5: boolean;
}

/** 剥掉 ETag 的引号（S3 协议里 ETag 常带双引号；mc 一般已剥好，但两种都要能读）。 */
export function normalizeEtag(raw: string): string {
  return raw.trim().replace(/^"+|"+$/g, '').toLowerCase();
}

/** ETag 能否当 md5 用：单段上传 = 32 位十六进制；多段上传形如 `<md5>-<parts>`。 */
export function etagAsMd5(raw: string): string | null {
  const etag = normalizeEtag(raw);
  return /^[0-9a-f]{32}$/.test(etag) ? etag : null;
}

/**
 * 解析 `mc stat --json <target>` 的单行 JSON。
 * 用途：**上传后零传输的内容级核对**——比体积更能发现"传了别的对象/被覆盖"，
 * 又不必像 `mc cat` 那样把整个对象拉回来（GB 级备份不适合）。
 * 解析不出 ⇒ null（调用方降级为"只比体积"，并如实标注，不假装核对过）。
 *
 * 字段形态（M11-P9 实测教训）：**对象名在 `stat` 里叫 `name`，在 `ls --json` 里才叫 `key`**。
 * 早期版本只认 `key` ⇒ 解析恒为 null ⇒ ETag 明明在响应里却被丢掉，上传核对悄悄降级成
 * "只比了体积"，而且日志会让人以为服务端没给 ETag（错误归因）。两种字段都认。
 */
export function parseMcStatJson(text: string): McStatEntry | null {
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line.startsWith('{')) continue;
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    const key = typeof parsed.key === 'string' && parsed.key ? parsed.key : typeof parsed.name === 'string' ? parsed.name : '';
    if (!key) continue;
    const size = typeof parsed.size === 'number' && Number.isFinite(parsed.size) ? parsed.size : 0;
    const etagRaw = typeof parsed.etag === 'string' ? parsed.etag : '';
    const etag = normalizeEtag(etagRaw);
    return { key, sizeBytes: size, etag, etagIsMd5: etagAsMd5(etag) !== null };
  }
  return null;
}

export interface MirrorDiff {
  ok: boolean;
  missingInTarget: string[];
  extraInTarget: string[];
  sizeMismatch: { key: string; sourceBytes: number; targetBytes: number }[];
}

/**
 * 核对源/目标（对象数 + 逐对象体积 + 总体积）。任何一项不等 ⇒ ok=false ⇒ 脚本非 0 退出。
 * 只比 key 与 size：内容级核对用 `--checksum-sample N`（对抽样对象做 md5 比对），
 * 因为在 GB 级桶上做全量哈希是 O(全量读取)，不适合每日 mirror。
 */
export function diffMirror(source: McMirrorSummary, target: McMirrorSummary): MirrorDiff {
  const srcMap = new Map(source.objects.map((o) => [o.key, o.sizeBytes]));
  const dstMap = new Map(target.objects.map((o) => [o.key, o.sizeBytes]));
  const missingInTarget: string[] = [];
  const extraInTarget: string[] = [];
  const sizeMismatch: { key: string; sourceBytes: number; targetBytes: number }[] = [];
  for (const [key, size] of srcMap) {
    if (!dstMap.has(key)) missingInTarget.push(key);
    else if (dstMap.get(key) !== size) sizeMismatch.push({ key, sourceBytes: size, targetBytes: dstMap.get(key) as number });
  }
  for (const key of dstMap.keys()) if (!srcMap.has(key)) extraInTarget.push(key);
  return {
    ok: missingInTarget.length === 0 && extraInTarget.length === 0 && sizeMismatch.length === 0,
    missingInTarget,
    extraInTarget,
    sizeMismatch,
  };
}

/**
 * 从对象清单里确定性地抽 N 个 key 做内容级校验（可复现：同一清单永远抽同一批）。
 * 首尾都取到（i=0 → 第一个，i=n-1 → 最后一个），中间等距——比"截前 N 个"更能暴露尾部缺失。
 */
export function sampleKeys(summary: McMirrorSummary, n: number): string[] {
  if (n <= 0) return [];
  const keys = summary.objects.map((o) => o.key).sort();
  if (keys.length <= n) return keys;
  if (n === 1) return [keys[Math.floor(keys.length / 2)]];
  const step = (keys.length - 1) / (n - 1);
  const picked: string[] = [];
  for (let i = 0; i < n; i += 1) picked.push(keys[Math.min(keys.length - 1, Math.round(i * step))]);
  return [...new Set(picked)];
}

/** 构造 `MC_HOST_<alias>` 的值（凭证 URL-encoded，避免含 `@`/`:` 的密钥破坏 URL 结构）。 */
export function hostEnvValue(opts: { origin: string; accessKey: string; secretKey: string }): string {
  const origin = /^https?:\/\//.test(opts.origin) ? opts.origin : `http://${opts.origin}`;
  const url = new URL(origin);
  return `${url.protocol}//${encodeURIComponent(opts.accessKey)}:${encodeURIComponent(opts.secretKey)}@${url.host}`;
}

// ===== M12-P5：临时凭证文件的**信号清理**（SIGINT/SIGTERM 不留残留）=====

/** 信号源（可注入：单测用假信号源验证"清理 + 退出码"，绝不真的杀测试进程） */
export interface SignalSource {
  on(signal: NodeJS.Signals, listener: () => void): unknown;
  off(signal: NodeJS.Signals, listener: () => void): unknown;
  exit(code: number): void;
  /** 退出前的留痕（默认写 stderr；注入以便断言文案） */
  notify(message: string): void;
}

const DEFAULT_SIGNAL_SOURCE: SignalSource = {
  on: (signal, listener) => process.on(signal, listener),
  off: (signal, listener) => process.off(signal, listener),
  exit: (code) => process.exit(code),
  notify: (message) => process.stderr.write(message),
};

/** 信号 → 退出码（shell 惯例 128+signo：SIGINT=2→130、SIGTERM=15→143） */
export const SIGNAL_EXIT_CODES: Readonly<Record<string, number>> = { SIGINT: 130, SIGTERM: 143 };
const HANDLED_SIGNALS: readonly NodeJS.Signals[] = ['SIGINT', 'SIGTERM'];

/** 进程内**存活**的临时凭证文件（现阶段只有 docker 模式的 env 文件；native 模式凭证只经环境变量，不落盘） */
const liveTempEnvFiles = new Set<{ path: string; dispose: () => void }>();
const listeners = new Map<NodeJS.Signals, () => void>();
let signalSource: SignalSource = DEFAULT_SIGNAL_SOURCE;
let installed = false;

/** 删除全部存活临时凭证文件，返回清理个数（幂等；清理失败不抛——绝不因清理失败卡住退出） */
export function disposeAllTempEnvFiles(): number {
  const entries = [...liveTempEnvFiles];
  liveTempEnvFiles.clear();
  for (const entry of entries) {
    try {
      entry.dispose();
    } catch {
      /* 逐个兜底：一个删不掉不影响其余 */
    }
  }
  if (liveTempEnvFiles.size === 0) uninstallSignalHandlers();
  return entries.length;
}

/** 存活临时凭证文件数（观测/测试用） */
export function liveTempEnvFileCount(): number {
  return liveTempEnvFiles.size;
}

/**
 * **仅供测试**：注入信号源并重置状态（`null` = 还原默认源）。
 * 生产代码绝不调用——信号源在生产恒为 process。
 */
export function __setSignalSourceForTest(source: SignalSource | null): void {
  uninstallSignalHandlers();
  disposeAllTempEnvFiles();
  signalSource = source ?? DEFAULT_SIGNAL_SOURCE;
}

/** **仅供测试**：信号处理器是否已接管（空转时必须为 false） */
export function __isSignalCleanupInstalledForTest(): boolean {
  return installed;
}

function handleSignal(signal: NodeJS.Signals): void {
  const cleaned = disposeAllTempEnvFiles(); // 先删凭证文件（幂等），任何情况下都不带着残留退出
  uninstallSignalHandlers();
  signalSource.notify(`[mc] 收到 ${signal}：已清理 ${cleaned} 个含凭证的临时文件\n`);
  signalSource.exit(SIGNAL_EXIT_CODES[signal] ?? 1);
}

/** 接管信号（仅在**有临时凭证文件在场**时；幂等） */
function installSignalHandlers(): void {
  if (installed) return;
  for (const signal of HANDLED_SIGNALS) {
    const listener = () => handleSignal(signal);
    listeners.set(signal, listener);
    signalSource.on(signal, listener);
  }
  installed = true;
}

/** 卸载信号处理器（临时文件清零后调用——空转时不改变进程原有的信号语义） */
function uninstallSignalHandlers(): void {
  if (!installed) return;
  for (const [signal, listener] of listeners) signalSource.off(signal, listener);
  listeners.clear();
  installed = false;
}

/**
 * 临时 env 文件（0600；用完必删）。内容含密钥 ⇒ 只在临时目录、只通过 `--env-file` 传给 docker。
 * 创建即登记进存活集合（安装信号清理）；`dispose()` 幂等（重复调用无副作用）。
 */
export function createTempEnvFile(vars: Record<string, string>): { path: string; dispose: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'm10p9-mc-'));
  const path = join(dir, 'mc.env');
  writeFileSync(path, `${Object.entries(vars).map(([k, v]) => `${k}=${v}`).join('\n')}\n`, { mode: 0o600 });
  try {
    chmodSync(path, 0o600);
  } catch {
    /* Windows 上 chmod 语义有限；文件在临时目录且用完即删，不阻断 */
  }
  const entry = {
    path,
    dispose: () => {
      liveTempEnvFiles.delete(entry);
      if (liveTempEnvFiles.size === 0) uninstallSignalHandlers();
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        /* 清理失败不影响结果 */
      }
    },
  };
  liveTempEnvFiles.add(entry);
  installSignalHandlers();
  return entry;
}

export interface McRunOptions {
  /** 需要挂进容器的宿主机目录（本地目录 mirror 用） */
  mounts?: { hostPath: string; containerPath: string }[];
  timeoutMs?: number;
  quiet?: boolean;
  /** 保留原始 stdout 字节（二进制对象哈希） */
  captureBinary?: boolean;
}

/** 一次性 mc 客户端。每次调用都重新注入凭证环境（无状态残留）。 */
export class McClient {
  private readonly opts: Required<Pick<McOptions, 'mode' | 'alias' | 'origin' | 'image' | 'network' | 'dockerBin' | 'mcBin'>> &
    Pick<McOptions, 'accessKey' | 'secretKey'>;

  constructor(options: McOptions) {
    this.opts = {
      mode: options.mode,
      alias: options.alias ?? 'm10',
      origin: options.origin,
      accessKey: options.accessKey,
      secretKey: options.secretKey,
      image: options.image ?? 'quay.io/minio/mc:latest',
      network: options.network ?? 'container:docker-minio-1',
      dockerBin: options.dockerBin ?? 'docker',
      mcBin: options.mcBin ?? 'mc',
    };
  }

  get description(): string {
    return this.opts.mode === 'docker'
      ? `docker run --rm --network ${this.opts.network} ${this.opts.image}（别名 ${this.opts.alias}）`
      : `${this.opts.mcBin}（直连 ${this.opts.origin}）`;
  }

  /** 桶引用：`<alias>/<bucket>`。 */
  ref(bucket: string): string {
    return `${this.opts.alias}/${bucket}`;
  }

  async exec(clientArgs: readonly string[], options: McRunOptions = {}): Promise<RunResult> {
    const env = { [`MC_HOST_${this.opts.alias}`]: hostEnvValue(this.opts) };
    if (this.opts.mode === 'native') {
      return run(this.opts.mcBin, [...clientArgs], {
        env: { ...process.env, ...env },
        timeoutMs: options.timeoutMs,
        quiet: options.quiet,
        captureBinary: options.captureBinary,
      });
    }
    const envFile = createTempEnvFile(env);
    try {
      const args = ['run', '--rm'];
      if (this.opts.network) args.push('--network', this.opts.network);
      args.push('--env-file', envFile.path);
      for (const mount of options.mounts ?? []) args.push('-v', `${mount.hostPath}:${mount.containerPath}`);
      args.push('--entrypoint', 'mc', this.opts.image, ...clientArgs);
      return await run(this.opts.dockerBin, args, {
        timeoutMs: options.timeoutMs,
        quiet: options.quiet,
        captureBinary: options.captureBinary,
      });
    } finally {
      envFile.dispose();
    }
  }

  /** `mc ls -r --json`（用于对象数/体积核对）。 */
  async list(remote: string, options: McRunOptions = {}): Promise<RunResult> {
    return this.exec(['ls', '-r', '--json', remote], options);
  }

  /** 读对象的字节（内容级抽样校验用；`captureBinary` 打开后取 `stdoutBuffer`）。 */
  async cat(remote: string, options: McRunOptions = {}): Promise<RunResult> {
    return this.exec(['cat', remote], { captureBinary: true, ...options });
  }

  /** `mc stat --json`（零传输拿到 size + ETag：单段对象 ETag == 内容 md5）。 */
  async stat(remote: string, options: McRunOptions = {}): Promise<RunResult> {
    return this.exec(['stat', '--json', remote], { quiet: true, ...options });
  }

  async makeBucket(bucket: string, options: McRunOptions = {}): Promise<RunResult> {
    return this.exec(['mb', '--ignore-existing', this.ref(bucket)], options);
  }

  async removeBucket(bucket: string, options: McRunOptions = {}): Promise<RunResult> {
    return this.exec(['rb', '--force', this.ref(bucket)], options);
  }

  /** docker 模式下 `mc` 只认得容器内路径 ⇒ 本地目录必须映射成容器内路径（native 模式不需要）。 */
  mountFor(hostDir: string, containerPath: string, mode: McMode): { hostPath: string; containerPath: string }[] {
    return mode === 'docker' ? [{ hostPath: hostDir, containerPath }] : [];
  }
}

/** 本地目录 mirror 的容器内目标路径。 */
export const MC_CONTAINER_TARGET = '/mnt/target';

/** 桶名合法性（mirror 目标/源都必须是显式给出的桶名，绝不从对象 key 推导）。 */
export function isBucketName(ref: string): boolean {
  return /^[a-z0-9][a-z0-9.-]{1,62}$/.test(ref);
}

/**
 * 本地目录清单（对象数 + 总体积）——与桶侧 `parseMcListJson` **同一数据结构与口径**，
 * 这样"桶 ↔ 目录"的核对可以用同一个 `diffMirror()`，不会出现两套口径。
 */
export function summarizeDir(dir: string): McMirrorSummary {
  const objects: McListEntry[] = [];
  const walk = (current: string) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) objects.push({ key: relative(dir, full).split('\\').join('/'), sizeBytes: statSync(full).size, isDir: false });
    }
  };
  walk(dir);
  return { count: objects.length, totalBytes: objects.reduce((s, o) => s + o.sizeBytes, 0), objects };
}

/** 报错信息脱敏 + 截断（mc 的错误偶尔带签名 URL）。 */
export function safeMcError(res: RunResult): string {
  return redactSecrets((res.stderr || res.stdout).trim()).slice(0, 800);
}
