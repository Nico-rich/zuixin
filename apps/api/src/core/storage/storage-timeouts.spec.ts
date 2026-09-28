import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  DEFAULT_S3_CONNECT_TIMEOUT_MS, DEFAULT_S3_REQUEST_TIMEOUT_MS, STORAGE_DEADLINE_SLACK_MS,
  StorageTimeoutError, isStorageTimeoutError, storageConnectTimeoutMs, storageDeadlineMs,
  storageRequestTimeoutMs, withStorageDeadline,
} from './storage-timeouts';

/** M11-P11（D1-12/NV-13）：调用面兜底原语 + env 口径（0 被显式拒绝，绝不落到"永不超时"） */

const ENV_KEYS = ['STORAGE_S3_CONNECT_TIMEOUT_MS', 'STORAGE_S3_REQUEST_TIMEOUT_MS', 'STORAGE_DEADLINE_MS'];
let savedEnv: Record<string, string | undefined>;

beforeEach(() => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k]; else process.env[k] = savedEnv[k];
  }
  vi.restoreAllMocks();
});

describe('存储超时 env 口径', () => {
  it('默认值：建连 5s / 请求 30s / 调用面兜底 = 请求 + 宽限', () => {
    expect(storageConnectTimeoutMs()).toBe(DEFAULT_S3_CONNECT_TIMEOUT_MS);
    expect(storageRequestTimeoutMs()).toBe(DEFAULT_S3_REQUEST_TIMEOUT_MS);
    expect(storageDeadlineMs()).toBe(DEFAULT_S3_REQUEST_TIMEOUT_MS + STORAGE_DEADLINE_SLACK_MS);
  });

  it('env 覆盖（含 STORAGE_DEADLINE_MS 独立覆盖）', () => {
    process.env.STORAGE_S3_CONNECT_TIMEOUT_MS = '1200';
    process.env.STORAGE_S3_REQUEST_TIMEOUT_MS = '4500';
    expect(storageConnectTimeoutMs()).toBe(1_200);
    expect(storageRequestTimeoutMs()).toBe(4_500);
    expect(storageDeadlineMs()).toBe(9_500);
    process.env.STORAGE_DEADLINE_MS = '700';
    expect(storageDeadlineMs()).toBe(700);
  });

  it('非法/零/负值一律回退默认（0 = 永不超时是必须堵死的取值）', () => {
    for (const bad of ['0', '-1', 'abc', '', 'NaN']) {
      process.env.STORAGE_S3_CONNECT_TIMEOUT_MS = bad;
      process.env.STORAGE_S3_REQUEST_TIMEOUT_MS = bad;
      process.env.STORAGE_DEADLINE_MS = bad;
      expect(storageConnectTimeoutMs()).toBe(DEFAULT_S3_CONNECT_TIMEOUT_MS);
      expect(storageRequestTimeoutMs()).toBe(DEFAULT_S3_REQUEST_TIMEOUT_MS);
      expect(storageDeadlineMs()).toBe(DEFAULT_S3_REQUEST_TIMEOUT_MS + STORAGE_DEADLINE_SLACK_MS);
    }
  });
});

describe('withStorageDeadline', () => {
  it('正常完成/失败语义不变（不引入额外包装层）', async () => {
    await expect(withStorageDeadline(Promise.resolve(42), 50, 'unit')).resolves.toBe(42);
    await expect(withStorageDeadline(Promise.reject(new Error('boom')), 50, 'unit')).rejects.toThrow('boom');
  });

  it('永不 settle 的 Promise → StorageTimeoutError（带 label/超时值），绝不无限挂起', async () => {
    vi.useFakeTimers();
    const p = withStorageDeadline(new Promise<never>(() => undefined), 1_000, 'attachments:put:abc');
    const assertion = expect(p).rejects.toBeInstanceOf(StorageTimeoutError);
    await vi.advanceTimersByTimeAsync(1_001);
    await assertion;
    await expect(p).rejects.toMatchObject({ code: 'STORAGE_TIMEOUT', label: 'attachments:put:abc', timeoutMs: 1_000 });
    await expect(p).rejects.toThrow('对象存储操作超时（attachments:put:abc，>1000ms）');
    vi.useRealTimers();
  });

  it('超时后原 Promise 的拒绝仍被消费（不产生 unhandled rejection）', async () => {
    vi.useFakeTimers();
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    try {
      let rejectLate: (e: Error) => void = () => undefined;
      const late = new Promise<never>((_, reject) => { rejectLate = reject; });
      const raced = withStorageDeadline(late, 10, 'attachments:rollback:abc').catch(() => 'timed-out');
      await vi.advanceTimersByTimeAsync(11);
      rejectLate(new Error('底层最终失败')); // 超时之后才失败的底层调用
      await expect(raced).resolves.toBe('timed-out');
      // 切回真实计时器后再让事件循环转一圈：Node 的 unhandledRejection 判定发生在微任务清空之后
      vi.useRealTimers();
      await new Promise((r) => setImmediate(r));
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off('unhandledRejection', unhandled);
      vi.useRealTimers();
    }
  });

  it('isStorageTimeoutError：只认本模块错误类型（SDK 文案不参与判定）', () => {
    expect(isStorageTimeoutError(new StorageTimeoutError('s3:put', 1))).toBe(true);
    expect(isStorageTimeoutError(new Error('Request timeout'))).toBe(false);
    expect(isStorageTimeoutError(new Error('timed out'))).toBe(false);
    expect(isStorageTimeoutError('timeout')).toBe(false);
  });
});
