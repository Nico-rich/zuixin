import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as http from 'node:http';
import { nodePinnedTransport } from './pinned-transport';

/**
 * M10-P1 M9-07/SA-13：DNS rebinding 连接固定（socket pin）单测。
 *
 * 测试策略（**不依赖真实外网**）：本地起 127.0.0.1 上的探针服务器，但请求 URL 用
 * **永不解析的域名**（`.invalid` 是 RFC 2606 保留 TLD）+ 已校验的 pinnedAddress。
 * - 连接成功 ⇒ 只连了 pinned 地址，**连接期没有第二次 DNS 查询**（否则 ENOTFOUND）；
 * - 服务器看到的 Host ⇒ 域名语义保持原样（pin 的是地址不是身份，SNI/证书主体不变）；
 * - pin 到无人监听的地址 ⇒ 连接失败而不是"回退 DNS 后成功"（**绝不静默降级**）。
 */

const NON_RESOLVABLE_HOST = 'pinned-probe.invalid';

interface Received { host?: string; url?: string; method?: string }

let server: http.Server;
let port = 0;
const received: Received[] = [];

beforeAll(async () => {
  server = http.createServer((req, res) => {
    received.push({ host: req.headers.host, url: req.url, method: req.method });
    if (req.url === '/redirect') {
      res.writeHead(302, { location: 'https://169.254.169.254/latest/meta-data' });
      res.end();
      return;
    }
    if (req.url === '/empty') {
      res.writeHead(204);
      res.end();
      return;
    }
    if (req.url === '/headers') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(req.headers));
      return;
    }
    if (req.url === '/slow') return; // 永不响应（测中止）
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('pong');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  port = typeof addr === 'object' && addr ? addr.port : 0;
});

afterAll(async () => {
  server.closeAllConnections?.(); // /slow 用例刻意留了悬挂连接，不清理会让 close() 挂住
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const req = (path: string, over: Record<string, unknown> = {}) => ({
  url: `http://${NON_RESOLVABLE_HOST}:${port}${path}`,
  pinnedAddress: '127.0.0.1',
  addresses: ['127.0.0.1'],
  ...over,
});

describe('nodePinnedTransport：连接固定（DNS rebinding 防护）', () => {
  it('I1：URL 域名永不解析（.invalid）却连接成功 → 连接期**零 DNS 查询**', async () => {
    received.length = 0;
    const res = await nodePinnedTransport(req('/echo?a=1'));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('pong');
    // 反向证据：该域名在 DNS 里不存在；若实现里还有第二次解析，这里必然是 ENOTFOUND
    expect(received).toHaveLength(1);
  });

  it('I2：Host 头保持**原域名**（pin 地址 ≠ 改身份；TLS SNI 同理用 servername）', async () => {
    received.length = 0;
    await nodePinnedTransport(req('/echo'));
    expect(received[0].host).toBe(`${NON_RESOLVABLE_HOST}:${port}`);
    expect(received[0].url).toBe('/echo');
  });

  it('I3：pin 到未监听地址 → 连接失败（绝不回退 DNS 后"悄悄成功"）', async () => {
    // 127.0.0.2 是合法回环地址但无监听；若实现回退到域名解析会解析失败，若回退到 127.0.0.1 会成功
    await expect(nodePinnedTransport(req('/echo', { pinnedAddress: '127.0.0.2' })))
      .rejects.toMatchObject({ code: 'ECONNREFUSED' });
  });

  it('方法/自定义头透传；默认不协商压缩（accept-encoding: identity，下载字节口径一致）', async () => {
    received.length = 0;
    const res = await nodePinnedTransport(req('/headers', { method: 'POST', headers: { 'x-trace': 't1' } }));
    const seen = await res.json() as Record<string, string>;
    expect(received[0].method).toBe('POST');
    expect(seen['x-trace']).toBe('t1');
    expect(seen['accept-encoding']).toBe('identity');
  });

  it('调用方显式要求压缩时以调用方为准（默认值不覆盖显式配置）', async () => {
    const res = await nodePinnedTransport(req('/headers', { headers: { 'accept-encoding': 'gzip' } }));
    const seen = await res.json() as Record<string, string>;
    expect(seen['accept-encoding']).toBe('gzip');
  });

  it('3xx **不跟随**（重定向由调用方逐跳校验，绝不自动跳到 metadata 地址）', async () => {
    const res = await nodePinnedTransport(req('/redirect'));
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('https://169.254.169.254/latest/meta-data');
  });

  it('无 body 状态码（204/304）→ body 为 null（Response 构造合法，不抛错）', async () => {
    const res = await nodePinnedTransport(req('/empty'));
    expect(res.status).toBe(204);
    expect(res.body).toBeNull();
    expect(await res.text()).toBe('');
  });

  it('中止信号 → 抛出的错误保持 AbortError 语义（调用方据此映射 PROVIDER_TIMEOUT）', async () => {
    const controller = new AbortController();
    const pending = nodePinnedTransport(req('/slow', { signal: controller.signal }));
    await new Promise((r) => setTimeout(r, 30));
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('每跳独立 socket（agent: false）：两次调用互不复用连接', async () => {
    received.length = 0;
    await nodePinnedTransport(req('/echo'));
    await nodePinnedTransport(req('/echo'));
    expect(received).toHaveLength(2);
  });
});
