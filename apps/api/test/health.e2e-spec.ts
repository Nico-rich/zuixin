import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { AppModule } from '../src/app.module';
import { GlobalExceptionFilter } from '../src/common/filters/global-exception.filter';

describe('Health (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api/v1');
    app.useGlobalFilters(moduleRef.get(GlobalExceptionFilter));
    await app.init();
  });

  afterAll(async () => { await app.close(); });

  it('GET /api/v1/health 返回 200 ok（M8-P9：兼容保留 status，扩展依赖明细）', async () => {
    const res = await request(app.getHttpServer()).get('/api/v1/health').expect(200);
    // M8-P9 前：body 形如 {status:'ok'}。现扩展为含 db/redis/queue/storage/checks 的报告，
    // 但 status 字段语义与取值不变（既有探针/告警规则零改动可用）。
    expect(res.body.status).toBe('ok');
    expect(res.body.db.state).toBe('up');
    expect(res.body.redis.state).toBe('up');
    expect(res.body.checks.map((c: { name: string }) => c.name)).toEqual(['db', 'redis', 'storage']);
  });

  it('未捕获异常返回统一 envelope（含 requestId）', async () => {
    const res = await request(app.getHttpServer()).get('/api/v1/health/boom').expect(500);
    expect(res.body.error.code).toBe('INTERNAL');
    expect(res.body.error.requestId).toBeTruthy();
  });
});
