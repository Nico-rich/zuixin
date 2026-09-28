import type * as net from 'node:net';
import { isIP } from 'node:net';
import * as http from 'node:http';
import * as https from 'node:https';
import { Readable } from 'node:stream';

/**
 * M10-P1 M9-07/SA-13：**DNS rebinding 连接固定**（socket pin）。
 *
 * 问题（Pre-M9 F3-A/B 已诚实标注的 TOCTOU）：`assertSafeUrl` 校验的是"DNS 现在解析出的地址"，
 * 而真正建连时 fetch/undici **会再解析一次**。攻击者控制的域名只要在两次解析之间把 A 记录
 * 从公网 IP 切成 `169.254.169.254`/`10.0.0.5`，校验就形同虚设（经典 DNS rebinding）。
 * 调用方拿到的 `addresses` 返回值此前是"仅供参考"——无人使用，窗口始终存在。
 *
 * 本模块把返回值变成**连接事实**：
 * 1. DNS **只解析一次**（在 ssrf-guard 的 assertSafeUrl 内），逐地址分类校验；
 * 2. 建连走 node:https/http 的 `lookup` 钩子，**无条件返回已校验的 pinned IP**，
 *    该钩子内**绝不调用任何解析器**——连接期不存在第二次 DNS 查询；
 * 3. `Host` 头与 TLS `servername`（SNI + 证书校验主体）仍用**原域名**：
 *    域名语义不变 → 证书校验仍按域名（pin 不会把 https 降级成"连 IP 不校验证书"）；
 * 4. 因而"校验用的地址"与"实际连上的地址"在**同一个 socket** 上强一致。
 *
 * 传输层可注入（`PINNED_TRANSPORT`）：单测用假 transport 断言 pin 行为（解析次数 = 1/跳、
 * 连接地址 = 已校验地址、后续 DNS 翻转不影响本次连接），无需真实出网。
 */

/** 单跳请求（已通过 SSRF 校验与白名单校验） */
export interface PinnedRequest {
  /** 已校验的完整 URL（Host 头 / SNI / 路径都来自它） */
  url: string;
  /** ★ 连接固定的目标地址（assertSafeUrl 返回的**已校验**地址之一） */
  pinnedAddress: string;
  /** assertSafeUrl 返回的全部已校验地址（诊断/审计用，不参与连接） */
  addresses: string[];
  method?: string;
  headers?: Record<string, string>;
  /** 调用方的单跳/总预算中止信号（超时由调用方裁决错误码，本层不自行超时） */
  signal?: AbortSignal;
}

/**
 * 单跳传输契约：
 * - **绝不跟随重定向**（3xx 原样返回给调用方，由逐跳校验循环裁决下一跳）；
 * - 只连 `pinnedAddress`，不解析 DNS；
 * - 抛出的错误保持 `name === 'AbortError'` 语义（调用方据此映射 PROVIDER_TIMEOUT）。
 */
export type PinnedTransport = (req: PinnedRequest) => Promise<Response>;

/** Nest DI token（SecurityModule 注册；单测可直接注入假实现） */
export const PINNED_TRANSPORT = 'SECURITY_PINNED_TRANSPORT';

/** 响应头归一化：node 的 IncomingHttpHeaders → HeadersInit（数组值 join，与 fetch 语义一致） */
function toHeadersInit(headers: http.IncomingHttpHeaders): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    out[key] = Array.isArray(value) ? value.join(', ') : String(value);
  }
  return out;
}

/** 哪些状态码不允许携带 body（Fetch 规范：Response 构造器对 null-body 状态码的限制） */
const NULL_BODY_STATUS = new Set([101, 204, 205, 304]);

/**
 * 默认传输：node:https / node:http + `lookup` 钩子做连接固定。
 * 不缓存连接（`agent: false`）：每跳独立 socket，pin 与校验一一对应，避免跨请求复用错连。
 */
export const nodePinnedTransport: PinnedTransport = async (req: PinnedRequest): Promise<Response> => {
  const url = new URL(req.url);
  const secure = url.protocol === 'https:';
  const mod = secure ? https : http;
  const pinned = req.pinnedAddress;
  const family = isIP(pinned) === 6 ? 6 : 4;

  /** ★ 关键钩子：socket 建连时**只**用已校验地址；此处绝不解析 DNS（连接期无第二次查询） */
  const lookup: net.LookupFunction = ((_hostname: string, options: unknown, cb: (...args: unknown[]) => void) => {
    if (options && typeof options === 'object' && (options as { all?: boolean }).all) {
      cb(null, [{ address: pinned, family }]);
      return;
    }
    cb(null, pinned, family);
  }) as unknown as net.LookupFunction;

  const res = await new Promise<http.IncomingMessage>((resolve, reject) => {
    const request = mod.request(
      {
        protocol: url.protocol,
        hostname: url.hostname, // 原域名 → Host 头保持原域名
        port: url.port !== '' ? Number(url.port) : (secure ? 443 : 80),
        path: `${url.pathname}${url.search}`,
        method: req.method ?? 'GET',
        // 不主动协商压缩：下载字节需要与 content-length 口径一致（省去解压后的再计数歧义）
        headers: { 'accept-encoding': 'identity', ...(req.headers ?? {}) },
        lookup,
        // TLS：证书校验主体与 SNI 一律用原域名（pin 的是地址，不是身份）
        ...(secure ? { servername: url.hostname } : {}),
        agent: false,
        signal: req.signal,
      },
      resolve,
    );
    request.on('error', reject);
    request.end();
  });

  const status = res.statusCode ?? 502;
  // node:http 不会产生 <200 的最终响应（1xx 由 'information' 事件处理）；防御性处理避免 Response 构造失败
  const safeStatus = status >= 200 && status <= 599 ? status : 502;
  const body = NULL_BODY_STATUS.has(safeStatus) ? null : (Readable.toWeb(res) as unknown as ReadableStream<Uint8Array>);
  return new Response(body, {
    status: safeStatus,
    statusText: res.statusMessage,
    headers: toHeadersInit(res.headers),
  });
};
