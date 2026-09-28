import { AppError, ErrorCode } from '../../common/errors/app-error';
import { assertSafeUrl, DnsResolver, nodeDnsResolver } from './ssrf-guard';

/**
 * Pre-M9 F3-B：Provider baseUrl **调用期**校验（唯一实现，四个 manager 的 resolve 共用）。
 *
 * 威胁：provider 的 baseUrl 是后台/扩展可写字段（扩展安装时只做过一次校验），一旦被改成
 * `http://169.254.169.254/...`、`http://10.0.0.5/`、`http://localhost:6379` 或"公网域名解析到内网"，
 * 平台就会带着**平台自己的出口身份**去访问内网（SSRF）+ 可能把 provider API Key 送给内网服务。
 * 因此每次真正调用前都要按当前 baseUrl 重新判定（scheme / 主机名 / 解析出的全部 IP），fail-closed。
 *
 * 复用 ssrf-guard 的判定函数（绝不重写分类逻辑）：同步层（协议/凭证/主机名/IP 字面量，含 IPv6 各种形态）
 * + 异步层（DNS 解析后逐个地址分类，防"公网域名解析到内网"）。失败统一映射为 `SSRF_BLOCKED`。
 *
 * 诚实边界：DNS 解析与真实连接之间仍有 TOCTOU 窗口（无连接固定）；本函数是"每次调用前立即重解析"，
 * 不缓存校验结果（缓存会把窗口放大到缓存 TTL）。重定向策略由 adapter 侧 `redirect: 'manual'` 兜底
 * （见各 adapter 的 fetch/SDK 配置）——校验函数无法在运行期检查这一点。
 */
export interface ProviderBaseUrlInput {
  providerId: string;
  providerName?: string;
  /** adapter 名（mock* 无远端目标，跳过校验） */
  adapter: string;
  baseUrl?: string | null;
  resolver?: DnsResolver;
  /** 是否放行 http（默认 false；内网自建推理服务需显式 PROVIDER_ALLOW_HTTP=true） */
  allowHttp?: boolean;
}

/**
 * M10-P1 D24：mock 类 adapter 判定从正则 `/^mock(-|$)/` **收紧为精确枚举**。
 *
 * 原正则的问题：它是一个**前缀/分段**匹配，任何形如 `mock-anything`、`mock_anything`（`-` 分段）、
 * 甚至未来新增的 `mock-<恶意或第三方>` adapter 名都会**自动**被当作"不出网"而**跳过 baseUrl 的 SSRF 校验**
 * ——等于给了一个"取个 mock- 开头的名字就能让平台带自己的出口身份去访问任意内网地址"的旁路。
 * 既然适配器集合是**平台代码里固定的枚举**（见 seed.ts 与各 manager 的 switch），判定就应当写成枚举：
 * 只有平台**真实实现**的替身 adapter 才享受跳过校验的待遇；未知名字一律按"会出网"处理（fail-closed）。
 *
 * 新增替身 adapter 时必须**同时**在此登记 + 在对应 manager 的 switch 中实现——
 * 这是一次有意识的改动，而不是靠命名巧合获得豁免。
 */
export const MOCK_ADAPTERS: ReadonlySet<string> = new Set([
  'mock',           // LLM echo 替身（providers/llm/adapters/mock.adapter.ts）
  'mock-router',    // 意图路由替身（llm-manager 的 mock-router）
  'mock-image',     // 生图替身（providers/image/adapters/mock-image.adapter.ts）
  'mock-video',     // 生视频替身（providers/video/adapters/mock-video.adapter.ts）
  'mock-embedding', // embedding 确定性向量替身（providers/embedding）
]);

export function isMockAdapter(adapter: string | null | undefined): boolean {
  return typeof adapter === 'string' && MOCK_ADAPTERS.has(adapter.trim());
}

/**
 * Provider 出网 fetch：**禁止自动跟随重定向**（3xx 是 SSRF/凭证外泄的经典绕行路径：
 * 校验过的公网 baseUrl 302 到内网地址后，调用方若跟随就等于绕过全部校验）。
 * 各 adapter 统一使用（OpenAI SDK 通过 `fetch` 选项注入），使"重定向策略"与 baseUrl 校验同属一条防线。
 */
export const manualRedirectFetch = ((input: RequestInfo | URL, init?: RequestInit) =>
  fetch(input, { ...init, redirect: 'manual' })) as typeof fetch;

/**
 * 校验 provider baseUrl 是否可安全出网；不通过抛 `SSRF_BLOCKED`（非 mock adapter 未配置 baseUrl 同样 fail-closed）。
 * @returns 已校验的 URL（mock/空 baseUrl 返回 null）
 */
export async function assertProviderBaseUrlSafe(input: ProviderBaseUrlInput): Promise<URL | null> {
  const baseUrl = (input.baseUrl ?? '').trim();
  const label = `${input.providerName ?? input.providerId}（${input.adapter}）`;
  if (isMockAdapter(input.adapter)) return null; // mock adapter 不发起网络请求
  if (!baseUrl) {
    throw new AppError(ErrorCode.SSRF_BLOCKED, `provider ${label} 未配置 baseUrl，拒绝出网调用（fail-closed）`);
  }
  try {
    const { url } = await assertSafeUrl(baseUrl, {
      allowHttp: input.allowHttp ?? process.env.PROVIDER_ALLOW_HTTP === 'true',
      resolve: input.resolver ?? nodeDnsResolver,
    });
    return url;
  } catch (err) {
    throw new AppError(
      ErrorCode.SSRF_BLOCKED,
      `provider ${label} baseUrl 未通过安全校验: ${(err as Error).message}`,
      undefined,
      err,
    );
  }
}
