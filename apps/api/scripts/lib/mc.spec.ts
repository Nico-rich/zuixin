import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { diffMirror, etagAsMd5, hostEnvValue, parseMcListJson, parseMcStatJson, sampleKeys, summarizeDir } from './mc';
import { backupFileName, stampFromBackupName } from './manifest';
import { redactSecrets } from './cli';

describe('mc ls --json 解析（对象数/体积核对的入口）', () => {
  const sample = [
    '{"status":"success","type":"folder","key":"a/","size":0}',
    '{"status":"success","type":"file","key":"a/obj-1.bin","size":65536}',
    '{"status":"success","type":"file","key":"a/obj-2.bin","size":131072}',
    'not-json-line-ignored',
    '{"status":"success","type":"file","key":"b/obj-3.bin","size":10}',
  ].join('\n');

  it('排除目录项，合计对象数与总体积', () => {
    const summary = parseMcListJson(sample);
    expect(summary.count).toBe(3);
    expect(summary.totalBytes).toBe(65536 + 131072 + 10);
    expect(summary.objects.map((o) => o.key)).toEqual(['a/obj-1.bin', 'a/obj-2.bin', 'b/obj-3.bin']);
  });

  it('空输出 / 全非法行 ⇒ 0 对象（而不是崩溃）', () => {
    expect(parseMcListJson('')).toEqual({ count: 0, totalBytes: 0, objects: [] });
    expect(parseMcListJson('garbage\nmc: <ERROR> ...')).toEqual({ count: 0, totalBytes: 0, objects: [] });
  });
});

describe('mc stat --json 解析（上传后的零传输内容级核对）', () => {
  const md5 = 'd41d8cd98f00b204e9800998ecf8427e';

  it('读出台 key/size/etag，并判定 etag 能否当 md5 用', () => {
    const entry = parseMcStatJson(`{"status":"success","key":"db-backups/postgres/x.sql.gz.gpg","size":2356235,"etag":"${md5}","type":"file"}`);
    expect(entry).toEqual({ key: 'db-backups/postgres/x.sql.gz.gpg', sizeBytes: 2356235, etag: md5, etagIsMd5: true });
    // 带引号的 ETag（S3 协议常见）同样要能读
    expect(parseMcStatJson(`{"key":"k","size":1,"etag":"\\"${md5}\\"","type":"file"}`)?.etag).toBe(md5);
  });

  it('多段上传的 ETag（<md5>-<parts>）**不**当作 md5（否则会把"没核对"伪装成"核对过"）', () => {
    const entry = parseMcStatJson(`{"key":"k","size":10,"etag":"${md5}-3","type":"file"}`);
    expect(entry?.etagIsMd5).toBe(false);
    expect(etagAsMd5(`${md5}-3`)).toBeNull();
    expect(etagAsMd5(md5.toUpperCase())).toBe(md5);
  });

  it('**实测形态**：stat 的对象名在 `name`（不是 `key`）——只认 key 会把 ETag 丢掉并错误归因给服务端', () => {
    // 真实 `mc stat --json` 输出（mc RELEASE.2025 系，file 目标）
    const real =
      '{"status":"success","name":"agent_platform-m11p9-enc-20260928-172637.sql.gz.gpg","lastModified":"2026-09-28T09:27:06Z",' +
      '"size":3504232,"etag":"439ce8df8e1ba2d52d54002dc415385b","type":"file","metadata":{"Content-Type":"application/octet-stream"}}';
    const entry = parseMcStatJson(real);
    expect(entry).toEqual({
      key: 'agent_platform-m11p9-enc-20260928-172637.sql.gz.gpg',
      sizeBytes: 3504232,
      etag: '439ce8df8e1ba2d52d54002dc415385b',
      etagIsMd5: true,
    });
    expect(etagAsMd5(entry!.etag)).toBe('439ce8df8e1ba2d52d54002dc415385b');
  });

  it('非 JSON / 既无 key 也无 name 的输出 ⇒ null（调用方降级为"只比体积"并如实标注）', () => {
    expect(parseMcStatJson('garbage')).toBeNull();
    expect(parseMcStatJson('{"status":"error","error":"not found"}')).toBeNull();
    expect(parseMcStatJson('{"status":"success","type":"file","size":10}')).toBeNull();
  });
});

describe('mirror 核对（退出码 3 的依据）', () => {
  const src = parseMcListJson('{"type":"file","key":"a","size":1}\n{"type":"file","key":"b","size":2}\n');

  it('完全一致 ⇒ ok', () => {
    const dst = parseMcListJson('{"type":"file","key":"a","size":1}\n{"type":"file","key":"b","size":2}\n');
    expect(diffMirror(src, dst)).toEqual({ ok: true, missingInTarget: [], extraInTarget: [], sizeMismatch: [] });
  });

  it('缺失 / 多余 / 体积不符 都被识别且 ok=false', () => {
    const dst = parseMcListJson('{"type":"file","key":"a","size":9}\n{"type":"file","key":"c","size":2}\n');
    const diff = diffMirror(src, dst);
    expect(diff.ok).toBe(false);
    expect(diff.missingInTarget).toEqual(['b']);
    expect(diff.extraInTarget).toEqual(['c']);
    expect(diff.sizeMismatch).toEqual([{ key: 'a', sourceBytes: 1, targetBytes: 9 }]);
  });
});

describe('抽样校验的确定性（同一输入必得同一抽样）', () => {
  it('sampleKeys 排序后等距取样且去重', () => {
    const summary = parseMcListJson(
      ['e', 'd', 'c', 'b', 'a'].map((k, i) => `{"type":"file","key":"${k}","size":${i}}`).join('\n'),
    );
    expect(sampleKeys(summary, 3)).toEqual(['a', 'c', 'e']);
    expect(sampleKeys(summary, 10)).toEqual(['a', 'b', 'c', 'd', 'e']);
    expect(sampleKeys(summary, 0)).toEqual([]);
  });
});

describe('MC_HOST 注入值（凭证不进命令行）', () => {
  it('拼出带凭证的端点 URL 并转义特殊字符', () => {
    expect(hostEnvValue({ origin: 'http://localhost:9000', accessKey: 'minioadmin', secretKey: 'minioadmin' })).toBe(
      'http://minioadmin:minioadmin@localhost:9000',
    );
    const encoded = hostEnvValue({ origin: 'localhost:9000', accessKey: 'a@b', secretKey: 'p:w' });
    expect(encoded).toBe('http://a%40b:p%3Aw@localhost:9000');
    expect(encoded).not.toContain('a@b');
  });

  it('日志脱敏覆盖连接串与 PGPASSWORD', () => {
    expect(redactSecrets('psql postgresql://agent:secret@localhost:5433/db')).toBe('psql postgresql://agent:***@localhost:5433/db');
    expect(redactSecrets('PGPASSWORD=hunter2 pg_dump -U agent')).toBe('PGPASSWORD=*** pg_dump -U agent');
  });
});

describe('本地目录清单（与桶侧同一数据结构）', () => {
  it('递归统计文件数与总体积，key 用正斜杠', () => {
    const dir = mkdtempSync(join(tmpdir(), 'm10p9-dir-'));
    try {
      mkdirSync(join(dir, 'nested'));
      writeFileSync(join(dir, 'a.bin'), Buffer.alloc(10));
      writeFileSync(join(dir, 'nested', 'b.bin'), Buffer.alloc(5));
      const summary = summarizeDir(dir);
      expect(summary.count).toBe(2);
      expect(summary.totalBytes).toBe(15);
      expect(summary.objects.map((o) => o.key).sort()).toEqual(['a.bin', 'nested/b.bin']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('备份命名与保留策略（按文件名时间戳排序，不依赖 mtime）', () => {
  it('文件名可往返解析（含 M11 的加密形态）', () => {
    const name = backupFileName({ database: 'agent_platform', stamp: '20260928-120000', label: 'pre migration', compression: 'gzip' });
    expect(name).toBe('agent_platform-pre_migration-20260928-120000.sql.gz');
    expect(stampFromBackupName(name)).toBe('20260928-120000');
    expect(stampFromBackupName(backupFileName({ database: 'db', stamp: '20260101-000000' }))).toBe('20260101-000000');
    // 加密产物必须同样能被保留策略看见（M11-P9 之前这里返回 null ⇒ .gpg 文件永远不被回收）
    const encrypted = backupFileName({ database: 'db', stamp: '20260101-000000', compression: 'gzip', encryption: 'gpg' });
    expect(encrypted).toBe('db-20260101-000000.sql.gz.gpg');
    expect(stampFromBackupName(encrypted)).toBe('20260101-000000');
    expect(stampFromBackupName('random.txt')).toBeNull();
  });
});
