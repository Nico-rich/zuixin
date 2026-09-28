import { describe, it, expect, afterEach } from 'vitest';
import {
  WEBHOOK_SECRET_GRACE_DEFAULT_MS, WEBHOOK_SECRET_GRACE_MAX_MS,
  matchWebhookSecret, parseWebhookSecrets, serializeWebhookSecrets, webhookSecretGraceMs, webhookSignature,
} from './webhook-secret';

const RAW_TS = '1750000000000';
const EVENT = 'evt-1';
const BODY = Buffer.from(JSON.stringify({ hello: '世界' }), 'utf8');
const NOW = Date.now();

const OLD = 'a'.repeat(64);
const NEW = 'b'.repeat(64);

function match(secrets: Parameters<typeof matchWebhookSecret>[0], provided: string, nowMs = NOW) {
  return matchWebhookSecret(secrets, { rawTimestamp: RAW_TS, eventId: EVENT, rawBody: BODY, provided, nowMs });
}

afterEach(() => { delete process.env.WEBHOOK_SECRET_GRACE_MS; });

/**
 * M10-P5 SA-18：webhook 双 secret 过渡窗（纯函数语义锁定）。
 * 关键不变量：签名串契约与 Pre-M9 完全一致（顺序/拼接方式不变）；过渡窗内两代都接受；
 * 窗口后旧代拒绝且**可归因**（previous_expired ≠ none —— 后者是"压根不匹配"）。
 */
describe('webhook-secret（M10-P5 SA-18 双 secret 过渡窗）', () => {
  it('签名串 = hex(HMAC_SHA256(secret, timestamp + eventId + rawBody))（Pre-M9 契约不变）', () => {
    const sig = webhookSignature(OLD, RAW_TS, EVENT, BODY);
    expect(sig).toMatch(/^[0-9a-f]{64}$/);
    expect(webhookSignature(OLD, RAW_TS, EVENT, BODY)).toBe(sig); // 确定性
    // 三个字段任一变化 → 签名变化（timestamp/eventId 参与签名 = 防"窗口内无限重放"）
    expect(webhookSignature(OLD, '1750000000001', EVENT, BODY)).not.toBe(sig);
    expect(webhookSignature(OLD, RAW_TS, 'evt-2', BODY)).not.toBe(sig);
    expect(webhookSignature(OLD, RAW_TS, EVENT, Buffer.from('{}', 'utf8'))).not.toBe(sig);
    expect(webhookSignature(NEW, RAW_TS, EVENT, BODY)).not.toBe(sig);
  });

  it('信封序列化/解析往返；legacy 裸 secret 与畸形信封都按"单代 current"处理（绝不静默丢密钥）', () => {
    const envelope = serializeWebhookSecrets({ current: NEW, previous: OLD, previousExpiresAt: NOW + 1000 });
    expect(parseWebhookSecrets(envelope)).toEqual({ current: NEW, previous: OLD, previousExpiresAt: NOW + 1000 });
    // 无 previous → 不写 previous 键
    const single = parseWebhookSecrets(serializeWebhookSecrets({ current: NEW, previous: null, previousExpiresAt: null }));
    expect(single).toEqual({ current: NEW, previous: null, previousExpiresAt: null });
    // Pre-M10 行：裸 hex secret
    expect(parseWebhookSecrets(OLD)).toEqual({ current: OLD, previous: null, previousExpiresAt: null });
    // 畸形 / 半截 JSON / 缺 current → 视为该字符串本身是密钥（宁可验签失败，绝不把密钥当垃圾丢掉）
    expect(parseWebhookSecrets('{not json')).toEqual({ current: '{not json', previous: null, previousExpiresAt: null });
    expect(parseWebhookSecrets('{"v":2}')).toEqual({ current: '{"v":2}', previous: null, previousExpiresAt: null });
    expect(parseWebhookSecrets('{"v":2,"current":""}')).toEqual({ current: '{"v":2,"current":""}', previous: null, previousExpiresAt: null });
    // previous 存在但过期时刻非法 → previousExpiresAt = null（= 不过期，仍接受；绝不因缺字段而误拒）
    expect(parseWebhookSecrets(`{"v":2,"current":"${NEW}","previous":"${OLD}"}`))
      .toEqual({ current: NEW, previous: OLD, previousExpiresAt: null });
  });

  it('过渡窗内：current 与 previous 的签名都接受，并各自可归因', () => {
    const secrets = { current: NEW, previous: OLD, previousExpiresAt: NOW + 60_000 };
    expect(match(secrets, webhookSignature(NEW, RAW_TS, EVENT, BODY))).toBe('current');
    expect(match(secrets, webhookSignature(OLD, RAW_TS, EVENT, BODY))).toBe('previous');
    // 边界：恰好等于过期时刻仍接受（`>` 才判过期）——窗口含右端点，避免时钟抖动造成"早一秒失效"
    expect(match(secrets, webhookSignature(OLD, RAW_TS, EVENT, BODY), NOW + 60_000)).toBe('previous');
    expect(match(secrets, webhookSignature(OLD, RAW_TS, EVENT, BODY), NOW + 60_001)).toBe('previous_expired');
  });

  it('过渡窗后：旧 secret 签名拒绝且**可诊断**（previous_expired）；无关签名一律 none', () => {
    const secrets = { current: NEW, previous: OLD, previousExpiresAt: NOW - 1 };
    expect(match(secrets, webhookSignature(OLD, RAW_TS, EVENT, BODY))).toBe('previous_expired');
    expect(match(secrets, webhookSignature(NEW, RAW_TS, EVENT, BODY))).toBe('current');
    expect(match(secrets, 'f'.repeat(64))).toBe('none');
    expect(match(secrets, webhookSignature('c'.repeat(64), RAW_TS, EVENT, BODY))).toBe('none');
    // 长度不等/空签名 → none（绝不抛错：timingSafeEqual 前先比长度）
    expect(match(secrets, '')).toBe('none');
    expect(match(secrets, 'abcd')).toBe('none');
  });

  it('只保留一代：previous 为空 → 更早一代立即失效（不是 previous_expired，而是 none）', () => {
    const secrets = { current: NEW, previous: null, previousExpiresAt: null };
    expect(match(secrets, webhookSignature(OLD, RAW_TS, EVENT, BODY))).toBe('none');
    expect(match(secrets, webhookSignature(NEW, RAW_TS, EVENT, BODY))).toBe('current');
  });

  it('previousExpiresAt = null 视为不过期（兼容"未声明过期时刻"的信封）', () => {
    expect(match({ current: NEW, previous: OLD, previousExpiresAt: null }, webhookSignature(OLD, RAW_TS, EVENT, BODY), NOW + 10 * 365 * 86400_000))
      .toBe('previous');
  });

  it('webhookSecretGraceMs：默认 24h；负数 → 0（立即失效）；超上界截断；非法回默认', () => {
    expect(webhookSecretGraceMs()).toBe(WEBHOOK_SECRET_GRACE_DEFAULT_MS);
    process.env.WEBHOOK_SECRET_GRACE_MS = '500';
    expect(webhookSecretGraceMs()).toBe(500);
    process.env.WEBHOOK_SECRET_GRACE_MS = '0';
    expect(webhookSecretGraceMs()).toBe(0);
    process.env.WEBHOOK_SECRET_GRACE_MS = '-5';
    expect(webhookSecretGraceMs()).toBe(0);
    process.env.WEBHOOK_SECRET_GRACE_MS = String(90 * 86400_000);
    expect(webhookSecretGraceMs()).toBe(WEBHOOK_SECRET_GRACE_MAX_MS);
    process.env.WEBHOOK_SECRET_GRACE_MS = 'abc';
    expect(webhookSecretGraceMs()).toBe(WEBHOOK_SECRET_GRACE_DEFAULT_MS);
  });
});
