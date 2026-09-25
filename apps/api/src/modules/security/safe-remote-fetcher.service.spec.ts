import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AppError, ErrorCode } from '../../common/errors/app-error';
import { SafeRemoteFetcher } from './safe-remote-fetcher.service';

/**
 * Pre-M9 F3-A 单测：SafeRemoteFetcher 是媒体结果下载的唯一出口。
 * 断言的是"外部可观测行为"：错误码 + fetch 是否被真的调用（未通过校验 ⇒ 一个字节都不出网）。
 *
 * 覆盖：回环/私网/元数据/IPv6 回环/IPv6 嵌入形态/0.0.0.0、重定向到内网、
 * DNS rebinding（DNS 返回混合公网+内网）、超限（content-length 与流式两种）、超时、
 * 白名单（含重定向后域名）、合法 provider URL、data URL。
 */

const PUBLIC_IP = '93.184.216.34';

function fetcherWith(map: Record<string, string[]>): SafeRemoteFetcher {
  const resolver = async (hostname: string): Promise<string[]> => {
    const found = map[hostname];
    if (!found) throw new Error(`ENOTFOUND ${hostname}`);
    return found;
  };
  return new SafeRemoteFetcher(resolver);
}

/** 简易 200 响应 */
function ok(body: string, headers: Record<string, string> = {}): Response {
  return new Response(body, { status: 200, headers });
}

/** 无限/大体积流式响应（用于超限 + cancel 断言） */
function streamResponse(chunkBytes: number, chunks: number, headers: Record<string, string> = {}): { res: Response; state: { cancelled: boolean } } {
  const state = { cancelled: false };
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (state.cancelled || chunks-- <= 0) { controller.close(); return; }
      controller.enqueue(new Uint8Array(chunkBytes));
    },
    cancel() { state.cancelled = true; },
  });
  return { res: new Response(stream, { status: 200, headers }), state };
}

describe('Pre-M9 F3-A SafeRemoteFetcher', () => {
  beforeEach(() => { vi.restoreAllMocks(); });
  afterEach(() => { vi.unstubAllGlobals(); });

  describe('① 目标地址校验（校验不过 ⇒ 绝不出网）', () => {
    const blocked: Array<{ name: string; url: string; dns: Record<string, string[]> }> = [
      { name: 'localhost 主机名', url: 'https://localhost/result.png', dns: {} },
      { name: '回环 IPv4', url: 'https://127.0.0.1/result.png', dns: {} },
      { name: '0.0.0.0', url: 'https://0.0.0.0/result.png', dns: {} },
      { name: '私网 10.x', url: 'https://10.0.0.5/result.png', dns: {} },
      { name: '私网 192.168.x', url: 'https://192.168.1.10/result.png', dns: {} },
      { name: '私网 172.16.x', url: 'https://172.16.3.4/result.png', dns: {} },
      { name: '云 metadata（link-local）', url: 'https://169.254.169.254/latest/meta-data/', dns: {} },
      { name: 'IPv6 回环', url: 'https://[::1]/result.png', dns: {} },
      { name: 'IPv6 链路本地', url: 'https://[fe80::1]/result.png', dns: {} },
      { name: 'IPv6 嵌入私网 IPv4', url: 'https://[::ffff:10.0.0.5]/result.png', dns: {} },
      { name: 'http 协议降级', url: 'http://cdn.example.com/result.png', dns: { 'cdn.example.com': [PUBLIC_IP] } },
      { name: '带凭证 URL', url: 'https://user:pass@cdn.example.com/result.png', dns: { 'cdn.example.com': [PUBLIC_IP] } },
      { name: '内网域名后缀', url: 'https://cache.internal/result.png', dns: {} },
    ];

    for (const c of blocked) {
      it(`${c.name} → SSRF_BLOCKED 且不发请求`, async () => {
        const fetchSpy = vi.fn();
        vi.stubGlobal('fetch', fetchSpy);
        const fetcher = fetcherWith(c.dns);
        await expect(fetcher.fetchBuffer(c.url)).rejects.toMatchObject({ code: ErrorCode.SSRF_BLOCKED });
        expect(fetchSpy).not.toHaveBeenCalled();
      });
    }

    it('公网域名解析到内网（DNS 层）→ SSRF_BLOCKED 且不发请求', async () => {
      const fetchSpy = vi.fn();
      vi.stubGlobal('fetch', fetchSpy);
      const fetcher = fetcherWith({ 'evil.example.com': ['10.1.2.3'] });
      await expect(fetcher.fetchBuffer('https://evil.example.com/a.png')).rejects.toMatchObject({ code: ErrorCode.SSRF_BLOCKED });
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('DNS rebinding：解析结果混合公网+内网 → 整体拒绝（不赌哪个地址被连上）', async () => {
      const fetchSpy = vi.fn();
      vi.stubGlobal('fetch', fetchSpy);
      const fetcher = fetcherWith({ 'rebind.example.com': [PUBLIC_IP, '169.254.169.254'] });
      await expect(fetcher.fetchBuffer('https://rebind.example.com/a.png')).rejects.toMatchObject({ code: ErrorCode.SSRF_BLOCKED });
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('DNS 不可解析 → SSRF_BLOCKED（fail-closed）', async () => {
      const fetchSpy = vi.fn();
      vi.stubGlobal('fetch', fetchSpy);
      const fetcher = fetcherWith({});
      await expect(fetcher.fetchBuffer('https://nope.example.com/a.png')).rejects.toMatchObject({ code: ErrorCode.SSRF_BLOCKED });
      expect(fetchSpy).not.toHaveBeenCalled();
    });
  });

  describe('② 重定向（逐跳校验，绝不自动跟随）', () => {
    it('302 → 内网地址：第二跳被拦截，且只发出一次请求', async () => {
      const fetchSpy = vi.fn().mockResolvedValueOnce(
        new Response(null, { status: 302, headers: { location: 'https://internal.example.com/secret' } }),
      );
      vi.stubGlobal('fetch', fetchSpy);
      const fetcher = fetcherWith({ 'cdn.example.com': [PUBLIC_IP], 'internal.example.com': ['127.0.0.1'] });
      await expect(fetcher.fetchBuffer('https://cdn.example.com/a.png')).rejects.toMatchObject({ code: ErrorCode.SSRF_BLOCKED });
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      // 首跳也必须显式禁用自动重定向
      expect(fetchSpy.mock.calls[0][1]).toMatchObject({ redirect: 'manual' });
    });

    it('302 → http（协议降级）被拒绝', async () => {
      const fetchSpy = vi.fn().mockResolvedValueOnce(
        new Response(null, { status: 302, headers: { location: 'http://cdn.example.com/a.png' } }),
      );
      vi.stubGlobal('fetch', fetchSpy);
      const fetcher = fetcherWith({ 'cdn.example.com': [PUBLIC_IP] });
      await expect(fetcher.fetchBuffer('https://cdn.example.com/a.png')).rejects.toMatchObject({ code: ErrorCode.SSRF_BLOCKED });
    });

    it('重定向次数超限 → SSRF_BLOCKED', async () => {
      const fetchSpy = vi.fn().mockImplementation(async () =>
        new Response(null, { status: 302, headers: { location: 'https://cdn.example.com/next.png' } }));
      vi.stubGlobal('fetch', fetchSpy);
      const fetcher = fetcherWith({ 'cdn.example.com': [PUBLIC_IP] });
      await expect(fetcher.fetchBuffer('https://cdn.example.com/a.png', { maxRedirects: 2 }))
        .rejects.toMatchObject({ code: ErrorCode.SSRF_BLOCKED });
      expect(fetchSpy).toHaveBeenCalledTimes(3); // 首跳 + 2 次重定向后才拒绝
    });

    it('合法重定向（公网 → 公网）跟随成功，redirects 计数正确', async () => {
      const fetchSpy = vi.fn()
        .mockResolvedValueOnce(new Response(null, { status: 301, headers: { location: '/real.png' } }))
        .mockResolvedValueOnce(ok('PNGDATA'));
      vi.stubGlobal('fetch', fetchSpy);
      const fetcher = fetcherWith({ 'cdn.example.com': [PUBLIC_IP] });
      const r = await fetcher.fetchBuffer('https://cdn.example.com/a.png');
      expect(r.buffer.toString()).toBe('PNGDATA');
      expect(r.redirects).toBe(1);
      expect(r.url).toBe('https://cdn.example.com/real.png');
    });
  });

  describe('③ 白名单', () => {
    it('不在白名单的域名 → 拒绝且不出网', async () => {
      const fetchSpy = vi.fn();
      vi.stubGlobal('fetch', fetchSpy);
      const fetcher = fetcherWith({ 'evil.example.com': [PUBLIC_IP] });
      await expect(fetcher.fetchBuffer('https://evil.example.com/a.png', { allowedHosts: ['cdn.example.com'] }))
        .rejects.toMatchObject({ code: ErrorCode.SSRF_BLOCKED });
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('白名单子域放行；重定向到白名单外域名 → 拒绝', async () => {
      const fetchSpy = vi.fn()
        .mockResolvedValueOnce(ok('OK'))
        .mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: 'https://evil.example.com/x.png' } }));
      vi.stubGlobal('fetch', fetchSpy);
      const fetcher = fetcherWith({ 'a.cdn.example.com': [PUBLIC_IP], 'evil.example.com': [PUBLIC_IP] });
      const r = await fetcher.fetchBuffer('https://a.cdn.example.com/a.png', { allowedHosts: ['cdn.example.com'] });
      expect(r.buffer.toString()).toBe('OK');
      await expect(fetcher.fetchBuffer('https://a.cdn.example.com/b.png', { allowedHosts: ['cdn.example.com'] }))
        .rejects.toMatchObject({ code: ErrorCode.SSRF_BLOCKED });
      // 共 2 次：白名单内首跳 ×2；重定向到名单外域名的那一跳在白名单校验处就被拒绝（未出网）
      expect(fetchSpy).toHaveBeenCalledTimes(2);
    });
  });

  describe('④ 体积上限与超时', () => {
    it('content-length 超限 → VALIDATION_ERROR 且不读 body', async () => {
      const fetchSpy = vi.fn().mockResolvedValueOnce(ok('x', { 'content-length': String(10 * 1024 * 1024) }));
      vi.stubGlobal('fetch', fetchSpy);
      const fetcher = fetcherWith({ 'cdn.example.com': [PUBLIC_IP] });
      await expect(fetcher.fetchBuffer('https://cdn.example.com/a.png', { maxBytes: 1024 }))
        .rejects.toMatchObject({ code: ErrorCode.VALIDATION_ERROR });
    });

    it('流式响应超限 → 立即中断读取（cancel）并报错，不把整包读进内存', async () => {
      const { res, state } = streamResponse(64 * 1024, 100);
      vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(res));
      const fetcher = fetcherWith({ 'cdn.example.com': [PUBLIC_IP] });
      await expect(fetcher.fetchBuffer('https://cdn.example.com/a.png', { maxBytes: 128 * 1024 }))
        .rejects.toMatchObject({ code: ErrorCode.VALIDATION_ERROR });
      expect(state.cancelled).toBe(true);
    });

    it('单跳超时（服务端不响应）→ PROVIDER_TIMEOUT', async () => {
      const fetchSpy = vi.fn().mockImplementation((_url: string, init: RequestInit) => new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
      }));
      vi.stubGlobal('fetch', fetchSpy);
      const fetcher = fetcherWith({ 'cdn.example.com': [PUBLIC_IP] });
      await expect(fetcher.fetchBuffer('https://cdn.example.com/a.png', { connectTimeoutMs: 20, totalTimeoutMs: 5_000 }))
        .rejects.toMatchObject({ code: ErrorCode.PROVIDER_TIMEOUT });
    });
  });

  describe('⑤ 正常路径', () => {
    it('合法 provider URL（https + 公网 IP + 白名单）→ 返回字节与元信息', async () => {
      const fetchSpy = vi.fn().mockResolvedValueOnce(ok('IMGDATA', { 'content-type': 'image/png', 'content-length': '7' }));
      vi.stubGlobal('fetch', fetchSpy);
      const fetcher = fetcherWith({ 'dashscope.aliyuncs.com': [PUBLIC_IP] });
      const r = await fetcher.fetchBuffer('https://dashscope.aliyuncs.com/result.png', {
        allowedHosts: ['aliyuncs.com'], purpose: 'media-download:t1',
      });
      expect(r.bytes).toBe(7);
      expect(r.contentType).toBe('image/png');
      expect(r.buffer.toString()).toBe('IMGDATA');
      expect(fetchSpy.mock.calls[0][0]).toBe('https://dashscope.aliyuncs.com/result.png');
      expect(fetchSpy.mock.calls[0][1]).toMatchObject({ redirect: 'manual' });
    });

    it('IP 字面量公网地址（provider 直连结果）可通过', async () => {
      const fetchSpy = vi.fn().mockResolvedValueOnce(ok('BYTES'));
      vi.stubGlobal('fetch', fetchSpy);
      const fetcher = fetcherWith({});
      const r = await fetcher.fetchBuffer(`https://${PUBLIC_IP}/r.png`);
      expect(r.buffer.toString()).toBe('BYTES');
    });

    it('data URL（mock provider 内联 base64）→ 解码成功，不出网', async () => {
      const fetchSpy = vi.fn();
      vi.stubGlobal('fetch', fetchSpy);
      const fetcher = fetcherWith({});
      const r = await fetcher.fetchBuffer(`data:image/png;base64,${Buffer.from('MOCK-IMAGE').toString('base64')}`);
      expect(r.buffer.toString()).toBe('MOCK-IMAGE');
      expect(r.contentType).toBe('image/png');
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('data URL 超限 → VALIDATION_ERROR；空地址 → VALIDATION_ERROR', async () => {
      const fetcher = fetcherWith({});
      await expect(fetcher.fetchBuffer(`data:image/png;base64,${'A'.repeat(4096)}`, { maxBytes: 64 }))
        .rejects.toBeInstanceOf(AppError);
      await expect(fetcher.fetchBuffer('   ')).rejects.toMatchObject({ code: ErrorCode.VALIDATION_ERROR });
    });

    it('非 2xx 响应 → 使用调用方指定错误码（默认 PROVIDER_UNKNOWN）', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(new Response('nope', { status: 404 })));
      const fetcher = fetcherWith({ 'cdn.example.com': [PUBLIC_IP] });
      await expect(fetcher.fetchBuffer('https://cdn.example.com/a.png')).rejects.toMatchObject({ code: ErrorCode.PROVIDER_UNKNOWN });
    });

    it('envAllowedHosts 解析 MEDIA_DOWNLOAD_ALLOWED_HOSTS（逗号分隔、大小写/空白归一）', () => {
      expect(SafeRemoteFetcher.envAllowedHosts(' CDN.Example.com , ,oss.example.com ')).toEqual(['cdn.example.com', 'oss.example.com']);
      expect(SafeRemoteFetcher.envAllowedHosts('')).toEqual([]);
    });
  });
});
