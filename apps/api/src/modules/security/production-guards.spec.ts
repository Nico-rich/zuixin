import { describe, it, expect, vi } from 'vitest';
import { Logger } from '@nestjs/common';
import {
  DEV_DEFAULT_SEED_PASSWORDS, DEV_SUBSTITUTE_ENV_KEYS,
  assertProductionSafety, assertSeedPasswordSafe, auditProductionSafety,
  isPlaceholderSecret, isValidEncryptionKey,
} from './production-guards';

/**
 * M10-P1 D2/D8/D23/PR-8：生产安全守卫单测。
 * 断言重点：**生产 fail-fast 且一次列全**（不让运维"修一个报一个"）、非生产只告警不拦、
 * 报错消息**绝不回显密钥值**、seed 口令三档拒绝（占位/开发默认/过短）。
 */

const STRONG_JWT = 'Zm9vYmFyYmF6cXV1eDEyMzQ1Njc4OTBhYmNkZWZnaGlqa2xtbm9wcXJzdHV2d3h5eg==';
const STRONG_ENC = Buffer.alloc(32, 7).toString('base64');
const STRONG_PASSWORD = 'Str0ng-Passw0rd-2026!';

/** 一个"完全合规"的生产环境基线（各用例只改它的一项） */
const prodEnv = () => ({
  NODE_ENV: 'production',
  JWT_SECRET: STRONG_JWT,
  ENCRYPTION_KEY: STRONG_ENC,
  SEED_ADMIN_PASSWORD: STRONG_PASSWORD,
}) as Record<string, string | undefined>;

describe('isPlaceholderSecret', () => {
  it('缺失/空串视为占位（生产绝不允许空密钥）', () => {
    expect(isPlaceholderSecret('')).toBe(true);
    expect(isPlaceholderSecret('   ')).toBe(true);
    expect(isPlaceholderSecret(undefined)).toBe(true);
    expect(isPlaceholderSecret(null)).toBe(true);
  });

  it('历史默认值与模板占位全部命中（含换行/空白包裹）', () => {
    for (const bad of [
      'change_me_jwt_secret', 'change-me', 'CHANGEME', 'dev-secret-please-change',
      'your_secret_here', 'replace_me', 'placeholder', 'insecure', 'not-a-secret',
      'secret', 'JWT_SECRET', 'admin123456', '  secret  ',
      '<YOUR_JWT_SECRET>', '{{jwt_secret}}',
    ]) {
      expect(isPlaceholderSecret(bad), bad).toBe(true);
    }
  });

  it('强随机密钥不误判（含恰好含 "example.com/secret" 之外的正常值）', () => {
    expect(isPlaceholderSecret(STRONG_JWT)).toBe(false);
    expect(isPlaceholderSecret('Xk9$2mQ!pL7wZ3vR8nT4bY6cA0dF1gH5')).toBe(false);
  });
});

describe('isValidEncryptionKey', () => {
  it('base64 32 字节 → true；长度不符/非法 → false', () => {
    expect(isValidEncryptionKey(STRONG_ENC)).toBe(true);
    expect(isValidEncryptionKey(Buffer.alloc(16, 1).toString('base64'))).toBe(false);
    expect(isValidEncryptionKey('too-short')).toBe(false);
    expect(isValidEncryptionKey('')).toBe(false);
    expect(isValidEncryptionKey(undefined)).toBe(false);
  });
});

describe('auditProductionSafety', () => {
  it('非生产：合规基线 + 替身开关 → violations 为空（替身开关只进 warnings，不误报为生产违规）', () => {
    const report = auditProductionSafety({
      ...devEnvBase(),
      MOCK_DELAY_MS: '100', MOCK_LLM_FAILURE: '1', MOCK_LLM_STALL_MS: '30', MOCK_EMBEDDING_DIMS: '64', LLM_RETRY_BACKOFF_MS: '5',
    });
    expect(report.mode).toBe('non-production');
    expect(report.violations).toEqual([]);
    for (const key of DEV_SUBSTITUTE_ENV_KEYS) {
      expect(report.warnings.join('\n')).toContain(key);
    }
  });

  it('非生产：占位密钥**不阻断**（只 warn），但 violations 仍列出"若在生产会被拦下的项"（部署前 dry-run 能力）', () => {
    const report = auditProductionSafety({ JWT_SECRET: 'change_me', ENCRYPTION_KEY: 'change_me' });
    expect(report.mode).toBe('non-production');
    // 阻断与否由 assertProductionSafety 按 mode 裁决（见其单测）；报告本身仍给出 dry-run 预览
    expect(report.violations.join('\n')).toContain('JWT_SECRET');
    expect(report.violations.join('\n')).toContain('ENCRYPTION_KEY');
    // 开发面向的提示同时在 warnings 里（弱密钥只限本地）
    expect(report.warnings.join('\n')).toContain('JWT_SECRET');
    expect(report.warnings.join('\n')).toContain('ENCRYPTION_KEY');
    expect(report.warnings.join('\n')).toContain('SEED_ADMIN_PASSWORD');
    expect(() => assertProductionSafety({ JWT_SECRET: 'change_me', ENCRYPTION_KEY: 'change_me' }, { warn: () => undefined } as never)).not.toThrow();
  });

  it('生产：完全合规配置 → 零违规（守卫不是"永远报错"）', () => {
    const report = auditProductionSafety(prodEnv());
    expect(report.mode).toBe('production');
    expect(report.violations).toEqual([]);
  });

  it('生产：**一次列全**全部违规项（JWT 占位 + 密钥占位 + 全部替身开关 + seed 口令）', () => {
    const report = auditProductionSafety({
      NODE_ENV: 'production', JWT_SECRET: 'change_me', ENCRYPTION_KEY: 'change_me',
      SEED_ADMIN_PASSWORD: 'admin123456',
      MOCK_DELAY_MS: '100', MOCK_LLM_FAILURE: '1',
    });
    expect(report.mode).toBe('production');
    // 6 项：JWT / ENCRYPTION_KEY / 2 个替身开关 / seed 口令 = 5；再加 1 保证不是"只报第一条"
    expect(report.violations.length).toBeGreaterThanOrEqual(5);
    const joined = report.violations.join('\n');
    expect(joined).toContain('JWT_SECRET');
    expect(joined).toContain('ENCRYPTION_KEY');
    expect(joined).toContain('MOCK_DELAY_MS');
    expect(joined).toContain('MOCK_LLM_FAILURE');
    expect(joined).toContain('SEED_ADMIN_PASSWORD');
  });

  it('生产：JWT_SECRET 过短（<32）也拦；弱口令/非 32 字节密钥同样拦', () => {
    // 注意：这里刻意用"非占位但过短"的值，确保命中的是**长度**分支而不是占位分支
    expect(auditProductionSafety({ ...prodEnv(), JWT_SECRET: 'A1b2C3d4E5f6G7h8' }).violations.join('\n'))
      .toContain('长度不足');
    expect(auditProductionSafety({ ...prodEnv(), ENCRYPTION_KEY: 'not-base64-32-bytes' }).violations.join('\n'))
      .toContain('32 字节');
  });

  it('生产：配了 ENCRYPTION_KEYS 多版本时不再要求单 ENCRYPTION_KEY', () => {
    const env = prodEnv();
    delete env.ENCRYPTION_KEY;
    env.ENCRYPTION_KEYS = `1:${STRONG_ENC},2:${Buffer.alloc(32, 9).toString('base64')}`;
    expect(auditProductionSafety(env).violations).toEqual([]);
  });

  it('生产：ENCRYPTION_KEYS 为空串 → 退化为"单 ENCRYPTION_KEY 校验"（不被空串骗过）', () => {
    const env = prodEnv();
    delete env.ENCRYPTION_KEY;
    env.ENCRYPTION_KEYS = '   ';
    expect(auditProductionSafety(env).violations.join('\n')).toContain('ENCRYPTION_KEY');
  });

  it('报告**绝不回显密钥值**（诊断/日志安全）', () => {
    const secret = 'super-secret-value-should-not-appear';
    const report = auditProductionSafety({ NODE_ENV: 'production', JWT_SECRET: secret, ENCRYPTION_KEY: secret, SEED_ADMIN_PASSWORD: secret });
    expect(JSON.stringify(report)).not.toContain(secret);
  });
});

describe('assertProductionSafety', () => {
  it('生产 + 违规 → 抛错且一次列全（fail-fast，绝不带病启动）', () => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    try {
      expect(() => assertProductionSafety({ NODE_ENV: 'production', JWT_SECRET: 'change_me', ENCRYPTION_KEY: 'change_me' }))
        .toThrow(/拒绝启动/);
      const err = (() => { try { assertProductionSafety({ NODE_ENV: 'production', JWT_SECRET: 'change_me' }); return null; } catch (e) { return e as Error; } })();
      expect(err?.message).toContain('JWT_SECRET'); // 错误消息里带上是哪一项
      expect(err?.message).not.toContain('change_me'); // 但绝不回显值
    } finally {
      warn.mockRestore();
    }
  });

  it('生产 + 合规 → 不抛错', () => {
    expect(() => assertProductionSafety(prodEnv())).not.toThrow();
  });

  it('非生产 → 只 warn 不抛错（本地/测试零配置可跑）', () => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    try {
      expect(() => assertProductionSafety({ JWT_SECRET: 'change_me', MOCK_DELAY_MS: '50' })).not.toThrow();
      expect(warn).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it('可注入 logger（部署脚本 dry-run 时收集告警，不走全局日志）', () => {
    const logger = { warn: vi.fn() };
    assertProductionSafety({ JWT_SECRET: 'change_me' }, logger as never);
    expect(logger.warn).toHaveBeenCalled();
  });
});

describe('assertSeedPasswordSafe（生产 seed 口令守卫）', () => {
  it('非生产：任何口令都不拦（含历史默认 admin123456）', () => {
    expect(() => assertSeedPasswordSafe({ SEED_ADMIN_PASSWORD: 'admin123456' })).not.toThrow();
    expect(() => assertSeedPasswordSafe({})).not.toThrow();
  });

  it('生产：缺失/占位 → 拒绝', () => {
    expect(() => assertSeedPasswordSafe({ NODE_ENV: 'production' })).toThrow(/占位/);
    expect(() => assertSeedPasswordSafe({ NODE_ENV: 'production', SEED_ADMIN_PASSWORD: 'your_password' })).toThrow(/占位/);
  });

  it('生产：开发默认口令逐个拒绝（DEV_DEFAULT_SEED_PASSWORDS 全枚举）', () => {
    // 口径：**拒绝**即可（当前 5 个默认口令同时命中 PLACEHOLDER_EXACT 的"占位"分支，
    // DEV_DEFAULT_SEED_PASSWORDS 分支是冗余的第二道；两者都指向同一条 fail-fast 结论，
    // 保留冗余是为了让默认口令名单可以独立于占位规则演进）。
    for (const pw of DEV_DEFAULT_SEED_PASSWORDS) {
      expect(() => assertSeedPasswordSafe({ NODE_ENV: 'production', SEED_ADMIN_PASSWORD: pw }), pw).toThrow(/拒绝执行 seed/);
    }
    // 临时往名单里加一个"非占位、强度也够"的值：必须被**默认口令分支**拦下（证明该分支有效，
    // 而不是"所有口令都靠占位规则拦"）——同时反证：不在名单里时同一口令会放行。
    const probe = 'Admin-Default-Password-2026';
    expect(() => assertSeedPasswordSafe({ NODE_ENV: 'production', SEED_ADMIN_PASSWORD: probe })).not.toThrow();
    DEV_DEFAULT_SEED_PASSWORDS.add(probe);
    try {
      expect(() => assertSeedPasswordSafe({ NODE_ENV: 'production', SEED_ADMIN_PASSWORD: probe })).toThrow(/开发默认口令/);
    } finally {
      DEV_DEFAULT_SEED_PASSWORDS.delete(probe);
    }
  });

  it('生产：长度 <12 的强口令也拒绝（口令强度下限；长度按原值计，不做 trim 宽容）', () => {
    expect(() => assertSeedPasswordSafe({ NODE_ENV: 'production', SEED_ADMIN_PASSWORD: 'Az9!xQ2' })).toThrow(/长度不足/);
  });

  it('生产：合规强口令 → 放行', () => {
    expect(() => assertSeedPasswordSafe({ NODE_ENV: 'production', SEED_ADMIN_PASSWORD: STRONG_PASSWORD })).not.toThrow();
  });

  it('错误消息不含口令本身', () => {
    const pw = 'P@ssw0rd-unique-value-123';
    try {
      assertSeedPasswordSafe({ NODE_ENV: 'production', SEED_ADMIN_PASSWORD: pw.slice(0, 11) });
      throw new Error('应当抛错');
    } catch (e) {
      expect((e as Error).message).not.toContain(pw.slice(0, 11));
    }
  });
});

/** 非生产基线（含一个足够强的 JWT，避免 ⑤ 的"占位"提示混淆断言） */
function devEnvBase() {
  return { JWT_SECRET: STRONG_JWT, ENCRYPTION_KEY: STRONG_ENC, SEED_ADMIN_PASSWORD: STRONG_PASSWORD };
}
