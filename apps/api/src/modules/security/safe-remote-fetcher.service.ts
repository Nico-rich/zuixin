import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { AppError, ErrorCode } from '../../common/errors/app-error';
import type { ErrorCodeType } from '../../common/errors/app-error';
import { assertSafeUrl, DnsResolver, nodeDnsResolver, normalizeHostname, SSRF_RESOLVER } from './ssrf-guard';

/**
 * Pre-M9 F3-A：统一"服务端代表自己去下载远端资源"的安全取回器（唯一入口）。
 *
 * 威胁：媒体生成结果 URL 来自 provider 响应（可被上游/中间人/恶意 provider 控制），
 * 直接 `fetch(url)` 会：跟随 302 → 内网（Open Redirect + SSRF）、读云 metadata（169.254.169.254）、
 * 无上限读取把内存打爆、无超时把 worker 挂死。下载结果随后会被写成**可信 Attachment**，一旦 SSRF
 * 命中即等于把内网内容以附件形式交付给攻击者。
 *
 * 防线（逐跳，绝不放行 3xx 自动跟随）：
 * 1. `redirect: 'manual'` + 手写重定向循环：**每一跳**都重跑 ssrf-guard（协议/主机名/IP 字面量 + DNS 解析 + 全地址分类）；
 * 2. 域名 allowlist（provider 域名 / 环境变量配置）逐跳校验——重定向到非白名单域名同样拒绝；
 * 3. connect（单跳）与 total（整体）双超时，超时即 abort；
 * 4. 响应体大小上限（先看 content-length，再流式累计，超限即 cancel 读取）；
 * 5. 失败一律抛**明确错误码**：SSRF/策略 → `SSRF_BLOCKED`，超时 → `PROVIDER_TIMEOUT`，超限/非法 URL → `VALIDATION_ERROR`。
 *
 * 诚实边界（不假装覆盖）：
 * - DNS 解析与真实连接之间仍有 TOCTOU 窗口——本实现是"每跳连接前立即重解析 + 全地址分类"，
 *   但受限于全局 fetch（undici）不暴露 socket 级地址固定（pin），无法彻底消除 rebinding；如需更强保证，
 *   应换用带 `lookup` 钩子的 Agent 做连接固定（本包不改依赖，已在报告中标注）。
 * - 只用于"下载字节"；调用方不得把未经本取回器的 URL 写入 Attachment 等可信事实。
 */

/** 默认上限：单文件 64MiB（媒体结果足够；防止无上限读取） */
export const DEFAULT_MAX_BYTES = 64 * 1024 * 1024;
/** 默认单跳（连接+响应头+读取首包）超时 */
export const DEFAULT_CONNECT_TIMEOUT_MS = 15_000;
/** 默认整体超时（含全部重定向跳） */
export const DEFAULT_TOTAL_TIMEOUT_MS = 120_000;
/** 默认最大重定向跳数 */
export const DEFAULT_MAX_REDIRECTS = 3;

export interface SafeFetchOptions {
  /** 允许访问的域名（精确或子域匹配）；非空时逐跳强制校验，重定向到名单外即拒绝 */
  allowedHosts?: string[];
  /** 用途标签（错误信息/日志用，如 'media-download'） */
  purpose?: string;
  maxBytes?: number;
  connectTimeoutMs?: number;
  totalTimeoutMs?: number;
  maxRedirects?: number;
  /** 是否放行 http（默认 false：只允许 https） */
  allowHttp?: boolean;
  /** 非 2xx 响应使用的错误码（默认 PROVIDER_UNKNOWN：上游结果不可用） */
  statusErrorCode?: ErrorCodeType;
}

export interface SafeFetchResult {
  buffer: Buffer;
  /** 最终（重定向后）URL */
  url: string;
  contentType?: string;
  bytes: number;
  redirects: number;
}

@Injectable()
export class SafeRemoteFetcher {
  private readonly logger = new Logger('SafeRemoteFetcher');

  // 显式 @Inject + @Optional：单测/非 Nest 上下文可直接 new，且不依赖 SecurityModule 是否已加载
  constructor(@Optional() @Inject(SSRF_RESOLVER) private readonly resolver: DnsResolver = nodeDnsResolver) {}

  /** 环境变量配置的全局下载白名单（provider 域名之外的可信 CDN 出口，逗号分隔） */
  static envAllowedHosts(env = process.env.MEDIA_DOWNLOAD_ALLOWED_HOSTS): string[] {
    return (env ?? '')
      .split(',')
      .map((s) => normalizeHostname(s.trim()))
      .filter((s) => s.length > 0);
  }

  /**
   * 取回远端字节（唯一入口）。
   * @param rawUrl http(s) 或 `data:`（data URL 只做大小上限校验，不出网）
   */
  async fetchBuffer(rawUrl: string, opts: SafeFetchOptions = {}): Promise<SafeFetchResult> {
    if (typeof rawUrl !== 'string' || rawUrl.trim() === '') {
      throw new AppError(ErrorCode.VALIDATION_ERROR, `下载地址为空${this.tag(opts)}`);
    }
    const url = rawUrl.trim();
    const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
    if (url.startsWith('data:')) return this.decodeDataUrl(url, maxBytes, opts);

    const totalTimeoutMs = opts.totalTimeoutMs ?? DEFAULT_TOTAL_TIMEOUT_MS;
    const connectTimeoutMs = opts.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
    const maxRedirects = opts.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
    const deadline = Date.now() + totalTimeoutMs;
    const allowedHosts = (opts.allowedHosts ?? []).map((h) => normalizeHostname(h)).filter((h) => h.length > 0);
    if (allowedHosts.length === 0 && opts.allowedHosts?.length) {
      // 调用方给了名单但全被规范化掉（空/非法）→ 配置问题，fail-closed 而不是"静默放行"
      throw new AppError(ErrorCode.VALIDATION_ERROR, `下载域名白名单配置非法${this.tag(opts)}`);
    }

    let current = url;
    let redirects = 0;
    for (;;) {
      if (Date.now() > deadline) {
        throw new AppError(ErrorCode.PROVIDER_TIMEOUT, `下载总时长超限（${totalTimeoutMs}ms）${this.tag(opts)}`);
      }
      // ① 每一跳都过 ssrf-guard（协议/主机名/IP 字面量 + DNS 解析 + 全部地址分类）
      const checked = await this.assertHopSafe(current, opts);
      const host = normalizeHostname(checked.hostname);
      // ② 每一跳都过域名白名单（重定向到名单外同样拒绝）
      if (allowedHosts.length && !allowedHosts.some((allowed) => host === allowed || host.endsWith(`.${allowed}`))) {
        throw new AppError(ErrorCode.SSRF_BLOCKED, `下载目标域名不在白名单内: ${host}${this.tag(opts)}`);
      }

      const controller = new AbortController();
      const hopBudget = Math.max(1, Math.min(connectTimeoutMs, deadline - Date.now()));
      const timer = setTimeout(() => controller.abort(), hopBudget);
      let res: Response;
      const startedAt = Date.now();
      try {
        res = await fetch(current, { redirect: 'manual', signal: controller.signal });
      } catch (err) {
        const timedOut = (err as Error).name === 'AbortError' || Date.now() - startedAt >= hopBudget;
        if (timedOut) {
          throw new AppError(ErrorCode.PROVIDER_TIMEOUT, `下载连接超时（${hopBudget}ms）${this.tag(opts)}`, undefined, err);
        }
        throw new AppError(ErrorCode.PROVIDER_UNKNOWN, `下载失败: ${(err as Error).message}${this.tag(opts)}`, undefined, err);
      } finally {
        clearTimeout(timer);
      }

      // ③ 3xx 一律不自动跟随：手工解析 Location，回到循环顶部重新校验（含 DNS/IP/白名单）
      if (res.status >= 300 && res.status < 400) {
        const location = res.headers.get('location');
        await this.drain(res);
        if (!location) {
          throw new AppError(ErrorCode.PROVIDER_UNKNOWN, `重定向缺少 Location（status=${res.status}）${this.tag(opts)}`);
        }
        redirects += 1;
        if (redirects > maxRedirects) {
          throw new AppError(ErrorCode.SSRF_BLOCKED, `重定向次数超限（>${maxRedirects}）${this.tag(opts)}`);
        }
        try {
          current = new URL(location, current).toString();
        } catch {
          throw new AppError(ErrorCode.VALIDATION_ERROR, `重定向目标非法: ${location}${this.tag(opts)}`);
        }
        // 白名单在下一跳顶部再次校验；这里提前拒绝"降级到 http"（防 https→http 重定向绕过）
        if (!opts.allowHttp && !current.startsWith('https:')) {
          throw new AppError(ErrorCode.SSRF_BLOCKED, `重定向到非 https 目标被拒绝${this.tag(opts)}`);
        }
        continue;
      }

      if (!res.ok) {
        await this.drain(res);
        throw new AppError(
          opts.statusErrorCode ?? ErrorCode.PROVIDER_UNKNOWN,
          `下载失败: HTTP ${res.status}${this.tag(opts)}`,
        );
      }

      const declared = Number(res.headers.get('content-length') ?? '0');
      if (Number.isFinite(declared) && declared > maxBytes) {
        await this.drain(res);
        throw new AppError(ErrorCode.VALIDATION_ERROR, `下载响应体超出上限（${declared} > ${maxBytes}）${this.tag(opts)}`);
      }

      const { buffer, bytes } = await this.readBounded(res, maxBytes, opts);
      return { buffer, url: current, contentType: res.headers.get('content-type') ?? undefined, bytes, redirects };
    }
  }

  /** 校验单跳 URL（复用 ssrf-guard 的分类函数，绝不重写判定逻辑），失败统一映射为 SSRF_BLOCKED */
  private async assertHopSafe(raw: string, opts: SafeFetchOptions): Promise<URL> {
    try {
      const { url } = await assertSafeUrl(raw, { allowHttp: opts.allowHttp ?? false, resolve: this.resolver });
      return url;
    } catch (err) {
      const message = (err as Error).message;
      // 审计留痕：只记主机名（URL 可能含 query 凭证，绝不整体落日志）
      this.logger.warn(`下载被 SSRF 防线拒绝: ${this.safeHost(raw)} ${message}${this.tag(opts)}`);
      throw new AppError(ErrorCode.SSRF_BLOCKED, `下载目标未通过安全校验: ${message}${this.tag(opts)}`, undefined, err);
    }
  }

  /** 仅取主机名用于日志（解析失败则返回占位，绝不泄漏完整 URL） */
  private safeHost(raw: string): string {
    try {
      return normalizeHostname(new URL(raw).hostname);
    } catch {
      return '[unparsable]';
    }
  }

  /** 流式读取并强制大小上限（超限 abort，绝不把整个响应读进内存） */
  private async readBounded(res: Response, maxBytes: number, opts: SafeFetchOptions): Promise<{ buffer: Buffer; bytes: number }> {
    if (!res.body) {
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length > maxBytes) {
        throw new AppError(ErrorCode.VALIDATION_ERROR, `下载响应体超出上限（${buf.length} > ${maxBytes}）${this.tag(opts)}`);
      }
      return { buffer: buf, bytes: buf.length };
    }
    const reader = res.body.getReader();
    const chunks: Buffer[] = [];
    let total = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value) continue;
        total += value.byteLength;
        if (total > maxBytes) {
          await reader.cancel().catch(() => undefined);
          throw new AppError(ErrorCode.VALIDATION_ERROR, `下载响应体超出上限（>${maxBytes}）${this.tag(opts)}`);
        }
        chunks.push(Buffer.from(value));
      }
    } finally {
      reader.releaseLock?.();
    }
    return { buffer: Buffer.concat(chunks), bytes: total };
  }

  /** 丢弃响应体（保持连接可复用），失败不影响主流程 */
  private async drain(res: Response): Promise<void> {
    try {
      await res.body?.cancel();
    } catch {
      /* 忽略 */
    }
  }

  /**
   * `data:` URL 解码（provider mock 直接内联返回 base64 图片）。
   * 依旧受大小上限约束：base64 长度可预估解码后大小，超限直接拒绝（不先解出大 buffer）。
   */
  private decodeDataUrl(url: string, maxBytes: number, opts: SafeFetchOptions): SafeFetchResult {
    const comma = url.indexOf(',');
    if (comma < 0) throw new AppError(ErrorCode.VALIDATION_ERROR, `data URL 非法${this.tag(opts)}`);
    const meta = url.slice(5, comma);
    const payload = url.slice(comma + 1);
    const isBase64 = /;base64/i.test(meta);
    const contentType = meta.replace(/;base64/i, '') || undefined;
    const estimated = isBase64 ? Math.floor((payload.length * 3) / 4) : payload.length;
    if (estimated > maxBytes) {
      throw new AppError(ErrorCode.VALIDATION_ERROR, `data URL 超出上限（~${estimated} > ${maxBytes}）${this.tag(opts)}`);
    }
    const buffer = isBase64 ? Buffer.from(payload, 'base64') : Buffer.from(decodeURIComponent(payload), 'utf8');
    if (buffer.length > maxBytes) {
      throw new AppError(ErrorCode.VALIDATION_ERROR, `data URL 超出上限（${buffer.length} > ${maxBytes}）${this.tag(opts)}`);
    }
    return { buffer, url, contentType, bytes: buffer.length, redirects: 0 };
  }

  private tag(opts: SafeFetchOptions): string {
    return opts.purpose ? `（${opts.purpose}）` : '';
  }
}
