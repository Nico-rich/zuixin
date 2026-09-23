import { describe, it, expect } from 'vitest';
import { AppError, RETRYABLE_CODES } from '../src';

describe('ErrorCode / AppError', () => {
  it('RETRYABLE_CODES 只包含可重试的 provider 错误', () => {
    expect(RETRYABLE_CODES).toContain('PROVIDER_TIMEOUT');
    expect(RETRYABLE_CODES).toContain('PROVIDER_RATE_LIMITED');
    expect(RETRYABLE_CODES).toContain('PROVIDER_OVERLOADED');
    expect(RETRYABLE_CODES).not.toContain('PROVIDER_AUTH');
    expect(RETRYABLE_CODES).not.toContain('PROVIDER_BAD_REQUEST');
  });

  it('AppError 携带 requestId 并可序列化为响应 envelope', () => {
    const err = new AppError('QUOTA_EXCEEDED', '今日生图次数已达上限', 'req_1');
    expect(err.toJSON()).toEqual({
      code: 'QUOTA_EXCEEDED', message: '今日生图次数已达上限', requestId: 'req_1',
    });
  });

  it('PROVIDER_UNKNOWN 不是可重试错误', () => {
    expect(RETRYABLE_CODES.has('PROVIDER_UNKNOWN')).toBe(false);
  });
});
