import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { AppError, ErrorCode } from '../../common/errors/app-error';

/**
 * M8-P8 SSRF 通用防线（模块唯一入口；所有"服务端代表自身去访问用户给定 URL"的路径都必须先过这里）。
 *
 * 设计约束（诚实边界，绝不假装覆盖）：
 * 1. 校验发生在"发起请求之前"，基于 URL 字面量 + DNS 解析结果；**不控制调用方的重定向行为**——
 *    调用方必须使用 `redirect: 'manual'`（或等价配置）并拒绝 3xx，否则 Open Redirect 可绕过本防线；
 * 2. DNS 解析与实际连接之间存在 TOCTOU（DNS rebinding）窗口：调用方应使用 `assertSafeUrl` 返回的
 *    addresses 做连接固定（pin），或至少单次解析后立即发起请求；
 * 3. 本模块只做"拒绝"，绝不改写 URL（改写会引入自身的安全假设）。
 *
 * 判定分两层：
 * - 同步层（checkUrlSync）：协议 allowlist + 凭证 + 主机名字面量 + IP 字面量（含 IPv6 各种形态）；
 * - 异步层（assertSafeUrl）：在同步层之上做 DNS 解析，逐个地址分类（防"公网域名解析到内网"）。
 */

export type SsrfReason =
  | 'invalid_url'
  | 'protocol_not_allowed'
  | 'credentials_in_url'
  | 'internal_hostname'
  | 'private_ip'
  | 'dns_unresolvable';

export interface SsrfVerdict {
  ok: boolean;
  reason?: SsrfReason;
  /** 人类可读的原因（中文，可直接进 4xx 响应；不含内部拓扑信息/解析器信息） */
  detail?: string;
  /** 命中的不安全地址（DNS 层；用于审计留痕，不返回给客户端） */
  blockedAddress?: string;
  /** 命中的地址段分类（如 'loopback'/'link-local(metadata)'/'RFC1918'） */
  category?: string;
}

export interface SsrfOptions {
  /** 是否放行 http（默认 false：只允许 https） */
  allowHttp?: boolean;
  /** 是否放行私网/回环（默认 false；仅内部工具显式开启，业务路径绝不允许） */
  allowPrivate?: boolean;
}

/** 主机名层面的内网判定（DNS 解析之前；不依赖网络） */
const INTERNAL_HOST_SUFFIXES = ['.localhost', '.local', '.internal', '.home.arpa', '.lan', '.intranet', '.corp', '.test', '.invalid'];
const INTERNAL_HOST_EXACT = new Set(['localhost', 'metadata', 'metadata.google.internal', 'instance-data']);

/** RFC1918 / 回环 / link-local(含云 metadata 169.254.169.254) / CGNAT / 保留段 */
const BLOCKED_IPV4_CIDRS: Array<[string, number, string]> = [
  ['0.0.0.0', 8, 'this-network'],
  ['10.0.0.0', 8, 'RFC1918'],
  ['100.64.0.0', 10, 'CGNAT'],
  ['127.0.0.0', 8, 'loopback'],
  ['169.254.0.0', 16, 'link-local(metadata)'],
  ['172.16.0.0', 12, 'RFC1918'],
  ['192.0.0.0', 24, 'IETF-reserved'],
  ['192.0.2.0', 24, 'TEST-NET-1'],
  ['192.88.99.0', 24, '6to4-relay'],
  ['192.168.0.0', 16, 'RFC1918'],
  ['198.18.0.0', 15, 'benchmark'],
  ['198.51.100.0', 24, 'TEST-NET-2'],
  ['203.0.113.0', 24, 'TEST-NET-3'],
  ['224.0.0.0', 4, 'multicast'],
  ['240.0.0.0', 4, 'reserved'],
];

const SSRF_DETAIL: Record<SsrfReason, string> = {
  invalid_url: 'URL 非法',
  protocol_not_allowed: 'URL 协议不允许（仅 http/https）',
  credentials_in_url: 'URL 不得包含凭证',
  internal_hostname: 'URL 不得指向本机/内网',
  private_ip: 'URL 不得指向私网地址',
  dns_unresolvable: 'URL 主机无法解析',
};

function verdict(reason: SsrfReason, extra: Partial<SsrfVerdict> = {}): SsrfVerdict {
  return { ok: false, reason, detail: SSRF_DETAIL[reason], ...extra };
}

function ipv4ToInt(ip: string): number | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let out = 0;
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return null;
    const n = Number(p);
    if (n > 255) return null;
    out = (out * 256 + n) >>> 0;
  }
  return out >>> 0;
}

function ipv4ToBytes(ip: string): [number, number, number, number] | null {
  const n = ipv4ToInt(ip);
  if (n === null) return null;
  return [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
}

function cidr4Match(n: number, base: string, bits: number): boolean {
  const b = ipv4ToInt(base);
  if (b === null) return false;
  const mask = bits <= 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return ((n & mask) >>> 0) === ((b & mask) >>> 0);
}

/** IPv6 → 8 组 16bit（支持 `::` 压缩、末尾内嵌 IPv4、`%zone`；非法返回 null） */
export function expandIpv6(raw: string): number[] | null {
  let s = raw.trim().toLowerCase();
  const zone = s.indexOf('%');
  if (zone >= 0) s = s.slice(0, zone);
  if (s.startsWith('[') && s.endsWith(']')) s = s.slice(1, -1);
  if (s === '') return null;
  const dbl = s.indexOf('::');
  let head = '';
  let tail = '';
  if (dbl >= 0) {
    if (s.indexOf('::', dbl + 1) >= 0) return null; // 多个 `::` 非法
    head = s.slice(0, dbl);
    tail = s.slice(dbl + 2);
  } else {
    head = s;
  }
  const toGroups = (part: string): number[] | null => {
    if (part === '') return [];
    const segs = part.split(':');
    const out: number[] = [];
    for (let i = 0; i < segs.length; i++) {
      const seg = segs[i];
      if (seg.includes('.')) {
        if (i !== segs.length - 1) return null;
        const v4 = ipv4ToBytes(seg);
        if (!v4) return null;
        out.push((v4[0] << 8) | v4[1], (v4[2] << 8) | v4[3]);
        continue;
      }
      if (!/^[0-9a-f]{1,4}$/.test(seg)) return null;
      out.push(parseInt(seg, 16));
    }
    return out;
  };
  const h = toGroups(head);
  const t = toGroups(tail);
  if (!h || !t) return null;
  if (dbl >= 0) {
    const fill = 8 - h.length - t.length;
    if (fill < 0) return null;
    return [...h, ...new Array<number>(fill).fill(0), ...t];
  }
  return h.length === 8 ? h : null;
}

/** 由两个 16bit 组还原内嵌 IPv4 点分十进制（hi = 高 16 位，lo = 低 16 位） */
function ipv4FromGroups(hi: number, lo: number): string {
  return `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
}

/**
 * IP 分类（纯函数，无网络依赖）：不安全 → { unsafe: true, category }。
 * 覆盖 IPv4 保留段 + IPv6 回环/未指定/ULA/link-local/组播/文档段/NAT64/6to4/Teredo/IPv4-mapped。
 */
export function classifyIp(raw: string): { unsafe: boolean; category?: string; normalized?: string } {
  const ip = raw.trim();
  const kind = isIP(ip.startsWith('[') && ip.endsWith(']') ? ip.slice(1, -1) : ip);
  if (kind === 4) {
    const n = ipv4ToInt(ip);
    if (n === null) return { unsafe: true, category: 'unparsable' };
    for (const [base, bits, category] of BLOCKED_IPV4_CIDRS) {
      if (cidr4Match(n, base, bits)) return { unsafe: true, category, normalized: ip };
    }
    return { unsafe: false, normalized: ip };
  }
  if (kind !== 6) return { unsafe: true, category: 'not-an-ip' };

  const g = expandIpv6(ip);
  if (!g) return { unsafe: true, category: 'unparsable' };
  const first5Zero = g[0] === 0 && g[1] === 0 && g[2] === 0 && g[3] === 0 && g[4] === 0;
  const first6Zero = first5Zero && g[5] === 0;

  const classifyEmbedded = (v4: string, prefix: string): { unsafe: boolean; category?: string; normalized?: string } => {
    const inner = classifyIp(v4);
    return inner.unsafe
      ? { unsafe: true, category: `${prefix}:${inner.category}`, normalized: v4 }
      : { unsafe: false, normalized: v4 };
  };
  // IPv4-mapped ::ffff:a.b.c.d（最常见的绕过形态：必须解出内嵌 IPv4 再判定）
  if (first5Zero && g[5] === 0xffff) return classifyEmbedded(ipv4FromGroups(g[6], g[7]), 'ipv4-mapped');
  if (first6Zero && g[6] === 0 && g[7] === 0) return { unsafe: true, category: 'unspecified', normalized: '::' };
  if (first6Zero && g[6] === 0 && g[7] === 1) return { unsafe: true, category: 'loopback', normalized: '::1' };
  // IPv4-compatible ::a.b.c.d（已废弃；同样解出内嵌 IPv4，避免成为绕过路径）
  if (first6Zero) return classifyEmbedded(ipv4FromGroups(g[6], g[7]), 'ipv4-compatible');
  if ((g[0] & 0xfe00) === 0xfc00) return { unsafe: true, category: 'ULA', normalized: 'fc00::/7' };
  if ((g[0] & 0xffc0) === 0xfe80) return { unsafe: true, category: 'link-local', normalized: 'fe80::/10' };
  if ((g[0] & 0xff00) === 0xff00) return { unsafe: true, category: 'multicast', normalized: 'ff00::/8' };
  if (g[0] === 0x2001 && g[1] === 0x0db8) return { unsafe: true, category: 'TEST-NET', normalized: '2001:db8::/32' };
  if (g[0] === 0x2001 && g[1] === 0x0000) return { unsafe: true, category: 'Teredo', normalized: '2001::/32' };
  if (g[0] === 0x2001 && (g[1] & 0xfe00) === 0x0000) return { unsafe: true, category: 'IETF-reserved', normalized: '2001::/23' };
  if (g[0] === 0x3fff && (g[1] & 0xf000) === 0x0000) return { unsafe: true, category: 'TEST-NET', normalized: '3fff::/20' };
  if (g[0] === 0x0064 && g[1] === 0xff9b) return classifyEmbedded(ipv4FromGroups(g[6], g[7]), 'nat64');
  if (g[0] === 0x2002) {
    // 6to4：内嵌 IPv4 在 g[1]/g[2]
    const inner = classifyEmbedded(ipv4FromGroups(g[1], g[2]), '6to4');
    if (inner.unsafe) return inner;
  }
  return { unsafe: false };
}

/** URL.hostname 归一化：IPv6 带方括号 + 去 FQDN 尾点（`localhost.` 与 `localhost` 必须同样处理） */
export function normalizeHostname(hostname: string): string {
  let h = hostname.trim().toLowerCase();
  if (h.startsWith('[') && h.endsWith(']')) h = h.slice(1, -1);
  return h.replace(/\.$/, '');
}

/** 主机名字面量判定（不依赖 DNS）：localhost / *.local / *.internal / *.home.arpa / *.lan / *.intranet / *.corp / *.test / *.invalid */
export function isInternalHostname(hostname: string): boolean {
  const host = normalizeHostname(hostname);
  if (INTERNAL_HOST_EXACT.has(host)) return true;
  return INTERNAL_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix));
}

/**
 * 同步校验（无网络）：协议 allowlist + 凭证 + 主机名 + IP 字面量。
 * 用于纯同步上下文（如扩展 manifest 解析）；异步路径请用 assertSafeUrl（额外做 DNS 解析校验）。
 */
export function checkUrlSync(raw: string, opts: SsrfOptions = {}): SsrfVerdict {
  const { allowHttp = false, allowPrivate = false } = opts;
  if (typeof raw !== 'string' || raw.trim() === '') return verdict('invalid_url');
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return verdict('invalid_url');
  }
  if (url.protocol !== 'https:' && !(allowHttp && url.protocol === 'http:')) return verdict('protocol_not_allowed');
  if (url.username || url.password) return verdict('credentials_in_url');
  if (allowPrivate) return { ok: true };
  const host = normalizeHostname(url.hostname);
  if (isInternalHostname(host)) return verdict('internal_hostname', { blockedAddress: host });
  if (isIP(host) !== 0) {
    const c = classifyIp(host);
    if (c.unsafe) return verdict('private_ip', { blockedAddress: host, category: c.category });
  }
  return { ok: true };
}

/** DNS 解析器（可注入——测试与不同解析策略的替换点） */
export type DnsResolver = (hostname: string) => Promise<string[]>;

export const SSRF_RESOLVER = 'SECURITY_SSRF_RESOLVER';

/** 默认解析器：node:dns（返回全部 A/AAAA） */
export const nodeDnsResolver: DnsResolver = async (hostname: string): Promise<string[]> => {
  const rows = await lookup(hostname, { all: true });
  return rows.map((r) => r.address);
};

/**
 * 异步校验（同步层 + DNS 解析层）：通过返回 URL 与已校验地址；不通过抛 VALIDATION_ERROR。
 * 返回值里的 addresses 供调用方做连接固定（防 DNS rebinding）。
 */
export async function assertSafeUrl(
  raw: string,
  opts: SsrfOptions & { resolve?: DnsResolver } = {},
): Promise<{ url: URL; addresses: string[] }> {
  const sync = checkUrlSync(raw, opts);
  if (!sync.ok) throw new AppError(ErrorCode.VALIDATION_ERROR, sync.detail!);
  const url = new URL(raw);
  if (opts.allowPrivate) return { url, addresses: [] };
  const resolve = opts.resolve ?? nodeDnsResolver;
  const host = normalizeHostname(url.hostname);
  if (isIP(host) !== 0) return { url, addresses: [host] }; // IP 字面量已在同步层判定

  let addresses: string[];
  try {
    addresses = await resolve(host);
  } catch {
    throw new AppError(ErrorCode.VALIDATION_ERROR, SSRF_DETAIL.dns_unresolvable);
  }
  if (!addresses.length) throw new AppError(ErrorCode.VALIDATION_ERROR, SSRF_DETAIL.dns_unresolvable);
  for (const address of addresses) {
    const c = classifyIp(address);
    if (c.unsafe) {
      throw new AppError(ErrorCode.VALIDATION_ERROR, `${SSRF_DETAIL.private_ip}（DNS 解析指向 ${c.category}）`);
    }
  }
  return { url, addresses };
}

/** 判定型封装（不抛异常）：调用方需要自行决定错误语义时使用 */
export async function isSafeUrl(raw: string, opts: SsrfOptions & { resolve?: DnsResolver } = {}): Promise<SsrfVerdict> {
  try {
    await assertSafeUrl(raw, opts);
    return { ok: true };
  } catch (err) {
    const message = (err as Error).message;
    const reason = (Object.keys(SSRF_DETAIL) as SsrfReason[]).find((r) => SSRF_DETAIL[r] === message);
    return { ok: false, reason: reason ?? 'private_ip', detail: message };
  }
}
