import { describe, it, expect, beforeEach } from 'vitest';
import { CryptoService, encryptionKeyConfigFromEnv, parsePayload } from './crypto.service';
import { ErrorCode } from '../../common/errors/app-error';

/** 抛错时取 code（断言错误码比断言文案稳；文案会随打磨变动） */
function codeOf(fn: () => unknown): string | undefined {
  try { fn(); return undefined; } catch (e) { return (e as { code?: string }).code; }
}

const KEY = 'dGVzdC1rZXktMzItYnl0ZXMtbG9uZy1hYmNkZWZnaGk='; // base64 32 字节（test-key-32-bytes-long-abcdefghi）
const KEY_V2 = Buffer.alloc(32, 42).toString('base64'); // 第二个 32 字节密钥（版本轮换用）

describe('CryptoService', () => {
  let svc: CryptoService;
  beforeEach(() => { svc = new CryptoService(KEY); });

  it('加解密往返一致', () => {
    const plain = 'sk-test-api-key-12345';
    expect(svc.decrypt(svc.encrypt(plain))).toBe(plain);
  });

  it('每次加密产生不同密文（随机 IV）', () => {
    const a = svc.encrypt('same'); const b = svc.encrypt('same');
    expect(a).not.toBe(b);
  });

  it('密文被篡改后解密抛错', () => {
    const c = svc.encrypt('secret');
    const tampered = c.slice(0, -4) + 'AAAA';
    expect(() => svc.decrypt(tampered)).toThrow();
  });

  it('密钥非 32 字节时报错', () => {
    expect(() => new CryptoService('too-short')).toThrow();
  });

  it('单密钥配置 = 版本 1（向后兼容，无需任何迁移即可上线）', () => {
    expect(svc.currentKeyVersion).toBe(1);
    expect(svc.versions()).toEqual([1]);
    expect(svc.encrypt('x').startsWith('v1.')).toBe(true);
  });
});

describe('CryptoService（M10-P1 SA-12：密钥版本化轮换）', () => {
  const v1 = new CryptoService({ keys: { 1: KEY }, currentVersion: 1 });
  const v2 = new CryptoService({ keys: { 1: KEY, 2: KEY_V2 }, currentVersion: 2 });

  describe('密文自述版本', () => {
    it('新格式 `v{n}.{iv}.{tag}.{data}`；历史 3 段格式按**版本 1** 解读', () => {
      const modern = v1.encrypt('plain');
      expect(modern.split('.')).toHaveLength(4);
      const legacy = modern.replace(/^v1\./, ''); // 历史落库格式（无版本前缀）
      expect(v1.keyVersionOf(legacy)).toBe(1);
      expect(v1.decrypt(legacy)).toBe('plain'); // 老数据零迁移可读
      expect(v1.keyVersionOf(modern)).toBe(1);
    });

    it('历史密文能被多版本服务解开（升级路径：先并存、再 rewrap）', () => {
      const legacy = v1.encrypt('old-secret').replace(/^v1\./, '');
      expect(v2.decrypt(legacy)).toBe('old-secret');
      expect(v2.keyVersionOf(legacy)).toBe(1);
      expect(v2.needsRewrap(legacy)).toBe(true);
    });

    it('格式非法（段数/空段/版本号）→ KEY_VERSION_INVALID，绝不猜测', () => {
      for (const bad of ['', 'only-one', 'a.b', 'a.b.c.d.e', 'v0.a.b.c', 'vX.a.b.c', 'v1.a.b.', 'v1..tag.data']) {
        expect(codeOf(() => parsePayload(bad)), bad).toBe(ErrorCode.KEY_VERSION_INVALID);
      }
      // 错误消息不泄漏任何内部状态（不含任何密钥片段）
      expect(() => parsePayload('v0.a.b.c')).toThrow(/密文密钥版本非法/);
    });
  });

  describe('多版本并存与写入版本', () => {
    it('当前版本 = 最高版本（未显式指定时）；encrypt 默认写当前版本', () => {
      const svc = new CryptoService({ keys: { 1: KEY, 3: KEY_V2 } });
      expect(svc.currentKeyVersion).toBe(3);
      expect(svc.versions()).toEqual([1, 3]);
      expect(svc.encrypt('x').startsWith('v3.')).toBe(true);
    });

    it('可用旧版本密钥手动加密（rewrap 的底层能力）', () => {
      expect(v2.encrypt('x', 1).startsWith('v1.')).toBe(true);
      expect(v2.decrypt(v2.encrypt('x', 1))).toBe('x');
    });

    it('显式 currentVersion 必须是密钥集内版本，否则 KEY_VERSION_INVALID', () => {
      expect(() => new CryptoService({ keys: { 1: KEY }, currentVersion: 5 })).toThrow(/未在密钥集中配置/);
      expect(() => new CryptoService({ keys: { 1: KEY }, currentVersion: 0 })).toThrow(/未在密钥集中配置/);
    });

    it('版本号非法（0/负数/非整数）→ KEY_VERSION_INVALID', () => {
      expect(() => new CryptoService({ keys: { 0: KEY } })).toThrow(/密钥版本非法/);
      expect(() => new CryptoService({ keys: { '-1': KEY } })).toThrow(/密钥版本非法/);
      // 非数字版本号（TS 类型不允许，但 env 解析/外部配置可传入 → 必须运行期拒绝；见 encryptionKeyConfigFromEnv）
      expect(() => new CryptoService({ keys: { abc: KEY } as never })).toThrow(/密钥版本非法/);
    });

    it('任一版本密钥长度不符 → 构造即失败（绝不允许带病启动）', () => {
      expect(() => new CryptoService({ keys: { 1: KEY, 2: 'too-short' } })).toThrow(/32 字节/);
    });

    it('空密钥集 → KEY_VERSION_INVALID', () => {
      expect(() => new CryptoService({ keys: {} })).toThrow(/未配置任何加密密钥/);
    });

    it('支持 Map 形式的密钥集（密钥由外部管理时不必拼对象）', () => {
      const svc = new CryptoService({ keys: new Map([[1, KEY], [2, KEY_V2]]) });
      expect(svc.versions()).toEqual([1, 2]);
      expect(svc.decrypt(svc.encrypt('m'))).toBe('m');
    });
  });

  describe('未知版本绝不静默降级', () => {
    it('未知版本解密 → KEY_VERSION_INVALID（**不**拿当前 key 试解）', () => {
      const foreign = new CryptoService(KEY_V2); // 同长度但不同的 key，伪造出 v9 密文
      const bogus = foreign.encrypt('x').replace(/^v1\./, 'v9.');
      expect(() => v2.decrypt(bogus)).toThrow(/未知密钥版本 9/);
      expect(() => v2.keyVersionOf(bogus)).not.toThrow(); // 版本可识别（9），失败在 key 缺失
      expect(v2.keyVersionOf(bogus)).toBe(9);
    });

    it('版本 1 密文用错 key 服务解密 → GCM 认证失败（不是"解出乱码"）', () => {
      const other = new CryptoService(KEY_V2);
      const payload = v1.encrypt('a').replace(/^v1\./, '');
      expect(() => other.decrypt(payload)).toThrow();
    });

    it('错误信息里**不含**密钥值', () => {
      const foreign = new CryptoService(KEY_V2);
      const bogus = foreign.encrypt('x').replace(/^v1\./, 'v9.');
      try {
        v2.decrypt(bogus);
        throw new Error('应当抛错');
      } catch (e) {
        const msg = (e as Error).message;
        expect(msg).not.toContain(KEY_V2);
        expect(msg).not.toContain(KEY);
      }
    });
  });

  describe('rewrap（迁移）与 assertCurrentVersion', () => {
    it('rewrap：旧版本 → 当前版本，返回 { from, to } 可审计；迁移后不再需要 rewrap', () => {
      const legacy = v1.encrypt('to-migrate').replace(/^v1\./, '');
      const out = v2.rewrap(legacy);
      expect(out.from).toBe(1);
      expect(out.to).toBe(2);
      expect(v2.keyVersionOf(out.payload)).toBe(2);
      expect(v2.decrypt(out.payload)).toBe('to-migrate');
      expect(v2.needsRewrap(out.payload)).toBe(false);
      expect(v2.rewrap(out.payload)).toMatchObject({ from: 2, to: 2 }); // 幂等
    });

    it('rewrap 未知版本 → KEY_VERSION_INVALID（绝不产出"看起来迁移成功"的结果）', () => {
      const foreign = new CryptoService(KEY_V2);
      const bogus = foreign.encrypt('x').replace(/^v1\./, 'v9.');
      expect(() => v2.rewrap(bogus)).toThrow(/未知密钥版本 9/);
    });

    it('requireCurrent：密文落后于当前版本 → CREDENTIAL_REWRAP_REQUIRED（提示先迁移，而非按新 key 强解）', () => {
      const legacy = v1.encrypt('old');
      expect(() => v2.decrypt(legacy, { requireCurrent: true })).toThrow(/请先 rewrap 迁移/);
      expect(v2.decrypt(v2.encrypt('new'), { requireCurrent: true })).toBe('new');
    });

    it('assertCurrentVersion：旧版本抛 CREDENTIAL_REWRAP_REQUIRED；当前版本放行', () => {
      expect(() => v2.assertCurrentVersion(v1.encrypt('old'))).toThrow(/请先 rewrap 迁移/);
      expect(() => v2.assertCurrentVersion(v2.encrypt('new'))).not.toThrow();
      expect(() => v2.assertCurrentVersion(v1.encrypt('old').replace(/^v1\./, ''))).toThrow(/请先 rewrap 迁移/);
    });
  });
});

describe('encryptionKeyConfigFromEnv（单点配置解析）', () => {
  it('ENCRYPTION_KEYS="1:xxx,2:yyy" → 多版本对象（空白宽容）', () => {
    expect(encryptionKeyConfigFromEnv({ ENCRYPTION_KEYS: `1:${KEY}, 2:${KEY_V2}` }))
      .toEqual({ keys: { 1: KEY, 2: KEY_V2 } });
    expect(encryptionKeyConfigFromEnv({ ENCRYPTION_KEYS: ` 1:${KEY} ,, 2:${KEY_V2} , ` }))
      .toEqual({ keys: { 1: KEY, 2: KEY_V2 } });
  });

  it('未配 ENCRYPTION_KEYS（或为空串）→ 回退单 ENCRYPTION_KEY（= 版本 1）', () => {
    expect(encryptionKeyConfigFromEnv({ ENCRYPTION_KEY: KEY })).toBe(KEY);
    expect(encryptionKeyConfigFromEnv({ ENCRYPTION_KEY: KEY, ENCRYPTION_KEYS: '   ' })).toBe(KEY);
    expect(encryptionKeyConfigFromEnv({})).toBe('');
  });

  it('格式非法 → KEY_VERSION_INVALID（绝不"部分忽略"后带病启动）', () => {
    expect(() => encryptionKeyConfigFromEnv({ ENCRYPTION_KEYS: 'noseparator' })).toThrow(/ENCRYPTION_KEYS 格式非法/);
    expect(() => encryptionKeyConfigFromEnv({ ENCRYPTION_KEYS: `0:${KEY}` })).toThrow(/版本号非法/);
    expect(() => encryptionKeyConfigFromEnv({ ENCRYPTION_KEYS: `x:${KEY}` })).toThrow(/版本号非法/);
    expect(() => encryptionKeyConfigFromEnv({ ENCRYPTION_KEYS: ' , , ' })).toThrow(/未解析出任何密钥/);
  });

  it('解析结果可直接构造服务（配置 → 服务全链路）', () => {
    const svc = new CryptoService(encryptionKeyConfigFromEnv({ ENCRYPTION_KEYS: `1:${KEY},2:${KEY_V2}` }));
    expect(svc.currentKeyVersion).toBe(2);
    expect(svc.decrypt(svc.encrypt('end-to-end'))).toBe('end-to-end');
  });

  it('空配置：解析期宽容（返回空串），由**构造器**统一裁决 KEY_VERSION_INVALID（单一失败点）', () => {
    expect(() => encryptionKeyConfigFromEnv({})).not.toThrow();
    expect(encryptionKeyConfigFromEnv({})).toBe('');
    expect(() => new CryptoService(encryptionKeyConfigFromEnv({}))).toThrow(/32 字节/);
  });
});
