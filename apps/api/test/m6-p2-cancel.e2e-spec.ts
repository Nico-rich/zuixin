import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import http from 'node:http';
import cookieParser from 'cookie-parser';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { AppModule } from '../src/app.module';
import { GlobalExceptionFilter } from '../src/common/filters/global-exception.filter';
import { TransformInterceptor } from '../src/common/interceptors/transform.interceptor';
import { csrfProtection } from '../src/modules/auth/csrf.middleware';
import { PrismaService } from '../src/modules/prisma/prisma.service';

const XRW = { 'X-Requested-With': 'XMLHttpRequest' };

/**
 * M6-P2 取消链路 e2e（真实验证）：
 * 慢速 mock 流（MOCK_DELAY_MS=30 逐字符）→ 客户端在收到首个分块后销毁连接
 * → req 'close' → AbortSignal → LLM 流中断（mock 逐字符检查 signal）
 * → AgentRun cancelled（绝不伪装 provider failure），中断回合 usage 记 AGENT_CANCELLED。
 * 注：MOCK_DELAY_MS 在本文件进程内生效（vitest 文件级隔离，不影响其他套件）。
 */
describe('M6-P2 取消链路 (e2e, 慢速 mock + 连接销毁)', () => {
  let app: INestApplication;
  let cookie: string;
  let prisma: PrismaService;

  beforeAll(async () => {
    process.env.MOCK_DELAY_MS = '30';
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.use(cookieParser());
    app.use('/api/v1', csrfProtection);
    app.setGlobalPrefix('api/v1');
    app.useGlobalFilters(moduleRef.get(GlobalExceptionFilter));
    app.useGlobalInterceptors(new TransformInterceptor());
    await app.init();
    await app.listen(0); // 真实监听（取消用例需原生 http 直接连端口断开 socket）
    prisma = moduleRef.get(PrismaService);
    const login = await request(app.getHttpServer()).post('/api/v1/auth/login').set(XRW)
      .send({ email: process.env.SEED_ADMIN_EMAIL ?? 'admin@example.com', password: process.env.SEED_ADMIN_PASSWORD ?? 'admin123456' });
    cookie = (login.headers['set-cookie'] as unknown as string[]).map((c) => c.split(';')[0]).join('; ');
  });

  afterAll(async () => { await app.close(); });

  it('流式中客户端断开 → run cancelled + 中断回合 usage=AGENT_CANCELLED + message 落库 cancelled', async () => {
    // 原生 http 请求：收到首个 delta 后 req.destroy() 真实断开 socket（supertest 的 res.destroy 不保证断开底层连接）
    const addr = app.getHttpServer().address() as { port: number };
    const body = JSON.stringify({ message: '今天天气怎么样呀，请慢慢讲给我听' });
    let aborted = false;
    await new Promise<void>((resolve) => {
      const req = http.request({
        host: '127.0.0.1', port: addr.port, path: '/api/v1/chat', method: 'POST',
        headers: {
          'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body),
          'X-Requested-With': 'XMLHttpRequest', 'Cookie': cookie,
        },
      }, (res) => {
        res.on('data', (chunk: Buffer) => {
          if (!aborted && chunk.toString().includes('event: message_delta')) {
            aborted = true;
            req.destroy(); // 客户端断开 → 服务器 req 'close' → AbortSignal → LLM 流中断
          }
        });
        res.on('close', () => resolve());
        res.on('error', () => resolve());
      });
      req.on('error', () => resolve());
      req.write(body);
      req.end();
    });
    expect(aborted).toBe(true);

    // 等待引擎收尾（abort → cancelled 终态 + finalize）
    await new Promise((r) => setTimeout(r, 800));

    const runs = await prisma.agentRun.findMany({ orderBy: { createdAt: 'desc' }, take: 5, where: { status: 'cancelled' } });
    expect(runs.length).toBeGreaterThanOrEqual(1);
    const run = runs[0];
    expect(run.errorCode).toBeNull(); // cancelled 不是失败，无错误码

    // 中断回合 usage：AGENT_CANCELLED（M6-A8 归因）
    const usage = await prisma.usageRecord.findMany({ where: { runId: run.id } });
    expect(usage.some((u) => u.errorCode === 'AGENT_CANCELLED')).toBe(true);

    // assistant message 落库 cancelled（M1 语义：保留部分内容）
    const msg = await prisma.message.findMany({ where: { conversationId: run.conversationId!, role: 'assistant' }, orderBy: { createdAt: 'desc' }, take: 1 });
    expect(msg[0].status).toBe('cancelled');
  });

  it('对照组：正常完整流 → run completed（慢速 mock 全量流完）', async () => {
    const res = await request(app.getHttpServer()).post('/api/v1/chat').set(XRW).set('Cookie', cookie)
      .send({ message: '讲一个短笑话' })
      .buffer(true).parse((r, cb) => { let s = ''; r.on('data', (c: Buffer) => (s += c.toString())); r.on('end', () => cb(null, s)); })
      .expect(200);
    const text = res.body as string;
    expect(text).toContain('event: message_end');
    expect(text).toContain('"status":"completed"');
    const convMatch = text.match(/"conversationId":"([0-9a-f-]+)"/);
    const run = await prisma.agentRun.findFirst({ where: { conversationId: convMatch![1] }, orderBy: { createdAt: 'desc' } });
    expect(run?.status).toBe('completed');
  });
});
