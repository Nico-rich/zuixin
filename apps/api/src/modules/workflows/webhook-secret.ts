import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * M10-P5 SA-18：webhook 密钥轮换（**双 secret 过渡窗**）—— 纯函数（零 IO，便于单测锁定语义）。
 *
 * 存储契约（schema 冻结下的载体）：`WorkflowWebhook.secretEncrypted` 列内被加密的载荷从
 * "裸 secret 字符串" 升级为 JSON 信封 `{ v: 2, current, previous?, previousExpiresAt? }`；
 * Pre-M10 写入的裸 hex 行解析时视为 legacy（current = 该 secret、无 previous）——**向后兼容，绝不误拒**。
 *
 * 过渡窗语义（发布契约，测试锁定）：
 * - 轮换 = current → previous（带过期时刻）、新随机 current；
 * - 过渡窗内：**current 与 previous 的签名都接受**（发送方有窗口切换密钥，不中断投递）；
 * - 过渡窗后：previous 的签名**拒绝**（`WEBHOOK_SECRET_ROTATION_REQUIRED`，可诊断但不构成枚举信道——
 *   只有真正持有过旧密钥的发送方才可能产生"previous 命中"这一事实）；
 * - 再次轮换：previous 被当前 current 覆盖 → 更早一代 secret 立即失效（仅保留一代过渡，见 rotate）。
 */
export interface WebhookSecrets {
  current: string;
  previous: string | null;
  previousExpiresAt: number | null;
}

/** 旧 secret 过渡窗默认 24h（env WEBHOOK_SECRET_GRACE_MS 可覆盖——e2e 压缩窗口用） */
export const WEBHOOK_SECRET_GRACE_DEFAULT_MS = 24 * 3600_000;
/** 过渡窗上界（30 天：绝不接受"永不过期"的旧密钥） */
export const WEBHOOK_SECRET_GRACE_MAX_MS = 30 * 86400_000;

/** 过渡窗时长（非法/缺失 → 默认 24h；负数 → 0 = 立即失效；超上界 → 截断） */
export function webhookSecretGraceMs(): number {
  const raw = Number(process.env.WEBHOOK_SECRET_GRACE_MS);
  if (!Number.isFinite(raw)) return WEBHOOK_SECRET_GRACE_DEFAULT_MS;
  return Math.min(Math.max(0, Math.trunc(raw)), WEBHOOK_SECRET_GRACE_MAX_MS);
}

export function serializeWebhookSecrets(secrets: WebhookSecrets): string {
  return JSON.stringify({
    v: 2,
    current: secrets.current,
    ...(secrets.previous ? { previous: secrets.previous } : {}),
    ...(secrets.previous && secrets.previousExpiresAt != null ? { previousExpiresAt: secrets.previousExpiresAt } : {}),
  });
}

/** 解析（legacy 裸 secret → 单代 current；畸形信封 → 视为该字符串本身为 secret，绝不静默丢弃密钥） */
export function parseWebhookSecrets(plaintext: string): WebhookSecrets {
  if (!plaintext.startsWith('{')) return { current: plaintext, previous: null, previousExpiresAt: null };
  try {
    const parsed = JSON.parse(plaintext) as { v?: number; current?: unknown; previous?: unknown; previousExpiresAt?: unknown };
    if (typeof parsed?.current !== 'string' || parsed.current.length === 0) {
      return { current: plaintext, previous: null, previousExpiresAt: null };
    }
    const previous = typeof parsed.previous === 'string' && parsed.previous.length > 0 ? parsed.previous : null;
    const expires = Number(parsed.previousExpiresAt);
    return {
      current: parsed.current,
      previous,
      previousExpiresAt: previous && Number.isFinite(expires) ? expires : null,
    };
  } catch {
    return { current: plaintext, previous: null, previousExpiresAt: null };
  }
}

/**
 * 签名串（**Pre-M9 对外契约，顺序固定、字面拼接、无分隔符**）：
 * `hex(HMAC_SHA256(secret, timestamp + eventId + rawBody))`
 */
export function webhookSignature(secret: string, rawTimestamp: string, eventId: string, rawBody: Buffer): string {
  return createHmac('sha256', secret).update(`${rawTimestamp}${eventId}`).update(rawBody).digest('hex');
}

export type WebhookSecretMatch = 'none' | 'current' | 'previous' | 'previous_expired';

/**
 * 恒定时间比对 + 代际判定（**本轮命中哪一代**）：
 * - current 命中 → 'current'；
 * - previous 命中且未过期 → 'previous'；previous 命中但已过期 → 'previous_expired'（调用方拒绝并提示轮换）；
 * - 都不命中 → 'none'。
 * 判定顺序固定、逐代 timingSafeEqual（长度不等直接判负，绝不抛错）。
 */
export function matchWebhookSecret(
  secrets: WebhookSecrets,
  input: { rawTimestamp: string; eventId: string; rawBody: Buffer; provided: string; nowMs: number },
): WebhookSecretMatch {
  const provided = Buffer.from(input.provided, 'utf8');
  const matches = (secret: string): boolean => {
    const expected = Buffer.from(webhookSignature(secret, input.rawTimestamp, input.eventId, input.rawBody), 'utf8');
    return expected.length === provided.length && timingSafeEqual(expected, provided);
  };
  if (matches(secrets.current)) return 'current';
  if (!secrets.previous) return 'none';
  if (!matches(secrets.previous)) return 'none';
  const expiresAt = secrets.previousExpiresAt;
  if (expiresAt != null && input.nowMs > expiresAt) return 'previous_expired';
  return 'previous';
}
