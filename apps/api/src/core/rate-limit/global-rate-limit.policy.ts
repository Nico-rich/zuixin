/**
 * M10-P8 全局 per-IP 限流策略（审计 SA-25）。
 *
 * 背景：M7-P9 的限流只覆盖 9 个**显式标注** `@RateLimit` 的端点（agent-run 创建 / approval 决断 /
 * OAuth start+callback / webhook（按 token）/ 反馈提交 / marketplace 评审 / workflow-run 创建 /
 * creative-loop 启动），登录失败计数只覆盖 auth 的**失败**路径。其余全部端点（会话/任务/记忆/项目/
 * 附件/知识库/评测/事件…）此前**没有任何 per-IP 上界**：一个匿名或单账号的脚本可以无限洪泛。
 * 本模块为"全局面"补齐 per-IP 维度，与既有限流**并存且不叠加同一桶**（见"与既有限流的关系"）。
 *
 * ## 设计（决策矩阵集中在此文件，纯函数——守卫只做"取计划 → 计数 → 抛错"）
 *
 * 1. **粒度 = IP × 方法 × 端点**（`key = global:{bucket}:{ip}:{method}:{routeKey}`）：
 *    - 端点用**路由模板**（`req.route.path`，如 `/api/v1/conversations/:id`）而非原始 URL——
 *      键空间有界（否则带 UUID 的 URL 会让 Redis 键无限膨胀）；
 *    - 方法进键：GET 与 POST 同路径的语义/成本完全不同（读写阈值不同），必须各计各的桶。
 *      **取舍**：单端点桶把"单个端点的洪泛"限住，但不封顶"跨多个端点分摊"的总体流量
 *      （那需要第二组聚合桶 = 每请求多一次 Redis 往返，与 Pre-M9 P1"往返合并"的性能约束冲突；
 *      记为 X-08 同类 Deferred，不在本 Phase 实施）。
 * 2. **IP 解析 = 可信跳**（`TRUSTED_PROXY_HOPS`，默认 0 = 不信任任何 `X-Forwarded-For`）：
 *    取 XFF 链**右起第 N 跳**（N = 本 API 前面可信代理的层数），语义与 Express `trust proxy = N` 一致。
 *    右起取值是**抗伪造**的：客户端只能往左**追加**，边界代理追加的那一跳永远是我们取的位置；
 *    链长不足 N（客户端直连/代理缺失）时**回退 socket 地址**，绝不使用可伪造的最左项。
 *    注：`main.ts` 未设置 Express `trust proxy`（该文件不属本 Phase 所有权），故此处自行解析；
 *    与 auth 失败计数（用 `req.ip` = socket 地址）**口径不同**——反代场景下 auth 计数会退化为"所有用户
 *    共用一个代理 IP"，此为**已记录的跨模块风险**（修复属 auth 所有者，见 Phase 报告）。
 * 3. **阈值**（生产默认值，理由均在下面常量注释；env 可覆盖）：
 *    read 300/min、write 60/min、auth 30/min、upload 30/min，窗口 60s。
 * 4. **豁免**（绝不计数）：健康探针（编排层探针被限流 → 重启雪崩）、CORS 预检、webhook（已有 per-token 桶，
 *    且平台回调源 IP 高度集中，再叠 per-IP 会误伤）、SSE 长连接（重连风暴往往发生在服务端故障恢复期，
 *    此时限流会把"可自愈的重连"变成"更长的不可用"）。
 * 5. **固定窗口**（沿用 `RateLimitService` 既有实现：首次 INCR 时 PEXPIRE，窗口内固定计数）。
 *    固定窗口→滑动窗口（X-08）本 Phase **不实施**，仅记录。
 *
 * ## 与既有限流的关系（硬约束：不得破坏既有行为）
 * - 路由级 `@RateLimit`（webhook per-token、feedback 等）与全局桶**键空间不同**（前者 `name:user/ip`，
 *   后者 `global:...`），互不影响、不叠加同一计数器 —— 既有限额不会被"腰斩"；
 * - webhook 另在**路径层**整体豁免：`hooks/*` 已有 per-token 桶，双限流只会让平台回调被"更严的一侧"意外压制；
 * - 登录失败计数（auth 内，5 次/5 分钟按 IP）不动，全局侧另给 auth 一个**更宽松**的请求桶
 *   （30/min）：失败计数按"失败"计、请求桶按"请求"计（含成功），两套口径互补且不互相遮蔽。
 */

/** 限流桶（决定阈值；key 里也带桶名，便于运维直接 scan） */
export type RateBucket = 'read' | 'write' | 'auth' | 'upload';

/** 豁免原因（可观测 + 单测断言用） */
export type ExemptReason = 'disabled' | 'probe' | 'preflight' | 'webhook' | 'stream';

export interface GlobalRateLimitPlan {
  /** true = 本请求豁免（不计数、不拒绝） */
  exempt: boolean;
  /** 参与限流时为桶名；豁免时为豁免原因 */
  bucket: RateBucket | ExemptReason;
  /** 阈值（豁免时恒为 0） */
  limit: number;
  /** 窗口（毫秒；豁免时恒为 0） */
  windowMs: number;
  /** Redis 键（`RateLimitService` 会加 `ratelimit:` 前缀） */
  key: string;
}

export interface GlobalRateLimitConfig {
  enabled: boolean;
  trustedProxyHops: number;
  windowMs: number;
  limits: Record<RateBucket, number>;
  /** true = 非生产环境默认放宽（见 NON_PROD_RELAX_FACTOR）；用于一次性告警日志 */
  relaxed: boolean;
}

/** 请求的最小结构（守卫传 Express `Request`；单测传字面量，无需构造 Express 实例） */
export interface RateLimitRequestLike {
  method?: string;
  path?: string;
  headers?: Record<string, string | string[] | undefined>;
  socket?: { remoteAddress?: string | null };
  ip?: string;
  route?: { path?: string };
}

// ===== 阈值（生产默认值）=====
/**
 * 读端点 300/min：与既有最宽松的路由级限额（agent-run 创建/approval 300/min）**同档**。
 * 理由：全局默认必须 ≥ 既有端点限额，否则"全局桶先于端点桶触发"会**静默改变既有端点语义**
 * （本 Phase 的硬约束是不得破坏既有行为）。300/min = 5 req/s 持续，对单端点而言远超
 * 多标签页/轮询客户端的正常用量（办公 NAT 出口下多人共享），对脚本扫描是硬上界。
 */
export const DEFAULT_READ_PER_MIN = 300;
/**
 * 写端点 60/min：写路径触发 LLM/队列/外部副作用，成本远高于读；
 * 60 比"读"紧一档，且严于既有写端点中最宽松的 300、宽于最严的 30（30 那批端点自身的路由级桶仍然生效）。
 */
export const DEFAULT_WRITE_PER_MIN = 60;
/**
 * 认证端点（login/refresh）30/min：与 oauth-start（30/min）同档。
 * 必须**宽松于** auth 的失败计数（5 次失败/5 分钟）——否则"连续输错密码"会被两套计数同时惩罚，
 * 且正常用户在共享出口 IP 下更早被锁；两者口径互补：失败计数防猜解，请求桶防"无认证态的请求放大"。
 */
export const DEFAULT_AUTH_PER_MIN = 30;
/**
 * 上传端点 30/min：上传是全站最重的写路径（multer 缓冲 + 存储写入 + 后续可能的扫描），
 * 独立成桶且比通用写更严——通用写阈值不应被"最重路径"拉高，最重路径也不该借通用桶放大。
 */
export const DEFAULT_UPLOAD_PER_MIN = 30;
/** 窗口 60s：与既有全部路由级限流一致（分钟粒度），避免两套窗口语义并存造成运维认知负担 */
export const DEFAULT_WINDOW_MS = 60_000;

/**
 * 非生产环境（NODE_ENV !== 'production'）默认阈值放宽倍数：**仅当对应 env 未显式设置时**生效。
 * 理由：e2e 全部请求来自回环同一 IP 且多 spec 共享 Redis DB（fileParallelism:false 顺序跑），
 * 生产阈值会让既有套件互相污染、随机 429（本 Phase 硬约束：既有 e2e 保持全绿）；
 * 开发环境同理（本地连点几下不该被拦）。放宽仍是**有限**值（路径/计数/拒绝逻辑都在跑），
 * 且显式设置 env 即按显式值生效（本 Phase 的 e2e 正是走这条路径验证真实阈值语义）。
 */
export const NON_PROD_RELAX_FACTOR = 100;

export const GRL_ENV = {
  ENABLED: 'GLOBAL_RATE_LIMIT_ENABLED',
  READ: 'GLOBAL_RATE_LIMIT_PER_MIN',
  WRITE: 'GLOBAL_RATE_LIMIT_WRITE_PER_MIN',
  AUTH: 'GLOBAL_RATE_LIMIT_AUTH_PER_MIN',
  UPLOAD: 'GLOBAL_RATE_LIMIT_UPLOAD_PER_MIN',
  WINDOW: 'GLOBAL_RATE_LIMIT_WINDOW_MS',
  HOPS: 'TRUSTED_PROXY_HOPS',
} as const;

/** 健康探针路径（前缀 `api/v1` 已剥离）：探针被限流 = 编排层误判 → 摘流量/重启，绝不可发生 */
const PROBE_ENDPOINTS = new Set(['/health', '/live', '/ready']);
/** 上传集合路由（POST 落点；`POST /attachments` 之外的同名子路由不受影响） */
const UPLOAD_ENDPOINTS = new Set(['/attachments']);
/** 认证桶路由（login/refresh 都是"无认证态可打"的高成本端点：argon2 校验 / 会话续期） */
const AUTH_ENDPOINTS = new Set(['/auth/login', '/auth/refresh']);
/** 客户端 IP 形态校验（宽松但拒绝任意垃圾串：伪造的非法值一律回退 socket 地址） */
const IPV4_RE = /^(\d{1,3}\.){3}\d{1,3}$/;
const IPV6_RE = /^[0-9a-f:]+$/i;
/** 路由键长度上界（原始 URL 回退路径可能很长；键空间必须有界） */
const MAX_ROUTE_KEY = 96;

function positiveInt(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : fallback;
}

function nonNegativeInt(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.trunc(n) : fallback;
}

function isTruthyEnv(raw: string | undefined): boolean | undefined {
  if (raw === undefined || raw.trim() === '') return undefined;
  const v = raw.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(v)) return true;
  if (['0', 'false', 'no', 'off'].includes(v)) return false;
  return undefined; // 非法值 → 按未设置处理（默认启用，绝不因拼写错误静默关闭防护）
}

/** 配置缓存签名：任一输入变化即重算（守卫在热路径上，避免每请求重新解析 env） */
let cachedConfig: GlobalRateLimitConfig | undefined;
let cachedSignature = '';

export function globalRateLimitConfig(): GlobalRateLimitConfig {
  const envValues = [
    process.env[GRL_ENV.ENABLED],
    process.env[GRL_ENV.READ],
    process.env[GRL_ENV.WRITE],
    process.env[GRL_ENV.AUTH],
    process.env[GRL_ENV.UPLOAD],
    process.env[GRL_ENV.WINDOW],
    process.env[GRL_ENV.HOPS],
    process.env.NODE_ENV,
  ];
  const signature = envValues.map((v) => v ?? '').join(' ');
  if (cachedConfig && signature === cachedSignature) return cachedConfig;

  const production = process.env.NODE_ENV === 'production';
  const scale = production ? 1 : NON_PROD_RELAX_FACTOR;
  const explicit = (name: string, envDefault: number): number => {
    const raw = process.env[name];
    // 显式设置 → 任何环境都按显式值（e2e/运维用这条路径验证/收紧真实阈值）
    if (raw !== undefined && raw.trim() !== '') return positiveInt(raw, envDefault * scale);
    return envDefault * scale;
  };

  cachedConfig = {
    enabled: isTruthyEnv(process.env[GRL_ENV.ENABLED]) ?? true,
    trustedProxyHops: nonNegativeInt(process.env[GRL_ENV.HOPS], 0),
    // 窗口**不参与放宽**：放宽只针对阈值。若窗口也 ×100，"被拒绝"的桶会锁 100 分钟——
    // 开发环境一旦触发就只能清 Redis，比不放宽更糟。
    windowMs: positiveInt(process.env[GRL_ENV.WINDOW], DEFAULT_WINDOW_MS),
    limits: {
      read: explicit(GRL_ENV.READ, DEFAULT_READ_PER_MIN),
      write: explicit(GRL_ENV.WRITE, DEFAULT_WRITE_PER_MIN),
      auth: explicit(GRL_ENV.AUTH, DEFAULT_AUTH_PER_MIN),
      upload: explicit(GRL_ENV.UPLOAD, DEFAULT_UPLOAD_PER_MIN),
    },
    relaxed: !production,
  };
  cachedSignature = signature;
  return cachedConfig;
}

/** 单测/长稳工具用：清空配置缓存（env 变化本身也会触发重算，此处仅显式起见） */
export function resetGlobalRateLimitConfigCache(): void {
  cachedConfig = undefined;
  cachedSignature = '';
}

/**
 * 规范化单个 IP 字面量：去掉 IPv4-mapped IPv6 前缀（Node 在双栈 socket 上给 `::ffff:127.0.0.1`）、
 * 端口、方括号与空白。无法识别为 IP 时返回 undefined（调用方回退）。
 */
export function normalizeIp(raw: string | null | undefined): string | undefined {
  if (raw == null) return undefined;
  let v = String(raw).trim();
  if (v === '') return undefined;
  if (v.startsWith('[') && v.includes(']')) v = v.slice(1, v.indexOf(']')); // [::1]:1234
  if (v.toLowerCase().startsWith('::ffff:')) v = v.slice(7); // IPv4-mapped
  const colonCount = (v.match(/:/g) ?? []).length;
  if (colonCount === 1) {
    const [host, port] = v.split(':');
    if (/^\d+$/.test(port) && host !== '') v = host; // 1.2.3.4:5678（IPv6 不适用）
  }
  v = v.toLowerCase();
  if (IPV4_RE.test(v)) {
    return v.split('.').every((p) => Number(p) >= 0 && Number(p) <= 255) ? v : undefined;
  }
  if (v.includes(':') && IPV6_RE.test(v)) return v;
  return undefined;
}

/**
 * 客户端 IP（可信跳语义，抗伪造——见文件头 2）。
 * hops = 0（默认）→ 一律 socket 地址，`X-Forwarded-For` 被**完全忽略**（伪造无效）；
 * hops ≥ 1 → 取 XFF 链右起第 hops 跳；链长不足或取值非法 → 回退 socket 地址。
 */
export function resolveClientIp(req: RateLimitRequestLike, hops = globalRateLimitConfig().trustedProxyHops): string {
  const socketIp = normalizeIp(req.socket?.remoteAddress) ?? normalizeIp(req.ip) ?? 'unknown';
  if (hops <= 0) return socketIp;
  const raw = req.headers?.['x-forwarded-for'];
  const header = Array.isArray(raw) ? raw.join(',') : raw;
  if (typeof header !== 'string' || header.trim() === '') return socketIp;
  const chain = header.split(',').map((s) => s.trim()).filter((s) => s !== '');
  const idx = chain.length - hops;
  if (idx < 0) return socketIp; // 链比可信跳还短：不可信任何转发项
  return normalizeIp(chain[idx]) ?? socketIp;
}

/**
 * 端点键：优先用路由模板（有界键空间）；拿不到路由（守卫在路由层之前/非标准挂载）时回退为
 * **规范化原始路径**（UUID/cuid/长不透明段 → `:id`、纯数字 → `:num`，保证键空间仍然有界）。
 */
export function endpointKeyOf(req: RateLimitRequestLike): string {
  const routePath = req.route?.path;
  if (typeof routePath === 'string' && routePath.trim() !== '') return routePath.trim();
  return normalizePath(req.path ?? '/');
}

/** 原始路径规范化（仅用于路由模板不可用时的兜底） */
export function normalizePath(rawPath: string): string {
  const segments = rawPath.split('/').filter((s) => s !== '');
  const normalized = segments.map((seg) => {
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(seg)) return ':id'; // UUID
    if (/^c[a-z0-9]{20,}$/i.test(seg)) return ':id'; // cuid（Prisma 默认主键）
    if (/^[0-9a-f]{24,}$/i.test(seg)) return ':id'; // 长十六进制
    if (/^\d+$/.test(seg)) return ':num';
    if (seg.length > 32) return ':id'; // 其它长不透明段（token/签名等）
    return seg;
  });
  const joined = `/${normalized.join('/')}`;
  return joined.length > MAX_ROUTE_KEY ? joined.slice(0, MAX_ROUTE_KEY) : joined;
}

/** 剥离全局前缀（`api/v1`），使策略常量与挂载前缀解耦 */
function stripGlobalPrefix(endpoint: string): string {
  let v = endpoint.startsWith('/') ? endpoint : `/${endpoint}`;
  v = v.replace(/^\/api\/v\d+/i, '');
  return v === '' ? '/' : v;
}

/**
 * 长连接（SSE）路由判定：**路由模板**里 `/:param/(events|stream)` 或任意 `/stream` 结尾。
 * 只认路由模板/参数化路径（不看 `Accept: text/event-stream` 头——客户端可任意伪造该头，
 * 那会变成一条"自选豁免"的旁路）；集合型 `/events`（事件列表 API）**不在豁免之列**。
 */
export function isStreamingRoute(endpoint: string, method: string | undefined): boolean {
  if ((method ?? 'GET').toUpperCase() !== 'GET') return false;
  return /\/:[A-Za-z0-9_]+\/(events|stream)$/.test(endpoint) || /\/stream$/.test(endpoint);
}

function bucketOf(method: string | undefined, endpoint: string): RateBucket | null {
  const m = (method ?? 'GET').toUpperCase();
  if (m === 'POST' && AUTH_ENDPOINTS.has(endpoint)) return 'auth';
  if (m === 'POST' && UPLOAD_ENDPOINTS.has(endpoint)) return 'upload';
  if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(m)) return 'write';
  return 'read';
}

/**
 * 决策入口：给定请求 → 计划（豁免 或 桶/阈值/键）。
 * 判定顺序即优先级：关闭开关 → 探针 → 预检 → webhook → 长连接 → 桶。
 */
export function evaluateGlobalRateLimit(req: RateLimitRequestLike): GlobalRateLimitPlan {
  const config = globalRateLimitConfig();
  const method = (req.method ?? 'GET').toUpperCase();
  const endpoint = stripGlobalPrefix(endpointKeyOf(req));

  const exempt = (reason: ExemptReason): GlobalRateLimitPlan => ({ exempt: true, bucket: reason, limit: 0, windowMs: 0, key: '' });

  if (!config.enabled) return exempt('disabled');
  if (method === 'OPTIONS') return exempt('preflight');
  const probeRoot = endpoint.split('/')[1] ?? '';
  if (PROBE_ENDPOINTS.has(`/${probeRoot}`)) return exempt('probe');
  if (endpoint === '/hooks' || endpoint.startsWith('/hooks/')) return exempt('webhook');
  if (isStreamingRoute(endpoint, method)) return exempt('stream');

  const bucket = bucketOf(method, endpoint) ?? 'read';
  const ip = resolveClientIp(req, config.trustedProxyHops);
  return {
    exempt: false,
    bucket,
    limit: config.limits[bucket],
    windowMs: config.windowMs,
    key: `global:${bucket}:${ip}:${method}:${endpointKeyOf(req)}`,
  };
}
