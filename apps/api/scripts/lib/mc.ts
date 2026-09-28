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

/** 临时 env 文件（0600；用完必删）。内容含密钥 ⇒ 只在临时目录、只通过 `--env-file` 传给 docker。 */
export function createTempEnvFile(vars: Record<string, string>): { path: string; dispose: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'm10p9-mc-'));
  const path = join(dir, 'mc.env');
  writeFileSync(path, `${Object.entries(vars).map(([k, v]) => `${k}=${v}`).join('\n')}\n`, { mode: 0o600 });
  try {
    chmodSync(path, 0o600);
  } catch {
    /* Windows 上 chmod 语义有限；文件在临时目录且用完即删，不阻断 */
  }
  return {
    path,
    dispose: () => {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        /* 清理失败不影响结果 */
      }
    },
  };
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
