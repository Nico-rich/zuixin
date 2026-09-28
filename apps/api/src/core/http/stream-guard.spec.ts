import { describe, it, expect, vi, afterEach } from 'vitest';
import { StreamGuard, StreamTimeoutError, StreamTimeouts, streamTimeoutsFrom } from './stream-guard';

afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); });

const T = (ms: number): StreamTimeouts => ({ connectMs: ms, firstByteMs: ms, idleMs: ms, totalMs: ms * 20 });

/** 可控 async 迭代器：按序产出给定块；耗尽后 next() **永不 settle**（模拟 provider 静默/半开连接） */
function makeIterator(values: unknown[]) {
  let i = 0;
  return {
    next: vi.fn(async (): Promise<IteratorResult<unknown>> => {
      if (i < values.length) return { done: false, value: values[i++] };
      return new Promise<IteratorResult<unknown>>(() => undefined);
    }),
  } as unknown as AsyncIterator<unknown>;
}

/** 断言"必然超时"：正常 settle 视为测试失败；异常统一收敛为 StreamTimeoutError 以便断言层级 */
function expectTimeout(p: Promise<unknown>): Promise<StreamTimeoutError> {
  return p.then(
    () => { throw new Error('期望超时，但 Promise 正常 settle'); },
    (e) => e as StreamTimeoutError,
  );
}

describe('Pre-M9 G6：LLM 流式四层超时（连接/首包/空闲/总时长）', () => {
  it('connect 层：拿到流对象超时 → StreamTimeoutError(connect) 且主动中断请求', async () => {
    vi.useFakeTimers();
    const guard = new StreamGuard(T(1_000));
    const p = guard.connect(() => new Promise<never>(() => undefined));
    const assertion = expect(p).rejects.toMatchObject({ layer: 'connect', timeoutMs: 1_000 });
    await vi.advanceTimersByTimeAsync(1_100);
    await assertion;
    expect(guard.signal.aborted).toBe(true); // 超时 = abort 底层请求，绝不挂着
  });

  it('firstByte 层：流对象已建立但首个数据块不来 → StreamTimeoutError(firstByte)', async () => {
    vi.useFakeTimers();
    const guard = new StreamGuard(T(500));
    const caught = expectTimeout(guard.next(makeIterator([])));
    await vi.advanceTimersByTimeAsync(600);
    const err = await caught;
    expect(err).toBeInstanceOf(StreamTimeoutError);
    expect(err.layer).toBe('firstByte');
    expect(guard.signal.aborted).toBe(true);
  });

  it('idle 层：收到首包后相邻块静默超时 → StreamTimeoutError(idle)', async () => {
    vi.useFakeTimers();
    const guard = new StreamGuard(T(300));
    const it = makeIterator([{ n: 1 }]);
    const first = guard.next(it);
    await vi.advanceTimersByTimeAsync(0);
    await expect(first).resolves.toEqual({ done: false, value: { n: 1 } });
    const caught = expectTimeout(guard.next(it));
    await vi.advanceTimersByTimeAsync(400);
    expect((await caught).layer).toBe('idle');
    expect(guard.signal.aborted).toBe(true);
  });

  it('total 层：每块都及时但总时长超上限 → StreamTimeoutError(total)', async () => {
    vi.useFakeTimers();
    const guard = new StreamGuard({ connectMs: 100, firstByteMs: 100, idleMs: 100, totalMs: 250 });
    const it = makeIterator([1, 2, 3, 4, 5, 6, 7, 8]);
    let thrown: unknown;
    for (let i = 0; i < 8; i++) {
      try {
        await guard.next(it);
        await vi.advanceTimersByTimeAsync(50); // 间隔 50ms < idle 100ms，但累计突破 total 250ms
      } catch (err) { thrown = err; break; }
    }
    expect(thrown).toBeInstanceOf(StreamTimeoutError);
    expect((thrown as StreamTimeoutError).layer).toBe('total');
  });

  it('外部 deadline 中止：原样抛出（不伪装成 StreamTimeoutError，交给上层按取消/deadline 语义处理）', async () => {
    const external = new AbortController();
    const guard = new StreamGuard(T(5_000), external.signal);
    const it = {
      next: () => new Promise<never>((_, reject) => {
        external.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
      }),
    } as unknown as AsyncIterator<unknown>;
    const p = guard.next(it);
    external.abort();
    await expect(p).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('正常推进：逐块返回并在 done 时结束（不误伤正常流）', async () => {
    const guard = new StreamGuard(T(5_000));
    const queue: Array<IteratorResult<number>> = [
      { done: false, value: 1 }, { done: false, value: 2 }, { done: true, value: undefined as never },
    ];
    const it = { next: async () => queue.shift()! } as unknown as AsyncIterator<number>;
    expect((await guard.next(it)).value).toBe(1);
    expect((await guard.next(it)).value).toBe(2);
    expect((await guard.next(it)).done).toBe(true);
  });

  it('abort() 幂等；streamTimeoutsFrom 默认取 provider.timeoutMs，env 可逐层覆盖', () => {
    const guard = new StreamGuard(T(1_000));
    guard.abort(); guard.abort();
    expect(guard.signal.aborted).toBe(true);
    expect(streamTimeoutsFrom({ timeoutMs: 12_345 })).toEqual({ connectMs: 12_345, firstByteMs: 12_345, idleMs: 12_345, totalMs: 12_345 });
    vi.stubEnv('LLM_STREAM_IDLE_TIMEOUT_MS', '2000');
    vi.stubEnv('LLM_STREAM_TOTAL_TIMEOUT_MS', '9000');
    expect(streamTimeoutsFrom({ timeoutMs: 12_345 })).toEqual({ connectMs: 12_345, firstByteMs: 12_345, idleMs: 2_000, totalMs: 9_000 });
  });
});
