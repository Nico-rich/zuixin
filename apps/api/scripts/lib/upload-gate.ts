/**
 * M12-P5：`backup --upload` 的**明文外发闸门**（M12 审计项："backup --upload 明文确认缺口径"）。
 *
 * 问题：备份默认不加密（`--encrypt none`），而 dump 含用户数据与凭证密文；`--upload` 会把它推到远端桶。
 * 原实现只在帮助文本里写"出仓库前必须自行加密"——**没有任何强制**：一条 `--upload` 就能把明文库推到
 * 共享/异地存储，事后只能从 manifest 里看出"没加密"。
 *
 * 本闸门的口径（唯一判断，纯函数、可单测）：
 * - 上传 + 未加密 + **非本机端点** ⇒ 必须显式 `--allow-plaintext-upload`，否则前置条件失败（退出码 4），
 *   错误信息给出两条正路：加 `--encrypt gpg`，或显式承认风险 `--allow-plaintext-upload`；
 * - 上传 + 未加密 + **本机端点**（loopback）⇒ 放行，但记一条提醒（"本机明文上传：仅限开发环境"）；
 * - 已加密（`encryption='gpg'`）⇒ 与本闸门无关（无论端点在哪都放行——这正是推荐形态）；
 * - 未上传 ⇒ 与本闸门无关（本地明文产物由 `--keep-plain`/加密策略管）。
 *
 * 为什么只认 loopback 算"本机"：容器服务名（如 `minio:9000`）看着像"内网"，但同样可能被
 * 其它容器/宿主机抓到，而且运维确实把它当远端用；**宁可多要一次显式许可，也不猜网络拓扑**。
 * 端点无法解析（空串/坏 URL）⇒ 按**非本机**处理（保守方向：要许可，而不是默默放行）。
 */

export type UploadEncryption = 'none' | 'gpg';

export interface PlaintextUploadInput {
  /** 本次是否真的会外发（`--upload`） */
  upload: boolean;
  /** 产物加密形态（`--encrypt`） */
  encryption: UploadEncryption;
  /** 远端端点（`storage.endpoint`；空串 = 未配置 ⇒ 按非本机处理） */
  endpoint: string;
  /** 运维是否显式给了 `--allow-plaintext-upload` */
  allowPlaintextUpload: boolean;
}

export interface PlaintextUploadVerdict {
  /** false ⇒ 调用方必须按前置条件失败退出（EXIT_PRECONDITION） */
  ok: boolean;
  /** 端点是否 loopback（本机） */
  local: boolean;
  /** 是否需要运维显式确认（= 上传 ∧ 未加密 ∧ 非本机） */
  acknowledgementRequired: boolean;
  /** 放行但应提醒的说明（本机明文上传 / 已显式确认）；null = 无需提醒 */
  notice: string | null;
  /** 不放行的原因（ok=true 时为 null） */
  reason: string | null;
}

/**
 * 取主机名（小写、剥掉 IPv6 的方括号）；解析失败返回 null。
 *
 * 为什么要两步：**裸 IPv6 字面量**（`::1` / `0:0:0:0:0:0:0:1`）不加方括号时 WHATWG URL 直接抛
 * `Invalid URL` ⇒ 第一步失败，第二步补方括号重试（`http://[::1]`）；而 `[::1]:9000` 这类
 * 已带方括号的输入第一步就成功。不做这一步，"::1 是 loopback"这条判定**永远走不到**
 * （只会静默 fail-closed：运维多按一次 `--allow-plaintext-upload`，属于"不致命但错"）。
 */
function hostOf(raw: string): string | null {
  const strip = (hostname: string): string =>
    hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname;
  try {
    return strip(new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `http://${raw}`).hostname.toLowerCase());
  } catch {
    const bare = raw.split('/')[0];
    // 段数 > 2 才判定为 IPv6（`localhost:9000` 只有 2 段，不能当 IPv6 处理）
    if (!bare.includes(']') && bare.includes(':') && bare.split(':').length > 2) {
      try {
        return strip(new URL(`http://[${bare}]`).hostname.toLowerCase());
      } catch {
        return null;
      }
    }
    return null;
  }
}

/** 是否为 loopback 端点（localhost / *.localhost / 127.0.0.0/8 / ::1）。解析失败 ⇒ false（保守）。 */
export function isLoopbackEndpoint(endpoint: string): boolean {
  const raw = (endpoint ?? '').trim();
  if (!raw) return false; // 未配置端点：不猜，按非本机处理
  const bare = hostOf(raw);
  if (bare === null) return false;
  if (bare === 'localhost' || bare.endsWith('.localhost')) return true;
  if (bare === '::1' || bare === '0:0:0:0:0:0:0:1') return true;
  if (bare === '0.0.0.0') return true; // "本机的任意地址"——客户端连它即连本机
  // 诚实边界：IPv4-mapped 形式（`::ffff:127.0.0.1`，URL 会规范化为 `::ffff:7f00:1`）**不判定为
  // loopback**——保守方向是多要一次显式许可，而不是默默放行。
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(bare);
  if (v4) {
    const parts = v4.slice(1).map(Number);
    if (parts.some((p) => p > 255)) return false;
    return parts[0] === 127; // 127.0.0.0/8 全是 loopback
  }
  return false;
}

/** 明文外发判定（见文件头口径）。 */
export function assessPlaintextUpload(input: PlaintextUploadInput): PlaintextUploadVerdict {
  const local = isLoopbackEndpoint(input.endpoint);
  // 未上传 / 已加密：与本闸门无关（notice=null，ok=true）
  if (!input.upload || input.encryption !== 'none') {
    return { ok: true, local, acknowledgementRequired: false, notice: null, reason: null };
  }
  const target = input.endpoint.trim() || '（未配置端点）';
  if (local) {
    return {
      ok: true, local, acknowledgementRequired: false,
      notice: `明文备份上传到**本机**端点 ${target}（开发链路，未强制确认；生产请用 --encrypt gpg）`,
      reason: null,
    };
  }
  if (input.allowPlaintextUpload) {
    return {
      ok: true, local, acknowledgementRequired: true,
      notice: `明文备份上传到**非本机**端点 ${target}：已由 --allow-plaintext-upload 显式确认（manifest 记录未加密事实）`,
      reason: null,
    };
  }
  return {
    ok: false, local, acknowledgementRequired: true, notice: null,
    reason:
      `拒绝把**未加密**的备份上传到非本机端点 ${target}（dump 含用户数据与凭证密文）。\n` +
      '  两条正路：① 加 --encrypt gpg（推荐：压缩不是加密）；' +
      '② 若确知该端点是受控内网/自建环境，显式承认风险：追加 --allow-plaintext-upload。\n' +
      '  （本机端点如 http://localhost:9000 会自动放行，无需该开关。）',
  };
}
