import { describe, it, expect, vi } from 'vitest';
import { bodyLimitErrorHandler } from './body-limit.middleware';

function makeRes() {
  const res = {
    statusCode: 0,
    body: undefined as unknown,
    status(code: number) { this.statusCode = code; return this; },
    json(payload: unknown) { this.body = payload; return this; },
  };
  return res;
}

describe('bodyLimitErrorHandler', () => {
  it('entity.too.large → 413 + 统一 JSON 信封（不泄露堆栈/路径）', () => {
    const res = makeRes();
    const err = Object.assign(new Error('request entity too large'), {
      type: 'entity.too.large', status: 413,
      stack: 'Error: request entity too large\n    at C:\\app\\node_modules\\body-parser\\lib\\read.js:1:1',
    });
    bodyLimitErrorHandler(err, { id: 'req-1' } as never, res as never, vi.fn());
    expect(res.statusCode).toBe(413);
    expect(res.body).toEqual({ error: { code: 'VALIDATION_ERROR', message: '请求体超过大小限制', requestId: 'req-1' } });
    expect(JSON.stringify(res.body)).not.toContain('body-parser');
    expect(JSON.stringify(res.body)).not.toContain('read.js');
  });

  it('entity.parse.failed → 400（JSON 非法不是 500）', () => {
    const res = makeRes();
    bodyLimitErrorHandler(Object.assign(new Error('Unexpected token'), { type: 'entity.parse.failed', status: 400 }), { id: 'r' } as never, res as never, vi.fn());
    expect(res.statusCode).toBe(400);
    expect((res.body as { error: { message: string } }).error.message).toBe('请求体格式非法');
  });

  it('非 body-parser 错误交回后续错误处理（绝不吞异常）', () => {
    const res = makeRes();
    const next = vi.fn();
    const err = new Error('boom');
    bodyLimitErrorHandler(err, { id: 'r' } as never, res as never, next);
    expect(next).toHaveBeenCalledWith(err);
    expect(res.statusCode).toBe(0);
  });

  it('缺失 status 的 entity 错误兜底 400（不返回 undefined 状态码）', () => {
    const res = makeRes();
    bodyLimitErrorHandler({ type: 'entity.unknown' }, { id: 'r' } as never, res as never, vi.fn());
    expect(res.statusCode).toBe(400);
  });
});
