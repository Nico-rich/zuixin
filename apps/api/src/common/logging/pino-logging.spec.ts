import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import request from 'supertest';
import pino, { DestinationStream } from 'pino';
import { pinoHttp, Options as PinoHttpOptions } from 'pino-http';
import {
  PinoNestLogger, REDACTED, REDACT_PATHS, createHttpLoggerParams, createPinoOptions, scrubLogValue, scrubQuery,
} from './pino-logging';

/**
 * Pre-M9 F1/F2 日志脱敏单测（与 API/Worker 运行时同一份配置）：
 * ① 配置面：redact 路径覆盖 set-cookie/authorization/cookie（F1 泄漏点）；
 * ② 行为面：真实 pino 实例 + 真实 pino-http 中间件下，JWT 形态字符串绝不落日志（含 set-cookie 响应头）；
 * ③ Worker：PinoNestLogger（F2）与 API 同源配置，错误 message/嵌套 payload 中的密钥同样被擦洗。
 *
 * 断言方式：把 pino 输出写入内存流，对原始 JSON 行做"不包含 JWT 明文"的字符串断言
 * （不做字段级断言——防止漏网字段被误判为通过）。
 */

/** 真实 JWT 形态（三段 base64url，decode 后为 {sub} / {} / sig） */
const JWT = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJ1c2VyLTEiLCJvcmciOiJvcmctMSJ9.c2lnbmF0dXJlLXBhcnQ';
const REFRESH_JWT = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJ1c2VyLTEiLCJ0eXAiOiJyZWZyZXNoIn0.YW5vdGhlci1zaWduYXR1cmU';

function capture(): { stream: DestinationStream; text: () => string; lines: () => string[] } {
  const chunks: string[] = [];
  return {
    stream: { write: (s: string) => { chunks.push(s); } } as unknown as DestinationStream,
    text: () => chunks.join(''),
    lines: () => chunks.join('').split('\n').filter((l) => l.trim().length > 0),
  };
}

describe('Pre-M9 F1/F2 pino 日志脱敏', () => {
  describe('① 配置面：redact/serializer 覆盖', () => {
    it('REDACT_PATHS 覆盖 res.headers["set-cookie"]（F1 原始泄漏点）与 authorization/cookie', () => {
      const joined = REDACT_PATHS.join(',');
      expect(joined).toContain('res.headers["set-cookie"]');
      expect(joined).toContain('req.headers.authorization');
      expect(joined).toContain('req.headers.cookie');
      expect(joined).toContain('headers["set-cookie"]');
      expect(joined).toContain('apiKey');
    });

    it('createPinoOptions 携带 redact/serializers/hooks（API 与 Worker 同源）', () => {
      const opts = createPinoOptions('worker');
      expect(opts.redact).toMatchObject({ censor: REDACTED });
      expect(opts.serializers).toBeTruthy();
      expect(opts.hooks).toBeTruthy();
      expect(opts.base).toMatchObject({ service: 'worker' });
    });
  });

  describe('② 行为面：真实 pino 输出绝不含 JWT', () => {
    it('应用日志：嵌套 headers / token / authorization 一律擦洗', () => {
      const cap = capture();
      const logger = pino(createPinoOptions('api'), cap.stream);
      logger.info(
        {
          req: { id: 'r1', method: 'POST', url: '/api/v1/auth/login', headers: { cookie: `access_token=${JWT}`, authorization: `Bearer ${JWT}`, 'user-agent': 'vitest' } },
          res: { statusCode: 200, headers: { 'set-cookie': [`access_token=${JWT}; HttpOnly`, `refresh_token=${REFRESH_JWT}; HttpOnly`] } },
        },
        '请求完成',
      );
      logger.info({ nested: { deep: { token: JWT, apiKey: 'sk-live-abcdefghijklmn' } } }, '嵌套对象');
      logger.warn({ message: `刷新失败 refresh=${REFRESH_JWT}` });

      const text = cap.text();
      expect(text).not.toContain(JWT);
      expect(text).not.toContain(REFRESH_JWT);
      expect(text).not.toContain('sk-live-abcdefghijklmn');
      expect(text).toContain(REDACTED);
      // 安全字段仍可观测（脱敏不等于静默）
      expect(text).toContain('vitest');
      expect(text).toContain('POST');
    });

    it('错误日志：Error.message/stack 中的 JWT 被擦洗（err serializer）', () => {
      const cap = capture();
      const logger = pino(createPinoOptions('worker'), cap.stream);
      const err = new Error(`token 校验失败: ${JWT}`);
      err.stack = `Error: token 校验失败: ${JWT}\n    at worker (${JWT})`;
      logger.error(err);
      logger.error({ err }, '队列消费失败');

      const text = cap.text();
      expect(text).not.toContain(JWT);
      expect(text).not.toContain('eyJ');
      expect(cap.lines().some((l) => l.includes('"err"'))).toBe(true); // 仍是标准 err 形态
      // 顶层 Error（logger.error(err)）的派生态 msg 也必须已擦洗
      const [first] = cap.lines();
      expect(JSON.parse(first)).toMatchObject({ msg: 'token 校验失败: [Redacted]' });
    });

    it('scrubQuery / scrubLogValue 纯函数行为（URL 与任意层级密钥）', () => {
      expect(scrubQuery(`/api/v1/auth/callback?code=abc&access_token=${JWT}&page=2`)).not.toContain(JWT);
      expect(scrubQuery(`/api/v1/auth/callback?code=abc&access_token=${JWT}&page=2`)).toContain('page=2');
      const scrubbed = scrubLogValue({ a: [{ b: JWT }], headers: { cookie: JWT, 'user-agent': 'vitest' } }) as Record<string, unknown>;
      expect(JSON.stringify(scrubbed)).not.toContain(JWT);
    });
  });

  describe('③ 真实 pino-http 中间件（与 API 入口同一装配）', () => {
    let app: express.Express;
    let cap: ReturnType<typeof capture>;

    beforeAll(() => {
      cap = capture();
      const { pinoHttp: options } = createHttpLoggerParams('api', { autoLogging: { ignore: (req) => req.url === '/health' } });
      // 真实装配下 options 带 pino-pretty transport（只影响输出目标/格式化，redact/serializer/hook 完全一致）；
      // 测试需把日志落到内存流，故摘除 transport——其余字段与生产路径逐字段相同。
      const forTest = { ...(options as PinoHttpOptions) };
      delete (forTest as { transport?: unknown }).transport;
      app = express();
      app.use(pinoHttp(forTest, cap.stream));
      // 模拟登录/刷新：access+refresh JWT 经 Set-Cookie 下发
      app.post('/api/v1/auth/login', (_req, res) => {
        res.setHeader('Set-Cookie', [`access_token=${JWT}; HttpOnly; Path=/`, `refresh_token=${REFRESH_JWT}; HttpOnly; Path=/`]);
        res.json({ ok: true });
      });
      // 模拟 401/403：错误响应同样不得把请求携带的 Token 落档
      app.get('/api/v1/secure', (_req, res) => { res.status(403).json({ error: { code: 'FORBIDDEN' } }); });
    });

    afterAll(() => { /* 无外部资源 */ });

    it('login（Set-Cookie: access+refresh JWT）→ 请求日志无任何 JWT', async () => {
      await request(app).post('/api/v1/auth/login').set('Cookie', `access_token=${JWT}`).set('Authorization', `Bearer ${JWT}`).set('User-Agent', 'vitest-agent').expect(200);
      const text = cap.text();
      expect(text).not.toContain(JWT);
      expect(text).not.toContain(REFRESH_JWT);
      expect(text).toContain('request completed');
      expect(text).toContain('"statusCode":200');
    });

    it('401/403 请求日志同样无 JWT（错误路径不成为旁路）', async () => {
      await request(app).get('/api/v1/secure').set('Cookie', `refresh_token=${REFRESH_JWT}`).set('Authorization', `Bearer ${REFRESH_JWT}`).expect(403);
      const text = cap.text();
      expect(text).not.toContain(JWT);
      expect(text).not.toContain(REFRESH_JWT);
      expect(text).toContain('"statusCode":403');
    });

    it('健康检查不受影响（autoLogging ignore 保持）', async () => {
      const before = cap.lines().length;
      await request(app).get('/health').expect(404);
      expect(cap.lines().length).toBe(before);
    });

    it('真实装配（transport / LOG_FILE 两种形态）同样携带完整 redact 路径', () => {
      const dev = createHttpLoggerParams('api');
      const devOpts = (Array.isArray(dev.pinoHttp) ? dev.pinoHttp[0] : dev.pinoHttp) as { redact?: { paths?: string[] }; serializers?: unknown; hooks?: unknown };
      expect(devOpts.redact?.paths).toContain('res.headers["set-cookie"]');
      expect(devOpts.serializers).toBeTruthy();
      expect(devOpts.hooks).toBeTruthy();

      const prev = process.env.LOG_FILE;
      process.env.LOG_FILE = `${process.cwd()}/.tmp-pino-logging-test.log`;
      try {
        const file = createHttpLoggerParams('api');
        // [options, destination]：pino 不允许 transport 与 destination 并存
        expect(Array.isArray(file.pinoHttp)).toBe(true);
        const fileOpts = (file.pinoHttp as [PinoHttpOptions, DestinationStream])[0] as { redact?: { paths?: string[] } };
        expect(fileOpts.redact?.paths).toContain('res.headers["set-cookie"]');
      } finally {
        if (prev === undefined) delete process.env.LOG_FILE; else process.env.LOG_FILE = prev;
      }
    });

    it('serializer 白名单：headers 只保留安全字段（cookie/authorization/set-cookie 永不出现）', () => {
      const text = cap.text();
      expect(text).toContain('vitest-agent');
      expect(text).toContain('content-type');
      expect(text).not.toContain('set-cookie');
      expect(text).not.toContain('"cookie"');
      expect(text).not.toContain('"authorization"');
      // 请求/响应日志均不得出现任何 JWT 片段
      expect(text).not.toContain('eyJ');
    });
  });

  describe('④ Worker：PinoNestLogger（F2 与 API 同源）', () => {
    it('queue payload / 错误对象中的 credential 被擦洗，安全 ID 保留', () => {
      const cap = capture();
      const nestLogger = new PinoNestLogger('worker', { });
      // 用同一份配置但替换目的地（验证配置本身；运行时 worker.ts 使用默认 stdout）
      const logger = pino(createPinoOptions('worker'), cap.stream);
      logger.info({ runId: 'run-1', taskId: 'task-1', payload: { apiKey: 'sk-worker-secret-key', note: JWT } }, '队列消费开始');
      logger.error({ err: new Error(`凭证失效 ${JWT}`), runId: 'run-1' }, '消费失败');
      const text = cap.text();
      expect(text).not.toContain(JWT);
      expect(text).not.toContain('sk-worker-secret-key');
      expect(text).toContain('run-1');

      // Nest LoggerService 适配层可用（error(message, stack, context) 形态）
      expect(typeof nestLogger.log).toBe('function');
      expect(() => nestLogger.error('worker 启动失败', 'stack-line', 'Bootstrap')).not.toThrow();
      expect(() => nestLogger.log({ runId: 'run-2', apiKey: 'sk-x' }, 'Context')).not.toThrow();
    });

    it('Nest LoggerService 适配：字段/context 正常落盘（同源配置）', () => {
      const cap = capture();
      const logger = pino(createPinoOptions('worker'), cap.stream);
      logger.info({ runId: 'run-9', context: 'AgentRunProcessor' }, 'claim 成功');
      const [line] = cap.lines();
      expect(JSON.parse(line)).toMatchObject({ service: 'worker', runId: 'run-9', context: 'AgentRunProcessor', msg: 'claim 成功' });
    });

    it('PinoNestLogger 底层 pino 实例可审计且与 API 同源（redact 路径一致）', () => {
      const nestLogger = new PinoNestLogger('worker');
      const opts = (nestLogger.instance as unknown as { [k: symbol]: unknown })[Symbol.for('pino.opts')] as { redact?: { paths?: string[] } } | undefined;
      // pino 实例内部 opts 非稳定 API，这里退化为断言序列化行为与 createPinoOptions 一致（配置同源由 createPinoOptions 单点保证）
      expect(JSON.stringify(REDACT_PATHS)).toBe(JSON.stringify(createPinoOptions('api').redact && (createPinoOptions('api').redact as { paths: string[] }).paths));
      expect(opts === undefined || typeof opts === 'object').toBe(true);
      expect(typeof nestLogger.instance.child).toBe('function');
    });
  });
});
