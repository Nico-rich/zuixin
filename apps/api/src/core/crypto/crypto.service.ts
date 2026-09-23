import { Injectable } from '@nestjs/common';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const ALGO = 'aes-256-gcm';

@Injectable()
export class CryptoService {
  private readonly key: Buffer;

  /** keyBase64 来自环境变量 ENCRYPTION_KEY（openssl rand -base64 32） */
  constructor(keyBase64: string) {
    const key = Buffer.from(keyBase64, 'base64');
    if (key.length !== 32) throw new Error('ENCRYPTION_KEY 必须是 base64 编码的 32 字节密钥');
    this.key = key;
  }

  encrypt(plain: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv(ALGO, this.key, iv);
    const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return [iv, tag, enc].map((b) => b.toString('base64')).join('.');
  }

  decrypt(payload: string): string {
    const [ivB64, tagB64, dataB64] = payload.split('.');
    if (!ivB64 || !tagB64 || !dataB64) throw new Error('密文格式非法');
    const decipher = createDecipheriv(ALGO, this.key, Buffer.from(ivB64, 'base64'));
    decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(dataB64, 'base64')), decipher.final()]).toString('utf8');
  }
}
