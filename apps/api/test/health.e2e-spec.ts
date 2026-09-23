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

  it('GET /api/v1/health 返回 200 ok', async () => {
    const res = await request(app.getHttpServer()).get('/api/v1/health').expect(200);
    expect(res.body).toEqual({ status: 'ok' });
  });

  it('未捕获异常返回统一 envelope（含 requestId）', async () => {
    const res = await request(app.getHttpServer()).get('/api/v1/health/boom').expect(500);
    expect(res.body.error.code).toBe('INTERNAL');
    expect(res.body.error.requestId).toBeTruthy();
  });
});
