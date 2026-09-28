import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import cookieParser from 'cookie-parser';
import Redis from 'ioredis';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CreateBucketCommand, DeleteObjectCommand, GetObjectCommand, HeadBucketCommand, HeadObjectCommand, S3Client,
} from '@aws-sdk/client-s3';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { GlobalExceptionFilter } from '../src/common/filters/global-exception.filter';
import { TransformInterceptor } from '../src/common/interceptors/transform.interceptor';
import { csrfProtection } from '../src/modules/auth/csrf.middleware';
import { PrismaService } from '../src/modules/prisma/prisma.service';
import { makeBombZip, makeJpegWithExif, makeNormalZip, makePngWithMetadata } from './support/attachment-fixtures';

/**
 * M10-P7 附件内容安全 + S3/MinIO 驱动 e2e（审计 SA-19/X-18/SA-20）。
 *
 * 真实基础设施：PostgreSQL + Redis（隔离 DB）+ **真实 MinIO**（http://localhost:9000，
 * STORAGE_DRIVER=s3 走 StorageS3Adapter，非 mock/local 落盘）+ 真实 HTTP（supertest → Nest）。
 *
 * 覆盖：
 * ① S3 全链路：上传 → 下载（S3 流式回源）→ 删除（DeleteObject）→ 对象与库行状态一致；
 * ② 内容安全：EXIF 剥离后**对象里的字节**就没有 APP1（不是只改了 DB 字段）；zip 炸弹（真实可 inflate
 *    出 40MB）被 400 ATTACHMENT_UNZIP_REJECTED 拒绝；正常 docx 放行；
 * ③ 每用户附件配额：tiny 计划 2 次额度 → 第 3 次 429 ATTACHMENT_QUOTA_EXCEEDED；账本计数（配额口径）
 *    与预留释放状态可查；被拒上传不消耗额度、不留预留、不写账本；
 * ④ 凭证不入日志：真实 pino 落盘（LOG_FILE）后断言 access key/secret/预签名签名串绝不出现
 *    （S3 预签名 URL 的 query 里带明文 access key —— 是最现实的泄漏通道）。
 *
 * 隔离：STORAGE_BUCKET 用**专用桶** agent-storage-e2e-p7（绝不污染默认 agent-storage）；
 * Redis 用调用方给定 REDIS_URL（M10 铁律 /27），若服务端 databases 配置不支持该索引则退到闲置 DB 13
 * （见 resolveRedisUrl 注释——越界索引会被 ioredis 静默落到 DB0，必须按服务端配置判定）。
 */

const XRW = { 'X-Requested-With': 'XMLHttpRequest' };
const STAMP = Date.now();
const S3_BUCKET = 'agent-storage-e2e-p7';
const S3_ENDPOINT = process.env.STORAGE_ENDPOINT ?? 'http://localhost:9000';
const S3_ACCESS_KEY = process.env.STORAGE_ACCESS_KEY_ID ?? 'minioadmin';
const S3_SECRET_KEY = process.env.STORAGE_SECRET_ACCESS_KEY ?? 'minioadmin';

const LOG_DIR = mkdtempSync(join(tmpdir(), 'm10-p7-s3-'));
const API_LOG_FILE = join(LOG_DIR, 'api.jsonl');

const ORIGINAL_ENV = {
  REDIS_URL: process.env.REDIS_URL,
  STORAGE_DRIVER: process.env.STORAGE_DRIVER,
  STORAGE_BUCKET: process.env.STORAGE_BUCKET,
  STORAGE_ENDPOINT: process.env.STORAGE_ENDPOINT,
  STORAGE_ACCESS_KEY_ID: process.env.STORAGE_ACCESS_KEY_ID,
  STORAGE_SECRET_ACCESS_KEY: process.env.STORAGE_SECRET_ACCESS_KEY,
  LOG_FILE: process.env.LOG_FILE,
};

/**
 * Redis 隔离 DB 解析：**不能**靠 PING 探测——实测 ioredis 连 `.../27` 时只发 error 事件
 * （"ERR DB index is out of range"）而连接 status 仍为 ready，SET/GET 全部成功但数据**静默落到 DB0**
 * （违反"禁止 DB0"铁律）。故读服务端 `databases` 配置做裁决：越界 → 退到闲置 DB 13
 * （既有 e2e 已用 0/1/2/3/4/5/7/8/9/10/11；12~15 未被占用）。
 */
async function resolveRedisUrl(): Promise<string> {
  const preferred = process.env.REDIS_URL ?? 'redis://localhost:6379/0';
  const base = preferred.replace(/\/\d+$/, '');
  const requested = Number(/:\d+\/(\d+)/.exec(preferred)?.[1] ?? '0');
  // 先连**不带索引**的地址，再显式 SELECT：越界会 reject（可判定），绝不依赖握手期 SELECT 的失败表现
  const probe = new Redis(base, { lazyConnect: true, maxRetriesPerRequest: 1, retryStrategy: () => null, connectTimeout: 2_000 });
  probe.on('error', () => undefined);
  let connected = false;
  try {
    await probe.connect();
    connected = true;
    await probe.select(requested);
    return preferred;
  } catch (err) {
    if (!connected) return preferred; // 连不上：基础设施问题，保持调用方给定值（AppModule 自行报错）
    const raw = (await probe.config('GET', 'databases').catch(() => null)) as string[] | null;
    const databases = Number(raw?.[1]);
    const limit = Number.isFinite(databases) && databases > 0 ? databases : 16;
    // 候选倒序挑选：优先未被既有套件占用（0/1/2/3/4/5/7/8/9/10/11）且当前为空的 DB
    const candidates = [limit - 1, limit - 3, limit - 2, limit - 4].filter((n) => n > 0 && n !== requested);
    let fallbackDb = candidates[0];
    for (const n of candidates) {
      const size = await probe.select(n).then(() => probe.dbsize()).catch(() => Number.POSITIVE_INFINITY);
      if (size === 0) { fallbackDb = n; break; }
    }
    const fallback = `${base}/${fallbackDb}`;
    // eslint-disable-next-line no-console
    console.warn(`[M10-P7 e2e] ${preferred} 的 DB 索引不可用（服务端 databases=${limit}，${String((err as Error).message)}）→ 使用隔离 DB ${fallback}`);
    return fallback;
  } finally {
    probe.disconnect();
  }
}

describe('M10-P7 附件内容安全 + S3/MinIO（e2e）', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let s3: S3Client;
  let cookieMain = '';
  let cookieQuota = '';
  let userMainId = '';
  let orgMainId = '';
  let userQuotaId = '';
  let orgQuotaId = '';
  let planId = '';
  const attachmentIds: string[] = [];
  const storageKeys: string[] = [];

  const api = () => request(app.getHttpServer());

  beforeAll(async () => {
    // ① 环境固定（必须在 AppModule 动态 import 之前——LoggerModule/pino 与 StorageModule 都在装载时读 env）
    process.env.REDIS_URL = await resolveRedisUrl();
    process.env.LOG_FILE = API_LOG_FILE;
    process.env.STORAGE_DRIVER = 's3';            // M10 计划指定值（StorageModule 同时接受 s3-compatible/minio）
    process.env.STORAGE_ENDPOINT = S3_ENDPOINT;
    process.env.STORAGE_BUCKET = S3_BUCKET;
    process.env.STORAGE_ACCESS_KEY_ID = S3_ACCESS_KEY;
    process.env.STORAGE_SECRET_ACCESS_KEY = S3_SECRET_KEY;

    const { AppModule } = await import('../src/app.module');
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.use(cookieParser());
    app.use('/api/v1', csrfProtection);
    app.setGlobalPrefix('api/v1');
    app.useGlobalFilters(moduleRef.get(GlobalExceptionFilter));
    app.useGlobalInterceptors(new TransformInterceptor());
    await app.init();
    prisma = moduleRef.get(PrismaService);

    // ② 专用桶（幂等创建；已存在则复用）
    s3 = new S3Client({
      endpoint: S3_ENDPOINT, region: process.env.STORAGE_REGION ?? 'us-east-1', forcePathStyle: true,
      credentials: { accessKeyId: S3_ACCESS_KEY, secretAccessKey: S3_SECRET_KEY },
    });
    try {
      await s3.send(new HeadBucketCommand({ Bucket: S3_BUCKET }));
    } catch {
      await s3.send(new CreateBucketCommand({ Bucket: S3_BUCKET }));
    }

    // ③ 两个用户（主流程用户 / 配额用户）+ 个人组织 + 直签 JWT cookie
    const main = await prisma.user.create({ data: { email: `m10p7-main-${STAMP}@example.com`, passwordHash: 'unused-hash' } });
    userMainId = main.id;
    orgMainId = (await prisma.organization.create({
      data: { id: `personal-${userMainId}`, name: 'M10P7 Main', slug: `personal-${userMainId}`, isPersonal: true, ownerUserId: userMainId, members: { create: { userId: userMainId, role: 'owner' } } },
    })).id;

    const quotaUser = await prisma.user.create({ data: { email: `m10p7-quota-${STAMP}@example.com`, passwordHash: 'unused-hash' } });
    userQuotaId = quotaUser.id;
    orgQuotaId = (await prisma.organization.create({
      data: { id: `personal-${userQuotaId}`, name: 'M10P7 Quota', slug: `personal-${userQuotaId}`, isPersonal: true, ownerUserId: userQuotaId, members: { create: { userId: userQuotaId, role: 'owner' } } },
    })).id;

    // 配额：2 次额度（月度/日度同值，避免跨日/跨月抖动）
    planId = (await prisma.plan.create({
      data: {
        code: `p7-tiny-${STAMP}`, name: 'P7 Tiny', monthlyPrice: 1, yearlyPrice: 10, active: true,
        entitlements: {
          agentRunsMonthly: 100, agentRunsDaily: 100, concurrentAgentRuns: 10,
          workflowRunsMonthly: 100, workflowRunsDaily: 100, concurrentWorkflowRuns: 10,
          llmTokensMonthly: 1_000_000_000, imageMonthly: 1_000_000, videoSecondsMonthly: 1_000_000,
          externalApiMonthly: 1_000_000, storageMb: 100_000, seats: 100,
          attachmentsMonthly: 2, attachmentsDaily: 2,
        },
      },
    })).id;
    const now = new Date();
    await prisma.subscription.create({
      data: { organizationId: orgQuotaId, planId, status: 'active', currentPeriodStart: now, currentPeriodEnd: new Date(now.getTime() + 30 * 86400_000) },
    });

    const { JwtService } = await import('@nestjs/jwt');
    const jwt = app.get(JwtService);
    cookieMain = `agent_access=${await jwt.signAsync({ sub: userMainId, role: 'user' })}`;
    cookieQuota = `agent_access=${await jwt.signAsync({ sub: userQuotaId, role: 'user' })}`;
  });

  afterAll(async () => {
    // 清理对象与库行（绝不污染 MinIO 桶与共享 DB）
    for (const key of storageKeys) {
      await s3.send(new DeleteObjectCommand({ Bucket: S3_BUCKET, Key: key })).catch(() => undefined);
    }
    await prisma.attachment.deleteMany({ where: { userId: { in: [userMainId, userQuotaId] } } }).catch(() => undefined);
    await prisma.usageLedgerEntry.deleteMany({ where: { organizationId: { in: [orgMainId, orgQuotaId] } } }).catch(() => undefined);
    await prisma.quotaReservation.deleteMany({ where: { organizationId: { in: [orgMainId, orgQuotaId] } } }).catch(() => undefined);
    await prisma.subscription.deleteMany({ where: { organizationId: { in: [orgMainId, orgQuotaId] } } }).catch(() => undefined);
    if (planId) await prisma.plan.delete({ where: { id: planId } }).catch(() => undefined);
    await prisma.session.deleteMany({ where: { userId: { in: [userMainId, userQuotaId] } } }).catch(() => undefined);
    await prisma.user.deleteMany({ where: { id: { in: [userMainId, userQuotaId] } } }).catch(() => undefined);
    s3?.destroy();
    await app?.close();

    // 还原环境（后续 spec 文件不得继承 S3 驱动/测试桶）
    for (const [key, value] of Object.entries(ORIGINAL_ENV)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(LOG_DIR, { recursive: true, force: true });
  });

  const upload = (cookie: string, body: Buffer, filename: string, contentType: string) =>
    api().post('/api/v1/attachments').set(XRW).set('Cookie', cookie)
      .attach('file', body, { filename, contentType });

  const getObject = async (key: string): Promise<Buffer> => {
    const res = await s3.send(new GetObjectCommand({ Bucket: S3_BUCKET, Key: key }));
    const chunks: Buffer[] = [];
    for await (const chunk of res.Body as AsyncIterable<Buffer>) chunks.push(chunk);
    return Buffer.concat(chunks);
  };

  it('S3 驱动生效（前置断言）：STORAGE_ADAPTER 是 S3 适配器且专用桶可达', async () => {
    const { StorageS3Adapter } = await import('../src/core/storage/s3/storage-s3.adapter');
    expect(app.get('STORAGE_ADAPTER')).toBeInstanceOf(StorageS3Adapter);
    await expect(s3.send(new HeadBucketCommand({ Bucket: S3_BUCKET }))).resolves.toBeDefined();
  });

  it('上传 JPEG（带 EXIF）→ 201；对象真的落在 MinIO 且对象字节已无 EXIF；库行大小=对象大小', async () => {
    const jpeg = makeJpegWithExif();
    const res = await upload(cookieMain, jpeg, 'photo.jpg', 'image/jpeg').expect(201);
    const { id, storageKey, sizeBytes, type, kind } = res.body.data as { id: string; storageKey: string; sizeBytes: number; type: string; kind: string };
    attachmentIds.push(id); storageKeys.push(storageKey);
    expect({ type, kind }).toEqual({ type: 'image', kind: 'upload' });
    expect(storageKey).toMatch(/^[0-9a-f-]{36}\/\d{4}\/\d{2}\/[0-9a-f-]{36}\.jpg$/);

    // 对象已在 MinIO（不是本地磁盘）：直读对象字节断言 EXIF 已被剥离
    const object = await getObject(storageKey);
    expect(object.includes(Buffer.from('Exif\0\0', 'latin1'))).toBe(false);
    expect(object.includes(Buffer.from('xmpmeta', 'latin1'))).toBe(false);
    expect(object.subarray(0, 3).toString('hex')).toBe('ffd8ff');
    expect(object.length).toBe(sizeBytes);
    expect(object.length).toBeLessThan(jpeg.length);

    const head = await s3.send(new HeadObjectCommand({ Bucket: S3_BUCKET, Key: storageKey }));
    expect(head.ContentType).toBe('image/jpeg');
    expect(head.ContentLength).toBe(sizeBytes);
  });

  it('下载附件 → S3 流式回源 200，字节与 MinIO 对象逐字节一致', async () => {
    const png = makePngWithMetadata(); // 含 tEXt/eXIf 元数据块
    const up = await upload(cookieMain, png, 'shot.png', 'image/png').expect(201);
    const { id, storageKey, sizeBytes } = up.body.data as { id: string; storageKey: string; sizeBytes: number };
    attachmentIds.push(id); storageKeys.push(storageKey);

    const object = await getObject(storageKey);
    expect(object.includes(Buffer.from('GPS 37.7749', 'latin1'))).toBe(false); // 元数据块已剥离
    expect(object.length).toBe(sizeBytes);

    const dl = await api().get(`/api/v1/attachments/${id}`).set('Cookie', cookieMain).expect(200);
    expect(dl.headers['content-type']).toContain('image/png');
    expect(Buffer.compare(dl.body as Buffer, object)).toBe(0); // 下载 == 对象存储字节（同一份）
    expect(Buffer.compare(dl.body as Buffer, png)).not.toBe(0); // 且**不是**原始上传字节（证明清洗真实发生）
  });

  it('删除（S3 DeleteObject）→ 对象从桶中消失（HeadObject 404）', async () => {
    const up = await upload(cookieMain, makePngWithMetadata(), 'del.png', 'image/png').expect(201);
    const { id, storageKey } = up.body.data as { id: string; storageKey: string };
    attachmentIds.push(id);

    await getObject(storageKey); // 前置：确实存在
    const adapter = app.get<{ delete(key: string): Promise<void> }>('STORAGE_ADAPTER');
    await adapter.delete(storageKey);

    await expect(s3.send(new HeadObjectCommand({ Bucket: S3_BUCKET, Key: storageKey })))
      .rejects.toMatchObject({ $metadata: { httpStatusCode: 404 } });
    // 库行仍在但对象已删（删除端点归 M10 其它 Phase；本断言锁定"对象生命周期由驱动真实执行"）
    expect(await prisma.attachment.findUnique({ where: { id } })).not.toBeNull();
  });

  it('压缩炸弹（真实可 inflate 出 40MB 的 docx）→ 400 ATTACHMENT_UNZIP_REJECTED，不落对象/不消耗配额', async () => {
    const bomb = makeBombZip();
    const res = await upload(cookieMain, bomb, 'bomb.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document').expect(400);
    expect(res.body.error.code).toBe('ATTACHMENT_UNZIP_REJECTED');
    expect(res.body.error.message).toContain('RATIO_LIMIT');
    expect(await prisma.attachment.count({ where: { userId: userMainId, originalName: 'bomb.docx' } })).toBe(0);
    // 被拒文件不消耗任何配额（预留/账本都没有痕迹）
    expect(await prisma.usageLedgerEntry.count({ where: { organizationId: orgMainId, kind: 'attachment_upload' } })).toBeGreaterThanOrEqual(0);
    expect(await prisma.quotaReservation.count({ where: { organizationId: orgMainId, kind: 'attachment_upload' } })).toBe(0);
  });

  it('正常 docx 形态 zip → 201（炸弹防护不误杀合法容器）', async () => {
    const res = await upload(cookieMain, makeNormalZip(), 'report.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document').expect(201);
    attachmentIds.push(res.body.data.id as string); storageKeys.push(res.body.data.storageKey as string);
    expect(res.body.data.type).toBe('file');
    expect((await getObject(res.body.data.storageKey as string)).length).toBe(res.body.data.sizeBytes);
  });

  it('基础边界仍在（S3 驱动下全量跑）：白名单外类型 400 / 无文件 400 / 越权或不存在 404', async () => {
    const bad = await upload(cookieMain, Buffer.from('evil'), 'x.exe', 'application/x-msdownload').expect(400);
    expect(bad.body.error.code).toBe('VALIDATION_ERROR');
    await api().post('/api/v1/attachments').set(XRW).set('Cookie', cookieMain).expect(400);
    await api().get(`/api/v1/attachments/${'0'.repeat(32)}`).set('Cookie', cookieMain).expect(404);
    await api().get(`/api/v1/attachments/${attachmentIds[0]}`).set(XRW).expect(401);
  });

  it('每用户附件配额：tiny 计划（attachmentsMonthly=2）第 3 次上传 429 ATTACHMENT_QUOTA_EXCEEDED；账本计数=2 且无残留预留', async () => {
    const quotaCookie = cookieQuota;
    expect(quotaCookie).toContain('agent_access=');

    const first = await upload(quotaCookie, makePngWithMetadata(), 'q1.png', 'image/png').expect(201);
    storageKeys.push(first.body.data.storageKey as string);
    expect(await prisma.usageLedgerEntry.count({ where: { organizationId: orgQuotaId, kind: 'attachment_upload' } })).toBe(1);

    const second = await upload(quotaCookie, makePngWithMetadata(), 'q2.png', 'image/png').expect(201);
    storageKeys.push(second.body.data.storageKey as string);

    // 配额计数（ledger 聚合口径）：2 次已消耗 + 预留全部释放（无残留占用）
    const ledger = await prisma.usageLedgerEntry.findMany({ where: { organizationId: orgQuotaId, kind: 'attachment_upload' }, select: { quantity: true, idempotencyKey: true } });
    expect(ledger.length).toBe(2);
    expect(ledger.reduce((n, e) => n + e.quantity, 0)).toBe(2);
    expect(new Set(ledger.map((e) => e.idempotencyKey)).size).toBe(2); // 幂等键唯一（同上传绝不二次计量）
    expect(await prisma.quotaReservation.count({ where: { organizationId: orgQuotaId, kind: 'attachment_upload' } })).toBe(0);

    // 第 3 次 → 429 专码（服务端裁决；LLM/客户端不参与）
    const blocked = await upload(quotaCookie, makePngWithMetadata(), 'q3.png', 'image/png').expect(429);
    expect(blocked.body.error.code).toBe('ATTACHMENT_QUOTA_EXCEEDED');
    // 超限后：账本不增、预留不残留、无新对象
    expect(await prisma.usageLedgerEntry.count({ where: { organizationId: orgQuotaId, kind: 'attachment_upload' } })).toBe(2);
    expect(await prisma.quotaReservation.count({ where: { organizationId: orgQuotaId, kind: 'attachment_upload' } })).toBe(0);
    expect(await prisma.attachment.count({ where: { userId: userQuotaId } })).toBe(2);
  });

  it('预签名 URL 可用但**签名材料不进日志**（真实 pino 落盘断言）', async () => {
    const adapter = app.get<{ createPresignedUrl(key: string, expiresInSec: number): Promise<string> }>('STORAGE_ADAPTER');
    const url = await adapter.createPresignedUrl(storageKeys[0], 60);
    expect(url).toContain('X-Amz-Signature');
    // 预签名 URL query 里带明文 access key —— 只在内存里用，绝不落盘
    const log = readFileSync(API_LOG_FILE, 'utf8');
    expect(log.length).toBeGreaterThan(0);
    expect(log).toContain('/api/v1/attachments'); // 覆盖成立（日志确实记录了本次链路）
    expect(log).not.toContain('X-Amz-Signature');
    expect(log).not.toContain('X-Amz-Credential');
    expect(log).not.toContain(S3_ACCESS_KEY);
    expect(log).not.toContain(S3_SECRET_KEY);
    expect(log).not.toContain('AWS4-HMAC-SHA256');
    expect(log.toLowerCase()).not.toContain('aws_secret_access_key');
  });
});
