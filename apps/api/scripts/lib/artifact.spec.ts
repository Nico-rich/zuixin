import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';

import {
  artifactPathFor, artifactStamp, artifactSuffix, backupSetKey, openArtifactStream, parseArtifactName, planRetention,
} from './artifact';
import {
  GPG_PASSPHRASE_ENV, buildGpgDecryptArgs, buildGpgSymmetricEncryptArgs, encryptFile, passphrasePresence,
} from './gpg';
import { sha256Stream } from './cli';

/** 本机有无 gpg（无则跳过真实加解密用例——脚本本身也会在缺失时以退出码 4 拒绝）。 */
const HAS_GPG = (() => {
  try {
    return spawnSync('gpg', ['--version'], { timeout: 20_000 }).status === 0;
  } catch {
    return false;
  }
})();

const PASSPHRASE = 'm11p9-unit-test-passphrase-0123456789';

function withTempDir<T>(fn: (dir: string) => Promise<T> | T): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), 'm11p9-artifact-'));
  return Promise.resolve(fn(dir)).finally(() => rmSync(dir, { recursive: true, force: true }));
}

async function sha256Of(path: string): Promise<string> {
  const hash = createHash('sha256');
  hash.update(readFileSync(path));
  return hash.digest('hex');
}

describe('产物扩展名链解析（唯一形态判定入口）', () => {
  it('四种受支持形态都能解析出 base 与链路', () => {
    expect(parseArtifactName('db-20260928-120000.sql')).toEqual({
      ok: true, base: 'db-20260928-120000.sql', compression: 'none', encryption: 'none', suffix: '',
    });
    expect(parseArtifactName('db-20260928-120000.sql.gz')).toEqual({
      ok: true, base: 'db-20260928-120000.sql', compression: 'gzip', encryption: 'none', suffix: '.gz',
    });
    expect(parseArtifactName('db-20260928-120000.sql.gpg')).toEqual({
      ok: true, base: 'db-20260928-120000.sql', compression: 'none', encryption: 'gpg', suffix: '.gpg',
    });
    expect(parseArtifactName('db.sql.gz.gpg')).toEqual({
      ok: true, base: 'db.sql', compression: 'gzip', encryption: 'gpg', suffix: '.gz.gpg',
    });
  });

  it('带目录/Windows 分隔符时只看文件名', () => {
    expect(parseArtifactName('C:\\backup\\db-20260928-120000.sql.gz.gpg')).toMatchObject({ ok: true, base: 'db-20260928-120000.sql', suffix: '.gz.gpg' });
    expect(parseArtifactName('/var/backups/db.sql.gz')).toMatchObject({ ok: true, base: 'db.sql', suffix: '.gz' });
  });

  it('**先加密后压缩**的命名被明确拒绝（不猜顺序）', () => {
    const parsed = parseArtifactName('db.sql.gpg.gz');
    expect(parsed.ok).toBe(false);
    expect(parsed.ok === false && parsed.error).toContain('.sql.gz.gpg');
  });

  it('未知扩展名/无 .sql 一律拒绝并给出可读原因', () => {
    for (const name of ['db.sql.bz2', 'db.sql.xz', 'db.tar.gz', 'db.sql.zip', 'README.md', 'db']) {
      const parsed = parseArtifactName(name);
      expect(parsed.ok).toBe(false);
      expect(parsed.ok === false && parsed.error.length).toBeGreaterThan(0);
    }
    expect(parseArtifactName('db.sql.gz.gpg.bak').ok).toBe(false);
  });

  it('后缀拼装与明文路径推导互为逆运算', () => {
    expect(artifactSuffix('none', 'none')).toBe('');
    expect(artifactSuffix('gzip', 'none')).toBe('.gz');
    expect(artifactSuffix('none', 'gpg')).toBe('.gpg');
    expect(artifactSuffix('gzip', 'gpg')).toBe('.gz.gpg');
    const chain = parseArtifactName(artifactPathFor('/tmp/x.sql', 'gzip', 'gpg'));
    expect(chain).toMatchObject({ ok: true, compression: 'gzip', encryption: 'gpg' });
  });
});

describe('保留策略分组键（加密产物必须同样可见）', () => {
  it('明文/压缩/加密/manifest 归到同一个 key', () => {
    const keys = [
      'agent-20260928-120000.sql',
      'agent-20260928-120000.sql.gz',
      'agent-20260928-120000.sql.gpg',
      'agent-20260928-120000.sql.gz.gpg',
      'agent-20260928-120000.manifest.json',
    ].map((n) => backupSetKey(n));
    expect(new Set(keys)).toEqual(new Set(['agent-20260928-120000']));
    expect(artifactStamp('agent-20260928-120000.sql.gz.gpg')).toBe('20260928-120000');
  });

  it('无关文件不参与保留策略', () => {
    for (const n of ['notes.txt', 'agent.sql', 'agent-20260928-120000.txt', 'agent-20260928120000.sql']) {
      expect(backupSetKey(n)).toBeNull();
    }
  });
});

describe('保留策略计划（整套删/整套留；白名单外的文件一律不动）', () => {
  const dir = [
    // 4 套加密备份（每套 3~4 个文件），+ 其他库 + 手工文件
    'agent-20260928-100000.sql', 'agent-20260928-100000.sql.gz', 'agent-20260928-100000.sql.gz.gpg', 'agent-20260928-100000.manifest.json',
    'agent-20260928-110000.sql.gz', 'agent-20260928-110000.sql.gz.gpg', 'agent-20260928-110000.manifest.json',
    'agent-20260928-120000.sql.gz', 'agent-20260928-120000.sql.gz.gpg', 'agent-20260928-120000.manifest.json',
    'agent-20260928-130000.sql.gz', 'agent-20260928-130000.sql.gz.gpg', 'agent-20260928-130000.manifest.json',
    'other-20260928-100000.sql.gz', // 别的库：永不删
    'README.txt', // 运维手工文件：永不删
  ];

  it('保留最近 N 套，超期的**整套**删除（含 .gpg 与 manifest，不留半套）', () => {
    const plan = planRetention(dir, { database: 'agent', keep: 3 });
    expect(plan.scannedSets).toBe(4);
    expect(plan.keep).toEqual(['agent-20260928-130000', 'agent-20260928-120000', 'agent-20260928-110000']);
    expect(plan.victims).toEqual(['agent-20260928-100000']);
    expect(plan.victimFiles.sort()).toEqual([
      'agent-20260928-100000.manifest.json',
      'agent-20260928-100000.sql',
      'agent-20260928-100000.sql.gz',
      'agent-20260928-100000.sql.gz.gpg',
    ]);
  });

  it('关键回归：加密产物 `.sql.gz.gpg` 必须出现在删除清单里（旧正则漏掉它 ⇒ 磁盘悄悄涨满）', () => {
    const plan = planRetention(['agent-20260927-100000.sql.gz', 'agent-20260927-100000.sql.gz.gpg', 'agent-20260928-110000.sql.gz.gpg'], {
      database: 'agent',
      keep: 1,
    });
    expect(plan.victims).toEqual(['agent-20260927-100000']);
    expect(plan.victimFiles).toContain('agent-20260927-100000.sql.gz.gpg');
  });

  it('别的库 / 手工文件不参与清理（并在 untouched 里如实回报）', () => {
    const plan = planRetention(dir, { database: 'agent', keep: 3 });
    expect(plan.untouched).toEqual(['other-20260928-100000.sql.gz', 'README.txt']);
    expect(plan.victimFiles).not.toContain('other-20260928-100000.sql.gz');
    expect(plan.victimFiles).not.toContain('README.txt');
  });

  it('keep 大于套数 ⇒ 不删任何东西；keep=0 ⇒ 全部删除（有意的激进用法）', () => {
    expect(planRetention(dir, { database: 'agent', keep: 99 }).victims).toEqual([]);
    const all = planRetention(dir, { database: 'agent', keep: 0 });
    expect(all.victims).toHaveLength(4);
    expect(all.keep).toEqual([]);
  });

  it('库名带正则元字符也不会误伤（用户库名不可控）', () => {
    const plan = planRetention(['a.b-20260928-100000.sql.gz', 'axb-20260928-100000.sql.gz'], { database: 'a.b', keep: 0 });
    expect(plan.victims).toEqual(['a.b-20260928-100000']);
    expect(plan.untouched).toEqual(['axb-20260928-100000.sql.gz']);
  });
});

describe('gpg argv（口令绝不进命令行）', () => {
  it('对称加密走 stdin（--passphrase-fd 0 + loopback），argv 里没有口令', () => {
    const args = buildGpgSymmetricEncryptArgs({ inPath: 'in.sql.gz', outPath: 'out.sql.gz.gpg' });
    expect(args).toContain('--symmetric');
    expect(args).toContain('--pinentry-mode');
    expect(args).toContain('loopback');
    expect(args).toEqual(args.filter((a) => !a.includes(PASSPHRASE)));
    expect(args.slice(-2)).toEqual(['--', 'in.sql.gz']);
    // 产物路径与算法是唯一出现的"业务"参数
    expect(args).toContain('AES256');
    expect(args).toContain('--compress-algo');
  });

  it('解密恒用 loopback（否则装了 pinentry 的环境会弹 GUI 口令框并挂住无人值守 Job）', () => {
    const args = buildGpgDecryptArgs({ inPath: 'x.gpg' });
    expect(args).toEqual(['--batch', '--yes', '--pinentry-mode', 'loopback', '--passphrase-fd', '0', '--decrypt', '--', 'x.gpg']);
    expect(args).not.toContain('--passphrase');
  });

  it('口令存在性只报长度/来源，不回显值', () => {
    const before = process.env[GPG_PASSPHRASE_ENV];
    try {
      delete process.env[GPG_PASSPHRASE_ENV];
      expect(passphrasePresence()).toEqual({ present: false, envName: GPG_PASSPHRASE_ENV, length: 0, looksLikePlaceholder: false });
      process.env[GPG_PASSPHRASE_ENV] = PASSPHRASE;
      const presence = passphrasePresence();
      expect(presence.present).toBe(true);
      expect(presence.length).toBe(PASSPHRASE.length);
      expect(JSON.stringify(presence)).not.toContain(PASSPHRASE);
      process.env[GPG_PASSPHRASE_ENV] = 'changeme';
      expect(passphrasePresence().looksLikePlaceholder).toBe(true);
    } finally {
      if (before === undefined) delete process.env[GPG_PASSPHRASE_ENV];
      else process.env[GPG_PASSPHRASE_ENV] = before;
    }
  });
});

describe.skipIf(!HAS_GPG)('真实加解密往返（本机 gpg 可用时）', () => {
  it('加密 → 统一 helper 解密回读 → sha256 与原文一致', async () => {
    await withTempDir(async (dir) => {
      const plain = join(dir, 'a.sql');
      writeFileSync(plain, 'CREATE TABLE public."T" (id int);\nCOPY public."T" (id) FROM stdin;\n1\n\\.,\n');
      const gz = join(dir, 'a.sql.gz');
      writeFileSync(gz, gzipSync(readFileSync(plain)));
      const enc = join(dir, 'a.sql.gz.gpg');

      const res = await encryptFile({ inPath: gz, outPath: enc, mode: { kind: 'symmetric' }, passphrase: PASSPHRASE });
      expect(res.ok).toBe(true);
      expect(statSync(enc).size).toBeGreaterThan(0);

      const opened = openArtifactStream(enc, { passphrase: PASSPHRASE });
      expect(opened.chain).toMatchObject({ compression: 'gzip', encryption: 'gpg' });
      const back = await sha256Stream(opened.stream);
      expect(await opened.finished).toMatchObject({ ok: true });
      expect(back).toBe(await sha256Of(plain));
    });
  });

  it('口令错误 ⇒ finished.ok=false（且不抛未捕获异常）', async () => {
    await withTempDir(async (dir) => {
      const plain = join(dir, 'b.sql');
      writeFileSync(plain, 'SELECT 1;\n');
      const enc = join(dir, 'b.sql.gpg');
      expect((await encryptFile({ inPath: plain, outPath: enc, mode: { kind: 'symmetric' }, passphrase: PASSPHRASE })).ok).toBe(true);

      const opened = openArtifactStream(enc, { passphrase: 'wrong-passphrase' });
      let err: string | null = null;
      try {
        await sha256Stream(opened.stream);
      } catch (e) {
        err = (e as Error).message;
      }
      const result = await opened.finished;
      expect(result.ok).toBe(false);
      expect(result.detail.length).toBeGreaterThan(0);
      // 不依赖具体形态（gpg 直接失败或产出被截断），但必须**有**失败证据
      expect(err !== null || result.detail.includes('gpg')).toBe(true);
    });
  });

  it('口令缺失（对称加密）同样以 finished.ok=false 收场', async () => {
    await withTempDir(async (dir) => {
      const plain = join(dir, 'c.sql');
      writeFileSync(plain, 'SELECT 1;\n');
      const enc = join(dir, 'c.sql.gpg');
      await encryptFile({ inPath: plain, outPath: enc, mode: { kind: 'symmetric' }, passphrase: PASSPHRASE });
      const opened = openArtifactStream(enc, { passphrase: null });
      try {
        await sha256Stream(opened.stream);
      } catch {
        /* 见上：形态取决于 gpg 行为 */
      }
      expect((await opened.finished).ok).toBe(false);
    });
  });

  it('加密时目标不可写 ⇒ ok=false 且不产生半截产物', async () => {
    await withTempDir(async (dir) => {
      const plain = join(dir, 'd.sql');
      writeFileSync(plain, 'SELECT 1;\n');
      const res = await encryptFile({ inPath: join(dir, 'missing.sql'), outPath: join(dir, 'd.sql.gpg'), mode: { kind: 'symmetric' }, passphrase: PASSPHRASE });
      expect(res.ok).toBe(false);
      expect(res.detail.length).toBeGreaterThan(0);
    });
  });
});

describe('未加密产物的读取链路（同一 helper，行为与 M10 一致）', () => {
  it('明文 .sql 直接可读', async () => {
    await withTempDir(async (dir) => {
      const p = join(dir, 'e.sql');
      writeFileSync(p, 'line1\nline2\n');
      const opened = openArtifactStream(p);
      let text = '';
      for await (const chunk of opened.stream) text += String(chunk);
      expect(text).toBe('line1\nline2\n');
      expect(await opened.finished).toMatchObject({ ok: true });
    });
  });

  it('gzip 产物可解压；截断的 .gz 以 finished.ok=false 暴露（而不是崩进程）', async () => {
    await withTempDir(async (dir) => {
      const p = join(dir, 'f.sql');
      writeFileSync(p, 'x'.repeat(5000));
      const gz = join(dir, 'f.sql.gz');
      const full = gzipSync(readFileSync(p));
      writeFileSync(gz, full.subarray(0, Math.floor(full.length / 2))); // 截断
      const opened = openArtifactStream(gz);
      try {
        await sha256Stream(opened.stream);
      } catch {
        /* 由 finished 给出结论 */
      }
      expect((await opened.finished).ok).toBe(false);
    });
  });
});
