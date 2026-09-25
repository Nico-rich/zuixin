import { describe, it, expect, vi } from 'vitest';
import { AppError, ErrorCode } from '../../common/errors/app-error';
import { assertProviderBaseUrlSafe, isMockAdapter, manualRedirectFetch } from './provider-base-url.guard';

/**
 * Pre-M9 F3-B 单测：provider baseUrl 调用期校验（LLM/Image/Video/Embedding 四个 manager 共用）。
 * 断言：mock adapter 跳过、空 baseUrl fail-closed、私网/回环/元数据/IPv6/DNS 指向内网一律 SSRF_BLOCKED、
 * 合法公网 https 放行、http 需显式开关、出网 fetch 统一禁用自动重定向。
 */

const PUBLIC_IP = '93.184.216.34';
const resolverOf = (map: Record<string, string[]>) => async (hostname: string): Promise<string[]> => {
  const found = map[hostname];
  if (!found) throw new Error(`ENOTFOUND ${hostname}`);
  return found;
};

describe('Pre-M9 F3-B provider baseUrl 调用期校验', () => {
  it('mock adapter 跳过校验（种子 provider baseUrl 为空是正常配置）', async () => {
    await expect(assertProviderBaseUrlSafe({ providerId: 'p1', adapter: 'mock', baseUrl: '' })).resolves.toBeNull();
    await expect(assertProviderBaseUrlSafe({ providerId: 'p1', adapter: 'mock-image', baseUrl: '' })).resolves.toBeNull();
    await expect(assertProviderBaseUrlSafe({ providerId: 'p1', adapter: 'mock-video', baseUrl: null })).resolves.toBeNull();
    await expect(assertProviderBaseUrlSafe({ providerId: 'p1', adapter: 'mock-router', baseUrl: undefined })).resolves.toBeNull();
    expect(isMockAdapter('mock')).toBe(true);
    expect(isMockAdapter('mock-embedding')).toBe(true);
    expect(isMockAdapter('openai-compatible')).toBe(false);
  });

  it('非 mock adapter 未配置 baseUrl → SSRF_BLOCKED（fail-closed，绝不"无地址就当安全"）', async () => {
    await expect(assertProviderBaseUrlSafe({ providerId: 'p1', providerName: 'X', adapter: 'openai-compatible', baseUrl: '' }))
      .rejects.toMatchObject({ code: ErrorCode.SSRF_BLOCKED });
    await expect(assertProviderBaseUrlSafe({ providerId: 'p1', adapter: 'dashscope-image', baseUrl: '   ' }))
      .rejects.toBeInstanceOf(AppError);
  });

  const blocked: Array<[string, string]> = [
    ['回环', 'https://127.0.0.1/v1'],
    ['localhost', 'https://localhost:11434/v1'],
    ['私网 10.x', 'https://10.0.0.5/v1'],
    ['私网 192.168.x', 'https://192.168.1.7/v1'],
    ['云 metadata', 'https://169.254.169.254/latest/meta-data'],
    ['IPv6 回环', 'https://[::1]:8000/v1'],
    ['http 协议', 'http://api.openai.com/v1'],
    ['内网域名后缀', 'https://llm.internal/v1'],
  ];

  it.each(blocked)('baseUrl 指向 %s → SSRF_BLOCKED，且错误信息含 provider 标识', async (_n, baseUrl) => {
    await expect(assertProviderBaseUrlSafe({ providerId: 'p1', providerName: '测试供应商', adapter: 'openai-compatible', baseUrl }))
      .rejects.toThrow(/provider 测试供应商/);
  });

  it('公网域名解析到内网（DNS rebinding）→ SSRF_BLOCKED', async () => {
    await expect(assertProviderBaseUrlSafe({
      providerId: 'p1', adapter: 'openai-compatible', baseUrl: 'https://rebind.example.com/v1',
      resolver: resolverOf({ 'rebind.example.com': ['10.0.0.9'] }),
    })).rejects.toMatchObject({ code: ErrorCode.SSRF_BLOCKED });
  });

  it('合法公网 https baseUrl → 放行（返回已校验 URL）', async () => {
    const url = await assertProviderBaseUrlSafe({
      providerId: 'p1', adapter: 'openai-compatible', baseUrl: 'https://api.deepseek.com/v1',
      resolver: resolverOf({ 'api.deepseek.com': [PUBLIC_IP] }),
    });
    expect(url?.hostname).toBe('api.deepseek.com');
  });

  it('IP 字面量公网地址放行（扩展安装场景：https://93.184.216.34/v1）', async () => {
    const url = await assertProviderBaseUrlSafe({
      providerId: 'p1', adapter: 'openai-compatible', baseUrl: `https://${PUBLIC_IP}/v1`, resolver: resolverOf({}),
    });
    expect(url?.hostname).toBe(PUBLIC_IP);
  });

  it('http 仅在显式 allowHttp 时允许（内网自建推理服务），且私网地址依然拒绝', async () => {
    await expect(assertProviderBaseUrlSafe({
      providerId: 'p1', adapter: 'openai-compatible', baseUrl: 'http://inference.corp.example.com/v1',
      allowHttp: true, resolver: resolverOf({ 'inference.corp.example.com': [PUBLIC_IP] }),
    })).resolves.toBeTruthy();
    await expect(assertProviderBaseUrlSafe({
      providerId: 'p1', adapter: 'openai-compatible', baseUrl: 'http://inference.corp.example.com/v1',
      allowHttp: true, resolver: resolverOf({ 'inference.corp.example.com': ['10.0.0.5'] }),
    })).rejects.toMatchObject({ code: ErrorCode.SSRF_BLOCKED });
  });

  it('manualRedirectFetch 强制 redirect: manual（3xx 不自动跟随）', async () => {
    const spy = vi.fn().mockResolvedValue(new Response('', { status: 200 }));
    vi.stubGlobal('fetch', spy);
    try {
      await manualRedirectFetch('https://api.deepseek.com/v1/chat/completions', { method: 'POST' });
      expect(spy.mock.calls[0][1]).toMatchObject({ method: 'POST', redirect: 'manual' });
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
