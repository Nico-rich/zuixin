import { Injectable } from '@nestjs/common';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { AppError, ErrorCode } from '../../common/errors/app-error';

const ALGO = 'aes-256-gcm';

/**
 * M10-P1 SA-12：**密钥版本化轮换**（Credential.keyVersion 已由 W0 建列）。
 *
 * 问题：`ENCRYPTION_KEY` 是"设置后不可更改"的单密钥——一旦需要轮换（泄漏/合规/定期轮换），
 * 存量密文全部不可解（要么停机重加密，要么永久丢失凭证）。
 *
 * 方案：
 * - **多密钥并存**：env `ENCRYPTION_KEYS="1:<旧>,2:<当前>"`（版本号增量，最高版本 = 当前写入版本）；
 *   单 `ENCRYPTION_KEY` 仍有效，等价于"只有版本 1"（**完全向后兼容**，零迁移即可上线）。
 * - **密文自述版本**：新密文格式 `v{n}.{iv}.{tag}.{data}`；历史密文（3 段，无前缀）按**版本 1** 解读。
 *   自述版本比"靠外部列记版本"更稳：没有版本列的既有落库点（webhook secret / provider apiKey /
 *   extension apiKey）也能随之轮换。
 * - **解密按版本选 key；未知版本 → `KEY_VERSION_INVALID`（绝不静默降级）**：
 *   静默降级（例如"解不开就试当前 key"）会在轮换期把"版本错配"伪装成"数据损坏"，
 *   更糟的情况是让攻击者用旧密钥解密新密文。
 * - **rewrap**：把旧版本密文重加密为当前版本（`{ from, to }` 可审计）。`assertCurrentVersion` 对
 *   "仍在使用旧版本"的调用点抛 `CREDENTIAL_REWRAP_REQUIRED`（提示需要迁移，而不是继续用旧密钥）。
 */
export class CryptoService {
  private readonly keys: Map<number, Buffer>;
  /** 当前写入版本（最高版本；encrypt 默认用它） */
  readonly currentKeyVersion: number;

  /**
   * @param config 单密钥字符串（= 版本 1，向后兼容）或多版本配置对象
   */
  constructor(config: string | { keys: Record<number, string> | Map<number, string>; currentVersion?: number }) {
    const entries: Array<[number, string]> = typeof config === 'string'
      ? [[1, config]]
      : Object.entries(config.keys instanceof Map ? Object.fromEntries(config.keys) : config.keys)
        .map(([k, v]) => [Number(k), v as string] as [number, string]);

    this.keys = new Map();
    for (const [version, base64] of entries) {
      if (!Number.isInteger(version) || version <= 0) {
        throw new AppError(ErrorCode.KEY_VERSION_INVALID, `密钥版本非法: ${version}（必须是 ≥1 的整数）`);
      }
      const key = Buffer.from(base64 ?? '', 'base64');
      if (key.length !== 32) {
        throw new AppError(ErrorCode.KEY_VERSION_INVALID, `密钥版本 ${version} 必须是 base64 编码的 32 字节密钥`);
      }
      this.keys.set(version, key);
    }
    if (this.keys.size === 0) {
      throw new AppError(ErrorCode.KEY_VERSION_INVALID, '未配置任何加密密钥（ENCRYPTION_KEY 或 ENCRYPTION_KEYS）');
    }
    const explicit = typeof config === 'string' ? undefined : config.currentVersion;
    const highest = Math.max(...this.keys.keys());
    if (explicit !== undefined && !this.keys.has(explicit)) {
      throw new AppError(ErrorCode.KEY_VERSION_INVALID, `当前密钥版本 ${explicit} 未在密钥集中配置`);
    }
    this.currentKeyVersion = explicit ?? highest;
  }

  /** 已配置的密钥版本（升序；诊断/运维用，绝不暴露密钥值） */
  versions(): number[] {
    return [...this.keys.keys()].sort((a, b) => a - b);
  }

  /** 加密（默认用当前版本；可显式指定版本——仅供 rewrap/测试） */
  encrypt(plain: string, keyVersion: number = this.currentKeyVersion): string {
    const key = this.keyOf(keyVersion);
    const iv = randomBytes(12);
    const cipher = createCipheriv(ALGO, key, iv);
    const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return [`v${keyVersion}`, ...[iv, tag, enc].map((b) => b.toString('base64'))].join('.');
  }

  /**
   * 解密（按密文自述的密钥版本选 key）。
   * @throws AppError KEY_VERSION_INVALID 版本未知/密文格式无法判定版本（**绝不回退到其他 key**）
   * @throws AppError CREDENTIAL_REWRAP_REQUIRED `requireCurrent` 且密文版本落后于当前版本
   */
  decrypt(payload: string, opts: { requireCurrent?: boolean } = {}): string {
    const { version, parts } = parsePayload(payload);
    if (opts.requireCurrent && version !== this.currentKeyVersion) {
      throw new AppError(
        ErrorCode.CREDENTIAL_REWRAP_REQUIRED,
        `密文为密钥版本 ${version}，当前版本 ${this.currentKeyVersion}：请先 rewrap 迁移（绝不按当前密钥强解）`,
      );
    }
    const key = this.keyOf(version);
    const [ivB64, tagB64, dataB64] = parts;
    const decipher = createDecipheriv(ALGO, key, Buffer.from(ivB64, 'base64'));
    decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(dataB64, 'base64')), decipher.final()]).toString('utf8');
  }

  /** 密文的密钥版本（历史 3 段格式 = 版本 1） */
  keyVersionOf(payload: string): number {
    return parsePayload(payload).version;
  }

  /** 密文是否需要用当前密钥重新加密（旧版本 = 需要 rewrap） */
  needsRewrap(payload: string): boolean {
    return this.keyVersionOf(payload) !== this.currentKeyVersion;
  }

  /** 断言密文已是当前版本；否则抛 CREDENTIAL_REWRAP_REQUIRED（供"必须用最新密钥"的调用点） */
  assertCurrentVersion(payload: string): void {
    const version = this.keyVersionOf(payload);
    if (version !== this.currentKeyVersion) {
      throw new AppError(
        ErrorCode.CREDENTIAL_REWRAP_REQUIRED,
        `密文为密钥版本 ${version}，当前版本 ${this.currentKeyVersion}：请先 rewrap 迁移`,
      );
    }
  }

  /**
   * 把（任意已配置版本的）密文重加密为**当前版本**。
   * 版本未知时无法恢复明文 → 直接抛 KEY_VERSION_INVALID（绝不猜测/绝不产出"看起来迁移成功"的结果）。
   */
  rewrap(payload: string): { payload: string; from: number; to: number } {
    const from = this.keyVersionOf(payload);
    const plain = this.decrypt(payload); // 版本未知在此抛 KEY_VERSION_INVALID
    return { payload: this.encrypt(plain, this.currentKeyVersion), from, to: this.currentKeyVersion };
  }

  private keyOf(version: number): Buffer {
    const key = this.keys.get(version);
    if (!key) {
      throw new AppError(
        ErrorCode.KEY_VERSION_INVALID,
        `未知密钥版本 ${version}（已配置版本: ${this.versions().join(',') || '无'}）：绝不静默降级解密`,
      );
    }
    return key;
  }
}

/** 密文解析：`v{n}.{iv}.{tag}.{data}`（新）或 `{iv}.{tag}.{data}`（历史，= 版本 1） */
export function parsePayload(payload: string): { version: number; parts: [string, string, string] } {
  const segments = (payload ?? '').split('.');
  if (segments.length === 3 && segments.every((s) => s !== '')) {
    return { version: 1, parts: [segments[0], segments[1], segments[2]] };
  }
  if (segments.length === 4 && /^v\d+$/.test(segments[0])) {
    const version = Number(segments[0].slice(1));
    if (!Number.isInteger(version) || version <= 0) {
      throw new AppError(ErrorCode.KEY_VERSION_INVALID, `密文密钥版本非法: ${segments[0]}`);
    }
    const [, iv, tag, data] = segments;
    if (!iv || !tag || !data) throw new AppError(ErrorCode.KEY_VERSION_INVALID, '密文格式非法');
    return { version, parts: [iv, tag, data] };
  }
  throw new AppError(ErrorCode.KEY_VERSION_INVALID, '密文格式非法（无法判定密钥版本）');
}

/**
 * 从环境变量解析密钥配置（单点约定，crypto.module 与测试共用）：
 * - `ENCRYPTION_KEYS="1:<base64>,2:<base64>"`（逗号分隔，`版本:密钥`；空白/空段忽略）；
 * - 否则 `ENCRYPTION_KEY`（等价于只配了版本 1）。
 * @throws AppError KEY_VERSION_INVALID 配置存在但格式非法（绝不"部分忽略"后带病启动）
 */
export function encryptionKeyConfigFromEnv(env: NodeJS.ProcessEnv = process.env): string | { keys: Record<number, string> } {
  const multi = env.ENCRYPTION_KEYS;
  if (multi !== undefined && multi.trim() !== '') {
    const keys: Record<number, string> = {};
    for (const segment of multi.split(',')) {
      const item = segment.trim();
      if (item === '') continue;
      const sep = item.indexOf(':');
      if (sep <= 0) {
        throw new AppError(ErrorCode.KEY_VERSION_INVALID, 'ENCRYPTION_KEYS 格式非法（应为 "1:<base64>,2:<base64>"）');
      }
      const version = Number(item.slice(0, sep).trim());
      if (!Number.isInteger(version) || version <= 0) {
        throw new AppError(ErrorCode.KEY_VERSION_INVALID, `ENCRYPTION_KEYS 中的版本号非法: ${item.slice(0, sep)}`);
      }
      keys[version] = item.slice(sep + 1).trim();
    }
    if (Object.keys(keys).length === 0) {
      throw new AppError(ErrorCode.KEY_VERSION_INVALID, 'ENCRYPTION_KEYS 已设置但未解析出任何密钥');
    }
    return { keys };
  }
  return env.ENCRYPTION_KEY ?? '';
}
