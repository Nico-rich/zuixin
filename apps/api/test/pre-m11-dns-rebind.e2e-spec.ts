import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as http from 'node:http';
import { Readable } from 'node:stream';
import { lookup as dnsLookup } from 'node:dns/promises';
import { PrismaModule } from '../src/modules/prisma/prisma.module';
import { SecurityModule } from '../src/modules/security/security.module';
import { SafeRemoteFetcher } from '../src/modules/security/safe-remote-fetcher.service';
import { nodePinnedTransport, PINNED_TRANSPORT, PinnedRequest, PinnedTransport } from '../src/modules/security/pinned-transport';
import { DnsResolver, nodeDnsResolver, SSRF_RESOLVER } from '../src/modules/security/ssrf-guard';
import { AppError, ErrorCode } from '../src/common/errors/app-error';

/**
 * Pre-M11 P14 / NV-05：DNS rebinding **真实投毒** e2e（真 socket + 真 HTTP 服务器 + 生产装配的固定传输层）。
 *
 * 与既有单测（`pinned-transport.spec.ts` / `safe-remote-fetcher.service.spec.ts` 的 ⑥）的差别：
 * 那些用例注入**假 transport** 断言"传参正确"；本 spec **不替换传输层**——用生产默认的
 * `nodePinnedTransport`（node:https/http + lookup 钩子）发**真实 TCP 连接**，只把解析器换成
 * "翻转解析器"（模拟攻击者控制的 DNS：第 1 次解析给公网地址通过校验，第 2 次起给 `127.0.0.1`）。
 *
 * 三条断言面（缺一不足以证明连接固定）：
 * 1. **连接落点**：本机 127.0.0.1 上的探针服务器**收到**请求（pin 生效，真实 socket 建连到已校验地址）；
 *    同时**翻转目标服务器收到 0 个请求**（若连接期发生第二次解析，请求会落到它身上）；
 * 2. **身份不变**：探针服务器看到的 `Host` 仍是**原域名**（pin 的是地址不是身份 → TLS 证书主体/SNI 语义不变）；
 * 3. **零第二次解析**：翻转解析器的调用次数恒为 1/跳；对**永不解析**的主机名（`.invalid`）请求仍成功
 *    （若连接期存在 DNS 查询，必然 ENOTFOUND 失败）——这是"连接期无第二次查询"的直接证据。
 *
 * 诚实边界（不假装覆盖）：
 * - 本机只有一个可路由的回环地址（Windows 下 127.0.0.1），**没有任何"公网分类且本机可达"的地址**
 *   （`classifyIp` 覆盖 127/8、10/8、192.168/16、169.254/16、CGNAT、TEST-NET 等全部保留段），
 *   因此"端到端经 SSRF 防线把真实连接落到本机服务器"在单机环境**不可能**——端到端那一段断言的是
 *   **判别性事实**：翻转目标服务器零请求 + 解析次数 1 + 失败语义为网络类（绝不是翻转目标的响应体）。
 * - pin 消除的是"校验地址 ≠ 连接地址"的窗口；同一地址上的服务被攻陷属上游信任问题（非 rebinding）。
 */

/** example.com 的真实 A 记录（RFC 2606 保留域，公网分类） */
const PUBLIC_IP = '93.184.216.34';
/**
 * 不可解析的探测域名：`.example` 为 RFC 2606 保留 TLD（无 A 记录）。
 * 注：**不能用 `.invalid`/`.test`/`.local`**——它们在 `isInternalHostname` 的拒绝名单里，
 * 同步层就会以 `internal_hostname` 拒掉，根本走不到 DNS/连接固定这一段。
 */
const UNRESOLVABLE_HOST = 'rebind-probe.example';

interface Hit { host?: string; url?: string; remote?: string; local?: string }

/** 启动一个真实 HTTP 探针服务器（127.0.0.1 + 临时端口），记录每个请求的 Host/远端/本地地址 */
async function startProbeServer(label: string, body: string, hits: Hit[]): Promise<{ port: number; close: () => Promise<void> }> {
  const server = http.createServer((req, res) => {
    hits.push({
      host: req.headers.host,
      url: req.url,
      remote: req.socket.remoteAddress,
      local: req.socket.localAddress,
    });
    if (req.url?.startsWith('/slow')) return; // 永不响应（用于超时分支）
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end(body);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  return {
    port,
    close: async () => {
      server.closeAllConnections?.();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

/**
 * 翻转解析器：模拟"攻击者控制的 DNS"。
 * 第 1 次解析 → 公网地址（通过 SSRF 分类校验，被固定为连接地址）；
 * 第 2 次起 → 127.0.0.1（攻击者的内网服务；**只有**代码在连接期第二次解析才会被用到）。
 */
function flippingResolver(firstAnswer: string): { resolve: DnsResolver; calls: string[] } {
  const calls: string[] = [];
  const resolve: DnsResolver = async (hostname: string): Promise<string[]> => {
    calls.push(hostname);
    return calls.length === 1 ? [firstAnswer] : ['127.0.0.1'];
  };
  return { resolve, calls };
}

/**
 * 脆弱传输层（**负控专用**，绝不出现在生产代码）：连接期再解析一次 DNS 并按解析结果建连
 * —— 这正是连接固定要消除的 TOCTOU 窗口。用来证明"同一翻转在脆弱实现下真的会把内网内容取回来"，
 * 从而证明 T3 的"零请求"不是"什么也没发生"的假阳性。
 */
function vulnerableTransport(resolveOnceMore: DnsResolver): PinnedTransport {
  return async (req: PinnedRequest): Promise<Response> => {
    const url = new URL(req.url);
    const [address] = await resolveOnceMore(url.hostname); // ← 第二次解析（攻击者的翻转在此生效）
    return await new Promise<Response>((resolve, reject) => {
      const request = http.request(
        {
          hostname: address,
          port: Number(url.port !== '' ? url.port : 80),
          path: `${url.pathname}${url.search}`,
          method: req.method ?? 'GET',
          headers: { host: url.host, ...(req.headers ?? {}) },
        },
        (res) => {
          resolve(new Response(Readable.toWeb(res) as unknown as ReadableStream<Uint8Array>, { status: res.statusCode ?? 502 }));
        },
      );
      request.on('error', reject);
      request.end();
    });
  };
}

describe('Pre-M11 P14 NV-05 DNS rebinding 投毒（真实 socket 连接固定）', () => {
  let app: INestApplication;
  let pinnedServer: { port: number; close: () => Promise<void> };
  let flippedServer: { port: number; close: () => Promise<void> };
  const pinnedHits: Hit[] = [];   // pin 目标（"provider 结果"）收到的请求
  const flippedHits: Hit[] = [];  // 翻转目标（"攻击者内网服务"）收到的请求

  beforeAll(async () => {
    pinnedServer = await startProbeServer('pinned', 'PINNED-OK', pinnedHits);
    flippedServer = await startProbeServer('flipped', 'INTERNAL-LEAK', flippedHits);
  });

  afterAll(async () => {
    await app?.close();
    await pinnedServer?.close();
    await flippedServer?.close();
  });

  // ────────────────────────────────────────────────────────────────────────────
  // T1：真实 socket——连接落在 pinned 地址；Host 保持原域名；连接期零 DNS
  // ────────────────────────────────────────────────────────────────────────────
  it('T1a 真实 HTTP：pin 到 127.0.0.1 的请求成功（域名不可解析 → 连接期零 DNS 查询）', async () => {
    const flippedBefore = flippedHits.length;
    const res = await nodePinnedTransport({
      url: `http://${UNRESOLVABLE_HOST}:${pinnedServer.port}/probe`,
      pinnedAddress: '127.0.0.1',
      addresses: ['127.0.0.1'],
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('PINNED-OK'); // 本机探针服务器应答（真实 TCP）
    const hit = pinnedHits.at(-1)!;
    expect(hit.remote).toBe('127.0.0.1'); // 真实建连落点 = pinned 地址
    expect(hit.host).toBe(`${UNRESOLVABLE_HOST}:${pinnedServer.port}`); // Host 仍是原域名
    expect(flippedHits.length).toBe(flippedBefore); // 翻转目标零请求
  }, 20000);

  it('T1b 真实 HTTP：域名（可解析到公网地址）仍连 pinned 地址（DNS 答案被 pin 覆盖）', async () => {
    // example.com 真实解析到公网地址；pin 覆盖它 → 请求落到本机探针服务器而不是公网
    const real = await dnsLookup('example.com', { all: true }).catch(() => []);
    const realAddresses = real.map((r) => r.address);
    const res = await nodePinnedTransport({
      url: `http://example.com:${pinnedServer.port}/probe`,
      pinnedAddress: '127.0.0.1',
      addresses: ['127.0.0.1'],
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('PINNED-OK');
    const hit = pinnedHits.at(-1)!;
    expect(hit.host).toBe(`example.com:${pinnedServer.port}`);
    expect(hit.remote).toBe('127.0.0.1');
    // 证据行（非断言硬依赖）：域名当前 DNS 解析确实不是回环 → "pin 覆盖了 DNS 答案"
    if (realAddresses.length) {
      expect(realAddresses.every((a) => a !== '127.0.0.1' && !a.startsWith('127.'))).toBe(true);
    }
  }, 20000);

  it('T1c 真实 HTTP：pin 地址不可达 → 连接失败且错误里是**已固定地址**（不回退、不静默）', async () => {
    // 取一个确定无人监听的端口：临时绑定后立即关闭（该端口在测试期内不再使用）
    const throwaway = await startProbeServer('throwaway', 'x', []);
    await throwaway.close();
    const closedPort = throwaway.port;
    const flippedBefore = flippedHits.length;

    const error = await nodePinnedTransport({
      url: `http://example.com:${closedPort}/probe`, // 域名可解析到公网 —— 但连接只许去 pin
      pinnedAddress: '127.0.0.1',
      addresses: ['127.0.0.1'],
    }).then(
      () => null,
      (err: Error) => err,
    );
    expect(error).toBeInstanceOf(Error);
    // OS 层事实：connect 的目标是 pinned 地址（错误串形如 "connect ECONNREFUSED 127.0.0.1:PORT"）
    expect(error!.message).toContain('127.0.0.1');
    expect(error!.message).not.toContain(PUBLIC_IP);
    expect(flippedHits.length).toBe(flippedBefore); // 失败绝不改打别的地址
  }, 20000);

  // ────────────────────────────────────────────────────────────────────────────
  // T2/T3：端到端（SSRF 防线 → 连接固定 → 真实 transport），攻击者 DNS 翻转
  // ────────────────────────────────────────────────────────────────────────────
  it('T3 DNS 翻转（第 1 次公网、第 2 次起 127.0.0.1）：请求绝不落到翻转地址，且解析只发生 1 次', async () => {
    const flip = flippingResolver(PUBLIC_IP);
    // 只覆盖 DNS 解析器（= 攻击者的能力）；传输层用 SecurityModule 装配的**生产实现**
    const moduleRef = await Test.createTestingModule({ imports: [PrismaModule, SecurityModule] })
      .overrideProvider(SSRF_RESOLVER)
      .useValue(flip.resolve)
      .compile();
    app = moduleRef.createNestApplication();
    await app.init();

    const wired = moduleRef.get<PinnedTransport>(PINNED_TRANSPORT);
    expect(wired).toBe(nodePinnedTransport); // 生产装配事实：默认即"连接固定"传输层（非测试替身）

    const fetcher = moduleRef.get(SafeRemoteFetcher);
    // URL 端口 = 翻转服务器端口：若连接期发生第二次解析（127.0.0.1），请求会落在它身上并被记录
    const url = `http://rebind-e2e-${Date.now()}.example:${flippedServer.port}/payload`;
    const flippedBefore = flippedHits.length;
    const pinnedBefore = pinnedHits.length;

    let outcome: 'ok' | 'error' = 'ok';
    let bodyText = '';
    try {
      const result = await fetcher.fetchBuffer(url, {
        allowHttp: true,
        connectTimeoutMs: 700, // 公网地址大概率不可达：短超时把"网络类失败"变成确定性事实
        totalTimeoutMs: 3000,
      });
      bodyText = result.buffer.toString('utf8');
    } catch (err) {
      outcome = 'error';
      expect(err).toBeInstanceOf(AppError);
      // 失败语义必须是"网络/超时"（连接被固定到公网地址后不可达），绝不是从翻转目标拿到的响应
      expect([ErrorCode.PROVIDER_TIMEOUT, ErrorCode.PROVIDER_UNKNOWN]).toContain((err as AppError).code);
    }

    // ① 判别性事实：翻转目标服务器**零请求**（连接期没有第二次解析，请求没被投毒到 127.0.0.1）
    expect(flippedHits.length).toBe(flippedBefore);
    // ② 解析只做了 1 次（校验期），之后不再解析
    expect(flip.calls).toEqual([new URL(url).hostname]);
    // ③ 任何一种结局都不允许是翻转目标的响应体
    if (outcome === 'ok') expect(bodyText).not.toContain('INTERNAL-LEAK');
    // ④ pin 目标（本机探针）也不该被这次请求命中：pin 的是解析出的**公网**地址，不是本机
    expect(pinnedHits.length).toBe(pinnedBefore);
  }, 20000);

  it('T3b 同上但记录传输层入参：pinnedAddress = 校验期解析出的公网地址（不是翻转后的地址）', async () => {
    const flip = flippingResolver(PUBLIC_IP);
    const seen: PinnedRequest[] = [];
    // 观察壳：只为**记录**入参，行为完全委托生产实现（真 socket）
    const recordingTransport: PinnedTransport = (req) => {
      seen.push(req);
      return nodePinnedTransport(req);
    };
    const fetcher = new SafeRemoteFetcher(flip.resolve, recordingTransport);
    const url = `http://rebind-e2e-b-${Date.now()}.example:${flippedServer.port}/payload`;
    const flippedBefore = flippedHits.length;

    await fetcher
      .fetchBuffer(url, { allowHttp: true, connectTimeoutMs: 700, totalTimeoutMs: 3000 })
      .then((r) => expect(r.buffer.toString()).not.toContain('INTERNAL-LEAK'))
      .catch((err) => {
        expect(err).toBeInstanceOf(AppError);
        expect([ErrorCode.PROVIDER_TIMEOUT, ErrorCode.PROVIDER_UNKNOWN]).toContain((err as AppError).code);
      });

    expect(seen).toHaveLength(1);
    expect(seen[0].pinnedAddress).toBe(PUBLIC_IP);        // 连接固定 = 校验期地址
    expect(seen[0].addresses).toEqual([PUBLIC_IP]);        // 已校验地址集合（第 2 次解析的 127.0.0.1 从未出现）
    expect(seen[0].url).toBe(url);                        // Host/SNI 仍是原域名
    expect(seen[0].pinnedAddress).not.toBe('127.0.0.1');  // 翻转后的内网地址绝不成为连接目标
    expect(flippedHits.length).toBe(flippedBefore);
    expect(flip.calls).toHaveLength(1);
  }, 20000);

  it('T4 反向翻转（第 1 次解析即内网）：fail-closed，零出网（transport 一次都不被调用）', async () => {
    const flip = flippingResolver('127.0.0.1');
    const transportCalls: PinnedRequest[] = [];
    const fetcher = new SafeRemoteFetcher(flip.resolve, (req) => {
      transportCalls.push(req);
      return nodePinnedTransport(req);
    });
    const flippedBefore = flippedHits.length;
    await expect(
      fetcher.fetchBuffer(`http://rebind-c-${Date.now()}.example:${flippedServer.port}/payload`, {
        allowHttp: true, connectTimeoutMs: 700, totalTimeoutMs: 3000,
      }),
    ).rejects.toMatchObject({ code: ErrorCode.SSRF_BLOCKED });
    expect(transportCalls).toHaveLength(0); // 校验未过 ⇒ 一个字节都不出网
    expect(flippedHits.length).toBe(flippedBefore);
  }, 20000);

  it('T6 负控（判别力自证）：换成"连接期重解析"的脆弱传输层 → 内网内容真的被取回（证明 T3 的零请求有意义）', async () => {
    const flip = flippingResolver(PUBLIC_IP);
    const fetcher = new SafeRemoteFetcher(flip.resolve, vulnerableTransport(flip.resolve));
    const url = `http://rebind-e2e-neg-${Date.now()}.example:${flippedServer.port}/payload`;
    const flippedBefore = flippedHits.length;

    const result = await fetcher.fetchBuffer(url, { allowHttp: true, connectTimeoutMs: 2000, totalTimeoutMs: 4000 });
    expect(result.buffer.toString('utf8')).toBe('INTERNAL-LEAK'); // 内网服务的内容被读回（这就是被防住的攻击）
    expect(flip.calls).toHaveLength(2); // 校验 1 次 + 连接期 1 次（TOCTOU 窗口 = 两次解析之间的间隙）
    expect(flippedHits.length).toBe(flippedBefore + 1);
    expect(flippedHits.at(-1)?.remote).toBe('127.0.0.1');
    // 对照：同一翻转 + 生产固定传输层（T3）= 翻转目标零请求 —— 差别只来自"连接是否固定"
  }, 20000);

  it('T5 生产装配真相：未覆盖时 SSRF_RESOLVER = node:dns、PINNED_TRANSPORT = 连接固定实现', async () => {
    const moduleRef = await Test.createTestingModule({ imports: [PrismaModule, SecurityModule] }).compile();
    const app5 = moduleRef.createNestApplication();
    await app5.init();
    try {
      expect(moduleRef.get(SSRF_RESOLVER)).toBe(nodeDnsResolver);
      expect(moduleRef.get(PINNED_TRANSPORT)).toBe(nodePinnedTransport);
      expect(moduleRef.get(SafeRemoteFetcher)).toBeInstanceOf(SafeRemoteFetcher);
    } finally {
      await app5.close();
    }
  }, 20000);
});
