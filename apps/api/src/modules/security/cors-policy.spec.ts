import { describe, it, expect } from 'vitest';
import { DEFAULT_CORS_ORIGINS, corsOriginsFromEnv } from './cors-policy';

describe('corsOriginsFromEnv / CORS 白名单边界', () => {
  it('多来源逐项 trim（修掉带空格导致整串不匹配的沉默失效）', () => {
    expect(corsOriginsFromEnv('http://a.example, http://b.example ,http://c.example'))
      .toEqual(['http://a.example', 'http://b.example', 'http://c.example']);
  });

  it('未配置 / 空串 → 默认本地白名单（绝不放开为 *）', () => {
    expect(corsOriginsFromEnv(undefined)).toEqual([...DEFAULT_CORS_ORIGINS]);
    expect(corsOriginsFromEnv('')).toEqual([...DEFAULT_CORS_ORIGINS]);
    expect(corsOriginsFromEnv('  ,  ')).toEqual([...DEFAULT_CORS_ORIGINS]);
  });

  it('通配项一律丢弃：* 与子域通配都不被接受（fail-closed）', () => {
    expect(corsOriginsFromEnv('*')).toEqual([...DEFAULT_CORS_ORIGINS]);
    expect(corsOriginsFromEnv('https://*.example.com')).toEqual([...DEFAULT_CORS_ORIGINS]);
    expect(corsOriginsFromEnv('*,http://ok.example')).toEqual(['http://ok.example']);
    expect(corsOriginsFromEnv('http://ok.example,https://*.example.com, *')).toEqual(['http://ok.example']);
  });

  it('任何输入下输出都不含 *（credentials=true 时 ACAO:* 属误配置）', () => {
    for (const raw of ['*', '*,*', 'http://a.example,*', ' https://*.x.example ']) {
      expect(corsOriginsFromEnv(raw).every((o) => !o.includes('*'))).toBe(true);
    }
  });

  it('精确匹配语义：来源不做前缀/后缀归一（http://a.example 不会匹配 https://a.example）', () => {
    const allowed = corsOriginsFromEnv('http://a.example');
    expect(allowed).toEqual(['http://a.example']);
    expect(allowed.includes('https://a.example')).toBe(false);
  });
});
