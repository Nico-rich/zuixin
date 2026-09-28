/**
 * M10-P9 运维脚本公共壳：日志、退出码、子进程执行、体积/耗时格式化。
 *
 * 纪律（与 `docs/operations/m8-disaster-recovery.md` 一致）：
 * - **绝不打印密钥**：所有回显路径都必须经过 `redactSecrets()`（credential/连接串只显示用户名与库名）；
 * - **退出码即契约**：编排（cron/K8s Job/CI）靠退出码判定成败，不允许"失败了但 exit 0"；
 * - 子进程统一 `spawn`（不经 shell）⇒ 无 shell 注入面、参数传递无引号歧义（Windows 亦一致）。
 */

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, WriteStream } from 'node:fs';
import type { Readable } from 'node:stream';

export const EXIT_OK = 0;
export const EXIT_FAIL = 1;
export const EXIT_USAGE = 2;
export const EXIT_VERIFY = 3;
export const EXIT_PRECONDITION = 4;

export const DEFAULT_EXIT_CODES: readonly [string, string][] = [
  ['0', '成功'],
  ['1', '执行失败（命令非 0 退出 / IO 错误）'],
  ['2', '参数错误（未知参数、取值非法、缺少必填项）'],
  ['3', '校验失败（备份/恢复结果与期望不一致）'],
  ['4', '前置条件不满足（依赖缺失、目标库不安全、文件不存在）'],
];

export interface Logger {
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
  step(msg: string): void;
  raw(msg: string): void;
}

/** 纯文本日志（不含颜色：CI 日志要可 grep、可存档）。 */
export function createLogger(scope: string): Logger {
  const stamp = () => new Date().toISOString();
  const emit = (level: string, msg: string) => process.stdout.write(`${stamp()} [${level}] [${scope}] ${msg}\n`);
  return {
    info: (m) => emit('info', m),
    warn: (m) => emit('warn', m),
    error: (m) => emit('error', m),
    step: (m) => emit('step', `→ ${m}`),
    raw: (m) => process.stdout.write(`${m}\n`),
  };
}

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
  durationMs: number;
  /** 命令是否根本没跑起来（ENOENT 等） */
  spawnError?: string;
  command: string;
  /** captureBinary=true 时的原始字节（二进制对象做 md5 用；stdout 的 utf8 解码对二进制是有损的） */
  stdoutBuffer?: Buffer;
}

export interface RunOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /** 需要喂给子进程的 stdin（Buffer 或流）；未提供则忽略 stdin */
  stdin?: NodeJS.ReadableStream | Buffer | string;
  /** 把 stdout 直接落到该文件（大 dump 用；此时 stdout 不留在内存里） */
  stdoutToFile?: string;
  /** 超时（ms）；超时会 kill 子进程并返回 code=124 */
  timeoutMs?: number;
  /** 静默（不打印命令回显） */
  quiet?: boolean;
  /** 额外保留原始 stdout 字节（二进制内容哈希用） */
  captureBinary?: boolean;
}

/**
 * 执行子进程并收集结果。**不经 shell**：命令与参数数组直达 execve。
 *
 * 注意：`stdoutToFile` 与 `stdout` 收集互斥；两者都不传时 stdout 被丢弃（仅看退出码的探针用）。
 */
export function run(command: string, args: readonly string[], options: RunOptions = {}): Promise<RunResult> {
  return new Promise((resolve) => {
    const started = Date.now();
    const display = [command, ...args.map(quoteForDisplay)].join(' ');
    if (!options.quiet) process.stdout.write(`${new Date().toISOString()} [exec] ${redactSecrets(display)}\n`);
    let child;
    try {
      child = spawn(command, [...args], {
        cwd: options.cwd,
        env: options.env ?? process.env,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } catch (err) {
      resolve({
        code: -1,
        stdout: '',
        stderr: '',
        durationMs: Date.now() - started,
        spawnError: (err as Error).message,
        command: display,
        stdoutBuffer: options.captureBinary ? Buffer.alloc(0) : undefined,
      });
      return;
    }

    const outChunks: Buffer[] = [];
    const errChunks: Buffer[] = [];
    let sink: WriteStream | null = null;
    if (options.stdoutToFile) sink = createWriteStream(options.stdoutToFile);
    let timedOut = false;
    const timer = options.timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          child.kill('SIGKILL');
        }, options.timeoutMs)
      : null;

    child.stdout.on('data', (chunk: Buffer) => {
      if (sink) sink.write(chunk);
      else outChunks.push(chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => errChunks.push(chunk));

    if (options.stdin !== undefined) {
      if (typeof options.stdin === 'string' || Buffer.isBuffer(options.stdin)) child.stdin.end(options.stdin);
      else options.stdin.pipe(child.stdin);
    } else {
      child.stdin.end();
    }

    const done = (code: number, spawnError?: string) => {
      if (timer) clearTimeout(timer);
      if (sink) sink.end();
      const outBuffer = Buffer.concat(outChunks);
      resolve({
        code: timedOut ? 124 : code,
        stdout: outBuffer.toString('utf8'),
        stderr: Buffer.concat(errChunks).toString('utf8'),
        durationMs: Date.now() - started,
        spawnError,
        command: display,
        stdoutBuffer: options.captureBinary ? outBuffer : undefined,
      });
    };

    child.on('error', (err) => done(-1, err.message));
    child.on('close', (code) => done(code ?? -1));
  });
}

export interface StreamingChild {
  /** 子进程 stdout（**作为流**交给下游：gpg 解密的明文直接进 psql，不经过内存） */
  stdout: Readable;
  /** 子进程结束/失败后的结论（默认不 reject；stderr 已收集并截断） */
  done: Promise<Omit<RunResult, 'stdout' | 'stdoutBuffer'>>;
}

/**
 * 与 `run()` 同源的启动方式，但 **stdout 作为流返回**（用于"解密 → psql"这类管道）：
 * - 同样不经 shell、同样回显脱敏命令（口令只走 stdin，绝不进 argv）；
 * - stderr 由本函数收集（管道下游只消费 stdout，留一份给失败诊断）；
 * - `stdin` 支持一次性写入的 Buffer/string 或流：gpg 的口令就是一次性 Buffer。
 */
export function spawnStreaming(
  command: string,
  args: readonly string[],
  options: { stdin?: NodeJS.ReadableStream | Buffer | string; env?: NodeJS.ProcessEnv; quiet?: boolean } = {},
): StreamingChild {
  const started = Date.now();
  const display = [command, ...args.map(quoteForDisplay)].join(' ');
  if (!options.quiet) process.stdout.write(`${new Date().toISOString()} [exec] ${redactSecrets(display)}\n`);
  const child = spawn(command, [...args], {
    env: options.env ?? process.env,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  const errChunks: Buffer[] = [];
  child.stderr.on('data', (chunk: Buffer) => {
    // 上限 64KB：失败诊断够用，且绝不因为下游不读 stderr 而积压内存
    if (errChunks.length < 512) errChunks.push(chunk);
  });
  if (options.stdin !== undefined) {
    if (typeof options.stdin === 'string' || Buffer.isBuffer(options.stdin)) child.stdin.end(options.stdin);
    else options.stdin.pipe(child.stdin);
  } else {
    child.stdin.end(); // 关掉 stdin：gpg 在 --batch 下宁可失败也不去等一个永不到来的口令
  }
  const done = new Promise<Omit<RunResult, 'stdout' | 'stdoutBuffer'>>((resolve) => {
    child.on('error', (err) =>
      resolve({ code: -1, stderr: Buffer.concat(errChunks).toString('utf8'), durationMs: Date.now() - started, spawnError: err.message, command: display }),
    );
    child.on('close', (code) =>
      resolve({ code: code ?? -1, stderr: Buffer.concat(errChunks).toString('utf8'), durationMs: Date.now() - started, command: display }),
    );
  });
  return { stdout: child.stdout, done };
}

/** 命令是否可用（`--version` 探针）。 */
export async function commandExists(command: string): Promise<boolean> {
  const res = await run(command, ['--version'], { quiet: true, timeoutMs: 15_000 });
  return !res.spawnError && res.code === 0;
}

function quoteForDisplay(arg: string): string {
  return /[\s"']/.test(arg) ? `"${arg.replace(/"/g, '\\"')}"` : arg;
}

/**
 * 回显脱敏：把 `postgresql://user:pass@host/db` 之类连接串折叠为 `postgresql://user:***@host/db`。
 * 只用于**日志展示**；真实参数仍按原值传给子进程。
 */
export function redactSecrets(text: string): string {
  return text
    .replace(/([a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^:@/\s]+):([^@/\s]+)@/g, '$1:***@')
    .replace(/(PGPASSWORD=)[^\s"']+/gi, '$1***')
    .replace(/(--password[= ])[^\s"']+/gi, '$1***')
    .replace(/(AWS_SECRET_ACCESS_KEY=)[^\s"']+/gi, '$1***');
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return 'n/a';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${unit === 0 ? value : Number(value.toFixed(2))} ${units[unit]}（${bytes} 字节）`;
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(2)}s`;
  const m = Math.floor(ms / 60_000);
  const s = ((ms % 60_000) / 1000).toFixed(1);
  return `${m}m${s}s`;
}

/** 本地时间戳（备份文件名用；与 m8 手册 `date +%Y%m%d-%H%M%S` 同形）。 */
export function stamp(d: Date = new Date()): string {
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

export function sha256File(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(path);
    stream.on('error', reject);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

/**
 * 对**流**求 sha256（加密自检用：把 gpg 解密后的字节直接哈希，不落临时明文文件）。
 * 顺序：必须先读完流再取哈希；出错时 reject（调用方转为非 0 退出码）。
 */
export function sha256Stream(stream: Readable): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    stream.on('error', reject);
    stream.on('data', (chunk: Buffer) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

/**
 * 文件的 MD5（**只用于与 S3/MinIO 单段对象的 ETag 比对**——ETag 对单段上传即对象内容的 MD5）。
 * 不用于任何安全用途（MD5 已不抗碰撞；这里是"传输完整性"而非"防篡改"，防篡改由 sha256 + gpg 承担）。
 */
export function md5File(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('md5');
    const stream = createReadStream(path);
    stream.on('error', reject);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

/** 统一的失败出口（打印原因 + 退出码语义）。 */
export function fail(logger: Logger, message: string, code: number = EXIT_FAIL): never {
  logger.error(message);
  process.exit(code);
}
