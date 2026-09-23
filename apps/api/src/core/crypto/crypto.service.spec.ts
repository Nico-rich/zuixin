import { describe, it, expect, beforeEach } from 'vitest';
import { CryptoService } from './crypto.service';

const KEY = 'dGVzdC1rZXktMzItYnl0ZXMtbG9uZy1hYmNkZWY='; // base64 32 字节

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
});
