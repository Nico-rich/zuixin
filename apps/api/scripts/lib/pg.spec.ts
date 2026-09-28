import { describe, expect, it } from 'vitest';
import { PROTECTED_DATABASES, assertSafeTargetDatabase, parsePipeRows, parseRowCountOutput, quoteIdent } from './pg';
import { parseDatabaseUrl, secretPresence } from './env';

describe('恢复目标安全闸门（最容易造成不可逆事故的地方）', () => {
  const base = { sourceDatabase: 'agent_platform' };

  it('合法临时库名通过', () => {
    for (const target of ['m10p9_drill', 'agent_platform_restore_20260928', 'restore1']) {
      expect(assertSafeTargetDatabase({ ...base, target }).ok).toBe(true);
    }
  });

  it('拒绝恢复到源库（脚本不提供"就地覆盖生产库"的捷径）', () => {
    const r = assertSafeTargetDatabase({ ...base, target: 'agent_platform' });
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('拒绝恢复到源库');
  });

  it('拒绝系统库', () => {
    for (const target of PROTECTED_DATABASES) {
      expect(assertSafeTargetDatabase({ ...base, target }).ok).toBe(false);
    }
  });

  it('拒绝非法标识符（注入面 / CREATE DATABASE 拼接风险）', () => {
    for (const target of ['M10_Drill', 'm10p9 drill', 'x"; DROP DATABASE agent_platform; --', '1abc', '', 'a'.repeat(64), 'm10p9-drill']) {
      expect(assertSafeTargetDatabase({ ...base, target }).ok).toBe(false);
    }
  });

  it('quoteIdent 拒绝内嵌引号（双保险）', () => {
    expect(quoteIdent('m10p9_drill')).toBe('"m10p9_drill"');
    expect(() => quoteIdent('a"b')).toThrow();
  });
});

describe('psql 输出解析', () => {
  it('parsePipeRows 处理空行与多列', () => {
    expect(parsePipeRows('a|1\n\nb|2|x\n')).toEqual([['a', '1'], ['b', '2|x']]);
  });

  it('parseRowCountOutput 解析逐表行数（含 0 行表）', () => {
    expect(parseRowCountOutput('"AgentRun"|5\n"User"|0\n')).toEqual({ AgentRun: 5, User: 0 });
  });
});

describe('DATABASE_URL 解析与脱敏（口令绝不进日志）', () => {
  it('拆出连接字段并给出脱敏形式', () => {
    const t = parseDatabaseUrl('postgresql://agent:sup3r-s3cret@localhost:5433/agent_platform?schema=public');
    expect(t.user).toBe('agent');
    expect(t.password).toBe('sup3r-s3cret');
    expect(t.host).toBe('localhost');
    expect(t.port).toBe(5433);
    expect(t.database).toBe('agent_platform');
    expect(t.redacted).toBe('postgresql://agent:***@localhost:5433/agent_platform');
    expect(t.redacted).not.toContain('sup3r-s3cret');
  });

  it('默认端口 5432；URL 编码的口令/用户名被解码', () => {
    const t = parseDatabaseUrl('postgres://us%40er:p%40ss@db.internal/app');
    expect(t.port).toBe(5432);
    expect(t.user).toBe('us@er');
    expect(t.password).toBe('p@ss');
  });

  it('非法 URL / 缺库名 / 非 postgres 协议 抛错', () => {
    expect(() => parseDatabaseUrl(undefined)).toThrow(/DATABASE_URL/);
    expect(() => parseDatabaseUrl('not a url')).toThrow();
    expect(() => parseDatabaseUrl('postgresql://u:p@h:5432/')).toThrow(/缺少库名/);
    expect(() => parseDatabaseUrl('mysql://u:p@h/db')).toThrow(/协议/);
  });
});

describe('RPO=0 密钥存在性（只报有没有，绝不报值）', () => {
  it('识别缺失、已配置与占位符', () => {
    const saved = { ...process.env };
    try {
      process.env.M10_TEST_KEY_PRESENT = 'a-real-secret-value-here';
      process.env.M10_TEST_KEY_PLACEHOLDER = 'change_me_openssl_rand_base64_32';
      delete process.env.M10_TEST_KEY_MISSING;
      const presence = secretPresence(['M10_TEST_KEY_PRESENT', 'M10_TEST_KEY_PLACEHOLDER', 'M10_TEST_KEY_MISSING'], {
        M10_TEST_KEY_PRESENT: 'file',
        M10_TEST_KEY_PLACEHOLDER: 'file',
      });
      expect(presence.M10_TEST_KEY_PRESENT).toEqual({ present: true, length: 24, source: 'file' });
      expect(presence.M10_TEST_KEY_PLACEHOLDER.source).toBe('default-placeholder');
      expect(presence.M10_TEST_KEY_MISSING).toEqual({ present: false, length: 0, source: 'missing' });
    } finally {
      delete process.env.M10_TEST_KEY_PRESENT;
      delete process.env.M10_TEST_KEY_PLACEHOLDER;
      process.env = saved;
    }
  });

  it('返回值里不含任何密钥值（构造不出"值"这个字段）', () => {
    process.env.M10_TEST_KEY_X = 'zzz';
    try {
      const presence = secretPresence(['M10_TEST_KEY_X']);
      expect(JSON.stringify(presence)).not.toContain('zzz');
    } finally {
      delete process.env.M10_TEST_KEY_X;
    }
  });
});
