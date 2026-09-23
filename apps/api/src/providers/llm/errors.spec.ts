import { describe, it, expect } from 'vitest';
import { mapProviderError, toChatError } from './errors';

describe('mapProviderError', () => {
  it('429 → PROVIDER_RATE_LIMITED 可重试', () => {
    const err = mapProviderError(Object.assign(new Error('rate'), { status: 429 }));
    expect(err.code).toBe('PROVIDER_RATE_LIMITED'); expect(err.retryable).toBe(true);
  });
  it('401 → PROVIDER_AUTH 不可重试', () => {
    const err = mapProviderError(Object.assign(new Error('auth'), { status: 401 }));
    expect(err.code).toBe('PROVIDER_AUTH'); expect(err.retryable).toBe(false);
  });
  it('400 → PROVIDER_BAD_REQUEST 不可重试', () => {
    const err = mapProviderError(Object.assign(new Error('bad'), { status: 400 }));
    expect(err.code).toBe('PROVIDER_BAD_REQUEST'); expect(err.retryable).toBe(false);
  });
  it('5xx → PROVIDER_OVERLOADED 可重试', () => {
    const err = mapProviderError(Object.assign(new Error('boom'), { status: 503 }));
    expect(err.code).toBe('PROVIDER_OVERLOADED'); expect(err.retryable).toBe(true);
  });
  it('AbortError → PROVIDER_TIMEOUT 可重试', () => {
    const err = mapProviderError(Object.assign(new Error('aborted'), { name: 'AbortError' }));
    expect(err.code).toBe('PROVIDER_TIMEOUT'); expect(err.retryable).toBe(true);
  });
  it('未知错误 → PROVIDER_UNKNOWN 不可重试', () => {
    const err = mapProviderError(new Error('?'));
    expect(err.code).toBe('PROVIDER_UNKNOWN'); expect(err.retryable).toBe(false);
  });
});

describe('toChatError', () => {
  it('把任意异常包装为 AppError', () => {
    const err = toChatError(Object.assign(new Error('x'), { status: 429 }), 'req_9');
    expect(err.code).toBe('PROVIDER_RATE_LIMITED'); expect(err.requestId).toBe('req_9');
  });
});
