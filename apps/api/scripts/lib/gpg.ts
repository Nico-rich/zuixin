/**
 * M11-P9 运维脚本：gpg 静态加密原语（**口令绝不进 argv**）。
 *
 * 审计 D1-13：备份产物此前只有 gzip（**压缩不是加密**）。备份文件常常要出仓库
 * （异地桶 / 离线介质 / 工单附件），而 pg_dump 明文里含用户表数据、凭证密文、审计记录——
 * 一旦落进对象存储就等于把数据库内容复制了一份到另一个信任域。
 *
 * 本模块只做三件事（其余留给 artifact.ts 组合）：
 *   1. 构造 gpg 的 **argv**（纯函数、可单测：断言口令不出现在参数里）；
 *   2. 解析口令的**存在性**（只报有没有/长度，绝不回显值）；
 *   3. 加密文件（口令经 stdin 传给子进程；对称模式用 AES256）。
 *
 * 密钥纪律（与 lib/mc.ts 同一条纪律）：
 * - 对称口令只经 `BACKUP_GPG_PASSPHRASE` 环境变量进入进程，再经 **stdin** 交给 gpg；
 * - `argv` 里只有算法/文件路径（`ps`/`docker ps`/审计日志看不到口令）；
 * - 所有回显走 `redactSecrets()`，且口令长度之外不提供任何信息。
 *
 * 两种模式：
 * - **对称**（默认）：`--symmetric`，口令来自环境变量。适合"密钥与备份分开保管"（Vault/KMS/K8s Secret）；
 * - **公钥**：`--encrypt --recipient <keyid|email>`，加密只需要公钥、解密需要私钥在 keyring 里，
 *   运维机器上**不需要**放口令（生产推荐）。
 */

import { existsSync, statSync } from 'node:fs';

import { redactSecrets, run, type RunResult } from './cli';

/** 对称口令的环境变量名（**唯一**的密钥入口；不要加命令行选项）。 */
export const GPG_PASSPHRASE_ENV = 'BACKUP_GPG_PASSPHRASE';

/** 对称加密的默认算法（gpg 2.4 亦为默认；显式写出便于审计与跨版本一致）。 */
export const GPG_CIPHER_ALGO = 'AES256';

export type GpgMode = 'symmetric' | 'public-key';

export interface PassphrasePresence {
  present: boolean;
  /** 环境变量名（值本身绝不返回） */
  envName: string;
  /** 长度（长度不是秘密；用于发现"配了个占位符"这类事故） */
  length: number;
  /** 是否命中已知占位符（`.env.example` 里的模板值） */
  looksLikePlaceholder: boolean;
}

/** 已知占位符（与 lib/env.ts 的口径一致；出现在生产环境等于没配）。 */
const PLACEHOLDER_PASSPHRASES: readonly string[] = ['change_me', 'changeme', 'password', 'passphrase', 'test', 'minioadmin', 'admin123456'];

/** 口令存在性（只读环境；调用方负责在缺失时以退出码 4 拒绝继续）。 */
export function passphrasePresence(envName: string = GPG_PASSPHRASE_ENV): PassphrasePresence {
  const value = process.env[envName];
  const present = value !== undefined && value !== '';
  return {
    present,
    envName,
    length: present ? (value as string).length : 0,
    looksLikePlaceholder: present ? PLACEHOLDER_PASSPHRASES.includes((value as string).toLowerCase()) : false,
  };
}

/**
 * 对称加密 argv。
 * 关键点：`--passphrase-fd 0` + `--pinentry-mode loopback` ⇒ 口令从 **stdin** 读，
 * 派生自 gpg 的 S2K（迭代+加盐，默认值）而不是命令行；`--compress-algo none` 是因为
 * 产物已经过 gzip（再压一次只花 CPU、不改体积），且让密文大小可预测。
 */
export function buildGpgSymmetricEncryptArgs(opts: { inPath: string; outPath: string; cipher?: string }): string[] {
  return [
    '--batch',
    '--yes',
    '--pinentry-mode',
    'loopback',
    '--passphrase-fd',
    '0',
    '--symmetric',
    '--cipher-algo',
    opts.cipher ?? GPG_CIPHER_ALGO,
    '--compress-algo',
    'none',
    '--output',
    opts.outPath,
    '--',
    opts.inPath,
  ];
}

/**
 * 公钥加密 argv（recipient 是**公钥标识**，不是密钥材料 ⇒ 可以进 argv）。
 * `--trust-model always`：收件人由运维显式给出，密钥的信任度由 keyring 导入流程负责，
 * 这里不该因为"没签名"而拒绝加密（否则备份任务会静默失败）。
 */
export function buildGpgPublicKeyEncryptArgs(opts: { inPath: string; outPath: string; recipient: string }): string[] {
  return [
    '--batch',
    '--yes',
    '--trust-model',
    'always',
    '--encrypt',
    '--recipient',
    opts.recipient,
    '--compress-algo',
    'none',
    '--output',
    opts.outPath,
    '--',
    opts.inPath,
  ];
}

/**
 * 解密 argv（对称/公钥通用：gpg 从数据包自行判定）。
 *
 * **恒用 loopback + `--passphrase-fd 0`**（实测教训）：不加 loopback 时，只要环境里装了 pinentry，
 * gpg 就会**弹出 GUI 口令框并一直等**——在无人值守的备份/恢复 Job 里表现为"挂住不动"，
 * 比报错难排查得多。loopback 下：口令给对了就解，没给/给错就立刻以非 0 退出（stdin 关闭 ⇒ 空口令 ⇒ 快速失败）。
 * 公钥模式的私钥若无口令，gpg 根本不会去读 stdin，因此这条参数对它是无副作用的。
 */
export function buildGpgDecryptArgs(opts: { inPath: string }): string[] {
  return ['--batch', '--yes', '--pinentry-mode', 'loopback', '--passphrase-fd', '0', '--decrypt', '--', opts.inPath];
}

/** 加密模式的可打印描述（不含任何密钥材料）。 */
export function describeGpgMode(mode: { kind: GpgMode; recipient?: string | null }): string {
  if (mode.kind === 'public-key') return `gpg 公钥加密（--recipient ${mode.recipient ?? '?'}）`;
  return `gpg 对称加密（${GPG_CIPHER_ALGO}，口令来自环境变量 ${GPG_PASSPHRASE_ENV}）`;
}

/** gpg 是否可用（加密前的前置检查；缺失时以退出码 4 拒绝，绝不静默降级为明文）。 */
export async function gpgAvailable(bin = 'gpg'): Promise<{ ok: boolean; version: string }> {
  const res = await run(bin, ['--version'], { quiet: true, timeoutMs: 20_000 });
  if (res.spawnError || res.code !== 0) return { ok: false, version: '' };
  return { ok: true, version: res.stdout.split(/\r?\n/)[0]?.trim() ?? '' };
}

export interface EncryptFileResult {
  ok: boolean;
  detail: string;
  outBytes: number;
  durationMs: number;
}

/**
 * 加密一个文件（**同步失败必须体现在返回值上**：调用方据此以非 0 退出码拒绝继续）。
 *
 * `passphrase` 只在对称模式使用：经 stdin 写进子进程，随后立即关闭 stdin；
 * 该值绝不进入 `run()` 的 argv、也绝不进入日志（`run()` 的 `[exec]` 行只回显命令与参数）。
 */
export async function encryptFile(opts: {
  inPath: string;
  outPath: string;
  mode: { kind: GpgMode; recipient?: string | null };
  passphrase?: string | null;
  bin?: string;
  timeoutMs?: number;
}): Promise<EncryptFileResult> {
  const bin = opts.bin ?? 'gpg';
  const args =
    opts.mode.kind === 'public-key'
      ? buildGpgPublicKeyEncryptArgs({ inPath: opts.inPath, outPath: opts.outPath, recipient: String(opts.mode.recipient) })
      : buildGpgSymmetricEncryptArgs({ inPath: opts.inPath, outPath: opts.outPath });
  const stdin = opts.mode.kind === 'symmetric' ? `${opts.passphrase ?? ''}\n` : undefined;
  const res: RunResult = await run(bin, args, { stdin, timeoutMs: opts.timeoutMs ?? 3_600_000, env: process.env });
  const outBytes = existsSync(opts.outPath) ? statSync(opts.outPath).size : 0;
  if (res.spawnError) return { ok: false, detail: `gpg 无法执行：${res.spawnError}`, outBytes, durationMs: res.durationMs };
  if (res.code !== 0) {
    return { ok: false, detail: `gpg 加密失败（退出码 ${res.code}）：${redactSecrets(res.stderr.trim()).slice(0, 400)}`, outBytes, durationMs: res.durationMs };
  }
  if (outBytes === 0) return { ok: false, detail: 'gpg 产物为 0 字节（加密未生效）', outBytes, durationMs: res.durationMs };
  return { ok: true, detail: `gpg 退出码 0，产物 ${outBytes} 字节`, outBytes, durationMs: res.durationMs };
}

/** 供"生产环境自检"用的可读结论（不回显口令）。 */
export async function gpgPreflight(opts: { mode: { kind: GpgMode; recipient?: string | null }; bin?: string }): Promise<{ ok: boolean; detail: string }> {
  const available = await gpgAvailable(opts.bin);
  if (!available.ok) return { ok: false, detail: `找不到可用的 gpg（PATH 里没有 ${opts.bin ?? 'gpg'}）：加密备份无法执行` };
  if (opts.mode.kind === 'public-key') {
    const res = await run(opts.bin ?? 'gpg', ['--batch', '--list-keys', '--', String(opts.mode.recipient)], { quiet: true, timeoutMs: 30_000 });
    if (res.code !== 0) {
      return { ok: false, detail: `keyring 里没有收件人公钥 "${opts.mode.recipient}"（先 gpg --import 或改用对称模式）` };
    }
    return { ok: true, detail: `${available.version}；${describeGpgMode(opts.mode)}` };
  }
  const presence = passphrasePresence();
  if (!presence.present) return { ok: false, detail: `缺少环境变量 ${presence.envName}（对称加密的口令入口）` };
  if (presence.looksLikePlaceholder) return { ok: false, detail: `${presence.envName} 是占位符值（长度 ${presence.length}）——请换成真实口令` };
  if (presence.length < 16) return { ok: false, detail: `${presence.envName} 长度只有 ${presence.length}（建议 ≥ 32 字符的随机串）` };
  return { ok: true, detail: `${available.version}；${describeGpgMode(opts.mode)}，口令已设置（长度 ${presence.length}，不回显）` };
}
