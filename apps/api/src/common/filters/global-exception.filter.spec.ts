import { describe, it, expect } from 'vitest';
import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { MulterError } from 'multer';
import { GlobalExceptionFilter } from './global-exception.filter';
import { AppError, ErrorCode, type ErrorCodeType } from '../errors/app-error';

function makeRes() {
  return {
    statusCode: 0,
    body: undefined as unknown,
    status(code: number) { this.statusCode = code; return this; },
    json(payload: unknown) { this.body = payload; return this; },
  };
}

function makeHost(request: Record<string, unknown> = {}) {
  const res = makeRes();
  const host = {
    switchToHttp: () => ({ getResponse: () => res, getRequest: () => request }),
  };
  return { host, res };
}

const asError = (body: unknown) => body as { error: { code: string; message: string; requestId?: string } };

describe('GlobalExceptionFilter / 错误脱敏', () => {
  const filter = new GlobalExceptionFilter();

  it('未知异常 → 500 通用文案；堆栈/内部细节绝不进响应体', () => {
    const { host, res } = makeHost({ id: 'req-9' });
    const err = new Error('connect ECONNREFUSED postgresql://agent:secret@10.0.0.5:5432/db (password=secret)');
    err.stack = 'Error: boom\n    at C:\\app\\src\\modules\\x.service.ts:42:7';
    filter.catch(err, host as never);
    expect(res.statusCode).toBe(500);
    expect(asError(res.body).error.code).toBe(ErrorCode.INTERNAL);
    expect(asError(res.body).error.message).toBe('服务器内部错误');
    const raw = JSON.stringify(res.body);
    expect(raw).not.toContain('postgresql://');
    expect(raw).not.toContain('secret');
    expect(raw).not.toContain('.ts:42');
    expect(raw).not.toContain('ECONNREFUSED');
  });

  it('Prisma 风格异常（meta/query 含 SQL 与参数）→ 不泄露 SQL/参数', () => {
    const { host, res } = makeHost({ id: 'r' });
    const err = Object.assign(new Error('Unique constraint failed'), {
      code: 'P2002', meta: { target: ['email'], query: 'SELECT * FROM "User" WHERE email = $1' },
    });
    filter.catch(err, host as never);
    expect(res.statusCode).toBe(500);
    const raw = JSON.stringify(res.body);
    expect(raw).not.toContain('SELECT * FROM');
    expect(raw).not.toContain('P2002');
    expect(raw).not.toContain('Unique constraint');
  });

  it('HttpException 只透出 code/message（响应体里的额外敏感键一律丢弃）', () => {
    const { host, res } = makeHost({ id: 'r' });
    const ex = new ForbiddenException({ code: 'FORBIDDEN', message: '权限不足', stack: 'at x.ts:1', internalSecret: 'sk-live-123' });
    filter.catch(ex, host as never);
    expect(res.statusCode).toBe(403);
    const raw = JSON.stringify(res.body);
    expect(raw).not.toContain('internalSecret');
    expect(raw).not.toContain('sk-live-123');
    expect(raw).not.toContain('at x.ts:1');
    expect(Object.keys(asError(res.body).error).sort()).toEqual(['code', 'message', 'requestId']);
  });

  it('AppError 按 code 映射 HTTP 状态（401/403/404/409/429）', () => {
    const cases: Array<[ErrorCodeType, number]> = [
      [ErrorCode.UNAUTHORIZED, 401], [ErrorCode.FORBIDDEN, 403], [ErrorCode.NOT_FOUND, 404],
      [ErrorCode.RATE_LIMITED, 429], [ErrorCode.WEBHOOK_REPLAY, 409], [ErrorCode.WEBHOOK_SIGNATURE_INVALID, 401],
      [ErrorCode.CONNECTION_REVOKED, 409], [ErrorCode.VALIDATION_ERROR, 400],
    ];
    for (const [code, expected] of cases) {
      const { host, res } = makeHost({ id: 'r' });
      filter.catch(new AppError(code, 'x'), host as never);
      expect(res.statusCode).toBe(expected);
      expect(asError(res.body).error.code).toBe(code);
    }
  });

  it('MulterError LIMIT_FILE_SIZE → 400 且文案不含 multer 内部细节', () => {
    const { host, res } = makeHost({ id: 'r' });
    filter.catch(new MulterError('LIMIT_FILE_SIZE', 'file'), host as never);
    expect(res.statusCode).toBe(400);
    expect(asError(res.body).error.message).toBe('文件超过上传大小限制');
    expect(JSON.stringify(res.body)).not.toContain('file');
  });

  it('body-parser 错误（express 级错误处理未接管时的兜底）→ 413 JSON 信封', () => {
    const { host, res } = makeHost({ id: 'r' });
    filter.catch(Object.assign(new Error('too large'), { type: 'entity.too.large', status: 413 }), host as never);
    expect(res.statusCode).toBe(413);
    expect(asError(res.body).error.message).toBe('请求体超过大小限制');
  });

  it('HttpException(字符串响应) 兜底为结构化错误（不裸抛字符串）', () => {
    const { host, res } = makeHost({ id: 'r' });
    filter.catch(new BadRequestException('字段非法'), host as never);
    expect(res.statusCode).toBe(400);
    expect(asError(res.body).error.requestId).toBe('r');
  });
});
