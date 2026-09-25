import { LoggerService } from '@nestjs/common';
import pino, { DestinationStream, Logger, LoggerOptions } from 'pino';
import type { Options as PinoHttpOptions } from 'pino-http';

/**
 * Pre-M9 F1/F2 统一日志脱敏层（API 与 Worker 同源，唯一实现）。
 *
 * 威胁：登录/刷新响应把 access+refresh JWT 写进 `set-cookie`，pino-http 默认 serializer 会把
 * 响应头整体打进请求日志 → 明文 JWT 落盘；worker 进程此前根本没有脱敏层（ConsoleLogger 原样打印）。
 *
 * 防线（三层，逐层收紧；任一层单独成立都不会泄漏）：
 * 1. **白名单 serializer**：req/res 只序列化安全字段（headers 白名单，绝不含 cookie/authorization/set-cookie）；
 * 2. **pino redact**：显式路径（各类 headers/凭据字段）→ `[Redacted]`；
 * 3. **hooks.logMethod 深度擦洗**：任意层级出现 JWT/Bearer/凭据形态的字符串 → `[Redacted]`
 *    （含错误 message/stack、queue payload、嵌套对象；只遍历纯对象/数组与 `headers` 形状，深度有界）。
 *
 * 契约：本文件的 REDACT_PATHS / scrubLogValue 被单测直接断言（新增敏感字段必须同步加白名单与断言）。
 */

/** JWT 形态（header.payload.signature，三段 base64url）——绝不允许出现在日志里 */
export const JWT_PATTERN = /eyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{4,}/g;
/** Bearer 形态（含非 JWT 的 opaque token） */
const BEARER_PATTERN = /\bBearer\s+[A-Za-z0-9\-._~+/=]{12,}/gi;
/** 平台密钥形态（sk-... / 私钥块 / DSN） */
const SECRET_VALUE_PATTERN = /(sk-[A-Za-z0-9_-]{12,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|postgres(ql)?:\/\/[^\s"']+|redis:\/\/[^\s"']+)/g;

export const REDACTED = '[Redacted]';

/** 敏感字段名（键名匹配 → 整个值替换） */
const SENSITIVE_KEY_PATTERN = /(^|[-_.])(authorization|cookie|set[-_]?cookie|api[-_]?key|apikey|secret|password|passwd|credential|private[-_]?key|token|access[-_]?token|refresh[-_]?token|id[-_]?token|session[-_]?key|bearer|signature|jwt)($|[-_.])/i;

/** 请求/响应头白名单（除这些之外一律不序列化——绝无 cookie/authorization/set-cookie 通道） */
const SAFE_HEADER_NAMES = new Set([
  'host', 'user-agent', 'content-type', 'content-length', 'accept', 'accept-encoding', 'accept-language',
  'origin', 'referer', 'x-request-id', 'x-forwarded-for', 'x-forwarded-proto', 'x-real-ip', 'x-trace-id',
  'connection', 'cache-control', 'range', 'if-none-match',
]);

/**
 * pino redact 路径（显式路径，作为白名单 serializer 之外的第二层；覆盖应用日志里自组装的 headers 对象）。
 * 说明：`res.headers["set-cookie"]` 是本次 F1 的核心修复点（此前完全未脱敏）。
 */
export const REDACT_PATHS: string[] = [
  'apiKey', 'api_key', 'password', 'secret', 'token', 'accessToken', 'refreshToken',
  'req.headers.authorization', 'req.headers.cookie', 'req.headers["set-cookie"]', 'req.headers["x-api-key"]',
  'req.headers["proxy-authorization"]', 'req.headers["x-auth-token"]',
  'res.headers["set-cookie"]', 'res.headers.authorization', 'res.headers.cookie',
  'headers.authorization', 'headers.cookie', 'headers["set-cookie"]', 'headers["x-api-key"]',
  'authorization', 'cookie', 'setCookie', 'set-cookie',
];

/** 深度擦洗：字符串形态的密钥/JWT 一律替换 */
export function scrubString(value: string): string {
  return value
    .replace(JWT_PATTERN, REDACTED)
    .replace(BEARER_PATTERN, REDACTED)
    .replace(SECRET_VALUE_PATTERN, REDACTED);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

const MAX_SCRUB_DEPTH = 8;

/**
 * 深度擦洗任意日志值（返回安全副本，绝不修改入参）：
 * - 键名命中敏感模式 → `[Redacted]`（无论值类型）；
 * - 字符串 → JWT/Bearer/DSN 形态替换；
 * - 纯对象/数组 → 递归；`headers` 形状的对象（req/res 等类实例上的 headers）→ 按白名单过滤；
 * - Error → 只保留 name/message/stack（message/stack 已擦洗）；
 * - 其他类实例（IncomingMessage/ServerResponse/Socket 等）→ 不深挖，返回 `[Unserializable]` 占位。
 */
export function scrubLogValue(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return scrubString(value);
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') return value;
  if (typeof value === 'function') return '[Function]';
  if (typeof value === 'symbol') return String(value);
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Error) {
    const out: Record<string, unknown> = {
      type: value.name,
      message: scrubString(value.message),
      stack: value.stack ? scrubString(value.stack) : undefined,
    };
    const code = (value as { code?: unknown }).code;
    if (typeof code === 'string' || typeof code === 'number') out.code = code;
    return out;
  }
  if (depth >= MAX_SCRUB_DEPTH) return '[Truncated]';

  if (Array.isArray(value)) return value.slice(0, 100).map((v) => scrubLogValue(v, depth + 1));

  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value)) {
      out[key] = SENSITIVE_KEY_PATTERN.test(key) ? REDACTED : scrubLogValue(val, depth + 1);
    }
    return out;
  }

  // 非纯对象：只认 `headers`（req/res/socket 等类实例上的请求头）——按白名单过滤，绝不整体展开
  const maybeHeaders = (value as { headers?: unknown }).headers;
  if (isPlainObject(maybeHeaders)) return { headers: filterHeaders(maybeHeaders) };
  return '[Unserializable]';
}

/** headers 白名单过滤（含敏感名二次剔除——白名单已不含它们） */
export function filterHeaders(headers: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(headers)) {
    const name = key.toLowerCase();
    if (!SAFE_HEADER_NAMES.has(name) || SENSITIVE_KEY_PATTERN.test(name)) continue;
    out[name] = typeof value === 'string' ? scrubString(value) : Array.isArray(value) ? value.map((v) => scrubString(String(v))) : value;
  }
  return out;
}

/** 请求 serializer（白名单字段；绝无 headers 全量透传） */
function reqSerializer(req: { id?: unknown; method?: string; url?: string; headers?: Record<string, unknown> }): Record<string, unknown> {
  return {
    id: req.id,
    method: req.method,
    url: typeof req.url === 'string' ? scrubQuery(req.url) : req.url,
    headers: isPlainObject(req.headers) ? filterHeaders(req.headers) : undefined,
  };
}

/** 响应 serializer（白名单字段；`set-cookie` 绝不出现——F1 的核心泄漏点） */
function resSerializer(res: { statusCode?: number; getHeaders?: () => Record<string, unknown>; headers?: Record<string, unknown> }): Record<string, unknown> {
  const raw = typeof res.getHeaders === 'function' ? res.getHeaders() : res.headers;
  return {
    statusCode: res.statusCode,
    headers: isPlainObject(raw) ? filterHeaders(raw) : undefined,
  };
}

/** URL query 脱敏（token/access_token/code/api_key 类参数一律替换） */
export function scrubQuery(url: string): string {
  const qIndex = url.indexOf('?');
  if (qIndex < 0) return scrubString(url);
  const [path, query] = [url.slice(0, qIndex), url.slice(qIndex + 1)];
  const scrubbed = query.split('&').map((pair) => {
    const eq = pair.indexOf('=');
    if (eq < 0) return pair;
    const key = pair.slice(0, eq);
    return SENSITIVE_KEY_PATTERN.test(key) ? `${key}=${REDACTED}` : `${key}=${scrubString(pair.slice(eq + 1))}`;
  });
  return `${scrubString(path)}?${scrubbed.join('&')}`;
}

/** 顶层交给 pino serializer 处理的键（保持对象身份——serializer 需要原始 req/res 的 id/method/url） */
const SERIALIZED_TOP_KEYS = new Set(['req', 'res', 'err', 'error']);

/** 顶层对象擦洗：req/res/err 保持原样（交给 serializer），其余键按敏感名/深度规则处理 */
function scrubTopLevel(obj: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (SERIALIZED_TOP_KEYS.has(key)) { out[key] = value; continue; }
    out[key] = SENSITIVE_KEY_PATTERN.test(key) ? REDACTED : scrubLogValue(value, 1);
  }
  return out;
}

/**
 * hooks.logMethod：所有日志调用先过深度擦洗（在 serializer/redact 之前）。
 * 对已挂载 serializer 的字段（req/res/err）保持对象身份，pino 会在格式化阶段按白名单处理。
 */
function scrubHook(this: Logger, args: unknown[], method: (...a: unknown[]) => void): void {
  if (args.length && isPlainObject(args[0])) {
    // 保持 pino 的重载语义：对象形态替换为擦洗副本，其余参数（message/占位符）原地擦洗
    const scrubbed = scrubTopLevel(args[0]);
    // pino 在 msg 缺省时用 err.message 作为日志 message（该派生值绕过了字符串擦洗）——此处预先擦洗
    const errValue = (args[0] as { err?: unknown; error?: unknown }).err ?? (args[0] as { error?: unknown }).error;
    if (errValue instanceof Error && args[1] === undefined) scrubbed.msg = scrubString(errValue.message);
    args[0] = scrubbed;
  } else if (args.length && args[0] instanceof Error) {
    // 顶层 Error：身份必须保留（pino 依 `_obj instanceof Error` 包装为 { err }），但 msg 缺省时
    // pino 会用 err.message 派生日志 message —— 该路径绕过 serializer，必须显式给出已擦洗的 msg。
    if (args[1] === undefined) args[1] = scrubString(args[0].message);
  } else if (args.length && typeof args[0] === 'object' && args[0] !== null) {
    // 非纯对象（类实例）：不替换身份（serializer 需要原始对象），由 serializer/redact 兜底
    args[0] = scrubLogValue(args[0]);
  }
  for (let i = 1; i < args.length; i++) {
    if (typeof args[i] === 'string') args[i] = scrubString(args[i] as string);
  }
  method.apply(this, args as never);
}

/** 共享 pino 选项（API 与 Worker 同源；service 仅用于标识来源进程） */
export function createPinoOptions(service: string, extra: Partial<LoggerOptions> = {}): LoggerOptions {
  return {
    level: process.env.LOG_LEVEL ?? 'info',
    base: { service },
    redact: { paths: REDACT_PATHS, censor: REDACTED },
    serializers: {
      req: reqSerializer as never,
      res: resSerializer as never,
      err: ((err: Error) => scrubLogValue(err)) as never,
      error: ((err: Error) => scrubLogValue(err)) as never,
    },
    hooks: { logMethod: scrubHook as never },
    ...extra,
  };
}

/**
 * HTTP 日志参数（API 入口唯一装配点）：
 * - `LOG_FILE` 设置时 → 落盘该文件（审计/测试捕获点；此时不启用 pino-pretty transport——pino 不允许二者共存）；
 * - 其余环境 → 开发用 pino-pretty，生产用默认 stdout JSON。
 */
export function createHttpLoggerParams(
  service = 'api',
  httpExtra: PinoHttpOptions = {},
): { pinoHttp: PinoHttpOptions | [PinoHttpOptions, DestinationStream] } {
  const options = { ...createPinoOptions(service), ...httpExtra };
  const file = process.env.LOG_FILE?.trim();
  if (file) {
    return { pinoHttp: [options, pino.destination({ dest: file, mkdir: true, sync: true })] };
  }
  return {
    pinoHttp: {
      ...options,
      transport: process.env.NODE_ENV === 'production' ? undefined : { target: 'pino-pretty', options: { singleLine: true } },
    },
  };
}

/**
 * Worker（非 HTTP 进程）的 Nest LoggerService 实现：与 API 共用 createPinoOptions（同一 redact/serializer/擦洗）。
 * 单独实现（而非复用 nestjs-pino）是刻意的：nestjs-pino 的 Logger 依赖 pino-http 中间件实例，
 * 在 createApplicationContext（无 HTTP adapter）下不可用。
 */
export class PinoNestLogger implements LoggerService {
  private readonly logger: Logger;

  constructor(service: string, extra: Partial<LoggerOptions> = {}) {
    this.logger = pino(createPinoOptions(service, extra));
  }

  /** 供测试/审计用：底层 pino 实例（同一份脱敏配置） */
  get instance(): Logger {
    return this.logger;
  }

  log(message: unknown, ...rest: unknown[]): void { this.call('info', message, rest); }
  warn(message: unknown, ...rest: unknown[]): void { this.call('warn', message, rest); }
  error(message: unknown, ...rest: unknown[]): void { this.call('error', message, rest); }
  debug(message: unknown, ...rest: unknown[]): void { this.call('debug', message, rest); }
  verbose(message: unknown, ...rest: unknown[]): void { this.call('trace', message, rest); }
  fatal(message: unknown, ...rest: unknown[]): void { this.call('fatal', message, rest); }

  /** Nest 调用约定归一化：最后一段字符串 = context；`error(message, stack, context)` 的 stack 单独落字段 */
  private call(level: 'info' | 'warn' | 'error' | 'debug' | 'trace' | 'fatal', message: unknown, rest: unknown[]): void {
    let context: string | undefined;
    let params = rest;
    if (params.length > 0 && typeof params[params.length - 1] === 'string') {
      context = params[params.length - 1] as string;
      params = params.slice(0, -1);
    }
    const obj: Record<string, unknown> = {};
    let msg = '';
    if (typeof message === 'string') {
      msg = message;
      const stack = params.find((p) => typeof p === 'string');
      if (stack) obj.stack = stack;
    } else if (message instanceof Error) {
      obj.err = message;
      msg = typeof params[0] === 'string' ? (params[0] as string) : message.message;
    } else if (typeof message === 'object' && message !== null) {
      Object.assign(obj, message as Record<string, unknown>);
      if (typeof params[0] === 'string') msg = params[0] as string;
      else if (params[0] !== undefined) msg = String(params[0]);
    } else {
      msg = String(message);
    }
    if (context) obj.context = context;
    this.logger[level](obj, msg);
  }
}
