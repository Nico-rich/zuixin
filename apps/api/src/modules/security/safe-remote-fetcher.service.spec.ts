import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AppError, ErrorCode } from '../../common/errors/app-error';
import { SafeRemoteFetcher } from './safe-remote-fetcher.service';
import type { PinnedRequest, PinnedTransport } from './pinned-transport';

/**
 * Pre-M9 F3-A 单测：SafeRemoteFetcher 是媒体结果下载的唯一出口。
 * 断言的是"外部可观测行为"：错误码 + 传输层是否被真的调用（未通过校验 ⇒ 一个字节都不出网）。
 *
 * M10-P1 M9-07/SA-13 起传输层可注入（`PinnedTransport`）：
 * - 单测不再 stub 全局 fetch，而是注入假 transport —— 于是"是否出网"与"连到哪个地址"都能被**直接断言**；
 * - pin 断言（DNS 只解析一次 / 连接期不重解析 / DNS 事后翻转无效）见 describe ⑥。
 *
 * 覆盖：回环/私网/元数据/IPv6 回环/IPv6 嵌入形态/0.0.0.0、重定向到内网、
 * DNS rebinding（DNS 返回混合公网+内网）、超限（content-length 与流式两种）、超时、
 * 白名单（含重定向后域名）、合法 provider URL、data URL、连接固定。
 */

const PUBLIC_IP = '93.184.216.34';
const PUBLIC_IP_2 = '93.184.216.35';

interface Harness {
  fetcher: SafeRemoteFetcher;
  transport: ReturnType<typeof vi.fn>;
  resolveCalls: string[];
}

/** 构造 fetcher：DNS 用 map 假解析（记录调用次数），传输层用 spy（默认返回 200） */
function makeFetcher(map: Record<string, string[]>, impl?: PinnedTransport): Harness {
  const resolveCalls: string[] = [];
  const resolver = async (hostname: string): Promise<string[]> => {
    resolveCalls.push(hostname);
    const found = map[hostname];
    if (!found) throw new Error(`ENOTFOUND ${hostname}`);
    return found;
  };
  const transport = vi.fn(impl ?? (async () => ok('BYTES')));
  const fetcher = new SafeRemoteFetcher(resolver, transport as unknown as PinnedTransport);
  return { fetcher, transport, resolveCalls };
}

/** 出网被拒的用例：传输层必须一次都没被调到 */
function expectNoOutbound(h: Harness) {
  expect(h.transport).not.toHaveBeenCalled();
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

/** 取第 n 次传输调用的请求参数 */
function callOf(transport: ReturnType<typeof vi.fn>, n = 0): PinnedRequest {
  return transport.mock.calls[n][0] as PinnedRequest;
}

describe('Pre-M9 F3-A SafeRemoteFetcher', () => {
  beforeEach(() => { vi.restoreAllMocks(); });

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
        const h = makeFetcher(c.dns, vi.fn() as unknown as PinnedTransport);
        await expect(h.fetcher.fetchBuffer(c.url)).rejects.toMatchObject({ code: ErrorCode.SSRF_BLOCKED });
        expectNoOutbound(h);
      });
    }

    it('公网域名解析到内网（DNS 层）→ SSRF_BLOCKED 且不发请求', async () => {
      const h = makeFetcher({ 'evil.example.com': ['10.1.2.3'] }, vi.fn() as unknown as PinnedTransport);
      await expect(h.fetcher.fetchBuffer('https://evil.example.com/a.png')).rejects.toMatchObject({ code: ErrorCode.SSRF_BLOCKED });
      expectNoOutbound(h);
    });

    it('DNS rebinding：解析结果混合公网+内网 → 整体拒绝（不赌哪个地址被连上）', async () => {
      const h = makeFetcher({ 'rebind.example.com': [PUBLIC_IP, '169.254.169.254'] }, vi.fn() as unknown as PinnedTransport);
      await expect(h.fetcher.fetchBuffer('https://rebind.example.com/a.png')).rejects.toMatchObject({ code: ErrorCode.SSRF_BLOCKED });
      expectNoOutbound(h);
    });

    it('DNS 不可解析 → SSRF_BLOCKED（fail-closed）', async () => {
      const h = makeFetcher({}, vi.fn() as unknown as PinnedTransport);
      await expect(h.fetcher.fetchBuffer('https://nope.example.com/a.png')).rejects.toMatchObject({ code: ErrorCode.SSRF_BLOCKED });
      expectNoOutbound(h);
    });
  });

  describe('② 重定向（逐跳校验，绝不自动跟随）', () => {
    it('302 → 内网地址：第二跳被拦截，且只发出一次请求', async () => {
      const h = makeFetcher(
        { 'cdn.example.com': [PUBLIC_IP], 'internal.example.com': ['127.0.0.1'] },
        vi.fn(async () => new Response(null, { status: 302, headers: { location: 'https://internal.example.com/secret' } })) as unknown as PinnedTransport,
      );
      await expect(h.fetcher.fetchBuffer('https://cdn.example.com/a.png')).rejects.toMatchObject({ code: ErrorCode.SSRF_BLOCKED });
      expect(h.transport).toHaveBeenCalledTimes(1);
      expect(callOf(h.transport).url).toBe('https://cdn.example.com/a.png');
    });

    it('302 → http（协议降级）被拒绝', async () => {
      const h = makeFetcher(
        { 'cdn.example.com': [PUBLIC_IP] },
        vi.fn(async () => new Response(null, { status: 302, headers: { location: 'http://cdn.example.com/a.png' } })) as unknown as PinnedTransport,
      );
      await expect(h.fetcher.fetchBuffer('https://cdn.example.com/a.png')).rejects.toMatchObject({ code: ErrorCode.SSRF_BLOCKED });
    });

    it('重定向次数超限 → SSRF_BLOCKED', async () => {
      const h = makeFetcher(
        { 'cdn.example.com': [PUBLIC_IP] },
        vi.fn(async () => new Response(null, { status: 302, headers: { location: 'https://cdn.example.com/next.png' } })) as unknown as PinnedTransport,
      );
      await expect(h.fetcher.fetchBuffer('https://cdn.example.com/a.png', { maxRedirects: 2 }))
        .rejects.toMatchObject({ code: ErrorCode.SSRF_BLOCKED });
      expect(h.transport).toHaveBeenCalledTimes(3); // 首跳 + 2 次重定向后才拒绝
    });

    it('合法重定向（公网 → 公网）跟随成功，redirects 计数正确', async () => {
      const h = makeFetcher(
        { 'cdn.example.com': [PUBLIC_IP] },
        vi.fn()
          .mockResolvedValueOnce(new Response(null, { status: 301, headers: { location: '/real.png' } }))
          .mockResolvedValueOnce(ok('PNGDATA')) as unknown as PinnedTransport,
      );
      const r = await h.fetcher.fetchBuffer('https://cdn.example.com/a.png');
      expect(r.buffer.toString()).toBe('PNGDATA');
      expect(r.redirects).toBe(1);
      expect(r.url).toBe('https://cdn.example.com/real.png');
    });
  });

  describe('③ 白名单', () => {
    it('不在白名单的域名 → 拒绝且不出网', async () => {
      const h = makeFetcher({ 'evil.example.com': [PUBLIC_IP] }, vi.fn() as unknown as PinnedTransport);
      await expect(h.fetcher.fetchBuffer('https://evil.example.com/a.png', { allowedHosts: ['cdn.example.com'] }))
        .rejects.toMatchObject({ code: ErrorCode.SSRF_BLOCKED });
      expectNoOutbound(h);
    });

    it('白名单子域放行；重定向到白名单外域名 → 拒绝', async () => {
      const h = makeFetcher(
        { 'a.cdn.example.com': [PUBLIC_IP], 'evil.example.com': [PUBLIC_IP] },
        vi.fn()
          .mockResolvedValueOnce(ok('OK'))
          .mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: 'https://evil.example.com/x.png' } }))
          // 后续调用（若白名单被绕过）返回 200，用来暴露"本该被拦下却出网了"的回归
          .mockResolvedValue(ok('LEAKED')) as unknown as PinnedTransport,
      );
      const r = await h.fetcher.fetchBuffer('https://a.cdn.example.com/a.png', { allowedHosts: ['cdn.example.com'] });
      expect(r.buffer.toString()).toBe('OK');
      await expect(h.fetcher.fetchBuffer('https://a.cdn.example.com/b.png', { allowedHosts: ['cdn.example.com'] }))
        .rejects.toMatchObject({ code: ErrorCode.SSRF_BLOCKED });
      // 共 2 次：白名单内首跳 ×2；重定向到名单外域名的那一跳在白名单校验处就被拒绝（未出网）
      expect(h.transport).toHaveBeenCalledTimes(2);
    });
  });

  describe('④ 体积上限与超时', () => {
    it('content-length 超限 → VALIDATION_ERROR 且不读 body', async () => {
      const h = makeFetcher(
        { 'cdn.example.com': [PUBLIC_IP] },
        vi.fn(async () => ok('x', { 'content-length': String(10 * 1024 * 1024) })) as unknown as PinnedTransport,
      );
      await expect(h.fetcher.fetchBuffer('https://cdn.example.com/a.png', { maxBytes: 1024 }))
        .rejects.toMatchObject({ code: ErrorCode.VALIDATION_ERROR });
    });

    it('流式响应超限 → 立即中断读取（cancel）并报错，不把整包读进内存', async () => {
      const { res, state } = streamResponse(64 * 1024, 100);
      const h = makeFetcher({ 'cdn.example.com': [PUBLIC_IP] }, vi.fn(async () => res) as unknown as PinnedTransport);
      await expect(h.fetcher.fetchBuffer('https://cdn.example.com/a.png', { maxBytes: 128 * 1024 }))
        .rejects.toMatchObject({ code: ErrorCode.VALIDATION_ERROR });
      expect(state.cancelled).toBe(true);
    });

    it('单跳超时（服务端不响应）→ PROVIDER_TIMEOUT', async () => {
      const h = makeFetcher(
        { 'cdn.example.com': [PUBLIC_IP] },
        vi.fn((req: PinnedRequest) => new Promise<Response>((_resolve, reject) => {
          req.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
        })) as unknown as PinnedTransport,
      );
      await expect(h.fetcher.fetchBuffer('https://cdn.example.com/a.png', { connectTimeoutMs: 20, totalTimeoutMs: 5_000 }))
        .rejects.toMatchObject({ code: ErrorCode.PROVIDER_TIMEOUT });
    });
  });

  describe('⑤ 正常路径', () => {
    it('合法 provider URL（https + 公网 IP + 白名单）→ 返回字节与元信息', async () => {
      const h = makeFetcher(
        { 'dashscope.aliyuncs.com': [PUBLIC_IP] },
        vi.fn(async () => ok('IMGDATA', { 'content-type': 'image/png', 'content-length': '7' })) as unknown as PinnedTransport,
      );
      const r = await h.fetcher.fetchBuffer('https://dashscope.aliyuncs.com/result.png', {
        allowedHosts: ['aliyuncs.com'], purpose: 'media-download:t1',
      });
      expect(r.bytes).toBe(7);
      expect(r.contentType).toBe('image/png');
      expect(r.buffer.toString()).toBe('IMGDATA');
      expect(callOf(h.transport).url).toBe('https://dashscope.aliyuncs.com/result.png');
    });

    it('IP 字面量公网地址（provider 直连结果）可通过，pin 即该字面量', async () => {
      const h = makeFetcher({});
      const r = await h.fetcher.fetchBuffer(`https://${PUBLIC_IP}/r.png`);
      expect(r.buffer.toString()).toBe('BYTES');
      expect(callOf(h.transport).pinnedAddress).toBe(PUBLIC_IP);
    });

    it('data URL（mock provider 内联 base64）→ 解码成功，不出网', async () => {
      const h = makeFetcher({}, vi.fn() as unknown as PinnedTransport);
      const r = await h.fetcher.fetchBuffer(`data:image/png;base64,${Buffer.from('MOCK-IMAGE').toString('base64')}`);
      expect(r.buffer.toString()).toBe('MOCK-IMAGE');
      expect(r.contentType).toBe('image/png');
      expectNoOutbound(h);
    });

    it('data URL 超限 → VALIDATION_ERROR；空地址 → VALIDATION_ERROR', async () => {
      const h = makeFetcher({});
      await expect(h.fetcher.fetchBuffer(`data:image/png;base64,${'A'.repeat(4096)}`, { maxBytes: 64 }))
        .rejects.toBeInstanceOf(AppError);
      await expect(h.fetcher.fetchBuffer('   ')).rejects.toMatchObject({ code: ErrorCode.VALIDATION_ERROR });
    });

    it('非 2xx 响应 → 使用调用方指定错误码（默认 PROVIDER_UNKNOWN）', async () => {
      const h = makeFetcher(
        { 'cdn.example.com': [PUBLIC_IP] },
        vi.fn(async () => new Response('nope', { status: 404 })) as unknown as PinnedTransport,
      );
      await expect(h.fetcher.fetchBuffer('https://cdn.example.com/a.png')).rejects.toMatchObject({ code: ErrorCode.PROVIDER_UNKNOWN });
    });

    it('envAllowedHosts 解析 MEDIA_DOWNLOAD_ALLOWED_HOSTS（逗号分隔、大小写/空白归一）', () => {
      expect(SafeRemoteFetcher.envAllowedHosts(' CDN.Example.com , ,oss.example.com ')).toEqual(['cdn.example.com', 'oss.example.com']);
      expect(SafeRemoteFetcher.envAllowedHosts('')).toEqual([]);
    });
  });

  /**
   * ⑥ M10-P1 M9-07/SA-13：DNS rebinding 连接固定（**证明 pin**，不是"重新解析"）。
   * 三个不变式：
   *   I1 每跳 DNS 解析**恰好一次**（且发生在出网之前）；
   *   I2 传输层拿到的 pinnedAddress ∈ 本次解析的已校验地址（不是事后第二次解析的结果）；
   *   I3 解析之后 DNS 记录翻转为内网 → 本次连接**仍**用 pinned 地址（窗口已关闭）。
   */
  describe('⑥ 连接固定（DNS rebinding 防护）', () => {
    it('I1：每跳 DNS 恰好解析一次（校验期），连接期不再解析', async () => {
      let secondAnswer = PUBLIC_IP;
      const resolveCalls: string[] = [];
      const resolver = async (): Promise<string[]> => { resolveCalls.push('x'); return [secondAnswer]; };
      // 传输层"模拟"一次会再解析的实现：如果实现里偷偷再解析，secondAnswer 翻转就会被看见
      const transport = vi.fn(async (req: PinnedRequest) => {
        secondAnswer = '169.254.169.254'; // 建连瞬间 DNS 被翻转（真实场景由攻击者控制权威 DNS）
        return ok(`PINNED:${req.pinnedAddress}`);
      });
      const fetcher = new SafeRemoteFetcher(resolver, transport as unknown as PinnedTransport);

      const r = await fetcher.fetchBuffer('https://cdn.example.com/a.png');
      expect(resolveCalls).toHaveLength(1);          // I1：整个请求只解析一次
      expect(r.buffer.toString()).toBe(`PINNED:${PUBLIC_IP}`); // I3：翻转后的内网地址未参与连接
      expect(callOf(transport).pinnedAddress).toBe(PUBLIC_IP);
    });

    it('I2：pinnedAddress 是本次解析出的已校验地址（多地址取第一个，且全部地址都进过分类校验）', async () => {
      const h = makeFetcher({ 'cdn.example.com': [PUBLIC_IP, PUBLIC_IP_2] });
      await h.fetcher.fetchBuffer('https://cdn.example.com/a.png');
      expect(callOf(h.transport).pinnedAddress).toBe(PUBLIC_IP);
      expect(callOf(h.transport).addresses).toEqual([PUBLIC_IP, PUBLIC_IP_2]);
    });

    it('I3：DNS 混合"公网 + 内网"时整体拒绝（绝不 pin 到内网地址）', async () => {
      const h = makeFetcher({ 'cdn.example.com': ['169.254.169.254'] }, vi.fn() as unknown as PinnedTransport);
      await expect(h.fetcher.fetchBuffer('https://cdn.example.com/a.png')).rejects.toMatchObject({ code: ErrorCode.SSRF_BLOCKED });
      expectNoOutbound(h);
    });

    it('重定向到新域名 → 新域名各自解析一次并各自 pin（pin 不跨跳复用）', async () => {
      const resolveCalls: string[] = [];
      const resolver = async (hostname: string): Promise<string[]> => {
        resolveCalls.push(hostname);
        return hostname === 'a.cdn.example.com' ? [PUBLIC_IP] : [PUBLIC_IP_2];
      };
      const transport = vi.fn()
        .mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: 'https://b.cdn.example.com/real.png' } }))
        .mockResolvedValueOnce(ok('OK'));
      const fetcher = new SafeRemoteFetcher(resolver, transport as unknown as PinnedTransport);

      const r = await fetcher.fetchBuffer('https://a.cdn.example.com/a.png');
      expect(r.url).toBe('https://b.cdn.example.com/real.png');
      expect(resolveCalls).toEqual(['a.cdn.example.com', 'b.cdn.example.com']);
      expect(callOf(transport, 0).pinnedAddress).toBe(PUBLIC_IP);
      expect(callOf(transport, 1).pinnedAddress).toBe(PUBLIC_IP_2);
    });

    it('传输层拿到的 URL 仍是原域名（Host 头/SNI 语义不变，pin 的是地址不是身份）', async () => {
      const h = makeFetcher({ 'dashscope.aliyuncs.com': [PUBLIC_IP] });
      await h.fetcher.fetchBuffer('https://dashscope.aliyuncs.com/result.png?v=1#frag');
      const req = callOf(h.transport);
      expect(new URL(req.url).hostname).toBe('dashscope.aliyuncs.com');
      expect(req.url).toBe('https://dashscope.aliyuncs.com/result.png?v=1#frag');
    });
  });
});
