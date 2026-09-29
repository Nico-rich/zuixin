/**
 * M10-P9 运维脚本：环境与连接串处理（**密钥绝不落日志**）。
 *
 * 事实源：仓库根 `.env`（`apps/api/src/env.ts` 的口径：monorepo 里唯一事实源在根 `.env`）。
 * 本模块只做三件事：
 *   1. 找到并加载 env 文件（不覆盖已存在的进程环境变量——编排注入的 Secret 优先）；
 *   2. 把 `DATABASE_URL` 解析成 pg 工具需要的字段 + **可打印的脱敏形式**；
 *   3. 输出「密钥清单存在性」（只报告有没有，绝不报告值）——RPO=0 清单的输入。
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse as parseDotenv } from 'dotenv';

/** RPO=0 清单：丢失即不可恢复（或需要全量轮换）的密钥。顺序即重要性顺序。 */
export const RPO_ZERO_SECRET_KEYS: readonly { key: string; why: string }[] = [
  { key: 'ENCRYPTION_KEY', why: '密文密钥（AES-256-GCM at rest）：丢失 ⇒ 连接凭证/webhook secret/扩展签名永久不可解，只能让用户重新授权' },
  { key: 'JWT_SECRET', why: '签发密钥：丢失 ⇒ 全部会话立即失效（可接受但不能与丢失 ENCRYPTION_KEY 混为一谈）' },
  { key: 'DATABASE_URL', why: '含 DB 口令：需要在密钥管理系统里可取回（口令可轮换，但仍应登记）' },
  { key: 'REDIS_URL', why: '含 Redis 口令：同上（Redis 数据本身可丢弃，见 DR 手册 §5）' },
  { key: 'STORAGE_ACCESS_KEY_ID', why: '对象存储访问凭证：泄露即数据面失守' },
  { key: 'STORAGE_SECRET_ACCESS_KEY', why: '对象存储访问凭证：同上' },
  { key: 'BACKUP_GPG_PASSPHRASE', why: 'M11-P9 备份 gpg 口令：丢失 ⇒ 全部加密备份永久不可解' },
];

/** 进程环境变量优先，其次 env 文件；返回实际生效的键（不返回值）。 */
export interface EnvLoadReport {
  /** 实际加载的 env 文件（undefined = 只用进程环境） */
  file?: string;
  /** 候选路径（按优先级，供排查"为什么没读到 .env"） */
  candidates: string[];
  /** 键 → 来源 */
  sources: Record<string, 'process' | 'file'>;
}

export function envFileCandidates(opts: { explicit?: string; cwd?: string; scriptDir?: string } = {}): string[] {
  const cwd = opts.cwd ?? process.cwd();
  const scriptDir = opts.scriptDir ?? __dirname;
  const list: string[] = [];
  if (opts.explicit) list.push(resolve(cwd, opts.explicit));
  if (process.env.ENV_FILE) list.push(resolve(cwd, process.env.ENV_FILE));
  list.push(resolve(cwd, '.env'));
  list.push(resolve(cwd, '../../.env')); // apps/api 下调用时的 monorepo 根
  list.push(resolve(scriptDir, '../../../.env')); // scripts/lib → 仓库根（不依赖 cwd）
  return [...new Set(list)];
}

/**
 * 加载 env：进程环境优先（编排注入的 Secret 不被文件覆盖），文件里的键只在进程未定义时写入。
 * `--env-file` 显式给出但文件不存在 ⇒ 抛错（拼错路径必须显式失败，不能静默降级）。
 */
export function loadEnv(opts: { explicit?: string; cwd?: string; scriptDir?: string } = {}): EnvLoadReport {
  const candidates = envFileCandidates(opts);
  const sources: Record<string, 'process' | 'file'> = {};
  for (const key of Object.keys(process.env)) if (process.env[key] !== undefined) sources[key] = 'process';

  if (opts.explicit) {
    const p = resolve(opts.cwd ?? process.cwd(), opts.explicit);
    if (!existsSync(p)) throw new Error(`--env-file 指定的文件不存在：${p}`);
  }

  const file = candidates.find((p) => existsSync(p));
  if (!file) return { candidates, sources };
  const parsed = parseDotenv(readFileSync(file));
  for (const [key, value] of Object.entries(parsed)) {
    if (process.env[key] === undefined) {
      process.env[key] = value;
      sources[key] = 'file';
    }
  }
  return { file, candidates, sources };
}

export interface DatabaseTarget {
  /** 协议（postgresql:/postgres:） */
  scheme: string;
  user: string;
  /** 口令（**绝不打印**） */
  password: string;
  host: string;
  port: number;
  database: string;
  /** 查询串（`?schema=public` 等，不含口令） */
  query: string;
  /** 可安全的打印形式：`postgresql://user:***@host:5432/db` */
  redacted: string;
}

/** 解析 `DATABASE_URL`。非法 URL / 缺库名 ⇒ 抛错（运维脚本宁可早失败）。 */
export function parseDatabaseUrl(raw: string | undefined): DatabaseTarget {
  if (!raw) throw new Error('缺少 DATABASE_URL（检查 .env 或 --env-file）');
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('DATABASE_URL 不是合法 URL');
  }
  if (!url.protocol.startsWith('postgres')) throw new Error(`DATABASE_URL 协议应为 postgres(ql)，实际 ${url.protocol}`);
  const database = decodeURIComponent(url.pathname.replace(/^\//, ''));
  if (!database) throw new Error('DATABASE_URL 缺少库名（pathname 为空）');
  const user = decodeURIComponent(url.username);
  const password = decodeURIComponent(url.password);
  const port = url.port ? Number(url.port) : 5432;
  return {
    scheme: url.protocol.replace(':', ''),
    user,
    password,
    host: url.hostname,
    port,
    database,
    query: url.search.replace(/^\?/, ''),
    redacted: `${url.protocol}//${user || 'unknown'}:***@${url.hostname}:${port}/${database}`,
  };
}

export interface SecretPresence {
  present: boolean;
  /** 只在 present 时给出长度（长度不是秘密；用于发现"占位符忘了换"这类事故） */
  length: number;
  source: 'process' | 'file' | 'default-placeholder' | 'missing';
}

/** 已知的占位符（.env.example / 文档模板值）：出现在生产 env 里等于"没配"。 */
const PLACEHOLDER_SECRETS: readonly string[] = ['change_me_openssl_rand_base64_32', 'minioadmin', 'admin123456', 'changeme', 'test'];

/** 只报告"有没有"，绝不报告值；供 RPO=0 清单打印。 */
export function secretPresence(
  keys: readonly string[] = RPO_ZERO_SECRET_KEYS.map((k) => k.key),
  sources: Record<string, 'process' | 'file'> = {},
): Record<string, SecretPresence> {
  const out: Record<string, SecretPresence> = {};
  for (const key of keys) {
    const value = process.env[key];
    const present = value !== undefined && value !== '';
    let source: SecretPresence['source'] = 'missing';
    if (present) source = PLACEHOLDER_SECRETS.includes(value as string) ? 'default-placeholder' : (sources[key] ?? 'file');
    out[key] = { present, length: present ? (value as string).length : 0, source };
  }
  return out;
}

/** `.env` 文件的元信息（mtime + 大小 + 是否被 git 忽略的提示）；只读，不回显内容。 */
export function envFileMeta(path: string): { path: string; exists: boolean; sizeBytes: number; mtime?: string; ageDays?: number } {
  if (!existsSync(path)) return { path, exists: false, sizeBytes: 0 };
  const st = statSync(path);
  const ageDays = (Date.now() - st.mtimeMs) / 86_400_000;
  return { path, exists: true, sizeBytes: st.size, mtime: st.mtime.toISOString(), ageDays: Number(ageDays.toFixed(2)) };
}

/**
 * `.env` 备份提醒（RPO=0 清单）：
 * - 备份文件**不会**包含 `.env`（见 .gitignore），因此密钥必须单独进密钥管理系统；
 * - 这里检查的是"备份目录里是否有人工留下的 .env 副本"，只报文件名/时间，绝不读内容。
 */
export function findEnvBackupCopies(dir: string): { path: string; sizeBytes: number; mtime: string }[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name: string) => /(^|\.)env(\.(backup|prod|bak|enc|\d{8}))?$|\.env\.(bak|enc|gpg|age)$/i.test(name))
    .map((name: string) => {
      const p = resolve(dir, name);
      const st = statSync(p);
      return { path: p, sizeBytes: st.size, mtime: st.mtime.toISOString() };
    });
}

/** 对象存储配置（与 `HealthService.probeStorage` / storage 适配器同源的环境变量名）。 */
export interface StorageConfig {
  driver: string;
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  localDir: string;
}

export function storageConfigFromEnv(): StorageConfig {
  return {
    driver: process.env.STORAGE_DRIVER ?? 'local',
    endpoint: process.env.STORAGE_ENDPOINT ?? '',
    region: process.env.STORAGE_REGION ?? 'us-east-1',
    bucket: process.env.STORAGE_BUCKET ?? 'agent-storage',
    accessKeyId: process.env.STORAGE_ACCESS_KEY_ID ?? '',
    secretAccessKey: process.env.STORAGE_SECRET_ACCESS_KEY ?? '',
    localDir: process.env.STORAGE_LOCAL_DIR ?? './data/storage',
  };
}
