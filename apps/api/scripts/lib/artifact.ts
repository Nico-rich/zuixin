/**
 * M11-P9 运维脚本：备份**产物扩展名链**的解析与统一读取（gzip / gpg）。
 *
 * 为什么单列一个模块（审计 D1-13 的收尾）：
 * 加密引入后，"备份文件"不再是单一形态，而是**后缀链**：
 *
 *   .sql              明文
 *   .sql.gz           gzip（M10 起的默认形态）
 *   .sql.gpg          只加密（--no-compress --encrypt gpg）
 *   .sql.gz.gpg       先 gzip 后 gpg（加密开启时的默认形态）
 *
 * restore.ts 原先在**三处**各自写 `file.endsWith('.gz') ? ... pipe(createGunzip()) : ...`
 * （内容统计一遍、抽样内容一遍、回灌一遍）。三处各写一份必然出现"改了两处漏一处"的
 * 经典事故：比如给回灌路径加了 .gpg 支持，而内容统计路径没加 ⇒ 统计到的表数是 0，
 * 演练会以"备份无效"的假失败告终（或更糟：校验被绕过）。
 * 现在只有一条链路实现，三个调用点共用。
 *
 * 纪律：
 * - **顺序固定**：只承认"先压缩后加密"（`.gz.gpg`）。`.gpg.gz` 明确报错而不是猜——
 *   猜错顺序会把密文当压缩流喂给 gunzip，得到一个"解析不出任何表"的假失败；
 * - **口令不进 argv**：口令只经 stdin 传给 gpg 子进程（见 lib/gpg.ts）；
 * - **失败必须可观测**：链上任何一环失败（gpg 退出码非 0、gunzip 报错、文件截断）
 *   都记录在 `finished` 上，调用方 await 后据此以非 0 退出码拒绝继续。
 */

import { createReadStream, type ReadStream } from 'node:fs';
import type { Readable } from 'node:stream';
import { createGunzip } from 'node:zlib';

import { redactSecrets, spawnStreaming } from './cli';
import { GPG_PASSPHRASE_ENV, buildGpgDecryptArgs } from './gpg';

export type Compression = 'none' | 'gzip';
export type Encryption = 'none' | 'gpg';

export interface ArtifactChain {
  /** 去掉全部压缩/加密后缀的基名（如 `agent_platform-20260928-120000.sql`） */
  base: string;
  compression: Compression;
  encryption: Encryption;
  /** 后缀链字符串（如 `.gz.gpg`），便于日志/报告直接回显 */
  suffix: string;
}

export type ArtifactParseResult = ({ ok: true } & ArtifactChain) | { ok: false; base: string; error: string };

/** 后缀拼装（**唯一**的产物命名来源；backup/restore/prune 都走这里）。 */
export function artifactSuffix(compression: Compression, encryption: Encryption): string {
  return `${compression === 'gzip' ? '.gz' : ''}${encryption === 'gpg' ? '.gpg' : ''}`;
}

/** 由明文路径推出最终产物路径（`x.sql` + gzip+gpg ⇒ `x.sql.gz.gpg`）。 */
export function artifactPathFor(plainPath: string, compression: Compression, encryption: Encryption): string {
  return `${plainPath}${artifactSuffix(compression, encryption)}`;
}

/**
 * 解析产物的扩展名链（纯函数，单测覆盖）。
 * 只承认 4 种形态；其余（`.sql.bz2`、`.sql.gpg.gz`、无 `.sql`、纯目录名）一律返回 ok=false + 可读原因——
 * restore 会以退出码 2/4 明确拒绝，而不是把文件当别的东西解析。
 */
export function parseArtifactName(name: string): ArtifactParseResult {
  const file = name.split(/[\\/]/).pop() ?? name;
  const lower = file.toLowerCase();
  let rest = lower;
  let encryption: Encryption = 'none';
  let compression: Compression = 'none';
  if (rest.endsWith('.gpg')) {
    encryption = 'gpg';
    rest = rest.slice(0, -'.gpg'.length);
  }
  if (rest.endsWith('.gz')) {
    compression = 'gzip';
    rest = rest.slice(0, -'.gz'.length);
  }
  const stripLen = file.length - rest.length;
  const base = file.slice(0, file.length - stripLen);
  const suffix = file.slice(file.length - stripLen);

  if (lower.endsWith('.gpg.gz') || lower.endsWith('.gpg.gzip')) {
    return {
      ok: false,
      base,
      error: `不支持的扩展名顺序 "${suffix}"：只承认「先压缩后加密」(.sql.gz.gpg)——先加密再压缩既无收益也容易读错`,
    };
  }
  if (!rest.endsWith('.sql')) {
    return {
      ok: false,
      base,
      error: `无法识别备份文件扩展名："${file}"（支持 .sql / .sql.gz / .sql.gpg / .sql.gz.gpg）`,
    };
  }
  return { ok: true, base, compression, encryption, suffix };
}

/** 人读链路描述（日志/报告用）。 */
export function describeArtifactChain(chain: ArtifactChain): string {
  const parts: string[] = [];
  if (chain.compression === 'gzip') parts.push('gzip');
  if (chain.encryption === 'gpg') parts.push('gpg');
  return parts.length === 0 ? '明文（未压缩未加密）' : parts.join(' → ') + '（读取时反序：gpg 解密 → gunzip 解压）';
}

/**
 * 保留策略的分组键（`<base>-<stamp>`）。
 *
 * 为什么要单独一个函数：backup.ts 原先用一条正则列出可删产物，正则里只写了 `.sql|.sql.gz|manifest.json`，
 * 加密后新增的 `.sql.gz.gpg` **匹配不上** ⇒ 加密备份永远不会被保留策略回收（磁盘悄悄涨满）。
 * 这里用扩展名链解析代替正则白名单，新增形态时只需改一处。
 */
export function backupSetKey(name: string): string | null {
  const manifest = /^(.*)-(\d{8}-\d{6})\.manifest\.json$/.exec(name);
  if (manifest) return `${manifest[1]}-${manifest[2]}`;
  const parsed = parseArtifactName(name);
  if (!parsed.ok) return null;
  const m = /^(.*)-(\d{8}-\d{6})\.sql$/.exec(parsed.base);
  return m ? `${m[1]}-${m[2]}` : null;
}

/** 从产物文件名取时间戳（保留策略按文件名排序，不依赖 mtime——拷贝会改 mtime）。 */
export function artifactStamp(name: string): string | null {
  const key = backupSetKey(name);
  if (!key) return null;
  const m = /-(\d{8}-\d{6})$/.exec(key);
  return m ? m[1] : null;
}

export interface RetentionPlan {
  /** 参与分组的备份集总数 */
  scannedSets: number;
  /** 保留（最新 N 套）的备份集键，按时间倒序 */
  keep: string[];
  /** 判定为超期、应整套删除的备份集键，按时间倒序 */
  victims: string[];
  /** 命中删除的**文件**（含同套的 .sql/.gz/.gpg/.manifest.json），供 --prune 落地 */
  victimFiles: string[];
  /** 未参与分组、因此**永不删除**的文件（其他库、其他工具的产物） */
  untouched: string[];
}

/**
 * 保留策略的纯函数部分（可单测；IO 留给调用方）。
 *
 * 两条纪律：
 * 1. **按套归组**：同一时间戳的 `.sql` / `.gz` / `.gpg` / `manifest.json` 是"一份备份"的四个文件，
 *    要么整套留、要么整套删——只删密文留下 manifest，恢复时才发现文件没了；只删 manifest 留下密文，
 *    等于把"这份备份当时的校验结论"抹掉（正是 manifest 要解决的问题）。
 * 2. **白名单之外一律不动**：只有能解析成 `<库名>-<时间戳>.sql[...]` 的文件才参与；其余文件原样留下，
 *    并在 `untouched` 里回报（避免把运维手工放的 README/校验和文件当垃圾清掉）。
 */
export function planRetention(names: readonly string[], opts: { database: string; keep: number }): RetentionPlan {
  const inScope = names.filter((n) => n.startsWith(`${opts.database}-`));
  const sets = new Map<string, string[]>();
  const untouched: string[] = [];
  for (const name of inScope) {
    const key = backupSetKey(name);
    if (!key) {
      untouched.push(name);
      continue;
    }
    sets.set(key, [...(sets.get(key) ?? []), name]);
  }
  const ordered = [...sets.keys()].sort().reverse(); // 时间戳字典序 == 时间序
  const keep = ordered.slice(0, Math.max(0, opts.keep));
  const victims = ordered.slice(Math.max(0, opts.keep));
  const victimFiles = victims.flatMap((k) => sets.get(k) ?? []);
  const outOfScope = names.filter((n) => !n.startsWith(`${opts.database}-`));
  return { scannedSets: sets.size, keep, victims, victimFiles, untouched: [...outOfScope, ...untouched] };
}

export interface ArtifactReadResult {
  ok: boolean;
  detail: string;
}

export interface OpenedArtifact {
  /** 解压/解密后的字节流（明文 SQL） */
  stream: Readable;
  chain: ArtifactChain;
  /** 人读链路描述 */
  description: string;
  /**
   * 读完流后 await：链上任一环节的失败证据。
   * 注意**必须先读完流**再 await（否则等价于提前判失败/死等），调用方按"读 → 判"的顺序使用。
   */
  finished: Promise<ArtifactReadResult>;
}

/**
 * 打开备份产物流（**唯一**的解压/解密实现；restore.ts 的三个读取点共用）。
 *
 * 链路（按后缀反序）：文件 → [gpg 解密] → [gunzip] → 消费方。
 * 口令经 stdin 写进 gpg 子进程；未提供口令时也允许尝试（公钥加密的产物不需要口令——
 * 私钥在 keyring 里），失败原因由 gpg 自己给出（"Bad session key" / "No secret key"）。
 */
export function openArtifactStream(
  path: string,
  opts: { passphrase?: string | null; onError?: (msg: string) => void } = {},
): OpenedArtifact {
  const parsed = parseArtifactName(path);
  if (!parsed.ok) throw new Error(parsed.error);
  const chain: ArtifactChain = { base: parsed.base, compression: parsed.compression, encryption: parsed.encryption, suffix: parsed.suffix };

  const errors: string[] = [];
  const note = (msg: string) => {
    errors.push(msg);
    opts.onError?.(msg);
  };

  // 每一环都挂上 error 监听：没有监听者的 'error' 事件在 Node 里是**未捕获异常** => 进程直接崩。
  const guard = (stream: Readable, label: string): Readable => {
    stream.on('error', (err: Error) => note(`${label}：${redactSecrets(err.message)}`));
    return stream;
  };

  // M11 Final Audit M16：gpg 链路下明文 createReadStream 只是"拿到 handle 确认文件可读"，
  // 流随即被 child.stdout 覆盖 ⇒ fd 泄漏（每次读取一个，循环调用无界）。改为惰性：仅非 gpg 才建流。
  let stream: Readable;
  let gpgDone: Promise<{ code: number; spawnError?: string; stderr: string }> = Promise.resolve({ code: 0, stderr: '' });

  if (chain.encryption === 'gpg') {
    const passphrase = opts.passphrase ?? null;
    // 口令走 stdin（给不出来就把 stdin 直接关掉 ⇒ gpg 立刻以非 0 退出，绝不去弹 pinentry）
    const child = spawnStreaming('gpg', buildGpgDecryptArgs({ inPath: path }), {
      stdin: passphrase !== null ? `${passphrase}\n` : undefined,
    });
    gpgDone = child.done;
    stream = guard(child.stdout, 'gpg 解密');
  } else {
    stream = guard(createReadStream(path) as ReadStream, '读取文件');
  }
  if (chain.compression === 'gzip') {
    stream = guard(stream.pipe(createGunzip()), 'gunzip 解压');
  }

  /**
   * **必须等流真正结束再下结论**：这个 IIFE 若在第一个 await 之前就走到 return，
   * 非加密产物会在数据到达之前被判成 ok（M11-P9 实测抓到的假通过）。
   */
  const settled = new Promise<void>((resolve) => {
    const once = () => resolve();
    stream.once('end', once);
    stream.once('error', once); // 错误已由 guard 记录
    stream.once('close', once); // 被提前销毁（下游中断）也要收敛，不能挂住调用方
  });

  const finished = (async (): Promise<ArtifactReadResult> => {
    await settled;
    if (chain.encryption === 'gpg') {
      const res = await gpgDone;
      if (res.spawnError) return { ok: false, detail: `gpg 无法执行：${res.spawnError}` };
      if (res.code !== 0) {
        const hint =
          opts.passphrase == null
            ? `（未提供 ${GPG_PASSPHRASE_ENV}：对称加密的备份必须提供口令；公钥加密则要求私钥在 keyring 中）`
            : '';
        return { ok: false, detail: `gpg 解密失败（退出码 ${res.code}）${hint}：${redactSecrets(res.stderr.trim()).slice(0, 400)}` };
      }
    }
    if (errors.length > 0) return { ok: false, detail: errors.slice(0, 3).join('；') };
    return { ok: true, detail: 'ok' };
  })();

  return { stream, chain, description: describeArtifactChain(chain), finished };
}
